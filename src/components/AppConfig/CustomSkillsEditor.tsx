import React, { ChangeEvent, useMemo, useState } from 'react';
import { css, cx } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import {
  Alert,
  Badge,
  Button,
  CodeEditor,
  Drawer,
  Field,
  IconButton,
  InlineSwitch,
  Input,
  Stack,
  TagsInput,
  TextArea,
  useStyles2,
} from '@grafana/ui';

import type { PiAppCustomSkill, PiAppCustomSkillActivation, PiAppCustomSkillResource } from '../../types';
import { CUSTOM_SKILL_CONFIG_LIMITS, parseCustomSkillsJson } from '../../pages/Chat/skills/configured';
import { GRAFANA_SKILLS } from '../../pages/Chat/skills/catalog';
import { testIds } from '../testIds';
import {
  createEmptyCustomSkill,
  formatCustomSkillValidationIssues,
  serializeCustomSkills,
  validateCustomSkillsForEditor,
  type CustomSkillValidationIssue,
} from './customSkillsEditorModel';

type Props = {
  value: PiAppCustomSkill[];
  issues: CustomSkillValidationIssue[];
  error?: string;
  onChange: (value: PiAppCustomSkill[]) => void;
};

const RESERVED_SKILL_NAMES = GRAFANA_SKILLS.map((skill) => skill.name);

export function CustomSkillsEditor({ value, issues, error, onChange }: Props) {
  const s = useStyles2(getStyles);
  const [editingIndex, setEditingIndex] = useState<number | undefined>(undefined);
  const [jsonEditorOpen, setJsonEditorOpen] = useState(false);
  const [jsonDraft, setJsonDraft] = useState('');
  const [jsonError, setJsonError] = useState<string | undefined>(undefined);
  const editingSkill = editingIndex === undefined ? undefined : value[editingIndex];
  const editingIssues = useMemo(
    () => (editingIndex === undefined ? [] : issues.filter((issue) => issue.skillIndex === editingIndex)),
    [editingIndex, issues]
  );

  const addSkill = () => {
    const nextSkills = [...value, createEmptyCustomSkill(value)];
    onChange(nextSkills);
    setEditingIndex(nextSkills.length - 1);
  };

  const openJsonEditor = () => {
    setJsonDraft(formatCustomSkillsJson(value));
    setJsonError(undefined);
    setJsonEditorOpen(true);
  };

  const applyJsonEditor = () => {
    try {
      const parsed = parseCustomSkillsJson(jsonDraft);
      const parsedIssues = validateCustomSkillsForEditor(parsed, { reservedNames: RESERVED_SKILL_NAMES });

      if (parsedIssues.length > 0) {
        setJsonError(formatCustomSkillValidationIssues(parsedIssues));
        return;
      }

      onChange(parsed);
      setJsonEditorOpen(false);
    } catch (err) {
      setJsonError(err instanceof Error ? err.message : String(err));
    }
  };

  const updateSkill = (index: number, nextSkill: PiAppCustomSkill) => {
    onChange(value.map((skill, skillIndex) => (skillIndex === index ? nextSkill : skill)));
  };

  const removeSkill = (index: number) => {
    onChange(value.filter((_, skillIndex) => skillIndex !== index));
    setEditingIndex((current) => (current === index ? undefined : current));
  };

  return (
    <div data-testid={testIds.appConfig.customSkillsEditor}>
      <div className={s.toolbar}>
        <div>
          <div className={s.summary}>
            {value.length} custom {value.length === 1 ? 'skill' : 'skills'} configured
          </div>
          <div className={s.helpText}>Custom skills are stored in jsonData and are sent to the configured LLM.</div>
        </div>
        <Stack direction="row" gap={1}>
          <Button
            type="button"
            variant="secondary"
            icon="brackets-curly"
            onClick={openJsonEditor}
            data-testid={testIds.appConfig.customSkillsJsonOpen}
          >
            Edit JSON
          </Button>
          <Button
            type="button"
            variant="secondary"
            icon="plus"
            onClick={addSkill}
            disabled={value.length >= CUSTOM_SKILL_CONFIG_LIMITS.maxSkills}
            data-testid={testIds.appConfig.customSkillAdd}
          >
            Add skill
          </Button>
        </Stack>
      </div>

      {error && (
        <Alert severity="error" title="Custom skills need attention" className={s.marginTop}>
          {error}
        </Alert>
      )}

      {value.length === 0 ? (
        <div className={s.emptyState}>No custom skills configured.</div>
      ) : (
        <div className={s.skillList}>
          {value.map((skill, index) => {
            const skillIssues = issues.filter((issue) => issue.skillIndex === index);
            const hasIssues = skillIssues.length > 0;

            return (
              <div
                className={cx(s.skillRow, hasIssues && s.skillRowInvalid)}
                key={`${skill.name ?? 'skill'}-${index}`}
                data-testid={testIds.appConfig.customSkillRow}
              >
                <div className={s.skillMain}>
                  <Stack direction="row" gap={1} alignItems="center" wrap>
                    <strong>{readSkillName(skill, index)}</strong>
                    <Badge
                      text={skill.enabled === false ? 'Disabled' : 'Enabled'}
                      color={skill.enabled === false ? 'darkgrey' : 'green'}
                    />
                    {hasIssues && (
                      <Badge text={`${skillIssues.length} issue${skillIssues.length === 1 ? '' : 's'}`} color="red" />
                    )}
                    <Badge text={activationSummary(skill.activation)} color="blue" />
                  </Stack>
                  <div className={s.skillDescription}>{skill.description || 'No description yet.'}</div>
                  <div className={s.badgeList}>
                    {skill.resources && skill.resources.length > 0 && (
                      <Badge
                        text={`${skill.resources.length} resource${skill.resources.length === 1 ? '' : 's'}`}
                        color="orange"
                      />
                    )}
                  </div>
                </div>
                <div className={s.rowActions}>
                  <IconButton
                    name="pen"
                    tooltip="Edit skill"
                    onClick={() => setEditingIndex(index)}
                    data-testid={testIds.appConfig.customSkillEdit}
                  />
                  <IconButton
                    name="trash-alt"
                    tooltip="Delete skill"
                    variant="destructive"
                    onClick={() => removeSkill(index)}
                    data-testid={testIds.appConfig.customSkillDelete}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {editingSkill && editingIndex !== undefined && (
        <SkillEditorDrawer
          skill={editingSkill}
          index={editingIndex}
          issues={editingIssues}
          onChange={(nextSkill) => updateSkill(editingIndex, nextSkill)}
          onClose={() => setEditingIndex(undefined)}
        />
      )}

      {jsonEditorOpen && (
        <Drawer title="Edit custom skills JSON" size="lg" onClose={() => setJsonEditorOpen(false)}>
          <div className={s.drawerContent}>
            <Alert severity="info" title="Raw JSON editor">
              Use this for bulk import or copy/paste. The structured editor uses the same saved jsonData.customSkills
              schema.
            </Alert>
            {jsonError && (
              <Alert severity="error" title="JSON cannot be applied">
                {jsonError}
              </Alert>
            )}
            <Field label="Custom skills JSON" invalid={Boolean(jsonError)} error={jsonError}>
              <TextArea
                className={s.jsonTextArea}
                data-testid={testIds.appConfig.customSkillsJson}
                rows={20}
                value={jsonDraft}
                onChange={(event) => {
                  setJsonDraft(event.currentTarget.value);
                  setJsonError(undefined);
                }}
              />
            </Field>
            <Stack direction="row" gap={1}>
              <Button type="button" variant="primary" icon="check" onClick={applyJsonEditor}>
                Apply JSON
              </Button>
              <Button type="button" variant="secondary" fill="outline" onClick={() => setJsonEditorOpen(false)}>
                Cancel
              </Button>
            </Stack>
          </div>
        </Drawer>
      )}
    </div>
  );
}

type SkillEditorDrawerProps = {
  skill: PiAppCustomSkill;
  index: number;
  issues: CustomSkillValidationIssue[];
  onChange: (skill: PiAppCustomSkill) => void;
  onClose: () => void;
};

function SkillEditorDrawer({ skill, issues, onChange, onClose }: SkillEditorDrawerProps) {
  const s = useStyles2(getStyles);
  const autoActivationEnabled = isAutoActivationEnabled(skill.activation);
  const resources = skill.resources ?? [];
  const issueSummary = formatCustomSkillValidationIssues(issues);

  return (
    <Drawer
      title={readSkillName(skill)}
      subtitle="Configure an instance-specific assistant skill."
      size="lg"
      onClose={onClose}
    >
      <div className={s.drawerContent}>
        {issueSummary && (
          <Alert severity="error" title="Fix this skill before saving">
            {issueSummary}
          </Alert>
        )}

        <Field label="Enabled" description="Disabled skills stay in configuration but are ignored at runtime.">
          <InlineSwitch
            value={skill.enabled !== false}
            label={skill.enabled === false ? 'Disabled' : 'Enabled'}
            showLabel
            onChange={(event) => onChange({ ...skill, enabled: event.currentTarget.checked })}
          />
        </Field>

        <Field
          label="Name"
          description="Users can activate the skill with $skill-name."
          invalid={hasFieldIssue(issues, 'name')}
          error={firstFieldIssue(issues, 'name')}
          required
        >
          <Input
            value={skill.name ?? ''}
            placeholder="team-runbook"
            data-testid={testIds.appConfig.customSkillName}
            onChange={(event: ChangeEvent<HTMLInputElement>) => onChange({ ...skill, name: event.currentTarget.value })}
          />
        </Field>

        <Field
          label="Description"
          description="Shown to the model in the available skills list."
          invalid={hasFieldIssue(issues, 'description')}
          error={firstFieldIssue(issues, 'description')}
          required
        >
          <Input
            value={skill.description ?? ''}
            placeholder="Use the team incident workflow and dashboard conventions."
            data-testid={testIds.appConfig.customSkillDescription}
            onChange={(event: ChangeEvent<HTMLInputElement>) =>
              onChange({ ...skill, description: event.currentTarget.value })
            }
          />
        </Field>

        <Field
          label="Instructions"
          description={`Markdown sent when the skill is active. Maximum ${CUSTOM_SKILL_CONFIG_LIMITS.maxSkillContentLength} characters.`}
          invalid={hasFieldIssue(issues, 'content')}
          error={firstFieldIssue(issues, 'content')}
          required
        >
          <div data-testid={testIds.appConfig.customSkillContent}>
            <CodeEditor
              value={skill.content ?? ''}
              language="markdown"
              height="260px"
              width="100%"
              showLineNumbers
              showMiniMap={false}
              wordWrap
              onChange={(content) => onChange({ ...skill, content })}
            />
          </div>
        </Field>

        <Field
          label="Automatic activation"
          description="Explicit $skill-name activation always works. Enable this only for predictable keywords or regexes."
          invalid={hasFieldIssue(issues, 'activation')}
          error={firstFieldIssue(issues, 'activation')}
        >
          <InlineSwitch
            value={autoActivationEnabled}
            label={autoActivationEnabled ? 'Automatic activation on' : 'Explicit only'}
            showLabel
            onChange={(event) =>
              onChange({
                ...skill,
                activation: {
                  ...(skill.activation ?? {}),
                  explicitOnly: !event.currentTarget.checked,
                },
              })
            }
          />
        </Field>

        {autoActivationEnabled && (
          <>
            <Field label="Keywords" description="Case-insensitive prompt fragments that activate this skill.">
              <div data-testid={testIds.appConfig.customSkillKeywords}>
                <TagsInput
                  tags={skill.activation?.keywords ?? []}
                  addOnBlur
                  placeholder="incident"
                  onChange={(keywords) =>
                    onChange({
                      ...skill,
                      activation: {
                        ...(skill.activation ?? {}),
                        explicitOnly: false,
                        keywords,
                      },
                    })
                  }
                />
              </div>
            </Field>

            <Field label="Regex" description="Optional JavaScript regular expression matched case-insensitively.">
              <Input
                value={skill.activation?.regex ?? ''}
                placeholder="incident|paging|latency"
                data-testid={testIds.appConfig.customSkillRegex}
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  onChange({
                    ...skill,
                    activation: {
                      ...(skill.activation ?? {}),
                      explicitOnly: false,
                      regex: event.currentTarget.value,
                    },
                  })
                }
              />
            </Field>
          </>
        )}

        <div className={s.helpText}>
          The assistant always has the same tools; skills only add instructions and resources.
        </div>

        <Field
          label="Do not send instructions to model"
          description="Advanced: keep the skill out of the system prompt while preserving its configured resources."
        >
          <InlineSwitch
            value={skill.disableModelInvocation === true}
            label={skill.disableModelInvocation === true ? 'Hidden from model prompt' : 'Visible in model prompt'}
            showLabel
            onChange={(event) => onChange({ ...skill, disableModelInvocation: event.currentTarget.checked })}
          />
        </Field>

        <div className={s.resourcesHeader}>
          <div>
            <h4 className={s.sectionHeading}>Resources</h4>
            <div className={s.helpText}>
              Optional text files the assistant can read under /.agents/skills/&lt;skill-name&gt;/ in its session
              filesystem.
            </div>
          </div>
          <Button
            type="button"
            variant="secondary"
            icon="plus"
            onClick={() => onChange({ ...skill, resources: [...resources, createEmptyResource(resources)] })}
            disabled={resources.length >= CUSTOM_SKILL_CONFIG_LIMITS.maxResources}
            data-testid={testIds.appConfig.customSkillResourceAdd}
          >
            Add resource
          </Button>
        </div>

        {resources.length === 0 ? (
          <div className={s.emptyState}>No resources configured.</div>
        ) : (
          <div className={s.resourceList}>
            {resources.map((resource, resourceIndex) => {
              const resourceIssues = issues.filter((issue) => issue.resourceIndex === resourceIndex);

              return (
                <ResourceEditor
                  key={`${resource.path ?? 'resource'}-${resourceIndex}`}
                  resource={resource}
                  index={resourceIndex}
                  issues={resourceIssues}
                  onChange={(nextResource) =>
                    onChange({
                      ...skill,
                      resources: resources.map((item, index) => (index === resourceIndex ? nextResource : item)),
                    })
                  }
                  onRemove={() =>
                    onChange({
                      ...skill,
                      resources: resources.filter((_, index) => index !== resourceIndex),
                    })
                  }
                />
              );
            })}
          </div>
        )}

        <Stack direction="row" gap={1}>
          <Button type="button" variant="primary" icon="check" onClick={onClose}>
            Done
          </Button>
        </Stack>
      </div>
    </Drawer>
  );
}

type ResourceEditorProps = {
  resource: PiAppCustomSkillResource;
  index: number;
  issues: CustomSkillValidationIssue[];
  onChange: (resource: PiAppCustomSkillResource) => void;
  onRemove: () => void;
};

function ResourceEditor({ resource, index, issues, onChange, onRemove }: ResourceEditorProps) {
  const s = useStyles2(getStyles);
  const issue = formatCustomSkillValidationIssues(issues);

  return (
    <div className={cx(s.resourceRow, issue && s.resourceRowInvalid)}>
      <div className={s.resourceTitleRow}>
        <strong>Resource {index + 1}</strong>
        <IconButton name="trash-alt" tooltip="Delete resource" variant="destructive" onClick={onRemove} />
      </div>
      {issue && (
        <Alert severity="error" title="Resource needs attention">
          {issue}
        </Alert>
      )}
      <Field label="Path" description="Relative path, for example references/team-runbook.md.">
        <Input
          value={resource.path ?? ''}
          placeholder="references/team-runbook.md"
          data-testid={testIds.appConfig.customSkillResourcePath}
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            onChange({ ...resource, path: event.currentTarget.value })
          }
        />
      </Field>
      <Field label="Content">
        <TextArea
          rows={7}
          className={s.resourceContent}
          value={resource.content ?? ''}
          data-testid={testIds.appConfig.customSkillResourceContent}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
            onChange({ ...resource, content: event.currentTarget.value })
          }
        />
      </Field>
    </div>
  );
}

function activationSummary(activation: PiAppCustomSkillActivation | undefined) {
  if (!isAutoActivationEnabled(activation)) {
    return 'Explicit only';
  }

  if (!activation) {
    return 'Explicit only';
  }

  const keywordCount = activation.keywords?.filter((keyword) => keyword.trim()).length ?? 0;
  const hasRegex = Boolean(activation.regex?.trim());

  if (keywordCount > 0 && hasRegex) {
    return `${keywordCount} keywords + regex`;
  }

  if (keywordCount > 0) {
    return `${keywordCount} keyword${keywordCount === 1 ? '' : 's'}`;
  }

  if (hasRegex) {
    return 'Regex';
  }

  return 'Auto activation';
}

function isAutoActivationEnabled(activation: PiAppCustomSkillActivation | undefined) {
  if (!activation) {
    return false;
  }

  if (typeof activation.explicitOnly === 'boolean') {
    return !activation.explicitOnly;
  }

  return Boolean(activation.keywords?.some((keyword) => keyword.trim()) || activation.regex?.trim());
}

function hasFieldIssue(issues: readonly CustomSkillValidationIssue[], field: CustomSkillValidationIssue['field']) {
  return issues.some((issue) => issue.field === field);
}

function firstFieldIssue(issues: readonly CustomSkillValidationIssue[], field: CustomSkillValidationIssue['field']) {
  return issues.find((issue) => issue.field === field)?.message;
}

function readSkillName(skill: PiAppCustomSkill, index?: number) {
  const name = skill.name?.trim();
  return name || (index === undefined ? 'New skill' : `Skill ${index + 1}`);
}

function createEmptyResource(resources: readonly PiAppCustomSkillResource[]): PiAppCustomSkillResource {
  const existingPaths = new Set(resources.map((resource) => resource.path));
  const base = 'references/resource.md';

  if (!existingPaths.has(base)) {
    return { path: base, content: '' };
  }

  for (let index = 2; index < CUSTOM_SKILL_CONFIG_LIMITS.maxResources + 10; index += 1) {
    const candidate = `references/resource-${index}.md`;
    if (!existingPaths.has(candidate)) {
      return { path: candidate, content: '' };
    }
  }

  return { path: `references/resource-${Date.now()}.md`, content: '' };
}

function formatCustomSkillsJson(customSkills: readonly PiAppCustomSkill[]) {
  return JSON.stringify(serializeCustomSkills(customSkills), null, 2);
}

const getStyles = (theme: GrafanaTheme2) => ({
  toolbar: css`
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: ${theme.spacing(2)};
    max-width: 980px;
  `,
  summary: css`
    color: ${theme.colors.text.primary};
    font-weight: ${theme.typography.fontWeightMedium};
  `,
  helpText: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
    line-height: ${theme.typography.bodySmall.lineHeight};
  `,
  marginTop: css`
    margin-top: ${theme.spacing(2)};
  `,
  emptyState: css`
    border: 1px dashed ${theme.colors.border.medium};
    border-radius: ${theme.shape.radius.default};
    color: ${theme.colors.text.secondary};
    margin-top: ${theme.spacing(2)};
    max-width: 980px;
    padding: ${theme.spacing(2)};
  `,
  skillList: css`
    display: grid;
    gap: ${theme.spacing(1)};
    margin-top: ${theme.spacing(2)};
    max-width: 980px;
  `,
  skillRow: css`
    align-items: flex-start;
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    display: grid;
    gap: ${theme.spacing(2)};
    grid-template-columns: minmax(0, 1fr) auto;
    padding: ${theme.spacing(2)};
  `,
  skillRowInvalid: css`
    border-color: ${theme.colors.error.border};
  `,
  skillMain: css`
    min-width: 0;
  `,
  skillDescription: css`
    color: ${theme.colors.text.secondary};
    margin-top: ${theme.spacing(0.75)};
    overflow-wrap: anywhere;
  `,
  badgeList: css`
    display: flex;
    flex-wrap: wrap;
    gap: ${theme.spacing(0.5)};
    margin-top: ${theme.spacing(1)};
  `,
  rowActions: css`
    display: flex;
    gap: ${theme.spacing(0.5)};
  `,
  drawerContent: css`
    display: grid;
    gap: ${theme.spacing(3)};
  `,
  sectionHeading: css`
    font-size: ${theme.typography.h4.fontSize};
    line-height: ${theme.typography.h4.lineHeight};
    margin: 0;
  `,
  resourcesHeader: css`
    align-items: flex-start;
    display: flex;
    justify-content: space-between;
    gap: ${theme.spacing(2)};
  `,
  resourceList: css`
    display: grid;
    gap: ${theme.spacing(2)};
  `,
  resourceRow: css`
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    display: grid;
    gap: ${theme.spacing(2)};
    padding: ${theme.spacing(2)};
  `,
  resourceRowInvalid: css`
    border-color: ${theme.colors.error.border};
  `,
  resourceTitleRow: css`
    align-items: center;
    display: flex;
    justify-content: space-between;
    gap: ${theme.spacing(2)};
  `,
  resourceContent: css`
    font-family: ${theme.typography.fontFamilyMonospace};
    width: 100%;
  `,
  jsonTextArea: css`
    font-family: ${theme.typography.fontFamilyMonospace};
    width: 100%;
  `,
});
