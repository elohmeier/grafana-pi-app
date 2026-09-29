import type { ArtifactRuntime } from '../domain/artifacts';
import { SKILLS_ROOT } from '../skills/prompt';
import type { GrafanaSkill } from '../skills/types';
import { alertRuleCatalogEntry } from './alertRuleModel';
import type { AlertRuleBroker, DashboardBroker, DashboardSearchHit, JsonnetBroker } from './broker';
import type { GeneratedFile, GeneratedMount, ResourceIndex, WorkspaceResourceSnapshot } from './types';

const CATALOG_PAGE_SIZE = 1000;
const CATALOG_TTL_MS = 5 * 60 * 1000;

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
            return text;
          },
        };
      }
      files['/artifacts/index.ndjson'] = { content: index.length ? `${index.join('\n')}\n` : '' };
      return files;
    },
  };
}

export type DashboardCatalog = { mount: GeneratedMount; index: ResourceIndex };

/**
 * Metadata-only listing of every dashboard visible to the current user, cached
 * briefly. It backs /grafana/catalog and the index that lists
 * /grafana/dashboards/<uid>/ before any dashboard content is fetched.
 */
export function createDashboardCatalog(dashboards: DashboardBroker): DashboardCatalog {
  type Loaded = { uids: string[]; hits: Map<string, DashboardSearchHit>; ndjson: string; coverage: string };
  let cache: { at: number; promise: Promise<Loaded> } | undefined;
  let loaded: Loaded | undefined;
  const load = (signal?: AbortSignal) => {
    if (!cache || Date.now() - cache.at > CATALOG_TTL_MS) {
      const promise = (async (): Promise<Loaded> => {
        const hits: DashboardSearchHit[] = [];
        let page = 1;
        let hasMore = true;
        while (hasMore) {
          const result = await dashboards.search({ limit: CATALOG_PAGE_SIZE, page }, signal);
          hits.push(...result.hits);
          hasMore = result.hasMore && result.hits.length > 0;
          page++;
        }
        const lines = hits.map((hit) =>
          JSON.stringify({ ...hit, path: `/grafana/dashboards/${hit.uid}/dashboard.json` })
        );
        return {
          uids: [...new Set(hits.map((hit) => hit.uid))],
          hits: new Map(hits.map((hit) => [hit.uid, hit])),
          ndjson: lines.length ? `${lines.join('\n')}\n` : '',
          coverage: `${JSON.stringify(
            {
              schemaVersion: 1,
              dashboards: hits.length,
              complete: true,
              generatedAt: new Date().toISOString(),
              scope:
                'dashboard metadata visible to the current user; every dashboard is listed under /grafana/dashboards and its content is fetched on first read',
            },
            null,
            2
          )}\n`,
        };
      })();
      cache = { at: Date.now(), promise };
      promise.then(
        (result) => {
          loaded = result;
        },
        () => {
          cache = undefined;
        }
      );
    }
    return cache.promise;
  };
  return {
    mount: {
      root: '/grafana/catalog',
      description: 'Dashboard discovery snapshot (metadata only).',
      files: () => ({
        '/grafana/catalog/dashboards.ndjson': { load: async (signal) => (await load(signal)).ndjson },
        '/grafana/catalog/coverage.json': { load: async (signal) => (await load(signal)).coverage },
      }),
    },
    index: {
      prepare: async (signal) => {
        await load(signal);
      },
      uids: () => loaded?.uids ?? EMPTY_UIDS,
      describe: (uid) => loaded?.hits.get(uid),
    },
  };
}

const EMPTY_UIDS: readonly string[] = [];

export const ALERT_RULE_CATALOG_PATH = '/grafana/catalog/alert-rules.ndjson';

export type AlertRuleCatalog = DashboardCatalog & {
  /** The rule as listed, so reading rule.json needs no request of its own. */
  snapshot: (uid: string) => WorkspaceResourceSnapshot | undefined;
};

/**
 * Every Grafana-managed alert rule visible to the current user, listed in one paginated
 * request and cached briefly. The listing backs /grafana/catalog/alert-rules.ndjson and the
 * index that lists /grafana/alert-rules/<uid>/; it carries the complete rules, so reading or
 * scanning rule.json files needs no further requests.
 */
export function createAlertRuleCatalog(alertRules: AlertRuleBroker): AlertRuleCatalog {
  type Loaded = {
    uids: string[];
    rules: Map<string, WorkspaceResourceSnapshot>;
    folderTitles: Record<string, string>;
    ndjson: string;
  };
  let cache: { at: number; promise: Promise<Loaded> } | undefined;
  let loaded: Loaded | undefined;
  const load = (signal?: AbortSignal) => {
    if (!cache || Date.now() - cache.at > CATALOG_TTL_MS) {
      const promise = alertRules.list(signal).then(({ rules, folderTitles }): Loaded => {
        const sorted = [...rules].sort((left, right) => left.meta.uid.localeCompare(right.meta.uid));
        const lines = sorted.map((rule) =>
          JSON.stringify(
            alertRuleCatalogEntry(rule, rule.meta.folderUid ? folderTitles[rule.meta.folderUid] : undefined)
          )
        );
        return {
          uids: sorted.map((rule) => rule.meta.uid),
          rules: new Map(sorted.map((rule) => [rule.meta.uid, rule])),
          folderTitles,
          ndjson: lines.length ? `${lines.join('\n')}\n` : '',
        };
      });
      cache = { at: Date.now(), promise };
      promise.then(
        (result) => {
          loaded = result;
        },
        () => {
          cache = undefined;
        }
      );
    }
    return cache.promise;
  };
  return {
    mount: {
      root: ALERT_RULE_CATALOG_PATH,
      description: 'Alert rule discovery snapshot (metadata only).',
      files: () => ({ [ALERT_RULE_CATALOG_PATH]: { load: async (signal) => (await load(signal)).ndjson } }),
    },
    index: {
      prepare: async (signal) => {
        await load(signal);
      },
      uids: () => loaded?.uids ?? EMPTY_UIDS,
      describe: (uid) => {
        const meta = loaded?.rules.get(uid)?.meta;
        return meta
          ? {
              title: meta.title,
              folderUid: meta.folderUid,
              folderTitle: meta.folderUid ? loaded?.folderTitles[meta.folderUid] : undefined,
              group: meta.group,
            }
          : undefined;
      },
    },
    snapshot: (uid) => loaded?.rules.get(uid),
  };
}

function ensureTrailingNewline(value: string) {
  return value.endsWith('\n') ? value : `${value}\n`;
}

export const JSONNET_LIB_ROOT = '/lib/jsonnet';

/**
 * Read-only view of the vendored Jsonnet libraries at their import paths:
 * `import 'github.com/g42/pi-dashboard/main.libsonnet'` is
 * /lib/jsonnet/github.com/g42/pi-dashboard/main.libsonnet. The listing loads
 * before the first filesystem access; file contents load per package on first read.
 */
export function createJsonnetLibraryMount(jsonnet: JsonnetBroker): GeneratedMount {
  let listing: { packages: string[]; files: Array<{ path: string; size: number }> } | undefined;
  return {
    root: JSONNET_LIB_ROOT,
    description: 'Read-only vendored Jsonnet libraries at their import paths.',
    prepare: async (signal) => {
      listing ??= await jsonnet.listLibraryFiles(signal);
    },
    files: () => {
      const files: Record<string, GeneratedFile> = {};
      for (const file of listing?.files ?? []) {
        const pkg = listing!.packages.find((candidate) => file.path.startsWith(`${candidate}/`));
        if (!pkg || file.path.split('/').includes('..')) {
          continue;
        }
        files[`${JSONNET_LIB_ROOT}/${file.path}`] = {
          load: async (signal) => (await jsonnet.loadLibraryPackage(pkg, signal))[file.path] ?? '',
        };
      }
      return files;
    },
  };
}
