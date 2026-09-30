export type BundledSkillResource = {
  path: string;
  content: string;
  bytes: number;
};

export type BundledGrafanaSkill = {
  name: string;
  description: string;
  content: string;
  filePath: string;
  disableModelInvocation?: boolean;
  resources: Record<string, BundledSkillResource>;
};

export type GrafanaSkillActivation = {
  keywords?: readonly string[];
  regex?: string;
  explicitOnly?: boolean;
};

export type GrafanaSkill = BundledGrafanaSkill & {
  activation?: GrafanaSkillActivation;
};

export type GrafanaSkillSelection = {
  activeSkills: GrafanaSkill[];
  activeSkillNames: string[];
  explicitSkillNames: string[];
};

export type GrafanaSkillContext = {
  pageType?: 'dashboard' | 'explore' | 'assistant' | 'other';
  hasDashboardContext?: boolean;
  hasPanelContext?: boolean;
  liveDashboardEditingAvailable?: boolean;
  /** Earlier user prompts of the chat; their skills stay active for follow-ups. */
  previousPrompts?: readonly string[];
};
