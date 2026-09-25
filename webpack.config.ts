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
  return {
    ...baseConfig,
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
        patterns: ['python.cjs', 'python.wasm', 'python313.zip'].map((file) => ({
          from: path.join(cpythonDir, file),
          to: `cpython/${file}`,
        })),
      }),
    ],
  };
};

export default config;
