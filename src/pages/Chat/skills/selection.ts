import { GRAFANA_SKILLS } from './catalog';
import type { GrafanaSkill, GrafanaSkillContext, GrafanaSkillSelection } from './types';

const DASHBOARD_INTENT =
  /\b(dashboard|dashboards|panel|panels|row|rows|variable|variables|jsonnet|render|save|sync|grafana view)\b/i;
const DASHBOARD_WRITE_INTENT =
  /\b(create|build|generate|make|add|update|edit|modify|change|save|sync|apply|render|write)\b[\s\S]{0,80}\b(dashboard|panel|jsonnet)\b/i;
const CONTEXTUAL_DASHBOARD_INTENT =
  /\b(this|current|here|visible|page|view|screen|it|panel|dashboard|query|empty|broken|noisy|misleading|rename|fix|change|update|edit|move|add|improve|troubleshoot|explain|summari[sz]e|why|what)\b/i;
const INVESTIGATION_INTENT =
  /\b(investigat(?:e|ion)|analy[sz](?:e|ing|is)|diagnos(?:e|is|tic)|root cause|why (?:is|are|did)|incident|outage|failure|failing|error spike|latency spike|degradation|regression|what'?s (?:wrong|causing))\b/i;
const ALERT_INTENT =
  /\b(alert(?:ing|s)?|alert rule|grafana-managed rule|firing|pending|normal state|warning state|no data|nodata|evaluation|silence|contact point|notification policy)\b/i;
const SKILL_REFERENCE = /\$([a-z0-9][a-z0-9-]{0,62}[a-z0-9])/gi;

export function selectGrafanaSkills(
  prompt: string,
  skills: readonly GrafanaSkill[] = GRAFANA_SKILLS,
  context?: GrafanaSkillContext
): GrafanaSkillSelection {
  const skillByName = new Map(skills.map((skill) => [skill.name, skill]));
  const explicitSkillNames = extractSkillReferences(prompt).filter((name) => skillByName.has(name));
  // A chat keeps its subject: "now filter by environment" after "build a dashboard" is still dashboard work.
  const activeNames = new Set<string>(
    (context?.previousPrompts ?? []).flatMap((previous) => selectGrafanaSkills(previous, skills).activeSkillNames)
  );

  for (const skillName of explicitSkillNames) {
    activeNames.add(skillName);
  }

  if (
    (shouldActivateDashboardSkill(prompt) || shouldActivateDashboardSkillFromContext(prompt, context)) &&
    skillByName.has('grafana-dashboard')
  ) {
    activeNames.add('grafana-dashboard');
  }

  if (INVESTIGATION_INTENT.test(prompt) && skillByName.has('investigation')) {
    activeNames.add('investigation');
  }

  if (shouldActivateAlertingSkill(prompt, context) && skillByName.has('grafana-alerting')) {
    activeNames.add('grafana-alerting');
  }

  for (const skill of skills) {
    if (!activeNames.has(skill.name) && shouldActivateConfiguredSkill(prompt, skill)) {
      activeNames.add(skill.name);
    }
  }

  const activeSkills = [...activeNames].map((name) => skillByName.get(name)).filter(isSkill);
  return {
    activeSkills,
    activeSkillNames: activeSkills.map((skill) => skill.name),
    explicitSkillNames,
  };
}

export function extractSkillReferences(prompt: string): string[] {
  const names = new Set<string>();

  for (const match of prompt.matchAll(SKILL_REFERENCE)) {
    names.add(match[1].toLowerCase());
  }

  return [...names];
}

function shouldActivateDashboardSkill(prompt: string) {
  return DASHBOARD_INTENT.test(prompt) || DASHBOARD_WRITE_INTENT.test(prompt);
}

function shouldActivateDashboardSkillFromContext(prompt: string, context: GrafanaSkillContext | undefined) {
  return Boolean(
    prompt.trim() &&
    context?.hasDashboardContext &&
    context.pageType === 'dashboard' &&
    CONTEXTUAL_DASHBOARD_INTENT.test(prompt)
  );
}

function shouldActivateAlertingSkill(prompt: string, context: GrafanaSkillContext | undefined) {
  return ALERT_INTENT.test(prompt) || Boolean(context?.hasPanelContext && /\b(firing|warning|alert)\b/i.test(prompt));
}

function shouldActivateConfiguredSkill(prompt: string, skill: GrafanaSkill) {
  const activation = skill.activation;

  if (!activation || activation.explicitOnly) {
    return false;
  }

  const lowerPrompt = prompt.toLowerCase();

  if (activation.keywords?.some((keyword) => lowerPrompt.includes(keyword.toLowerCase()))) {
    return true;
  }

  if (activation.regex) {
    try {
      return new RegExp(activation.regex, 'i').test(prompt);
    } catch {
      return false;
    }
  }

  return false;
}

function isSkill(skill: GrafanaSkill | undefined): skill is GrafanaSkill {
  return Boolean(skill);
}
