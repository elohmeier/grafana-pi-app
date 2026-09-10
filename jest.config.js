// force timezone to UTC to allow tests to work regardless of local timezone
// generally used by snapshots, but can affect specific tests
process.env.TZ = 'UTC';

const baseConfig = require('./.config/jest.config');
const { grafanaESModules, nodeModulesToTransform } = require('./.config/jest/utils');

module.exports = {
  // Jest configuration provided by Grafana scaffolding
  ...baseConfig,
  moduleNameMapper: {
    ...baseConfig.moduleNameMapper,
    '^@earendil-works/pi-agent-core$': '<rootDir>/src/test/piAgentCoreJestShim.ts',
    '^@earendil-works/pi-ai$': '<rootDir>/src/test/piAiJestShim.ts',
  },
  transformIgnorePatterns: [
    nodeModulesToTransform([
      ...grafanaESModules,
      '@earendil-works/pi-agent-core',
      '@react-hookz/web',
      '@ver0/deep-equal',
    ]),
  ],
};
