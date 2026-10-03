import { test, expect } from './fixtures';
import { ROUTES } from '../src/constants';
import { testIds } from '../src/components/testIds';
import pluginJson from '../src/plugin.json';
import { textResponse, toolCallResponse } from './llmResponses';

const LLM_ROUTE = '**/resources/llm/api/stream';
const pluginId = process.env.E2E_PLUGIN_ID ?? pluginJson.id;

/**
 * Runs `grafana-sql` against the MSSQL fixture of the `sql` Compose profile
 * (docs/restricted-sql.md) with a scripted model, and checks that no sentinel
 * from a sensitive column or an unlisted table reaches a model request or a
 * chat log commit. Skipped when the fixture or the SQL datasource policy is not
 * available.
 */
test.describe('restricted SQL access', () => {
  test('keeps sensitive columns out of model requests and chat logs', async ({ gotoPage, page }) => {
    const health = await page.request.get('/api/datasources/uid/mssql-itsm/health');
    const settings = await page.request.get(`/api/plugins/${pluginId}/settings`);
    const policy = settings.ok() ? (await settings.json()).jsonData?.sqlDatasources : undefined;
    test.skip(
      !health.ok() || !Array.isArray(policy) || policy.length === 0,
      'needs the `sql` Compose profile (mise run dev:sql) and the mssql-itsm policy from provisioning'
    );

    const commands = [
      // Schema, counts with filters on sensitive columns, groups and time buckets.
      `grafana-sql tables; grafana-sql columns dbo.Incidents; grafana-sql count dbo.Incidents --where 'ShortDescription~download' --time OpenedAt --since 30d --by Host --interval 1d`,
      // Rows with every visible column.
      `grafana-sql rows dbo.Changes --time ImplementedAt --since 1d; grafana-sql rows dbo.Incidents --time OpenedAt --since 30d --limit 2000`,
      // Refusals: sensitive columns, an unlisted table, and an unlisted datasource type.
      `grafana-sql rows dbo.Incidents --columns ShortDescription; grafana-sql count dbo.Incidents --by CallerEmail; grafana-sql rows dbo.Employees; grafana-sql tables --ds prometheus`,
      // Artifacts of the earlier commands.
      `cat /artifacts/*.json | head -c 400000`,
    ];
    const responses = [
      ...commands.map((command, index) => toolCallResponse('bash', { command }, `call_sql_${index}`)),
      textResponse('SQL checks done.'),
    ];
    const llmRequests: string[] = [];
    const commits: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && /\/chats\/[^/]+\/commits/.test(request.url())) {
        commits.push(request.postData() ?? '');
      }
    });
    await page.route(LLM_ROUTE, async (route) => {
      llmRequests.push(route.request().postData() ?? '');
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: responses.shift() ?? textResponse('No scripted response available.'),
      });
    });

    try {
      await gotoPage(`/${ROUTES.Chat}`);
      await expect(page.getByText('Ask about metrics, PromQL, or dashboards')).toBeVisible();
      await page
        .getByTestId(testIds.chat.composer)
        .fill('Investigate the report-renderer incidents in the ITSM database');
      await page.getByTestId(testIds.chat.send).click();
      await expect(page.getByText('SQL checks done.')).toBeVisible({ timeout: 60_000 });

      expect(llmRequests).toHaveLength(commands.length + 1);
      const modelInput = llmRequests.join('\n');
      // The data reached the model: groups, visible columns, and the change that preceded the incident.
      expect(modelInput).toContain('vm-web-01');
      expect(modelInput).toContain('CHG-4711');
      expect(modelInput).toContain('never returned');
      expect(modelInput).toContain('only visible columns can be grouped by');
      expect(modelInput).toContain('not available to the assistant');
      expect(modelInput).toContain('not a SQL datasource');
      // Sensitive content did not.
      expect(modelInput).not.toMatch(/PI-SENTINEL-/i);
      expect(commits.length).toBeGreaterThan(0);
      expect(commits.join('\n')).not.toMatch(/PI-SENTINEL-/i);
    } finally {
      await page.unroute(LLM_ROUTE).catch(() => undefined);
    }
  });
});
