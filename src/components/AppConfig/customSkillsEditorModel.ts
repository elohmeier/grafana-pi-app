import type { PiAppCustomSkill, PiAppCustomSkillResource } from '../../types';
import {
  CONFIGURABLE_SKILL_TOOL_GROUPS,
  CUSTOM_SKILL_CONFIG_LIMITS,
  LEGACY_SKILL_TOOL_GROUPS,
  CUSTOM_SKILL_NAME_PATTERN,
  isValidCustomSkillRegex,
  isValidCustomSkillResourcePath,
} from '../../pages/Chat/skills/configured';

type ValidationOptions = {
  reservedNames?: Iterable<string>;
};

export type CustomSkillValidationIssue = {
  message: string;
  field?: 'name' | 'description' | 'content' | 'activation' | 'toolGroups' | 'resources';
  skillIndex?: number;
  resourceIndex?: number;
};

const DEFAULT_TOOL_GROUP = 'skillResources';
// Tool groups no longer select tools; the field is kept so existing configs round-trip unchanged.
const KNOWN_TOOL_GROUP_SET = new Set<string>([...CONFIGURABLE_SKILL_TOOL_GROUPS, ...LEGACY_SKILL_TOOL_GROUPS]);

export function createEmptyCustomSkill(existingSkills: readonly PiAppCustomSkill[]): PiAppCustomSkill {
  return {
    name: nextUniqueSkillName(existingSkills),
    description: '',
    content: '',
    enabled: true,
    activation: {
      explicitOnly: true,
    },
    toolGroups: [DEFAULT_TOOL_GROUP],
    resources: [],
  };
}

export function serializeCustomSkills(customSkills: readonly PiAppCustomSkill[]): PiAppCustomSkill[] {
  return customSkills.map((skill) => {
    const serialized: PiAppCustomSkill = {
      name: readString(skill.name).trim().toLowerCase(),
      description: readString(skill.description).trim(),
      content: readString(skill.content).trimEnd(),
      activation: serializeActivation(skill),
      toolGroups: serializeToolGroups(skill.toolGroups),
    };

    if (skill.enabled === false) {
      serialized.enabled = false;
    }

    if (skill.disableModelInvocation === true) {
      serialized.disableModelInvocation = true;
    }

    const resources = serializeResources(skill.resources);
    if (resources.length > 0) {
      serialized.resources = resources;
    }

    return serialized;
  });
}

export function validateCustomSkillsForEditor(
  customSkills: readonly PiAppCustomSkill[],
  options: ValidationOptions = {}
): CustomSkillValidationIssue[] {
  const issues: CustomSkillValidationIssue[] = [];
  const names = new Set<string>();
  const reservedNames = new Set(Array.from(options.reservedNames ?? []).map((name) => name.toLowerCase()));

  if (customSkills.length > CUSTOM_SKILL_CONFIG_LIMITS.maxSkills) {
    issues.push({
      message: `Custom skills can contain at most ${CUSTOM_SKILL_CONFIG_LIMITS.maxSkills} skills.`,
    });
  }

  customSkills.forEach((skill, skillIndex) => {
    validateSkillName(skill, skillIndex, names, reservedNames, issues);
    validateSkillDescription(skill, skillIndex, issues);
    validateSkillContent(skill, skillIndex, issues);
    validateSkillActivation(skill, skillIndex, issues);
    validateSkillToolGroups(skill, skillIndex, issues);
    validateSkillResources(skill, skillIndex, issues);
  });

  return issues;
}

export function formatCustomSkillValidationIssues(issues: readonly CustomSkillValidationIssue[]) {
  if (issues.length === 0) {
    return undefined;
  }

  return issues
    .slice(0, 3)
    .map((issue) => issue.message)
    .join(' ');
}

function validateSkillName(
  skill: PiAppCustomSkill,
  skillIndex: number,
  names: Set<string>,
  reservedNames: Set<string>,
  issues: CustomSkillValidationIssue[]
) {
  const name = readString(skill.name).trim().toLowerCase();
  const label = skillLabel(skillIndex);

  if (!CUSTOM_SKILL_NAME_PATTERN.test(name)) {
    issues.push({ skillIndex, field: 'name', message: `${label} name must be kebab-case and 2-64 characters.` });
    return;
  }

  if (reservedNames.has(name)) {
    issues.push({ skillIndex, field: 'name', message: `${label} name is reserved by a bundled skill.` });
    return;
  }

  if (names.has(name)) {
    issues.push({ skillIndex, field: 'name', message: `${label} name duplicates another custom skill.` });
    return;
  }

  names.add(name);
}

function validateSkillDescription(skill: PiAppCustomSkill, skillIndex: number, issues: CustomSkillValidationIssue[]) {
  const description = readString(skill.description);
  const label = skillLabel(skillIndex);

  if (description.trim().length === 0) {
    issues.push({ skillIndex, field: 'description', message: `${label} description is required.` });
  } else if (description.length > 1024) {
    issues.push({
      skillIndex,
      field: 'description',
      message: `${label} description must be 1024 characters or fewer.`,
    });
  }
}

function validateSkillContent(skill: PiAppCustomSkill, skillIndex: number, issues: CustomSkillValidationIssue[]) {
  const content = readString(skill.content);
  const label = skillLabel(skillIndex);

  if (content.trim().length === 0) {
    issues.push({ skillIndex, field: 'content', message: `${label} instructions are required.` });
  } else if (content.length > CUSTOM_SKILL_CONFIG_LIMITS.maxSkillContentLength) {
    issues.push({
      skillIndex,
      field: 'content',
      message: `${label} instructions must be ${CUSTOM_SKILL_CONFIG_LIMITS.maxSkillContentLength} characters or fewer.`,
    });
  }
}

function validateSkillActivation(skill: PiAppCustomSkill, skillIndex: number, issues: CustomSkillValidationIssue[]) {
  const activation = skill.activation;
  const label = skillLabel(skillIndex);

  if (!activation) {
    return;
  }

  if (activation.keywords?.some((keyword) => typeof keyword !== 'string' || keyword.trim().length === 0)) {
    issues.push({
      skillIndex,
      field: 'activation',
      message: `${label} activation keywords must contain non-empty strings.`,
    });
  }

  const regex = readString(activation.regex).trim();
  if (regex && !isValidCustomSkillRegex(regex)) {
    issues.push({
      skillIndex,
      field: 'activation',
      message: `${label} activation regex must be a valid JavaScript regular expression.`,
    });
  }
}

function validateSkillToolGroups(skill: PiAppCustomSkill, skillIndex: number, issues: CustomSkillValidationIssue[]) {
  const label = skillLabel(skillIndex);

  for (const group of skill.toolGroups ?? []) {
    if (typeof group !== 'string' || !KNOWN_TOOL_GROUP_SET.has(group)) {
      issues.push({
        skillIndex,
        field: 'toolGroups',
        message: `${label} has unsupported tool group ${JSON.stringify(group)}.`,
      });
    }
  }
}

function validateSkillResources(skill: PiAppCustomSkill, skillIndex: number, issues: CustomSkillValidationIssue[]) {
  const resources = skill.resources ?? [];
  const seenPaths = new Set<string>();
  const label = skillLabel(skillIndex);

  if (resources.length > CUSTOM_SKILL_CONFIG_LIMITS.maxResources) {
    issues.push({
      skillIndex,
      field: 'resources',
      message: `${label} resources can contain at most ${CUSTOM_SKILL_CONFIG_LIMITS.maxResources} resources.`,
    });
  }

  resources.forEach((resource, resourceIndex) => {
    const path = readString(resource.path).trim();
    const content = readString(resource.content);
    const resourceLabel = `${label} resource ${resourceIndex + 1}`;

    if (!isValidCustomSkillResourcePath(path)) {
      issues.push({
        skillIndex,
        resourceIndex,
        field: 'resources',
        message: `${resourceLabel} path must be a relative path without .. segments.`,
      });
    } else if (seenPaths.has(path)) {
      issues.push({
        skillIndex,
        resourceIndex,
        field: 'resources',
        message: `${resourceLabel} path duplicates another resource.`,
      });
    } else {
      seenPaths.add(path);
    }

    if (content.length === 0) {
      issues.push({ skillIndex, resourceIndex, field: 'resources', message: `${resourceLabel} content is required.` });
    } else if (content.length > CUSTOM_SKILL_CONFIG_LIMITS.maxResourceLength) {
      issues.push({
        skillIndex,
        resourceIndex,
        field: 'resources',
        message: `${resourceLabel} content must be ${CUSTOM_SKILL_CONFIG_LIMITS.maxResourceLength} characters or fewer.`,
      });
    }
  });
}

function serializeActivation(skill: PiAppCustomSkill) {
  const activation = skill.activation ?? {};
  const keywords = uniqueStrings(activation.keywords ?? []);
  const regex = readString(activation.regex).trim();
  const hasAutoActivation = keywords.length > 0 || Boolean(regex);
  const explicitOnly = typeof activation.explicitOnly === 'boolean' ? activation.explicitOnly : !hasAutoActivation;

  return {
    explicitOnly,
    ...(keywords.length > 0 ? { keywords } : {}),
    ...(!explicitOnly && regex ? { regex } : {}),
  };
}

function serializeToolGroups(value: PiAppCustomSkill['toolGroups']) {
  const groups = uniqueStrings([DEFAULT_TOOL_GROUP, ...(value ?? [])]).filter((group) =>
    KNOWN_TOOL_GROUP_SET.has(group)
  );

  return groups.length > 0 ? groups : [DEFAULT_TOOL_GROUP];
}

function serializeResources(value: PiAppCustomSkill['resources']): PiAppCustomSkillResource[] {
  return (value ?? []).map((resource) => ({
    path: readString(resource.path).trim(),
    content: readString(resource.content).trimEnd(),
  }));
}

function nextUniqueSkillName(existingSkills: readonly PiAppCustomSkill[]) {
  const existingNames = new Set(existingSkills.map((skill) => readString(skill.name).trim().toLowerCase()));
  const base = 'new-skill';

  if (!existingNames.has(base)) {
    return base;
  }

  for (let index = 2; index < CUSTOM_SKILL_CONFIG_LIMITS.maxSkills + 10; index += 1) {
    const candidate = `${base}-${index}`;
    if (!existingNames.has(candidate)) {
      return candidate;
    }
  }

  return `${base}-${Date.now()}`;
}

function skillLabel(skillIndex: number) {
  return `Skill ${skillIndex + 1}`;
}

function uniqueStrings(values: readonly string[]) {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const value of values) {
    const trimmed = value.trim();

    if (!trimmed || seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    unique.push(trimmed);
  }

  return unique;
}

function readString(value: unknown) {
  return typeof value === 'string' ? value : '';
}
