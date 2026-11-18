import { BUNDLED_GRAFANA_SKILLS } from './bundledSkills.generated';
import { getConfiguredGrafanaSkills } from './configured';
import { getDirectoryGrafanaSkills } from './directory';
import type { Skill } from '../../../generated/api';
import type { PiAppJsonData } from '../../../types';
import type { GrafanaSkill } from './types';

export const GRAFANA_SKILLS: readonly GrafanaSkill[] = BUNDLED_GRAFANA_SKILLS;

export function getGrafanaSkill(name: string, skills: readonly GrafanaSkill[] = GRAFANA_SKILLS) {
  return skills.find((skill) => skill.name === name);
}

/**
 * Bundled skills, then the skills directory of the Grafana server, then the custom skills of jsonData.
 * An earlier skill wins over a later one of the same name.
 */
export function getGrafanaSkills(
  jsonData?: Pick<PiAppJsonData, 'customSkills'>,
  bundledSkills: readonly GrafanaSkill[] = GRAFANA_SKILLS,
  directorySkills: readonly Skill[] = []
) {
  const bundledNames = bundledSkills.map((skill) => skill.name);
  const fromDirectory = getDirectoryGrafanaSkills(directorySkills, bundledNames);

  return [
    ...bundledSkills,
    ...fromDirectory,
    ...getConfiguredGrafanaSkills(jsonData, {
      reservedNames: [...bundledNames, ...fromDirectory.map((skill) => skill.name)],
    }),
  ];
}
