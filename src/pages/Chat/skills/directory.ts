import type { Skill } from '../../../generated/api';
import { CUSTOM_SKILL_FILE_PREFIX, CUSTOM_SKILL_NAME_PATTERN, normalizeConfiguredSkillActivation } from './configured';
import type { BundledSkillResource, GrafanaSkill } from './types';

/**
 * Skills of the skills directory, valid as the backend checked them. They count as custom skills,
 * so a skill moved from jsonData to the directory keeps its file path and telemetry ID.
 */
export function getDirectoryGrafanaSkills(
  skills: readonly Skill[] | undefined,
  reservedNames: Iterable<string> = []
): GrafanaSkill[] {
  const taken = new Set(Array.from(reservedNames, (name) => name.toLowerCase()));
  const result: GrafanaSkill[] = [];

  for (const skill of skills ?? []) {
    if (!CUSTOM_SKILL_NAME_PATTERN.test(skill.name) || taken.has(skill.name)) {
      continue;
    }
    taken.add(skill.name);
    const resources: Record<string, BundledSkillResource> = {};
    for (const resource of skill.resources ?? []) {
      resources[resource.path] = {
        path: resource.path,
        content: resource.content,
        bytes: new TextEncoder().encode(resource.content).length,
      };
    }
    result.push({
      name: skill.name,
      description: skill.description,
      content: skill.content,
      filePath: `${CUSTOM_SKILL_FILE_PREFIX}/${skill.name}`,
      disableModelInvocation: skill.disableModelInvocation === true,
      resources,
      activation: normalizeConfiguredSkillActivation(skill.activation),
    });
  }

  return result;
}
