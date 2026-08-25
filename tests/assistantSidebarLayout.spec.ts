import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { testIds } from '../src/components/testIds';

const SIDEBAR_VARIANT_ENABLED =
  process.env.PLUGIN_VARIANT_ID === 'grafana-assistant-app' ||
  (process.env.GRAFANA_URL ? new URL(process.env.GRAFANA_URL).port === '3001' : false);
const PLUGIN_ID = process.env.E2E_PLUGIN_ID ?? 'grafana-assistant-app';
const LLM_ROUTE = `**/api/plugins/${PLUGIN_ID}/resources/llm/api/stream`;

type AppSettings = {
  enabled: boolean;
  pinned: boolean;
  jsonData: {
    models?: Array<Record<string, unknown>>;
    [key: string]: unknown;
  };
};

test.describe('Assistant sidebar layout', () => {
  test.skip(!SIDEBAR_VARIANT_ENABLED, 'The extension sidebar is only available in the grafana-assistant-app variant.');

  test('keeps multi-model selection in a centered settings dialog without overflowing the composer', async ({
    page,
  }) => {
    const settingsResponse = await page.request.get(`/api/plugins/${PLUGIN_ID}/settings`);
    expect(settingsResponse).toBeOK();
    const originalSettings = (await settingsResponse.json()) as AppSettings;
    const defaultModelName = 'Default test model';
    const alternateModelName = 'Review model with a deliberately long display name';
    const originalDefaultModel = originalSettings.jsonData.models?.[0] ?? {};
    const llmRequests: Array<{ options?: { reasoning?: string } }> = [];
    const fixtureSettings: AppSettings = {
      enabled: originalSettings.enabled,
      pinned: originalSettings.pinned,
      jsonData: {
        ...originalSettings.jsonData,
        models: [
          {
            ...originalDefaultModel,
            id: 'default-test-model',
            name: defaultModelName,
            default: true,
            protocol: 'responses',
            thinkingLevel: 'medium',
            thinkingFormat: 'openai',
          },
          {
            id: 'alternate-review-model-with-a-long-id',
            name: alternateModelName,
            default: false,
            protocol: 'auto',
            thinkingLevel: 'off',
            thinkingFormat: 'openai',
          },
        ],
      },
    };
    const suffix = Date.now().toString(36);
    const dashboardUid = `assistant-model-menu-${suffix}`;
    const dashboardTitle = `Assistant model menu ${suffix}`;
    const thinkingPrompt = `Thinking high ${suffix}`;

    await page.route(LLM_ROUTE, async (route) => {
      llmRequests.push((await route.request().postDataJSON()) as { options?: { reasoning?: string } });
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: textResponse('Thinking override received.'),
      });
    });
    await updatePluginSettings(page, fixtureSettings);

    try {
      await seedDashboard(page, dashboardUid, dashboardTitle);
      await page.goto(`/d/${dashboardUid}/assistant-model-menu?orgId=1`);
      await expect(page.getByRole('heading', { name: 'Sidebar layout fixture' })).toBeVisible();
      await openAssistantSidebar(page, dashboardUid);

      const container = page.getByTestId(testIds.chat.container);
      const modelSettingsButton = container.getByTestId(testIds.chat.modelSelect);
      const composer = container.getByTestId(testIds.chat.composer);
      const send = container.getByTestId(testIds.chat.send);

      await expect(modelSettingsButton).toBeVisible();
      await expect(modelSettingsButton).toHaveAccessibleName(`Chat settings, current model ${defaultModelName}`);
      await expect(container.getByRole('combobox')).toHaveCount(0);

      const [containerBox, composerBox, sendBox] = await Promise.all([
        container.boundingBox(),
        composer.boundingBox(),
        send.boundingBox(),
      ]);
      expect(containerBox).not.toBeNull();
      expect(composerBox).not.toBeNull();
      expect(sendBox).not.toBeNull();
      expect(composerBox!.x + composerBox!.width).toBeLessThanOrEqual(containerBox!.x + containerBox!.width + 1);
      expect(sendBox!.x + sendBox!.width).toBeLessThanOrEqual(containerBox!.x + containerBox!.width + 1);
      expect(await container.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);

      await modelSettingsButton.focus();
      await page.keyboard.press('Enter');
      const settingsDialog = page.getByRole('dialog', { name: 'Chat settings' });
      const modelSelect = settingsDialog.getByRole('combobox', { name: 'Model' });
      const thinkingLevelSelect = settingsDialog.getByRole('combobox', { name: 'Thinking level' });
      await expect(settingsDialog).toBeVisible();
      await expect(modelSelect).toHaveValue(defaultModelName);
      await expect(thinkingLevelSelect).toHaveValue('Medium');

      const [dialogBox, viewport] = await Promise.all([
        settingsDialog.boundingBox(),
        Promise.resolve(page.viewportSize()),
      ]);
      expect(dialogBox).not.toBeNull();
      expect(viewport).not.toBeNull();
      expect(Math.abs(dialogBox!.x + dialogBox!.width / 2 - viewport!.width / 2)).toBeLessThanOrEqual(2);
      expect(Math.abs(dialogBox!.y + dialogBox!.height / 2 - viewport!.height / 2)).toBeLessThanOrEqual(2);

      await thinkingLevelSelect.click();
      await thinkingLevelSelect.fill('High');
      await page.getByRole('option').filter({ hasText: 'High' }).first().click();
      await expect(thinkingLevelSelect).toHaveValue('High');

      await settingsDialog.getByRole('button', { name: 'Done' }).click();
      await expect(settingsDialog).toBeHidden();
      await expect(modelSettingsButton).toBeFocused();

      await composer.fill(thinkingPrompt);
      await send.click();
      await expect(container.getByText('Thinking override received.')).toBeVisible();
      expect(llmRequests).toHaveLength(1);
      expect(llmRequests[0].options?.reasoning).toBe('high');

      await container.getByRole('button', { name: 'New chat' }).click();
      await expect(container.getByRole('heading', { name: 'New chat' })).toBeVisible();
      await modelSettingsButton.press('Enter');
      await expect(settingsDialog).toBeVisible();
      await expect(thinkingLevelSelect).toHaveValue('Medium');
      await settingsDialog.getByRole('button', { name: 'Done' }).click();

      await container.getByRole('button', { name: 'Sessions' }).click();
      const sessionsMenu = page.getByRole('menu', { name: 'Assistant sessions' });
      await sessionsMenu.getByText(thinkingPrompt, { exact: true }).click();
      await expect(container.getByRole('heading', { name: thinkingPrompt })).toBeVisible();

      await modelSettingsButton.press('Enter');
      await expect(settingsDialog).toBeVisible();
      await expect(thinkingLevelSelect).toHaveValue('High');

      await modelSelect.click();
      await modelSelect.fill(alternateModelName);
      await page.getByRole('option').filter({ hasText: alternateModelName }).first().click();
      await expect(modelSelect).toHaveValue(alternateModelName);
      await expect(settingsDialog.getByRole('combobox', { name: 'Thinking level' })).toHaveCount(0);

      await settingsDialog.getByRole('button', { name: 'Done' }).click();
      await expect(settingsDialog).toBeHidden();
      await expect(modelSettingsButton).toBeFocused();
      await expect(modelSettingsButton).toHaveAccessibleName(`Chat settings, current model ${alternateModelName}`);

      await modelSettingsButton.press('Enter');
      await expect(settingsDialog).toBeVisible();
      await expect(modelSelect).toHaveValue(alternateModelName);
      await expect(settingsDialog.getByRole('combobox', { name: 'Thinking level' })).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(settingsDialog).toBeHidden();
      await expect(modelSettingsButton).toBeFocused();
    } finally {
      await page.unroute(LLM_ROUTE).catch(() => undefined);
      await updatePluginSettings(page, originalSettings);
      await page.request.delete(`/api/dashboards/uid/${encodeURIComponent(dashboardUid)}`).catch(() => undefined);
    }
  });

  test('keeps an imported investigation report in one collapsible reading column', async ({ page }, testInfo) => {
    const suffix = Date.now().toString(36);
    const dashboardUid = `assistant-sidebar-layout-${suffix}`;
    const dashboardTitle = `Assistant sidebar layout ${suffix}`;

    await seedDashboard(page, dashboardUid, dashboardTitle);

    try {
      await page.goto(`/d/${dashboardUid}/assistant-sidebar-layout?orgId=1`);
      await expect(page.getByRole('heading', { name: 'Sidebar layout fixture' })).toBeVisible();
      await openAssistantSidebar(page, dashboardUid);

      await page.getByTestId(testIds.chat.importInput).setInputFiles({
        name: 'assistant-sidebar-layout.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(investigationSessionFixture())),
      });

      const report = page.getByTestId(testIds.chat.investigationReport);
      const reportScroll = page.getByTestId(testIds.chat.investigationReportScroll);
      const messages = page.getByTestId(testIds.chat.messages);
      const container = page.getByTestId(testIds.chat.container);
      const reportDisclosure = report.getByRole('button', {
        name: /^Analyse long-running login latency/,
      });
      await expect(report).toBeVisible();
      await expect(reportDisclosure).toHaveAttribute('aria-expanded', 'true');
      await expect(report.getByText(/^Analyse long-running login latency/)).toBeVisible();

      const [reportBox, messagesBox, containerBox, inputBox, sendBox] = await Promise.all([
        report.boundingBox(),
        messages.boundingBox(),
        container.boundingBox(),
        page.getByTestId(testIds.chat.composer).boundingBox(),
        page.getByTestId(testIds.chat.send).boundingBox(),
      ]);
      expect(reportBox).not.toBeNull();
      expect(messagesBox).not.toBeNull();
      expect(containerBox).not.toBeNull();
      expect(inputBox).not.toBeNull();
      expect(sendBox).not.toBeNull();

      expect(Math.abs(reportBox!.x - messagesBox!.x)).toBeLessThan(2);
      expect(reportBox!.width).toBeGreaterThanOrEqual(messagesBox!.width - 2);
      expect(messagesBox!.height).toBeGreaterThanOrEqual(120);
      expect(reportBox!.height).toBeLessThanOrEqual(360);
      expect(sendBox!.x + sendBox!.width).toBeLessThanOrEqual(containerBox!.x + containerBox!.width + 1);
      expect(sendBox!.y + sendBox!.height).toBeLessThanOrEqual(containerBox!.y + containerBox!.height + 1);

      const horizontalOverflow = await container.evaluate((element) => element.scrollWidth - element.clientWidth);
      expect(horizontalOverflow).toBeLessThanOrEqual(1);

      await expect
        .poll(() => reportScroll.evaluate((element) => element.scrollHeight > element.clientHeight))
        .toBe(true);
      const initialReportScrollTop = await reportScroll.evaluate((element) => element.scrollTop);
      await reportScroll.hover();
      await page.mouse.wheel(0, 800);
      await expect
        .poll(() => reportScroll.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(initialReportScrollTop);

      await reportScroll.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect(
        report.getByText('Final remediation marker: validate the recovered login latency.')
      ).toBeInViewport();

      const [scrolledReportBox, scrolledInputBox] = await Promise.all([
        report.boundingBox(),
        page.getByTestId(testIds.chat.composer).boundingBox(),
      ]);
      expect(scrolledReportBox).not.toBeNull();
      expect(scrolledInputBox).not.toBeNull();
      expect(scrolledReportBox!.y + scrolledReportBox!.height).toBeLessThanOrEqual(scrolledInputBox!.y + 1);

      await testInfo.attach('assistant-sidebar-layout-open.png', {
        body: await page.screenshot(),
        contentType: 'image/png',
      });

      await reportDisclosure.click();
      await expect(reportDisclosure).toHaveAttribute('aria-expanded', 'false');
      const collapsedBox = await report.boundingBox();
      expect(collapsedBox).not.toBeNull();
      expect(collapsedBox!.height).toBeLessThan(reportBox!.height);

      await testInfo.attach('assistant-sidebar-layout-collapsed.png', {
        body: await page.screenshot(),
        contentType: 'image/png',
      });
    } finally {
      await page.request.delete(`/api/dashboards/uid/${encodeURIComponent(dashboardUid)}`).catch(() => undefined);
    }
  });
});

async function seedDashboard(page: Page, uid: string, title: string) {
  const response = await page.request.post('/api/dashboards/db', {
    data: {
      dashboard: {
        uid,
        title,
        tags: ['assistant-sidebar-layout'],
        timezone: 'browser',
        schemaVersion: 41,
        time: { from: 'now-6h', to: 'now' },
        panels: [
          {
            id: 1,
            title: 'Sidebar layout fixture',
            type: 'text',
            gridPos: { x: 0, y: 0, w: 12, h: 8 },
            options: { mode: 'markdown', content: 'Sidebar layout fixture' },
          },
        ],
      },
      overwrite: true,
    },
  });
  expect(response).toBeOK();
}

async function updatePluginSettings(page: Page, settings: AppSettings) {
  const response = await page.request.post(`/api/plugins/${PLUGIN_ID}/settings`, {
    data: settings,
  });
  expect(response).toBeOK();
}

function textResponse(text: string) {
  const events = [
    { type: 'start' },
    { type: 'text_start', contentIndex: 0 },
    { type: 'text_delta', contentIndex: 0, delta: text },
    { type: 'text_end', contentIndex: 0 },
    {
      type: 'done',
      reason: 'stop',
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
  ];
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
}

async function openAssistantSidebar(page: Page, dashboardUid: string) {
  const locators = [
    page.getByRole('button', { name: /^Open (Grafana )?Assistant$/ }).first(),
    page
      .locator(
        '[aria-label="Open Assistant"], [title="Open Assistant"], [aria-label="Open Grafana Assistant"], [title="Open Grafana Assistant"]'
      )
      .first(),
  ];

  for (const locator of locators) {
    if (await locator.isVisible({ timeout: 5000 }).catch(() => false)) {
      await locator.click();
      await expect(page).toHaveURL(new RegExp(`/d/${escapeRegExp(dashboardUid)}/`));
      await expect(page.getByTestId(testIds.chat.composer)).toBeVisible();
      return;
    }
  }

  throw new Error('Could not find the Assistant sidebar trigger on the dashboard page.');
}

function investigationSessionFixture() {
  const timestamp = '2026-08-10T19:37:00.000Z';
  return {
    kind: 'g42-pi-app.chat-session',
    schemaVersion: 1,
    exportedAt: timestamp,
    pluginId: 'grafana-assistant-app',
    session: {
      id: 'assistant-sidebar-layout',
      title: 'Troubleshoot login latency',
      createdAt: timestamp,
      updatedAt: timestamp,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Investigate the login latency.' }],
          timestamp,
        },
      ],
      investigationReport: {
        id: 'login-latency',
        title: 'Analyse long-running login latency across the customer domain',
        status: 'active',
        scope: [
          'Dashboard UID: long-dashboard-identifier, Panel ID: 86 (Durchschnittliche Login-Zeit)',
          'Prometheus datasource UID: thanos-production-database',
          'Incident time range: now-6h to now, focus around 19:00',
        ],
        evidence: [
          'The customer domain latency series rises sharply at 18:57 and remains elevated through 19:08.',
          'The corresponding request-rate series remains within its normal operating range.',
        ],
        hypotheses: [
          'A downstream identity provider is adding latency after the application accepts each login request.',
          'A saturated connection pool is serialising work during the incident window.',
        ],
        ruledOut: [
          'A broad traffic spike is not supported by the request-rate series.',
          'Dashboard rendering delay does not explain the server-side metric increase.',
        ],
        nextSteps: [
          'Compare the login latency with identity-provider duration and connection-pool wait time.',
          'Inspect pod-level latency to determine whether the increase is isolated to one replica.',
        ],
        remediation: [
          'Drain an unhealthy replica if the pod comparison identifies a single outlier.',
          'Final remediation marker: validate the recovered login latency.',
        ],
        updatedAt: timestamp,
      },
    },
  };
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
