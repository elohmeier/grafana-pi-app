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
};

export function renderGrafanaSystemPrompt({
  basePrompt = BASE_SYSTEM_PROMPT,
  skills = GRAFANA_SKILLS,
  activeSkillNames = [],
  liveDashboardEditingAvailable,
}: RenderGrafanaSystemPromptOptions = {}) {
  const activeSkillNameSet = new Set(activeSkillNames);
  const modelVisibleSkills = skills.filter((skill) => !skill.disableModelInvocation);
  const activeSkills = modelVisibleSkills.filter((skill) => activeSkillNameSet.has(skill.name));

  return [
    basePrompt.trim(),
    renderDashboardEditingCapability(liveDashboardEditingAvailable),
    renderAvailableSkills(modelVisibleSkills),
    renderActiveSkills(activeSkills),
  ]
    .filter(Boolean)
    .join('\n\n');
}

function renderDashboardEditingCapability(liveDashboardEditingAvailable: boolean | undefined) {
  if (liveDashboardEditingAvailable === undefined) {
    return '';
  }

  if (liveDashboardEditingAvailable) {
    return `## Dashboard Editing Capability
Live dashboard editing is available for the currently loaded dashboard.
- For on-the-fly panel or dashboard edits, prefer typed live tools such as rename_live_dashboard_panel, update_live_dashboard_panel_query, update_live_dashboard_panel_queries, apply_live_dashboard_prometheus_label_filter, add_live_dashboard_panel, move_or_resize_live_dashboard_panel, update_live_dashboard_settings, add_live_dashboard_variable, and update_live_dashboard_variable.
- Call list_live_dashboard_panels, get_live_dashboard_layout, get_live_dashboard_info, or list_live_dashboard_variables first when you need exact element names, layout paths, dashboard UID, or variable names.
- For many query edits with known replacements, use update_live_dashboard_panel_queries instead of repeated single-panel calls.
- For a dashboard-wide Prometheus variable and label filter, use apply_live_dashboard_prometheus_label_filter; it discovers, prevalidates, applies, and verifies the selected queries internally.
- For other multi-edit requests, keep an internal checklist of every requested edit and continue until all requested mutations and verification calls are complete.
- Verify the changed panel, layout, dashboard settings, or variable list after the requested mutation sequence.
- add_live_dashboard_panel and move_or_resize_live_dashboard_panel automatically attach screenshot verification when Grafana image rendering is configured.
- Use apply_live_dashboard_mutation only for advanced commands that do not have a typed tool.
- Use the session filesystem (dashboard.json working copies, the jsonnet command, workspace plan/apply) for durable saved changes, not for small live edits to the current dashboard unless the user asks for that path.`;
  }

  return `## Dashboard Editing Capability
Live dashboard editing is not available in this plugin/runtime context.
- Do not claim that you can directly edit the currently open dashboard.
- For dashboard changes, stage them in /grafana/dashboards/<uid>/dashboard.json and apply them with workspace plan/apply after user approval, or give clear manual edit guidance.`;
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
