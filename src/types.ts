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

/** Documents with one of `values` in the keyword field `field` are returned completely. */
export type PiAppLogCondition = {
  field?: string;
  values?: string[];
};

/**
 * An Elasticsearch datasource the assistant may use for structure, counts, and
 * non-text fields of documents. Text fields are never returned, except for
 * documents matching an `unrestricted` condition.
 */
export type PiAppLogDatasource = {
  uid?: string;
  /** Indices, data streams, aliases, or patterns; empty means the datasource's configured index. */
  indices?: string[];
  unrestricted?: PiAppLogCondition[];
};

/**
 * A Microsoft SQL Server datasource the assistant may use for schema, counts,
 * and visible columns of rows. Numeric, date/time, bit, and uniqueidentifier
 * columns are visible; string and binary columns only when listed.
 */
export type PiAppSqlDatasource = {
  uid?: string;
  /** `schema.table` or `table`; empty means every table and view of the database. */
  tables?: string[];
  /** String columns that may be returned, as `schema.table.column` or `table.column`. */
  visibleColumns?: string[];
};

export type PiAppAccessMode = 'all' | 'admins' | 'users' | 'rbac';
export type PiAppOpenAIProtocol = 'auto' | 'chat-completions' | 'responses';
export type PiAppThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
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
  /** Elasticsearch datasources for `grafana-logs`; datasources that are not listed are denied. */
  logDatasources?: PiAppLogDatasource[];
  /** MSSQL datasources for `grafana-sql`; datasources that are not listed are denied. */
  sqlDatasources?: PiAppSqlDatasource[];
  // Legacy name kept for existing plugin settings.
  allowedDatasourceUids?: string[];
  systemPromptAddendum?: string;
  customSkills?: PiAppCustomSkill[];
};
