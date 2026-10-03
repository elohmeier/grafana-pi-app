#!/usr/bin/env node
// Bundles the assistant host (src/host) for Node. `@grafana/runtime` is replaced
// by the host's HTTP implementation, and the plugin ID comes from the environment.
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = process.argv[2] ?? 'src/host/main.ts';

await build({
  entryPoints: [path.join(root, entry)],
  outfile: path.join(root, 'dist-host', `${path.basename(entry, '.ts')}.mjs`),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  logLevel: 'warning',
  alias: { '@grafana/runtime': path.join(root, 'src/host/grafanaRuntime.ts') },
  // Packages that load WebAssembly or workers relative to their own files stay in node_modules.
  external: ['jq-wasm', 'pyodide'],
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  plugins: [
    {
      name: 'plugin-id',
      setup(builder) {
        builder.onResolve({ filter: /(^|\/)plugin\.json$/ }, () => ({ path: 'plugin.json', namespace: 'plugin-id' }));
        builder.onLoad({ filter: /.*/, namespace: 'plugin-id' }, () => ({
          contents: 'export default { id: process.env.GRAFANA_PLUGIN_ID || "grafana-assistant-app" };',
          loader: 'js',
        }));
      },
    },
  ],
});
