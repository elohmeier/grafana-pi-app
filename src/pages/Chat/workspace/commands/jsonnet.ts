import { isWithin, normalizeWorkspacePath } from '../paths';
import { SCRATCH_MOUNTS } from '../workspace';
import {
  fail,
  json,
  listOption,
  numberOption,
  ok,
  stringOption,
  UsageError,
  type ParsedArgs,
  type WorkspaceCommandContext,
  type WorkspaceCommandSpec,
} from './registry';

const IMPORTABLE_FILE = /\.(jsonnet|libsonnet|json|txt|md)$/;
const MAX_IMPORT_FILES = 200;
const DASHBOARD_RESOURCE_UID = /^[A-Za-z0-9_-]{1,40}$/;

/**
 * Jsonnet over workspace files with the plugin's vendored libraries
 * (github.com/grafana/grafonnet, github.com/g42/pi-dashboard, jsonnet-libs).
 * Authoring uses the generic read/write/edit tools; this command only
 * evaluates, repairs, and browses libraries.
 */
export const jsonnetCommand: WorkspaceCommandSpec = {
  name: 'jsonnet',
  summary: 'Evaluate Jsonnet files from the workspace with the vendored Grafana libraries.',
  defaultSubcommand: 'eval',
  subcommands: {
    eval: {
      summary:
        'Evaluate FILE (relative imports resolve in the workspace, library imports in the vendor tree). `jsonnet FILE` is shorthand.',
      usage: 'jsonnet [eval] FILE [-o OUT] [-V KEY=VALUE]... [-A KEY=VALUE]... [-S] [--resource UID [--folder UID]]',
      effect: 'remote-read',
      options: {
        output: { type: 'string', alias: 'o', description: 'Write the result to OUT instead of stdout.' },
        'ext-str': { type: 'string[]', alias: 'V', description: 'External string variable KEY=VALUE (std.extVar).' },
        'tla-str': { type: 'string[]', alias: 'A', description: 'Top-level string argument KEY=VALUE.' },
        string: { type: 'boolean', alias: 'S', description: 'Expect a string result and print it raw.' },
        resource: {
          type: 'string',
          description:
            'Wrap a classic dashboard result as a dashboard.grafana.app/v1 resource with this UID (for -o /grafana/dashboards/UID/dashboard.json).',
        },
        folder: { type: 'string', description: 'Folder UID annotation for --resource output.' },
      },
      examples: [
        'jsonnet /workspace/dashboard.jsonnet | jq .title',
        'jsonnet dashboard.jsonnet --resource checkout-slo -o /grafana/dashboards/checkout-slo/dashboard.json',
      ],
      async run(parsed, ctx) {
        const jsonnet = requireJsonnet(ctx);
        const entrypoint = requireFile(parsed, ctx);
        const files = await importableFiles(ctx, entrypoint);
        const resourceUid = stringOption(parsed, 'resource');
        if (resourceUid !== undefined && !DASHBOARD_RESOURCE_UID.test(resourceUid)) {
          throw new UsageError('--resource must be a dashboard UID ([A-Za-z0-9_-], at most 40 characters)');
        }
        let output: string;
        try {
          output = await jsonnet.evaluate(
            {
              entrypoint,
              files,
              extStr: keyValues(parsed, 'ext-str'),
              tlaStr: keyValues(parsed, 'tla-str'),
              string: parsed.options.string === true,
            },
            ctx.signal
          );
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
        if (resourceUid) {
          output = `${JSON.stringify(dashboardResource(output, resourceUid, stringOption(parsed, 'folder')), null, 2)}\n`;
        } else if (!output.endsWith('\n')) {
          output += '\n';
        }
        const target = stringOption(parsed, 'output');
        if (target) {
          const path = normalizeWorkspacePath(target, ctx.cwd);
          await ctx.tx.writeFile(path, output);
          return ok('', '');
        }
        return ok(output);
      },
    },
    fix: {
      summary:
        'Repair common invalid dashboard constructors in FILE in place (explicit, reviewable edit). Prints the repairs.',
      usage: 'jsonnet fix FILE [--dry-run]',
      effect: 'local-stage',
      options: {
        'dry-run': { type: 'boolean', description: 'Print the repaired source instead of writing it.' },
      },
      async run(parsed, ctx) {
        const jsonnet = requireJsonnet(ctx);
        const path = requireFile(parsed, ctx);
        const source = await ctx.tx.readFile(path);
        let repaired: { source: string; repairs: string[] };
        try {
          repaired = await jsonnet.fix(source, ctx.signal);
        } catch (error) {
          return fail(`jsonnet fix: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (parsed.options['dry-run'] === true) {
          return ok(repaired.source);
        }
        if (repaired.source === source || repaired.repairs.length === 0) {
          return json({ path, changed: false, repairs: [] });
        }
        await ctx.tx.writeFile(path, repaired.source);
        return json({ path, changed: true, repairs: repaired.repairs, next: `jsonnet ${path}` });
      },
    },
    lib: {
      summary:
        'Browse vendored libraries: `lib ls [DIR]`, `lib cat PATH [--offset N --limit N]`, `lib search PATTERN [--path DIR]`.',
      usage: 'jsonnet lib ls|cat|search ...',
      effect: 'remote-read',
      options: {
        offset: { type: 'number', description: 'First line for `lib cat`.', default: 1 },
        limit: { type: 'number', description: 'Lines for `lib cat` (max 500).', default: 200 },
        path: { type: 'string', description: 'Library directory for `lib search`.' },
      },
      examples: [
        'jsonnet lib ls github.com/g42/pi-dashboard',
        'jsonnet lib search timeseries --path github.com/g42/pi-dashboard',
        'jsonnet lib cat github.com/g42/pi-dashboard/main.libsonnet --limit 80',
      ],
      async run(parsed, ctx) {
        const jsonnet = requireJsonnet(ctx);
        const [action, target] = parsed.positionals;
        if (action === 'ls') {
          const result = await jsonnet.listLibraries(target, ctx.signal);
          return ok(
            result.files.map((file) => `${result.basePath}/${file}`).join('\n') + (result.files.length ? '\n' : '')
          );
        }
        if (action === 'cat') {
          if (!target) {
            throw new UsageError('lib cat requires PATH');
          }
          const result = await jsonnet.readLibrary(
            target,
            {
              offset: numberOption(parsed, 'offset', 1, 1, 1_000_000),
              limit: numberOption(parsed, 'limit', 200, 1, 500),
            },
            ctx.signal
          );
          const last = result.lines[result.lines.length - 1]?.line ?? 0;
          const footer =
            last < result.totalLines ? `# ${result.totalLines - last} more lines; use --offset ${last + 1}\n` : '';
          return ok(result.lines.map((line) => line.text).join('\n') + '\n', footer);
        }
        if (action === 'search') {
          if (!target) {
            throw new UsageError('lib search requires PATTERN');
          }
          const result = await jsonnet.searchLibraries(target, stringOption(parsed, 'path'), ctx.signal);
          const lines = result.matches.map((match) => `${match.file}:${match.line}:${match.text}`);
          return ok(lines.join('\n') + (lines.length ? '\n' : ''), result.capped ? '# results capped\n' : '');
        }
        throw new UsageError('expected `lib ls`, `lib cat`, or `lib search`');
      },
    },
  },
};

function requireJsonnet(ctx: WorkspaceCommandContext) {
  if (!ctx.broker.jsonnet) {
    throw new Error('Jsonnet evaluation is not available in this session');
  }
  return ctx.broker.jsonnet;
}

function requireFile(parsed: ParsedArgs, ctx: WorkspaceCommandContext) {
  const raw = parsed.positionals[0];
  if (!raw) {
    throw new UsageError('FILE is required');
  }
  if (parsed.positionals.length > 1) {
    throw new UsageError(`unexpected argument ${JSON.stringify(parsed.positionals[1])}`);
  }
  return normalizeWorkspacePath(raw, ctx.cwd);
}

/** Workspace files the program may import: the entrypoint plus Jsonnet/JSON/text files in scratch mounts. */
async function importableFiles(ctx: WorkspaceCommandContext, entrypoint: string) {
  const files: Record<string, string> = { [entrypoint]: await ctx.tx.readFile(entrypoint) };
  let count = 1;
  for (const path of ctx.tx.allPaths()) {
    if (count >= MAX_IMPORT_FILES) {
      break;
    }
    if (path === entrypoint || !IMPORTABLE_FILE.test(path) || !SCRATCH_MOUNTS.some((mount) => isWithin(path, mount))) {
      continue;
    }
    if ((await ctx.tx.entryType(path)) === 'file') {
      files[path] = await ctx.tx.readFile(path);
      count++;
    }
  }
  return files;
}

function keyValues(parsed: ParsedArgs, name: string) {
  const values: Record<string, string> = {};
  for (const entry of listOption(parsed, name)) {
    const index = entry.indexOf('=');
    if (index <= 0) {
      throw new UsageError(`--${name} expects KEY=VALUE`);
    }
    values[entry.slice(0, index)] = entry.slice(index + 1);
  }
  return Object.keys(values).length ? values : undefined;
}

function dashboardResource(output: string, uid: string, folderUid: string | undefined) {
  let spec: Record<string, unknown>;
  try {
    spec = JSON.parse(output);
  } catch {
    throw new Error('--resource requires the program to evaluate to a JSON object');
  }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error('--resource requires the program to evaluate to a dashboard object');
  }
  if (spec.apiVersion && spec.spec) {
    throw new Error('the program already returns a resource; drop --resource');
  }
  const { id: _id, ...rest } = spec;
  return {
    apiVersion: 'dashboard.grafana.app/v1',
    kind: 'Dashboard',
    metadata: {
      name: uid,
      ...(folderUid ? { annotations: { 'grafana.app/folder': folderUid } } : {}),
    },
    spec: { ...rest, uid, tags: [...new Set([...(Array.isArray(rest.tags) ? rest.tags : []), 'genai'])] },
  };
}
