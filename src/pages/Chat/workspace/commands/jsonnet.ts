import { describeDashboardRemovals } from '../dashboardChanges';
import { isWithin, normalizeWorkspacePath, parentPath } from '../paths';
import { SCRATCH_MOUNTS } from '../workspace';
import {
  fail,
  json,
  listOption,
  ok,
  stringOption,
  UsageError,
  type ParsedArgs,
  type WorkspaceCommandContext,
  type WorkspaceCommandSpec,
} from './registry';

// Mirrors jsonnetEvalMaxInputBytes and the request body limit in pkg/plugin/jsonnet_eval.go
// (the body limit leaves 64 KiB for JSON encoding and the other request fields).
const MAX_INPUT_BYTES = 4 << 20;
const MAX_ENCODED_FILES_BYTES = MAX_INPUT_BYTES + (56 << 10);
const IMPORT_KEYWORD = /(?<![\w$])(importstr|importbin|import)\s*(@?)(['"])/g;
const STRING_ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' };
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
      usage:
        'jsonnet [eval] FILE [-o OUT] [-V KEY=VALUE]... [-A KEY=VALUE]... [-S] [--resource UID [--folder UID] [--replace]]',
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
        replace: {
          type: 'boolean',
          description:
            'Allow --resource output to drop panels or variables of an existing dashboard at OUT (a deliberate full rewrite).',
        },
      },
      examples: [
        'jsonnet /workspace/dashboard.jsonnet | jq .title',
        'jsonnet dashboard.jsonnet --resource checkout-slo -o /grafana/dashboards/checkout-slo/dashboard.json',
      ],
      async run(parsed, ctx) {
        const jsonnet = requireJsonnet(ctx);
        const entrypoint = requireFile(parsed, ctx);
        const files = await importedFiles(ctx, entrypoint);
        const tooLarge = oversizedRequest(files, entrypoint);
        if (tooLarge) {
          return fail(tooLarge);
        }
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
          if (resourceUid && parsed.options.replace !== true && (await ctx.tx.exists(path))) {
            // Rendering a new dashboard over an existing one replaces it; small edits belong in the JSON.
            const removed = describeDashboardRemovals(await ctx.tx.readFile(path), output);
            if (removed.length > 0) {
              return fail(
                `jsonnet: ${path} already holds dashboard ${resourceUid}, and the rendered result drops content from it:\n  ${removed.join('\n  ')}\nEdit existing dashboards in place (edit, jq, grafana-dashboard add-panel|set-panel), render to a new UID, or pass --replace if the user asked to rebuild it.\n`
              );
            }
          }
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

/**
 * The entrypoint plus every scratch file it reaches through import, importstr,
 * or importbin, transitively. Jsonnet import paths are string literals, so a
 * static scan finds them; a match inside a comment or string only adds a file
 * that exists. Paths resolve like the backend importer: absolute, or relative
 * to the importing file. Anything else (library paths, missing files) is left
 * to the backend, which resolves it in the vendor tree or reports the import.
 */
async function importedFiles(ctx: WorkspaceCommandContext, entrypoint: string) {
  const files: Record<string, string> = { [entrypoint]: await ctx.tx.readFile(entrypoint) };
  const pending = [entrypoint];
  while (pending.length > 0) {
    const from = pending.pop()!;
    for (const imported of importPaths(files[from])) {
      const path = resolveImport(from, imported);
      if (
        path === undefined ||
        path in files ||
        !SCRATCH_MOUNTS.some((mount) => isWithin(path, mount)) ||
        (await ctx.tx.entryType(path)) !== 'file'
      ) {
        continue;
      }
      files[path] = await ctx.tx.readFile(path);
      pending.push(path);
    }
  }
  return files;
}

function resolveImport(from: string, imported: string) {
  try {
    return normalizeWorkspacePath(imported, parentPath(from), { clampAtRoot: true });
  } catch {
    return undefined;
  }
}

/** The string literals following import, importstr, and importbin in Jsonnet source. */
export function importPaths(source: string): string[] {
  const paths: string[] = [];
  for (const match of source.matchAll(IMPORT_KEYWORD)) {
    const literal = readStringLiteral(source, match.index + match[0].length, match[3], match[2] === '@');
    if (literal) {
      paths.push(literal);
    }
  }
  return paths;
}

function readStringLiteral(source: string, start: number, quote: string, verbatim: boolean) {
  let value = '';
  for (let i = start; i < source.length; i++) {
    const char = source[i];
    if (char === quote) {
      if (verbatim && source[i + 1] === quote) {
        value += quote;
        i++;
        continue;
      }
      return value;
    }
    if (char === '\\' && !verbatim) {
      const next = source[++i];
      if (next === 'u') {
        value += String.fromCharCode(parseInt(source.slice(i + 1, i + 5), 16));
        i += 4;
      } else if (next !== undefined) {
        value += STRING_ESCAPES[next] ?? next;
      }
      continue;
    }
    value += char;
  }
  return undefined;
}

/** A failure message when the backend would reject the request as too large, naming the largest files. */
function oversizedRequest(files: Record<string, string>, entrypoint: string) {
  const encoder = new TextEncoder();
  const sizes = Object.entries(files).map(([path, content]) => ({ path, bytes: encoder.encode(content).length }));
  const total = sizes.reduce((sum, file) => sum + file.bytes, 0);
  const encoded = encoder.encode(JSON.stringify(files)).length;
  if (total <= MAX_INPUT_BYTES && encoded <= MAX_ENCODED_FILES_BYTES) {
    return undefined;
  }
  const largest = sizes
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 5)
    .map((file) => `${file.path} (${formatBytes(file.bytes)})`);
  return (
    `jsonnet: ${entrypoint} and the files it imports total ${formatBytes(total)}; the evaluator accepts at most ${formatBytes(MAX_INPUT_BYTES)}. Largest files sent:\n  ${largest.join('\n  ')}\n` +
    'Import only what the program needs: extract the needed fields into a smaller file (for example with jq) and import that, or write the values into the Jsonnet source.\n'
  );
}

function formatBytes(bytes: number) {
  return bytes >= 1 << 20 ? `${(bytes / (1 << 20)).toFixed(1)} MiB` : `${Math.ceil(bytes / 1024)} KiB`;
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
  const usage =
    "return d.dashboard.new(title=..., uid=..., variables=[...], rows=[d.row('Title', [d.layout.full(d.panel.timeseries(...))])])";
  if (typeof spec.title !== 'string' || !spec.title.trim()) {
    throw new Error(
      `--resource expects a classic dashboard object with a title; got top-level keys [${Object.keys(spec).join(', ')}]. ${usage}`
    );
  }
  if (spec.panels !== undefined) {
    const panels = Array.isArray(spec.panels) ? spec.panels : [];
    const invalid = panels.findIndex(
      (panel) => !panel || typeof panel !== 'object' || typeof (panel as { type?: unknown }).type !== 'string'
    );
    if (!Array.isArray(spec.panels) || invalid >= 0) {
      throw new Error(
        `--resource expects panels to be panel objects with a type${invalid >= 0 ? ` (panels[${invalid}] has none)` : ''}; pass d.row(...) and d.layout.* results to d.dashboard.new(rows=[...]) instead of panels. ${usage}`
      );
    }
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
