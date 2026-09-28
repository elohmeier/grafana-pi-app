export type PiAppCustomSkillActivation = {
  keywords?: string[];
  regex?: string;
  explicitOnly?: boolean;
};

export type PiAppCustomSkillResource = {
  path?: string;
  content?: string;
};

export type PiAppCustomSkill = {
  name?: string;
  description?: string;
  content?: string;
  enabled?: boolean;
  activation?: PiAppCustomSkillActivation;
  toolGroups?: string[];
  resources?: PiAppCustomSkillResource[];
  disableModelInvocation?: boolean;
};

export type PiAppAccessMode = 'all' | 'admins' | 'users' | 'rbac';
export type PiAppOpenAIProtocol = 'auto' | 'chat-completions' | 'responses';
export type PiAppThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'xhigh';
export type PiAppThinkingFormat = 'openai' | 'qwen' | 'qwen-chat-template' | 'deepseek';

export type PiAppModelConfig = {
  id?: string;
  name?: string;
  default?: boolean;
  protocol?: PiAppOpenAIProtocol;
  thinkingLevel?: PiAppThinkingLevel;
  thinkingFormat?: PiAppThinkingFormat;
  /** Endpoint input-plus-output token capacity. Numeric strings are accepted from provisioning. */
  contextWindow?: number | string;
  /** Output tokens requested per model call; the backend clamps requests to this value. */
  maxOutputTokens?: number | string;
};

export type PiAppJsonData = {
  /** Optional PostgreSQL session store, configured through provisioning. */
  sessionSchema?: string;
  sessionNamespace?: string;
  sessionGrafanaUrl?: string;
  openAIBaseUrl?: string;
  models?: PiAppModelConfig[];
  isOpenAIAPIKeySet?: boolean;
  accessMode?: PiAppAccessMode;
  allowedUsers?: string[];
  allowedPrometheusDatasourceUids?: string[];
  // Legacy name kept for existing plugin settings.
  allowedDatasourceUids?: string[];
  systemPromptAddendum?: string;
  customSkills?: PiAppCustomSkill[];
};
