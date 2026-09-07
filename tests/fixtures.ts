import { AppConfigPage, AppPage, test as base } from '@grafana/plugin-e2e';
import pluginJson from '../src/plugin.json';
import { captureBenchmark } from './benchmarkCapture';

const pluginId = process.env.E2E_PLUGIN_ID ?? pluginJson.id;

type AppTestFixture = {
  benchmarkCapture: void;
  appConfigPage: AppConfigPage;
  gotoPage: (path?: string) => Promise<AppPage>;
};

export const test = base.extend<AppTestFixture>({
  benchmarkCapture: [
    async ({ page }, use, testInfo) => captureBenchmark(page, testInfo, use),
    { auto: Boolean(process.env.BENCH_CASE_DIR) },
  ],
  appConfigPage: async ({ gotoAppConfigPage }, use) => {
    const configPage = await gotoAppConfigPage({
      pluginId,
    });
    await use(configPage);
  },
  gotoPage: async ({ gotoAppPage }, use) => {
    await use((path) =>
      gotoAppPage({
        path,
        pluginId,
      })
    );
  },
});

export { expect } from '@grafana/plugin-e2e';
