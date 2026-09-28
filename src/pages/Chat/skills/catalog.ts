import { BUNDLED_GRAFANA_SKILLS } from './bundledSkills.generated';
import { getConfiguredGrafanaSkills } from './configured';
import type { PiAppJsonData } from '../../../types';
import type { GrafanaSkill } from './types';

export const GRAFANA_SKILLS: readonly GrafanaSkill[] = BUNDLED_GRAFANA_SKILLS;

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
