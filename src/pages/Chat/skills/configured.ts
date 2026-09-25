import type { PiAppCustomSkill, PiAppJsonData } from '../../../types';
import type { BundledSkillResource, GrafanaSkill, GrafanaSkillActivation, SkillToolGroup } from './types';

export const CONFIGURABLE_SKILL_TOOL_GROUPS = [
  'metrics',
  'alerts',
  'dashboardMetricContext',
  'dashboardRead',
  'investigation',
  'skillResources',
] as const satisfies readonly SkillToolGroup[];

export const CUSTOM_SKILL_CONFIG_LIMITS = {
  maxSkills: 20,
  maxSkillContentLength: 20_000,
  maxResources: 20,
  maxResourceLength: 40_000,
  maxResourcePathLength: 256,
} as const;

export const CUSTOM_SKILL_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

const CONFIGURABLE_SKILL_TOOL_GROUP_SET = new Set<SkillToolGroup>(CONFIGURABLE_SKILL_TOOL_GROUPS);
/**
 * Retired groups whose tools moved into the always-available session
 * filesystem (read/write/edit/bash with the `jsonnet` command). Accepted so
 * existing configurations keep validating; they select nothing.
 */
export const LEGACY_SKILL_TOOL_GROUPS: ReadonlySet<string> = new Set([
  'jsonnetFiles',
  'jsonnetDashboards',
  'subagents',
]);
const DEFAULT_CONFIGURED_SKILL_TOOL_GROUPS: readonly SkillToolGroup[] = ['skillResources'];
const CUSTOM_SKILL_FILE_PREFIX = 'plugin-config/customSkills';

type ConfiguredSkillOptions = {
  reservedNames?: Iterable<string>;
};

export function getConfiguredGrafanaSkills(
  jsonData?: Pick<PiAppJsonData, 'customSkills'>,
  options: ConfiguredSkillOptions = {}
): GrafanaSkill[] {
  const customSkills = Array.isArray(jsonData?.customSkills) ? jsonData.customSkills : [];
  const reservedNames = new Set([...Array.from(options.reservedNames ?? [])].map((name) => name.toLowerCase()));
  const seenNames = new Set<string>();
  const skills: GrafanaSkill[] = [];

  for (const customSkill of customSkills.slice(0, CUSTOM_SKILL_CONFIG_LIMITS.maxSkills)) {
    const skill = normalizeConfiguredSkill(customSkill, reservedNames, seenNames);

    if (skill) {
      skills.push(skill);
    }
  }

  return skills;
}

export function parseCustomSkillsJson(value: string): PiAppCustomSkill[] {
  const trimmed = value.trim();

  if (!trimmed) {
    return [];
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON: ${message}`);
  }

  const errors = collectCustomSkillConfigErrors(parsed);

  if (errors.length > 0) {
    throw new Error(errors.slice(0, 3).join(' '));
  }

  return parsed as PiAppCustomSkill[];
}

export function validateCustomSkillsJson(value: string): string | undefined {
  try {
    parseCustomSkillsJson(value);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function normalizeConfiguredSkill(
  customSkill: PiAppCustomSkill,
  reservedNames: Set<string>,
  seenNames: Set<string>
): GrafanaSkill | undefined {
  if (!isRecord(customSkill) || customSkill.enabled === false) {
    return undefined;
  }

  const name = typeof customSkill.name === 'string' ? customSkill.name.trim().toLowerCase() : '';
  const description = typeof customSkill.description === 'string' ? customSkill.description.trim() : '';
  const content = typeof customSkill.content === 'string' ? truncateCustomSkillContent(customSkill.content.trim()) : '';

  if (
    !CUSTOM_SKILL_NAME_PATTERN.test(name) ||
    !description ||
    !content ||
    reservedNames.has(name) ||
    seenNames.has(name)
  ) {
    return undefined;
  }

  seenNames.add(name);

  return {
    name,
    description,
    content,
    filePath: `${CUSTOM_SKILL_FILE_PREFIX}/${name}`,
    disableModelInvocation: customSkill.disableModelInvocation === true,
    resources: normalizeConfiguredSkillResources(customSkill.resources),
    toolGroups: normalizeConfiguredSkillToolGroups(customSkill.toolGroups),
    activation: normalizeConfiguredSkillActivation(customSkill.activation),
  };
}

function normalizeConfiguredSkillToolGroups(value: unknown): readonly SkillToolGroup[] {
  const groups = new Set<SkillToolGroup>(DEFAULT_CONFIGURED_SKILL_TOOL_GROUPS);

  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string' && CONFIGURABLE_SKILL_TOOL_GROUP_SET.has(item as SkillToolGroup)) {
        groups.add(item as SkillToolGroup);
      }
    }
  }

  return [...groups];
}

function normalizeConfiguredSkillActivation(value: unknown): GrafanaSkillActivation {
  if (!isRecord(value)) {
    return { explicitOnly: true };
  }

  const keywords = Array.isArray(value.keywords)
    ? value.keywords
        .filter((keyword): keyword is string => typeof keyword === 'string')
        .map((keyword) => keyword.trim())
        .filter(Boolean)
    : [];
  const regex = typeof value.regex === 'string' && isValidRegex(value.regex.trim()) ? value.regex.trim() : undefined;
  const hasAutoActivation = keywords.length > 0 || Boolean(regex);
  const explicitOnly = typeof value.explicitOnly === 'boolean' ? value.explicitOnly : !hasAutoActivation;

  return {
    ...(keywords.length > 0 ? { keywords } : {}),
    ...(regex ? { regex } : {}),
    explicitOnly,
  };
}

function normalizeConfiguredSkillResources(value: unknown): Record<string, BundledSkillResource> {
  if (!Array.isArray(value)) {
    return {};
  }

  const resources: Record<string, BundledSkillResource> = {};

  for (const resource of value.slice(0, CUSTOM_SKILL_CONFIG_LIMITS.maxResources)) {
    if (!isRecord(resource)) {
      continue;
    }

    const path = typeof resource.path === 'string' ? resource.path.trim() : '';
    const content = typeof resource.content === 'string' ? resource.content.trimEnd() : '';

    if (!isValidResourcePath(path) || !content || resources[path]) {
      continue;
    }

    resources[path] = {
      path,
      content,
      bytes: textByteLength(content),
    };
  }

  return Object.fromEntries(Object.entries(resources).sort(([left], [right]) => left.localeCompare(right)));
}

function collectCustomSkillConfigErrors(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return ['Custom skills JSON must be an array.'];
  }

  const errors: string[] = [];
  const names = new Set<string>();

  if (value.length > CUSTOM_SKILL_CONFIG_LIMITS.maxSkills) {
    errors.push(`Custom skills JSON can contain at most ${CUSTOM_SKILL_CONFIG_LIMITS.maxSkills} skills.`);
  }

  value.forEach((item, index) => {
    const label = `customSkills[${index}]`;

    if (!isRecord(item)) {
      errors.push(`${label} must be an object.`);
      return;
    }

    validateCustomSkillObject(item, label, names, errors);
  });

  return errors;
}

function validateCustomSkillObject(item: Record<string, unknown>, label: string, names: Set<string>, errors: string[]) {
  const name = typeof item.name === 'string' ? item.name.trim().toLowerCase() : '';

  if (!CUSTOM_SKILL_NAME_PATTERN.test(name)) {
    errors.push(`${label}.name must be kebab-case and 2-64 characters.`);
  } else if (names.has(name)) {
    errors.push(`${label}.name duplicates another custom skill.`);
  } else {
    names.add(name);
  }

  if (typeof item.description !== 'string' || item.description.trim().length === 0) {
    errors.push(`${label}.description is required.`);
  } else if (item.description.length > 1024) {
    errors.push(`${label}.description must be 1024 characters or fewer.`);
  }

  if (typeof item.content !== 'string' || item.content.trim().length === 0) {
    errors.push(`${label}.content is required.`);
  } else if (item.content.length > CUSTOM_SKILL_CONFIG_LIMITS.maxSkillContentLength) {
    errors.push(`${label}.content must be ${CUSTOM_SKILL_CONFIG_LIMITS.maxSkillContentLength} characters or fewer.`);
  }

  validateCustomSkillActivation(item.activation, label, errors);
  validateCustomSkillToolGroups(item.toolGroups, label, errors);
  validateCustomSkillResources(item.resources, label, errors);
}

function validateCustomSkillActivation(value: unknown, label: string, errors: string[]) {
  if (value === undefined) {
    return;
  }

  if (!isRecord(value)) {
    errors.push(`${label}.activation must be an object.`);
    return;
  }

  if (value.explicitOnly !== undefined && typeof value.explicitOnly !== 'boolean') {
    errors.push(`${label}.activation.explicitOnly must be a boolean.`);
  }

  if (value.keywords !== undefined) {
    if (!Array.isArray(value.keywords)) {
      errors.push(`${label}.activation.keywords must be an array of strings.`);
    } else if (value.keywords.some((keyword) => typeof keyword !== 'string' || keyword.trim().length === 0)) {
      errors.push(`${label}.activation.keywords must contain non-empty strings.`);
    }
  }

  if (value.regex !== undefined) {
    if (typeof value.regex !== 'string' || value.regex.trim().length === 0) {
      errors.push(`${label}.activation.regex must be a non-empty string.`);
    } else if (!isValidRegex(value.regex.trim())) {
      errors.push(`${label}.activation.regex must be a valid JavaScript regular expression.`);
    }
  }
}

function validateCustomSkillToolGroups(value: unknown, label: string, errors: string[]) {
  if (value === undefined) {
    return;
  }

  if (!Array.isArray(value)) {
    errors.push(`${label}.toolGroups must be an array.`);
    return;
  }

  for (const item of value) {
    if (
      typeof item !== 'string' ||
      (!CONFIGURABLE_SKILL_TOOL_GROUP_SET.has(item as SkillToolGroup) && !LEGACY_SKILL_TOOL_GROUPS.has(item))
    ) {
      errors.push(`${label}.toolGroups contains unsupported group ${JSON.stringify(item)}.`);
    }
  }
}

function validateCustomSkillResources(value: unknown, label: string, errors: string[]) {
  if (value === undefined) {
    return;
  }

  if (!Array.isArray(value)) {
    errors.push(`${label}.resources must be an array.`);
    return;
  }

  if (value.length > CUSTOM_SKILL_CONFIG_LIMITS.maxResources) {
    errors.push(`${label}.resources can contain at most ${CUSTOM_SKILL_CONFIG_LIMITS.maxResources} resources.`);
  }

  value.forEach((resource, index) => {
    const resourceLabel = `${label}.resources[${index}]`;

    if (!isRecord(resource)) {
      errors.push(`${resourceLabel} must be an object.`);
      return;
    }

    const path = typeof resource.path === 'string' ? resource.path.trim() : '';

    if (!isValidResourcePath(path)) {
      errors.push(`${resourceLabel}.path must be a relative path without .. segments.`);
    }

    if (typeof resource.content !== 'string' || resource.content.length === 0) {
      errors.push(`${resourceLabel}.content is required.`);
    } else if (resource.content.length > CUSTOM_SKILL_CONFIG_LIMITS.maxResourceLength) {
      errors.push(
        `${resourceLabel}.content must be ${CUSTOM_SKILL_CONFIG_LIMITS.maxResourceLength} characters or fewer.`
      );
    }
  });
}

function truncateCustomSkillContent(value: string) {
  if (value.length <= CUSTOM_SKILL_CONFIG_LIMITS.maxSkillContentLength) {
    return value;
  }

  return value.slice(0, CUSTOM_SKILL_CONFIG_LIMITS.maxSkillContentLength);
}

export function isValidCustomSkillResourcePath(path: string) {
  if (
    !path ||
    path.length > CUSTOM_SKILL_CONFIG_LIMITS.maxResourcePathLength ||
    path.startsWith('/') ||
    path.includes('\\')
  ) {
    return false;
  }

  return !path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
}

function isValidResourcePath(path: string) {
  return isValidCustomSkillResourcePath(path);
}

export function isValidCustomSkillRegex(pattern: string) {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

function isValidRegex(pattern: string) {
  return isValidCustomSkillRegex(pattern);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function textByteLength(value: string) {
  return new TextEncoder().encode(value).length;
}
