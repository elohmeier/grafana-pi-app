import { BUNDLED_GRAFANA_SKILLS } from './bundledSkills.generated';
import { getConfiguredGrafanaSkills } from './configured';
import type { PiAppJsonData } from '../../../types';
import type { GrafanaSkill, SkillToolGroup } from './types';

const TOOL_GROUPS_BY_SKILL: Record<string, readonly SkillToolGroup[]> = {
  'grafana-alerting': ['alerts', 'dashboardRead', 'dashboardMetricContext', 'metrics', 'skillResources'],
  'grafana-dashboard': ['dashboardMetricContext', 'dashboardRead', 'liveDashboardEditing', 'skillResources'],
  investigation: ['metrics', 'dashboardMetricContext', 'investigation', 'skillResources'],
};

export const GRAFANA_SKILLS: readonly GrafanaSkill[] = BUNDLED_GRAFANA_SKILLS.map((skill) => ({
  ...skill,
  toolGroups: TOOL_GROUPS_BY_SKILL[skill.name] ?? ['skillResources'],
}));

export function getGrafanaSkill(name: string, skills: readonly GrafanaSkill[] = GRAFANA_SKILLS) {
  return skills.find((skill) => skill.name === name);
}

export function getGrafanaSkills(
  jsonData?: Pick<PiAppJsonData, 'customSkills'>,
  bundledSkills: readonly GrafanaSkill[] = GRAFANA_SKILLS
) {
  const bundledNames = bundledSkills.map((skill) => skill.name);

  return [...bundledSkills, ...getConfiguredGrafanaSkills(jsonData, { reservedNames: bundledNames })];
}
