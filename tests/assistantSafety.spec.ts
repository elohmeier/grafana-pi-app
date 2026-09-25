import { test, expect } from './fixtures';
import { ROUTES } from '../src/constants';
import { testIds } from '../src/components/testIds';

const LLM_ROUTE = '**/resources/llm/api/stream';

test.describe('assistant safety workflows', () => {
  test('requires approval before workspace apply writes a dashboard to Grafana', async ({ gotoPage, page }) => {
    const suffix = Date.now().toString(36);
    const deniedUid = `denied-e2e-${suffix}`;
    const approvedUid = `approved-e2e-${suffix}`;
    // Stage the working copy with the write tool, then plan and apply it in a separate bash call.
    const responses = [
      toolCallResponse('write', stagedDashboard(deniedUid, 'Denied E2E'), 'call_denied_write'),
      toolCallResponse('bash', { command: planAndApplyCommand(deniedUid) }, 'call_denied_apply'),
      textResponse('Denied path handled.'),
      toolCallResponse('write', stagedDashboard(approvedUid, 'Approved E2E'), 'call_approved_write'),
      toolCallResponse('bash', { command: planAndApplyCommand(approvedUid) }, 'call_approved_apply'),
      textResponse('Approved path handled.'),
    ];
    const llmRequests: any[] = [];

    await page.route(LLM_ROUTE, async (route) => {
      llmRequests.push(await route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: responses.shift() ?? textResponse('No scripted response available.'),
      });
    });

    try {
      await gotoPage(`/${ROUTES.Chat}`);
      await expect(page.getByText('Ask about metrics, PromQL, or dashboards')).toBeVisible();

      const composer = page.getByTestId(testIds.chat.composer);
      await composer.fill('Create a dashboard for confirmation denial');
      await page.getByTestId(testIds.chat.send).click();

      const confirmation = page.getByTestId(testIds.chat.toolConfirmation);
      await expect(confirmation).toBeVisible();
      await expect(confirmation).toContainText('workspace apply');
      await expect(confirmation).toContainText(deniedUid);
      await expect(confirmation.getByTestId('workspace-apply-diff')).toContainText('Denied E2E');
      await page.getByTestId(testIds.chat.toolConfirmationDeny).click();
      await expect(page.getByText('Denied path handled.')).toBeVisible();
      expect((await page.request.get(`/api/dashboards/uid/${deniedUid}`)).status()).toBe(404);

      // The denied change stays staged in the session; the plan is scoped to the new path.
      await composer.fill('Create a dashboard for confirmation approval');
      await page.getByTestId(testIds.chat.send).click();

      await expect(confirmation).toBeVisible();
      await expect(confirmation).toContainText(approvedUid);
      await expect(confirmation).not.toContainText(deniedUid);
      await page.getByTestId(testIds.chat.toolConfirmationApprove).click();
      await expect(page.getByText('Approved path handled.')).toBeVisible();

      const saved = await page.request.get(`/api/dashboards/uid/${approvedUid}`);
      expect(saved.ok()).toBe(true);
      expect((await saved.json()).dashboard).toMatchObject({ uid: approvedUid, title: 'Approved E2E' });
      expect((await page.request.get(`/api/dashboards/uid/${deniedUid}`)).status()).toBe(404);

      const toolNames = llmRequests[0].context.tools.map((tool: any) => tool.name);
      expect(toolNames).toEqual(expect.arrayContaining(['read', 'write', 'edit', 'bash']));
      expect(toolNames).not.toContain('save_dashboard');
    } finally {
      await page.unroute(LLM_ROUTE).catch(() => undefined);
      for (const uid of [deniedUid, approvedUid]) {
        await page.request.delete(`/api/dashboards/uid/${uid}`).catch(() => undefined);
      }
    }
  });

  test('renders an investigation report updated by the assistant', async ({ gotoPage, page }) => {
    const title = `VM web investigation ${Date.now()}`;
    const llmRequests: any[] = [];

    await page.route(LLM_ROUTE, async (route) => {
      llmRequests.push(await route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body:
          llmRequests.length === 1
            ? toolCallResponse(
                'update_report',
                {
                  title,
                  patch: [
                    { op: 'add', path: '/scope/-', value: 'vm-web-01 latency spike over the last 6h' },
                    { op: 'add', path: '/evidence/-', value: 'HTTP 500s are concentrated on /render/report' },
                    { op: 'add', path: '/hypotheses/-', value: 'CPU saturation may be increasing request latency' },
                    { op: 'add', path: '/nextSteps/-', value: 'Validate node_load1 and CPU idle for vm-web-01' },
                  ],
                },
                'call_update_report'
              )
            : textResponse('Investigation report updated.'),
      });
    });

    try {
      await gotoPage(`/${ROUTES.Chat}`);
      await expect(page.getByText('Ask about metrics, PromQL, or dashboards')).toBeVisible();

      const composer = page.getByTestId(testIds.chat.composer);
      await composer.fill('Investigate why vm-web-01 latency is high');
      await page.getByTestId(testIds.chat.send).click();

      const report = page.getByTestId(testIds.chat.investigationReport);
      await expect(report).toBeVisible();
      await expect(report.getByText(title)).toBeVisible();
      await expect(report.getByText('vm-web-01 latency spike over the last 6h')).toBeVisible();
      await expect(report.getByText('HTTP 500s are concentrated on /render/report')).toBeVisible();
      await expect(report.getByText('CPU saturation may be increasing request latency')).toBeVisible();
      await expect(report.getByText('Validate node_load1 and CPU idle for vm-web-01')).toBeVisible();
      await expect(page.getByText('Investigation report updated.')).toBeVisible();

      expect(llmRequests[0].context.tools.map((tool: any) => tool.name)).toContain('update_report');
    } finally {
      await page.unroute(LLM_ROUTE).catch(() => undefined);
    }
  });
});

function dashboardPath(uid: string) {
  return `/grafana/dashboards/${uid}/dashboard.json`;
}

function stagedDashboard(uid: string, title: string) {
  const resource = {
    apiVersion: 'dashboard.grafana.app/v1',
    kind: 'Dashboard',
    metadata: { name: uid },
    spec: {
      title,
      schemaVersion: 41,
      panels: [
        { id: 1, type: 'text', title: 'Note', gridPos: { x: 0, y: 0, w: 12, h: 4 }, options: { content: title } },
      ],
    },
  };
  return { path: dashboardPath(uid), content: `${JSON.stringify(resource, null, 2)}\n` };
}

function planAndApplyCommand(uid: string) {
  return `plan=$(workspace plan --path ${dashboardPath(uid)} | jq -r .planId) && workspace apply "$plan"`;
}

function sseResponse(events: unknown[]) {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
}

function toolCallResponse(toolName: string, args: unknown, id = `call_${toolName}`) {
  return sseResponse([
    { type: 'start' },
    { type: 'toolcall_start', contentIndex: 0, id, toolName },
    { type: 'toolcall_delta', contentIndex: 0, delta: JSON.stringify(args) },
    { type: 'toolcall_end', contentIndex: 0 },
    doneEvent('toolUse'),
  ]);
}

function textResponse(text: string) {
  return sseResponse([
    { type: 'start' },
    { type: 'text_start', contentIndex: 0 },
    { type: 'text_delta', contentIndex: 0, delta: text },
    { type: 'text_end', contentIndex: 0 },
    doneEvent('stop'),
  ]);
}

function doneEvent(reason: 'stop' | 'toolUse') {
  return {
    type: 'done',
    reason,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
