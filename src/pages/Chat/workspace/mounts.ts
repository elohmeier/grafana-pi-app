import type { DashboardMutationAPI } from '@grafana/data';
import type { ArtifactRuntime } from '../tools/artifacts';
import { SKILLS_ROOT } from '../skills/prompt';
import type { GrafanaSkill } from '../skills/types';
import type { DashboardBroker } from './broker';
import type { GeneratedFile, GeneratedMount } from './types';

const CATALOG_PAGE_SIZE = 1000;
const CATALOG_MAX_DASHBOARDS = 5000;
const CATALOG_TTL_MS = 5 * 60 * 1000;
const MAX_ARTIFACT_FILE_BYTES = 256 * 1024;

export function createSkillsMount(skills: readonly GrafanaSkill[]): GeneratedMount {
  return {
    root: SKILLS_ROOT,
    description: 'Read-only skill instructions (SKILL.md) and their reference resources.',
    files: () => {
      const files: Record<string, GeneratedFile> = {};
      const index: string[] = [];
      for (const skill of skills) {
        if (!/^[a-z0-9][a-z0-9-]*$/.test(skill.name)) {
          continue;
        }
        files[`${SKILLS_ROOT}/${skill.name}/SKILL.md`] = { content: ensureTrailingNewline(skill.content) };
        for (const [path, resource] of Object.entries(skill.resources ?? {})) {
          if (!path.includes('..')) {
            files[`${SKILLS_ROOT}/${skill.name}/${path.replace(/^\/+/, '')}`] = {
              content: ensureTrailingNewline(resource.content),
            };
          }
        }
        index.push(`- ${skill.name}: ${skill.description}`);
      }
      files[`${SKILLS_ROOT}/README.md`] = { content: `# Skills\n\n${index.join('\n')}\n` };
      return files;
    },
  };
}

export function createArtifactsMount(artifacts: ArtifactRuntime): GeneratedMount {
  return {
    root: '/artifacts',
    description: 'Read-only, bounded results captured by earlier tool calls and commands.',
    files: () => {
      const files: Record<string, GeneratedFile> = {};
      const index: string[] = [];
      for (const artifact of artifacts.list()) {
        const { id, kind, title, toolName, createdAt, summary, bytes } = artifact;
        index.push(
          JSON.stringify({ id, kind, title, toolName, createdAt, summary, bytes, path: `/artifacts/${id}.json` })
        );
        files[`/artifacts/${id}.json`] = {
          load: () => {
            const data =
              kind === 'image' ? { note: 'image artifact; pixel data is not available as text' } : artifact.data;
            const text = `${JSON.stringify({ id, kind, title, toolName, createdAt, summary, data }, null, 2)}\n`;
            return text.length > MAX_ARTIFACT_FILE_BYTES
              ? `${JSON.stringify({ id, kind, title, summary, truncated: true, note: 'artifact too large for the filesystem view' })}\n`
              : text;
          },
        };
      }
      files['/artifacts/index.ndjson'] = { content: index.length ? `${index.join('\n')}\n` : '' };
      return files;
    },
  };
}

/**
 * Paginated metadata-only discovery snapshot of dashboards visible to the
 * current user. Loaded lazily on first read and cached briefly.
 */
export function createCatalogMount(dashboards: DashboardBroker): GeneratedMount {
  let cache: { at: number; promise: Promise<{ ndjson: string; coverage: string }> } | undefined;
  const load = (signal?: AbortSignal) => {
    if (!cache || Date.now() - cache.at > CATALOG_TTL_MS) {
      const promise = (async () => {
        const lines: string[] = [];
        let page = 1;
        let hasMore = true;
        while (hasMore && lines.length < CATALOG_MAX_DASHBOARDS) {
          const result = await dashboards.search({ limit: CATALOG_PAGE_SIZE, page }, signal);
          for (const hit of result.hits) {
            lines.push(JSON.stringify({ ...hit, path: `/grafana/dashboards/${hit.uid}/dashboard.json` }));
          }
          hasMore = result.hasMore;
          page++;
        }
        const complete = !hasMore;
        return {
          ndjson: lines.length ? `${lines.slice(0, CATALOG_MAX_DASHBOARDS).join('\n')}\n` : '',
          coverage: `${JSON.stringify(
            {
              schemaVersion: 1,
              dashboards: Math.min(lines.length, CATALOG_MAX_DASHBOARDS),
              complete,
              limit: CATALOG_MAX_DASHBOARDS,
              generatedAt: new Date().toISOString(),
              scope: 'dashboard metadata visible to the current user; content is fetched on first read',
            },
            null,
            2
          )}\n`,
        };
      })();
      cache = { at: Date.now(), promise };
      promise.catch(() => {
        cache = undefined;
      });
    }
    return cache.promise;
  };
  return {
    root: '/grafana/catalog',
    description: 'Paginated dashboard discovery snapshot (metadata only).',
    files: () => ({
      '/grafana/catalog/dashboards.ndjson': { load: async (signal) => (await load(signal)).ndjson },
      '/grafana/catalog/coverage.json': { load: async (signal) => (await load(signal)).coverage },
    }),
  };
}

/** Read-only view of the unsaved dashboard currently open in the browser. */
export function createLiveDashboardMount(getApi: () => DashboardMutationAPI | undefined): GeneratedMount {
  const commands: Record<string, string> = {
    'info.json': 'GET_DASHBOARD_INFO',
    'panels.json': 'LIST_PANELS',
    'layout.json': 'GET_LAYOUT',
    'variables.json': 'LIST_VARIABLES',
  };
  return {
    root: '/live/dashboard',
    description: 'Unsaved state of the dashboard open in the browser (read-only).',
    files: () => {
      const api = getApi();
      if (!api) {
        return {};
      }
      let available: string[] = [];
      try {
        available = api.getAvailableCommands().map((command) => String(command));
      } catch {
        return {};
      }
      const files: Record<string, GeneratedFile> = {};
      for (const [name, command] of Object.entries(commands)) {
        if (!available.includes(command)) {
          continue;
        }
        files[`/live/dashboard/${name}`] = {
          load: async () => {
            const result = await api.execute({ type: command, payload: {} } as never);
            return `${JSON.stringify({ source: 'live browser dashboard (unsaved state)', command, result }, null, 2)}\n`;
          },
        };
      }
      return files;
    },
  };
}

function ensureTrailingNewline(value: string) {
  return value.endsWith('\n') ? value : `${value}\n`;
}
