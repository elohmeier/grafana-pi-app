import CopyWebpackPlugin from 'copy-webpack-plugin';
import path from 'path';
import webpack from 'webpack';
import type { Configuration } from 'webpack';
import grafanaConfig, { type Env } from './.config/webpack/webpack.config.ts';

const config = async (env: Env): Promise<Configuration> => {
  const baseConfig = await grafanaConfig(env);
  const zlibShimPath = path.resolve(process.cwd(), 'src', 'shims', 'nodeZlib.ts');
  // CPython (Emscripten/WASM) for the workspace `python3` command. Served as
  // static assets and loaded lazily by a dedicated Worker on first use.
  const cpythonDir = path.resolve(process.cwd(), 'node_modules', 'just-bash', 'vendor', 'cpython-emscripten');
  // Grafana loads the plugin module as AMD. Declare the library on the plugin
  // entries instead of the whole output: an output-wide library also wraps
  // worker entry chunks (the python3 worker) in `define(...)`, which fails in a
  // Web Worker with "define is not defined".
  const { library, ...output } = baseConfig.output ?? {};
  const entry = Object.fromEntries(
    Object.entries(baseConfig.entry as Record<string, string>).map(([name, file]) => [name, { import: file, library }])
  ) as webpack.EntryObject;
  return {
    ...baseConfig,
    entry,
    output,
    // Keep Grafana-provided externals as AMD dependencies; the default follows output.library.
    externalsType: 'amd',
    cache:
      typeof baseConfig.cache === 'object'
        ? {
            ...baseConfig.cache,
            buildDependencies: {
              ...baseConfig.cache.buildDependencies,
              config: [
                ...((baseConfig.cache.buildDependencies?.config as string[] | undefined) ?? []),
                path.resolve(process.cwd(), 'webpack.config.ts'),
              ],
            },
          }
        : baseConfig.cache,
    resolve: {
      ...baseConfig.resolve,
      alias: {
        ...baseConfig.resolve?.alias,
        'node:zlib': zlibShimPath,
      },
    },
    plugins: [
      ...(baseConfig.plugins ?? []),
      new webpack.NormalModuleReplacementPlugin(/^node:zlib$/, zlibShimPath),
      new CopyWebpackPlugin({
        // python.cjs is published as python.js: Grafana serves .cjs as text/plain,
        // which importScripts in the worker rejects.
        patterns: [
          ['python.cjs', 'python.js'],
          ['python.wasm', 'python.wasm'],
          ['python313.zip', 'python313.zip'],
        ].map(([from, to]) => ({
          from: path.join(cpythonDir, from),
          to: `cpython/${to}`,
        })),
      }),
    ],
  };
};

export default config;
