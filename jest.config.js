// force timezone to UTC to allow tests to work regardless of local timezone
// generally used by snapshots, but can affect specific tests
process.env.TZ = 'UTC';

const baseConfig = require('./.config/jest.config');
const { grafanaESModules, nodeModulesToTransform } = require('./.config/jest/utils');

module.exports = {
  // Jest configuration provided by Grafana scaffolding
  ...baseConfig,
  transform: {
    ...baseConfig.transform,
    // typebox ships ES modules as .mjs files.
    '^.+\\.mjs$': baseConfig.transform['^.+\\.(t|j)sx?$'],
  },
  moduleNameMapper: {
    ...baseConfig.moduleNameMapper,
    // The Pi packages are ESM-only and export only the `import` condition, which Jest does not resolve.
    '^@earendil-works/(chord|pi-agent-core|pi-ai|pi-durable)$':
      '<rootDir>/node_modules/@earendil-works/$1/dist/index.js',
    '^@earendil-works/(chord|pi-durable)/(.+)$': '<rootDir>/node_modules/@earendil-works/$1/dist/$2/index.js',
    '^@earendil-works/pi-ai/utils/(.+)$': '<rootDir>/node_modules/@earendil-works/pi-ai/dist/utils/$1.js',
    // Run the browser bundle under test: it is what the plugin ships.
    '^just-bash/browser$': '<rootDir>/node_modules/just-bash/dist/bundle/browser.js',
  },
  transformIgnorePatterns: [
    nodeModulesToTransform([
      ...grafanaESModules,
      '@earendil-works',
      'partial-json',
      'typebox',
      'diff',
      '@react-hookz/web',
      '@ver0/deep-equal',
      'just-bash',
    ]),
  ],
};
