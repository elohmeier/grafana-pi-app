import { test, expect } from './fixtures';
import { ROUTES } from '../src/constants';
import { testIds } from '../src/components/testIds';
import pluginJson from '../src/plugin.json';
import { textResponse, toolCallResponse } from './llmResponses';

const LLM_ROUTE = '**/resources/llm/api/stream';
const pluginId = process.env.E2E_PLUGIN_ID ?? pluginJson.id;

/**
 * Runs `grafana-logs` against the Elasticsearch fixture of the `logs` Compose
 * profile (docs/restricted-logs.md) with a scripted model, and checks that no
 * sentinel from a text field reaches a model request or a chat log commit.
 * Skipped when the fixture or the log datasource policy is not available.
 */
test.describe('restricted log access', () => {
  test('keeps log text out of model requests and chat logs', async ({ gotoPage, page }) => {
    const health = await page.request.get('/api/datasources/uid/es-logs/health');
    const settings = await page.request.get(`/api/plugins/${pluginId}/settings`);
    const policy = settings.ok() ? (await settings.json()).jsonData?.logDatasources : undefined;
    test.skip(
      !health.ok() || !Array.isArray(policy) || policy.length === 0,
      'needs the `logs` Compose profile (mise run dev:logs) and the es-logs policy from provisioning'
    );

    const commands = [
      // Counts with free text search, a time pattern, and groups by keyword fields.
      `grafana-logs count --since 30d -q 'message:"timed out"' --interval 1d; grafana-logs count --since 30d --by labels.session_token --top 50; grafana-logs count --since 30d --by user.email`,
      // Restricted documents only.
      `grafana-logs search --since 30d -q 'log.level:ERROR' --limit 300`,
      // Unrestricted deployment events mixed with restricted documents of the same service.
      `grafana-logs search --since 30d -q 'service.name:report-renderer AND (log.logger:deployer OR log.level:ERROR)' --limit 1000 | jq -c 'select(._restricted == false) | .message'`,
      // Refusals: an index and a datasource outside the policy, text fields as groups.
      `grafana-logs count --index logs-audit-prod; grafana-logs count --ds es-audit; grafana-logs count --by error.message.keyword; grafana-logs count --by message; grafana-logs fields --index logs-app-prod`,
      // Artifacts of the earlier commands.
      `cat /artifacts/*.json | head -c 400000`,
    ];
    const responses = [
      ...commands.map((command, index) => toolCallResponse('bash', { command }, `call_logs_${index}`)),
      textResponse('Log checks done.'),
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
      await page.getByTestId(testIds.chat.composer).fill('Investigate the report-renderer errors in the logs');
      await page.getByTestId(testIds.chat.send).click();
      await expect(page.getByText('Log checks done.')).toBeVisible({ timeout: 60_000 });

      expect(llmRequests).toHaveLength(commands.length + 1);
      const modelInput = llmRequests.join('\n');
      // The data reached the model: counts, keyword groups, and complete deployment events.
      expect(modelInput).toContain('ReportRenderTimeout');
      expect(modelInput).toContain('Deployment of report-renderer 3.8.0 to vm-web-01');
      expect(modelInput).toContain('is not available to the assistant');
      expect(modelInput).toContain('only non-text, aggregatable fields can be grouped by');
      // Text field content did not.
      expect(modelInput).not.toMatch(/PI-SENTINEL-/i);
      expect(commits.length).toBeGreaterThan(0);
      expect(commits.join('\n')).not.toMatch(/PI-SENTINEL-/i);
    } finally {
      await page.unroute(LLM_ROUTE).catch(() => undefined);
    }
  });
});
