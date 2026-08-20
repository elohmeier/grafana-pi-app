import { test, expect } from './fixtures';
import type { AppConfigPage, Page } from '@grafana/plugin-e2e';
import type { Locator } from '@playwright/test';
import { testIds } from '../src/components/testIds';
import type { PiAppCustomSkill, PiAppOpenAIProtocol, PiAppThinkingFormat, PiAppThinkingLevel } from '../src/types';

type ModelRowSettings = {
  id: string;
  name?: string;
  default?: boolean;
  protocol?: PiAppOpenAIProtocol;
  thinkingLevel?: PiAppThinkingLevel;
  thinkingFormat?: PiAppThinkingFormat;
};

const defaultLocalLLMSettings = {
  baseURL: 'http://host.docker.internal:8080/v1',
  model: 'unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL',
  protocol: 'auto' as const,
  thinkingLevel: 'medium' as const,
  thinkingFormat: 'qwen-chat-template' as const,
};

const localLLMSettings = {
  apiKey: process.env.OPENAI_API_KEY || 'local-dev-key',
  baseURL: process.env.E2E_OPENAI_BASE_URL || process.env.PI_OPENAI_BASE_URL || defaultLocalLLMSettings.baseURL,
  models: [
    {
      id: process.env.E2E_DEFAULT_MODEL || process.env.PI_DEFAULT_MODEL || defaultLocalLLMSettings.model,
      default: true,
      protocol: readProtocol(process.env.E2E_OPENAI_PROTOCOL || process.env.PI_OPENAI_PROTOCOL),
      thinkingLevel: readThinkingLevel(process.env.E2E_THINKING_LEVEL || process.env.PI_THINKING_LEVEL),
      thinkingFormat: readThinkingFormat(process.env.E2E_THINKING_FORMAT || process.env.PI_THINKING_FORMAT),
    },
  ],
  systemPromptAddendum: '',
};

test('should be possible to save app configuration', async ({ appConfigPage, page }) => {
  await saveLLMSettings(appConfigPage, page, {
    apiKey: 'secret-api-key',
    baseURL: 'https://api.openai.example/v1',
    models: [
      { id: 'gpt-test', name: 'Test model' },
      { id: 'gpt-test-reasoning', default: true, thinkingLevel: 'medium' },
    ],
    systemPromptAddendum: 'Prefer concise incident summaries.',
    customSkill: {
      name: 'team-runbook',
      description: 'Team incident workflow.',
      content: '# Team Runbook\n\nUse the internal incident workflow.',
    },
  });
  await saveLLMSettings(appConfigPage, page, localLLMSettings);
});

async function saveLLMSettings(
  appConfigPage: AppConfigPage,
  page: Page,
  settings: {
    apiKey: string;
    baseURL: string;
    models: ModelRowSettings[];
    systemPromptAddendum?: string;
    customSkill?: {
      name: string;
      description: string;
      content: string;
    };
  }
) {
  await page
    .getByRole('button', { name: /reset/i })
    .click({ timeout: 5000 })
    .catch(() => undefined);

  await page.getByRole('textbox', { name: 'API Key' }).fill(settings.apiKey);
  await page.getByRole('textbox', { name: 'Base URL' }).clear();
  await page.getByRole('textbox', { name: 'Base URL' }).fill(settings.baseURL);
  await configureModelRows(page, settings.models);
  await page.getByRole('textbox', { name: 'System prompt addendum' }).clear();
  if (settings.systemPromptAddendum) {
    await page.getByRole('textbox', { name: 'System prompt addendum' }).fill(settings.systemPromptAddendum);
  }

  await clearCustomSkills(page);
  if (settings.customSkill) {
    await addCustomSkill(page, settings.customSkill);
  }

  const saveResponse = appConfigPage.waitForSettingsResponse();
  await page.getByRole('button', { name: /Save LLM settings/i }).click();
  await expect(saveResponse).toBeOK();
}

async function configureModelRows(page: Page, models: ModelRowSettings[]) {
  const rows = page.getByTestId(testIds.appConfig.modelRow);
  while ((await rows.count()) > 1) {
    await page.getByTestId(testIds.appConfig.modelDelete).first().click();
  }

  for (const [index, model] of models.entries()) {
    if (index > 0) {
      await page.getByTestId(testIds.appConfig.modelAdd).click();
    }
    const row = rows.nth(index);
    await row.getByTestId(testIds.appConfig.modelId).clear();
    await row.getByTestId(testIds.appConfig.modelId).fill(model.id);
    await row.getByTestId(testIds.appConfig.modelName).clear();
    if (model.name) {
      await row.getByTestId(testIds.appConfig.modelName).fill(model.name);
    }
    await selectComboboxOption(
      page,
      row.getByTestId(testIds.appConfig.modelProtocol),
      protocolLabels[model.protocol ?? 'auto']
    );
    await selectComboboxOption(
      page,
      row.getByTestId(testIds.appConfig.modelThinkingLevel),
      thinkingLevelLabels[model.thinkingLevel ?? 'off']
    );
    if ((model.protocol ?? 'auto') !== 'responses') {
      await selectComboboxOption(
        page,
        row.getByTestId(testIds.appConfig.modelThinkingFormat),
        thinkingFormatLabels[model.thinkingFormat ?? 'openai']
      );
    }
    if (model.default) {
      await row.getByTestId(testIds.appConfig.modelDefault).check({ force: true });
    }
  }
}

async function selectComboboxOption(page: Page, combobox: Locator, label: string) {
  await combobox.click();
  await combobox.fill(label);
  await page.getByRole('option').filter({ hasText: label }).first().click();
  await expect(combobox).toHaveValue(label);
}

async function clearCustomSkills(page: Page) {
  const deleteButtons = page.getByTestId(testIds.appConfig.customSkillDelete);

  while ((await deleteButtons.count()) > 0) {
    await deleteButtons.first().click();
  }
}

async function addCustomSkill(
  page: Page,
  skill: {
    name: string;
    description: string;
    content: string;
  }
) {
  const customSkills: PiAppCustomSkill[] = [
    {
      name: skill.name,
      description: skill.description,
      content: skill.content,
      activation: { explicitOnly: true },
      toolGroups: ['skillResources'],
    },
  ];

  await page.getByTestId(testIds.appConfig.customSkillsJsonOpen).click();
  await page.getByTestId(testIds.appConfig.customSkillsJson).fill(JSON.stringify(customSkills, null, 2));
  await page.getByRole('button', { name: 'Apply JSON' }).click();

  const skillRow = page.getByTestId(testIds.appConfig.customSkillRow).filter({ hasText: skill.name });
  await expect(skillRow).toContainText(skill.description);
}

function readProtocol(value: string | undefined): PiAppOpenAIProtocol {
  return value === 'chat-completions' || value === 'responses' || value === 'auto'
    ? value
    : defaultLocalLLMSettings.protocol;
}

function readThinkingLevel(value: string | undefined): PiAppThinkingLevel {
  return isThinkingLevel(value) ? value : defaultLocalLLMSettings.thinkingLevel;
}

function readThinkingFormat(value: string | undefined): PiAppThinkingFormat {
  return isThinkingFormat(value) ? value : defaultLocalLLMSettings.thinkingFormat;
}

function isThinkingLevel(value: string | undefined): value is PiAppThinkingLevel {
  return value === 'off' || value === 'low' || value === 'medium' || value === 'high';
}

function isThinkingFormat(value: string | undefined): value is PiAppThinkingFormat {
  return value === 'openai' || value === 'qwen' || value === 'qwen-chat-template';
}

const protocolLabels: Record<PiAppOpenAIProtocol, string> = {
  auto: 'Auto',
  responses: 'Responses',
  'chat-completions': 'Chat Completions',
};

const thinkingLevelLabels: Record<PiAppThinkingLevel, string> = {
  off: 'Off',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

const thinkingFormatLabels: Record<PiAppThinkingFormat, string> = {
  openai: 'OpenAI',
  qwen: 'Qwen',
  'qwen-chat-template': 'Qwen template',
};
