import React, { ChangeEvent, FormEvent, useMemo, useState } from 'react';
import {
  Button,
  Checkbox,
  Combobox,
  Field,
  IconButton,
  Input,
  useStyles2,
  FieldSet,
  SecretInput,
  MultiCombobox,
  TextArea,
  RadioButtonGroup,
  type ComboboxOption,
} from '@grafana/ui';
import { PluginConfigPageProps, AppPluginMeta, PluginMeta, GrafanaTheme2 } from '@grafana/data';
import { getBackendSrv, getDataSourceSrv, locationService } from '@grafana/runtime';
import { css } from '@emotion/css';
import { testIds } from '../testIds';
import { lastValueFrom } from 'rxjs';
import type {
  PiAppAccessMode,
  PiAppCustomSkill,
  PiAppJsonData,
  PiAppModelConfig,
  PiAppOpenAIProtocol,
  PiAppThinkingFormat,
  PiAppThinkingLevel,
} from '../../types';
import { GRAFANA_SKILLS } from '../../pages/Chat/skills/catalog';
import { normalizeOpenAIProtocol, normalizeThinkingFormat, normalizeThinkingLevel } from '../../pages/Chat/model';
import {
  APP_ACCESS_ACTION,
  accessModeOptions,
  formatAllowedUsersInput,
  getConfiguredAccessMode,
  parseAllowedUsersInput,
} from '../../utils/access';
import { CustomSkillsEditor } from './CustomSkillsEditor';
import {
  formatCustomSkillValidationIssues,
  serializeCustomSkills,
  validateCustomSkillsForEditor,
} from './customSkillsEditorModel';

type State = {
  openAIBaseUrl: string;
  models: PiAppModelConfig[];
  isOpenAIAPIKeySet: boolean;
  openAIAPIKey: string;
  accessMode: PiAppAccessMode;
  allowedUsersText: string;
  allowedPrometheusDatasourceUids: string[];
  systemPromptAddendum: string;
  customSkills: PiAppCustomSkill[];
};

const emptyModelRow = (isDefault: boolean): PiAppModelConfig => ({
  id: '',
  name: '',
  default: isDefault,
  protocol: 'auto',
  thinkingLevel: 'off',
  thinkingFormat: 'openai',
});

const initialModelRows = (models?: PiAppModelConfig[]): PiAppModelConfig[] => {
  const rows = Array.isArray(models) ? models.filter((model) => (model?.id ?? '').trim()) : [];
  if (rows.length === 0) {
    return [emptyModelRow(true)];
  }
  return rows.map((model) => ({
    id: model.id ?? '',
    name: model.name ?? '',
    default: Boolean(model.default),
    protocol: normalizeOpenAIProtocol(model.protocol),
    thinkingLevel: normalizeThinkingLevel(model.thinkingLevel),
    thinkingFormat: normalizeThinkingFormat(model.thinkingFormat),
  }));
};

// Mirrors backend normalization: trim and dedupe IDs, drop empty rows, and
// keep exactly one default entry.
const serializeModels = (rows: PiAppModelConfig[]): PiAppModelConfig[] => {
  const seen = new Set<string>();
  const models: PiAppModelConfig[] = [];
  for (const row of rows) {
    const id = (row.id ?? '').trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const name = (row.name ?? '').trim();
    models.push({
      id,
      ...(name && name !== id ? { name } : {}),
      ...(row.default ? { default: true } : {}),
      protocol: normalizeOpenAIProtocol(row.protocol),
      thinkingLevel: normalizeThinkingLevel(row.thinkingLevel),
      thinkingFormat: normalizeThinkingFormat(row.thinkingFormat),
    });
  }
  if (models.length > 0 && !models.some((model) => model.default)) {
    models[0] = { ...models[0], default: true };
  }
  return models;
};

const validateModelRows = (rows: PiAppModelConfig[]): string | undefined => {
  const ids = rows.map((row) => (row.id ?? '').trim()).filter(Boolean);
  if (ids.length === 0) {
    return 'Add at least one model with a model ID.';
  }
  if (new Set(ids).size !== ids.length) {
    return 'Model IDs must be unique.';
  }
  if (rows.some((row) => !(row.id ?? '').trim())) {
    return 'Remove empty model rows or fill in their model IDs.';
  }
  return undefined;
};

export interface AppConfigProps extends PluginConfigPageProps<AppPluginMeta<PiAppJsonData>> {}

const AppConfig = ({ plugin }: AppConfigProps) => {
  const s = useStyles2(getStyles);
  const { enabled, pinned, jsonData } = plugin.meta;
  const [state, setState] = useState<State>({
    openAIBaseUrl: jsonData?.openAIBaseUrl || 'https://api.openai.com/v1',
    models: initialModelRows(jsonData?.models),
    openAIAPIKey: '',
    isOpenAIAPIKeySet: Boolean(jsonData?.isOpenAIAPIKeySet),
    accessMode: getConfiguredAccessMode(jsonData),
    allowedUsersText: formatAllowedUsersInput(jsonData?.allowedUsers),
    allowedPrometheusDatasourceUids: Array.isArray(jsonData?.allowedPrometheusDatasourceUids)
      ? jsonData.allowedPrometheusDatasourceUids
      : [],
    systemPromptAddendum: typeof jsonData?.systemPromptAddendum === 'string' ? jsonData.systemPromptAddendum : '',
    customSkills: Array.isArray(jsonData?.customSkills) ? jsonData.customSkills : [],
  });
  const datasourceOptions = getPrometheusDatasourceOptions(state.allowedPrometheusDatasourceUids);
  const customSkillIssues = useMemo(
    () =>
      validateCustomSkillsForEditor(state.customSkills, {
        reservedNames: GRAFANA_SKILLS.map((skill) => skill.name),
      }),
    [state.customSkills]
  );
  const customSkillsError = useMemo(() => formatCustomSkillValidationIssues(customSkillIssues), [customSkillIssues]);
  const allowedUsers = useMemo(() => parseAllowedUsersInput(state.allowedUsersText), [state.allowedUsersText]);
  const allowedUsersError =
    state.accessMode === 'users' && allowedUsers.length === 0
      ? 'Enter at least one Grafana login or email.'
      : undefined;

  const modelsError = useMemo(() => validateModelRows(state.models), [state.models]);

  const isSubmitDisabled = Boolean(
    !state.openAIBaseUrl ||
    modelsError ||
    (!state.isOpenAIAPIKeySet && !state.openAIAPIKey) ||
    allowedUsersError ||
    customSkillsError
  );

  const onResetOpenAIAPIKey = () =>
    setState({
      ...state,
      openAIAPIKey: '',
      isOpenAIAPIKeySet: false,
    });

  const onChangeOpenAIAPIKey = (event: ChangeEvent<HTMLInputElement>) => {
    setState({
      ...state,
      openAIAPIKey: event.target.value.trim(),
    });
  };

  const onChangeOpenAIBaseUrl = (event: ChangeEvent<HTMLInputElement>) => {
    setState({
      ...state,
      openAIBaseUrl: event.target.value.trim(),
    });
  };

  const onChangeModelRow = (index: number, patch: Partial<PiAppModelConfig>) => {
    setState({
      ...state,
      models: state.models.map((model, modelIndex) => (modelIndex === index ? { ...model, ...patch } : model)),
    });
  };

  const onSetDefaultModel = (index: number) => {
    setState({
      ...state,
      models: state.models.map((model, modelIndex) => ({ ...model, default: modelIndex === index })),
    });
  };

  const onAddModel = () => {
    setState({
      ...state,
      models: [...state.models, emptyModelRow(state.models.length === 0)],
    });
  };

  const onRemoveModel = (index: number) => {
    const models = state.models.filter((_, modelIndex) => modelIndex !== index);
    if (models.length > 0 && !models.some((model) => model.default)) {
      models[0] = { ...models[0], default: true };
    }
    setState({
      ...state,
      models,
    });
  };

  const onChangeAccessMode = (accessMode: PiAppAccessMode) => {
    setState({
      ...state,
      accessMode,
    });
  };

  const onChangeAllowedUsers = (event: ChangeEvent<HTMLTextAreaElement>) => {
    setState({
      ...state,
      allowedUsersText: event.currentTarget.value,
    });
  };

  const onChangeAllowedDatasourceUids = (options: Array<ComboboxOption<string>>) => {
    setState({
      ...state,
      allowedPrometheusDatasourceUids: options.map((option) => option.value),
    });
  };

  const onChangeSystemPromptAddendum = (event: ChangeEvent<HTMLTextAreaElement>) => {
    setState({
      ...state,
      systemPromptAddendum: event.currentTarget.value,
    });
  };

  const onChangeCustomSkills = (customSkills: PiAppCustomSkill[]) => {
    setState({
      ...state,
      customSkills,
    });
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const customSkills = serializeCustomSkills(state.customSkills);

    updatePluginAndReload(plugin.meta.id, {
      enabled,
      pinned,
      jsonData: {
        openAIBaseUrl: state.openAIBaseUrl,
        models: serializeModels(state.models),
        isOpenAIAPIKeySet: true,
        accessMode: state.accessMode,
        allowedUsers,
        allowedPrometheusDatasourceUids: state.allowedPrometheusDatasourceUids,
        systemPromptAddendum: state.systemPromptAddendum.trim(),
        customSkills,
      },
      secureJsonData: state.isOpenAIAPIKeySet
        ? undefined
        : {
            openAIAPIKey: state.openAIAPIKey,
          },
    });
  };

  return (
    <form onSubmit={onSubmit}>
      <FieldSet label="Access" className={s.marginTopXl}>
        <Field
          label="Who can use the app"
          description={`RBAC mode checks the ${APP_ACCESS_ACTION} permission. The plugin role grants it to organization admins by default.`}
        >
          <RadioButtonGroup<PiAppAccessMode>
            options={accessModeOptions}
            value={state.accessMode}
            onChange={onChangeAccessMode}
          />
        </Field>

        {state.accessMode === 'users' && (
          <Field
            label="Allowed users"
            description="One Grafana login or email per line. Organization admins are always allowed."
            className={s.marginTop}
            invalid={Boolean(allowedUsersError)}
            error={allowedUsersError}
          >
            <TextArea
              className={s.allowedUsersTextArea}
              data-testid={testIds.appConfig.allowedUsers}
              id="allowed-users"
              rows={5}
              value={state.allowedUsersText}
              placeholder="alice@example.com"
              onChange={onChangeAllowedUsers}
            />
          </Field>
        )}
      </FieldSet>

      <FieldSet label="OpenAI-compatible LLM" className={s.marginTopXl}>
        <Field label="API Key" description="Stored in secureJsonData and only used by the backend plugin.">
          <SecretInput
            width={60}
            data-testid={testIds.appConfig.openAIAPIKey}
            id="openai-api-key"
            value={state.openAIAPIKey}
            isConfigured={state.isOpenAIAPIKeySet}
            placeholder="sk-..."
            onChange={onChangeOpenAIAPIKey}
            onReset={onResetOpenAIAPIKey}
          />
        </Field>

        <Field
          label="Base URL"
          description="OpenAI-compatible API root, without /chat/completions or /responses."
          className={s.marginTop}
        >
          <Input
            width={60}
            id="openai-base-url"
            data-testid={testIds.appConfig.openAIBaseUrl}
            value={state.openAIBaseUrl}
            placeholder="https://api.openai.com/v1"
            onChange={onChangeOpenAIBaseUrl}
          />
        </Field>

        <Field
          label="Models"
          description="Models chat users can pick from the assistant model selector. The default model is preselected for new chats. Per-model protocol and thinking settings apply to requests with that model."
          className={s.marginTop}
          invalid={Boolean(modelsError)}
          error={modelsError}
        >
          <div className={s.modelList}>
            {state.models.map((model, index) => (
              <div className={s.modelRow} data-testid={testIds.appConfig.modelRow} key={index}>
                <div className={s.modelRowLine}>
                  <Field className={s.modelRowField} label="Model ID">
                    <Input
                      width={30}
                      data-testid={testIds.appConfig.modelId}
                      value={model.id ?? ''}
                      placeholder="gpt-4.1"
                      onChange={(event: ChangeEvent<HTMLInputElement>) =>
                        onChangeModelRow(index, { id: event.target.value.trim() })
                      }
                    />
                  </Field>
                  <Field className={s.modelRowField} label="Display name (optional)">
                    <Input
                      width={24}
                      data-testid={testIds.appConfig.modelName}
                      value={model.name ?? ''}
                      placeholder={model.id?.trim() || 'Shown in the chat selector'}
                      onChange={(event: ChangeEvent<HTMLInputElement>) =>
                        onChangeModelRow(index, { name: event.target.value })
                      }
                    />
                  </Field>
                  <div className={s.modelRowControls}>
                    <Checkbox
                      data-testid={testIds.appConfig.modelDefault}
                      label="Default"
                      checked={Boolean(model.default)}
                      onChange={() => onSetDefaultModel(index)}
                    />
                    <IconButton
                      aria-label="Remove model"
                      data-testid={testIds.appConfig.modelDelete}
                      disabled={state.models.length === 1}
                      name="trash-alt"
                      tooltip="Remove model"
                      onClick={() => onRemoveModel(index)}
                    />
                  </div>
                </div>
                <div className={s.modelRowLine}>
                  <Field className={s.modelRowField} label="API protocol">
                    <Combobox<PiAppOpenAIProtocol>
                      data-testid={testIds.appConfig.modelProtocol}
                      options={openAIProtocolOptions}
                      value={normalizeOpenAIProtocol(model.protocol)}
                      width={22}
                      onChange={(option) => onChangeModelRow(index, { protocol: option.value })}
                    />
                  </Field>
                  <Field className={s.modelRowField} label="Thinking level">
                    <Combobox<PiAppThinkingLevel>
                      data-testid={testIds.appConfig.modelThinkingLevel}
                      options={thinkingLevelOptions}
                      value={normalizeThinkingLevel(model.thinkingLevel)}
                      width={16}
                      onChange={(option) => onChangeModelRow(index, { thinkingLevel: option.value })}
                    />
                  </Field>
                  {normalizeOpenAIProtocol(model.protocol) !== 'responses' && (
                    <Field className={s.modelRowField} label="Thinking format">
                      <Combobox<PiAppThinkingFormat>
                        data-testid={testIds.appConfig.modelThinkingFormat}
                        options={thinkingFormatOptions}
                        value={normalizeThinkingFormat(model.thinkingFormat)}
                        width={20}
                        onChange={(option) => onChangeModelRow(index, { thinkingFormat: option.value })}
                      />
                    </Field>
                  )}
                </div>
              </div>
            ))}
            <div>
              <Button
                data-testid={testIds.appConfig.modelAdd}
                icon="plus"
                size="sm"
                type="button"
                variant="secondary"
                onClick={onAddModel}
              >
                Add model
              </Button>
            </div>
          </div>
        </Field>

        <Field
          label="System prompt addendum"
          description="Optional central instructions appended after the built-in guardrails. Do not include secrets."
          className={s.marginTop}
        >
          <TextArea
            className={s.promptTextArea}
            data-testid={testIds.appConfig.systemPromptAddendum}
            id="system-prompt-addendum"
            rows={8}
            value={state.systemPromptAddendum}
            placeholder="Prefer concise incident summaries. Mention dashboard changes explicitly."
            onChange={onChangeSystemPromptAddendum}
          />
        </Field>

        <Field
          label="Allowed Prometheus datasources"
          description="Leave empty to allow all Prometheus datasources visible to the current Grafana user. Select datasources to restrict assistant discovery and queries."
          className={s.marginTop}
        >
          <MultiCombobox
            width={60}
            id="allowed-prometheus-datasource-uids"
            data-testid={testIds.appConfig.allowedPrometheusDatasourceUids}
            options={datasourceOptions}
            value={state.allowedPrometheusDatasourceUids}
            placeholder="All visible Prometheus datasources"
            isClearable
            onChange={onChangeAllowedDatasourceUids}
          />
        </Field>
      </FieldSet>

      <FieldSet label="Custom skills" className={s.marginTopXl}>
        <CustomSkillsEditor
          value={state.customSkills}
          issues={customSkillIssues}
          error={customSkillsError}
          onChange={onChangeCustomSkills}
        />
      </FieldSet>

      <div className={s.marginTop}>
        <Button type="submit" data-testid={testIds.appConfig.submit} disabled={isSubmitDisabled}>
          Save LLM settings
        </Button>
      </div>
    </form>
  );
};

export default AppConfig;

const getStyles = (theme: GrafanaTheme2) => ({
  colorWeak: css`
    color: ${theme.colors.text.secondary};
  `,
  marginTop: css`
    margin-top: ${theme.spacing(3)};
  `,
  marginTopXl: css`
    margin-top: ${theme.spacing(6)};
  `,
  promptTextArea: css`
    max-width: 640px;
    width: 100%;
  `,
  allowedUsersTextArea: css`
    max-width: 640px;
    width: 100%;
    font-family: ${theme.typography.fontFamilyMonospace};
  `,
  modelList: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1)};
    max-width: 760px;
  `,
  modelRow: css`
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    padding: ${theme.spacing(1.5)};
  `,
  modelRowLine: css`
    display: flex;
    align-items: flex-end;
    flex-wrap: wrap;
    gap: ${theme.spacing(2)};
  `,
  modelRowField: css`
    margin-bottom: ${theme.spacing(1)};
  `,
  modelRowControls: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    margin-bottom: ${theme.spacing(1.5)};
  `,
});

const thinkingLevelOptions: Array<{ label: string; value: PiAppThinkingLevel; description: string }> = [
  { label: 'Off', value: 'off', description: 'Do not request model thinking.' },
  { label: 'Low', value: 'low', description: 'Small reasoning budget.' },
  { label: 'Medium', value: 'medium', description: 'Balanced reasoning budget.' },
  { label: 'High', value: 'high', description: 'Higher reasoning budget.' },
];

const openAIProtocolOptions: Array<{ label: string; value: PiAppOpenAIProtocol; description: string }> = [
  {
    label: 'Auto',
    value: 'auto',
    description: 'Use Chat Completions unless the provider explicitly requires Responses.',
  },
  { label: 'Responses', value: 'responses', description: 'Always use /responses.' },
  { label: 'Chat Completions', value: 'chat-completions', description: 'Always use /chat/completions.' },
];

const thinkingFormatOptions: Array<{ label: string; value: PiAppThinkingFormat; description: string }> = [
  { label: 'OpenAI', value: 'openai', description: 'Send reasoning_effort with Chat Completions.' },
  { label: 'Qwen', value: 'qwen', description: 'Send enable_thinking with Chat Completions.' },
  {
    label: 'Qwen template',
    value: 'qwen-chat-template',
    description: 'Send chat_template_kwargs.enable_thinking with Chat Completions.',
  },
];

const updatePluginAndReload = async (pluginId: string, data: Partial<PluginMeta<PiAppJsonData>>) => {
  try {
    await updatePlugin(pluginId, data);

    // Reloading the page as the changes made here wouldn't be propagated to the actual plugin otherwise.
    // This is not ideal, however unfortunately currently there is no supported way for updating the plugin state.
    locationService.reload();
  } catch (e) {
    console.error('Error while updating the plugin', e);
  }
};

const getPrometheusDatasourceOptions = (selectedUids: string[]): Array<ComboboxOption<string>> => {
  const options = getDataSourceSrv()
    .getList({ metrics: true, type: 'prometheus' })
    .filter((ds) => Boolean(ds.uid))
    .map((ds) => ({
      label: ds.name,
      value: ds.uid,
      description: `${ds.uid}${ds.isDefault ? ' (default)' : ''}`,
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
  const availableUids = new Set(options.map((option) => option.value));
  const missingOptions = selectedUids
    .filter((uid) => uid && !availableUids.has(uid))
    .map((uid) => ({
      label: uid,
      value: uid,
      description: 'Configured UID not visible in this session',
    }));

  return [...options, ...missingOptions];
};

const updatePlugin = async (pluginId: string, data: Partial<PluginMeta>) => {
  const response = getBackendSrv().fetch({
    url: `/api/plugins/${pluginId}/settings`,
    method: 'POST',
    data,
  });

  const dataResponse = await lastValueFrom(response);

  return dataResponse.data;
};
