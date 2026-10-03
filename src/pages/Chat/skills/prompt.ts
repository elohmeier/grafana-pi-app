import { BASE_SYSTEM_PROMPT } from '../systemPrompt';
import { GRAFANA_SKILLS } from './catalog';
import type { GrafanaSkill } from './types';

/** Virtual directory where the session filesystem mounts skills (see workspace/mounts.ts). */
export const SKILLS_ROOT = '/.agents/skills';

type RenderGrafanaSystemPromptOptions = {
  basePrompt?: string;
  skills?: readonly GrafanaSkill[];
  activeSkillNames?: readonly string[];
  liveDashboardEditingAvailable?: boolean;
  /** Whether the model accepts images; `false` adds that screenshots are only for the user. */
  imageInput?: boolean;
};

export function renderGrafanaSystemPrompt({
  basePrompt = BASE_SYSTEM_PROMPT,
  skills = GRAFANA_SKILLS,
  activeSkillNames = [],
  liveDashboardEditingAvailable,
  imageInput,
}: RenderGrafanaSystemPromptOptions = {}) {
  const activeSkillNameSet = new Set(activeSkillNames);
  const modelVisibleSkills = skills.filter((skill) => !skill.disableModelInvocation);
  const activeSkills = modelVisibleSkills.filter((skill) => activeSkillNameSet.has(skill.name));

  return [
    basePrompt.trim(),
    renderDashboardEditingCapability(liveDashboardEditingAvailable),
    imageInput === false ? TEXT_ONLY_MODEL : '',
    renderAvailableSkills(modelVisibleSkills),
    renderActiveSkills(activeSkills),
  ]
    .filter(Boolean)
    .join('\n\n');
}

const TEXT_ONLY_MODEL = `## Images
You cannot see images: screenshots (\`grafana-dashboard screenshot\`) are shown only to the user. Never describe what a screenshot shows; take values and times from queries (\`grafana-dashboard data\`, \`grafana-prom query\`).`;

function renderDashboardEditingCapability(liveDashboardEditingAvailable: boolean | undefined) {
  if (liveDashboardEditingAvailable === undefined) {
    return '';
  }

  if (liveDashboardEditingAvailable) {
    return `## Dashboard Editing Capability
Live dashboard editing is available for the dashboard open in the browser.
- /live/dashboard/dashboard.json is its unsaved state as a v2 dashboard resource. Edit it like a working copy (edit, jq, python3, \`grafana-dashboard label-filter\`), inspect it with \`grafana-dashboard inspect|data\`, and apply it with \`live apply\`. Live edits need no approval and are not saved; the user saves in Grafana.
- Change or add panels with \`grafana-dashboard set-panel\` and \`grafana-dashboard add-panel\` (titles, queries, units, types, positions) instead of hand-editing the v2 JSON.
- For a variable that filters panel queries, go straight to \`grafana-dashboard label-filter /live/dashboard/dashboard.json --label LABEL --variable-query 'label_values(METRIC, LABEL)' [--current VALUE]\` instead of writing the v2 variable by hand.
- Edits are not visible in the browser until \`live apply\` succeeds; it validates first, so run it once after the last edit instead of a separate validate.
- Read the file again after \`live apply\`: element names can be rekeyed. If apply reports that the dashboard changed in the browser, run \`live discard\`, read the file again, and redo the edit.
- Use /grafana/dashboards/<uid>/dashboard.json with workspace apply for durable saved changes, not for live edits to the current dashboard unless the user asks for that path.`;
  }

  return `## Dashboard Editing Capability
Live dashboard editing is not available in this plugin/runtime context.
- Do not claim that you can directly edit the currently open dashboard.
- For dashboard changes, stage them in /grafana/dashboards/<uid>/dashboard.json and apply them with workspace apply after user approval, or give clear manual edit guidance.`;
}

function renderAvailableSkills(skills: readonly GrafanaSkill[]) {
  if (skills.length === 0) {
    return '';
  }

  const rows = skills.map((skill) => `- ${skill.name}: ${skill.description} (${skillFilePath(skill)})`).join('\n');

  return `## Available Skills\n${rows}\n\nUse a skill when the user's request matches its description or when the user names it with $skill-name. Skills live in the session filesystem under ${SKILLS_ROOT}/<skill-name>/: read SKILL.md before applying a skill that is not active below, and read its references/templates with the read tool when needed.`;
}

function renderActiveSkills(skills: readonly GrafanaSkill[]) {
  if (skills.length === 0) {
    return '';
  }

  return ['## Active Skills', ...skills.map((skill) => renderSkill(skill))].join('\n\n');
}

function renderSkill(skill: GrafanaSkill) {
  const resources = Object.keys(skill.resources);
  const resourceList =
    resources.length > 0
      ? resources.map((resourcePath) => `- ${SKILLS_ROOT}/${skill.name}/${resourcePath}`).join('\n')
      : '- No bundled resources';

  return [`### ${skill.name}`, `Source: ${skillFilePath(skill)}`, 'Resources:', resourceList, skill.content].join('\n');
}

function skillFilePath(skill: GrafanaSkill) {
  return `${SKILLS_ROOT}/${skill.name}/SKILL.md`;
}
