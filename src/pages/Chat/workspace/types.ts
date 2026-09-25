export type WorkspaceResourceKind = 'dashboard';

/** Provider-owned resource metadata. It lives outside the editable document. */
export type WorkspaceResourceMeta = {
  kind: WorkspaceResourceKind;
  uid: string;
  /** API version of the editable document, for example dashboard.grafana.app/v1. */
  apiVersion: string;
  /** Version Grafana stored the resource in, when it differs from apiVersion. */
  storedVersion?: string;
  namespace?: string;
  resourceVersion?: string;
  generation?: number;
  title?: string;
  folderUid?: string;
  url?: string;
  /** Manager/provenance annotation. Managed resources are read-only in the workspace. */
  managedBy?: string;
  fetchedAt: string;
  /** Provider-owned annotations and labels preserved on write-back. */
  annotations?: Record<string, string>;
  labels?: Record<string, string>;
  /** SHA-256 of the canonical base document content. */
  contentHash: string;
};

export type WorkspaceResourceSnapshot = {
  content: string;
  meta: WorkspaceResourceMeta;
};

export type WorkspaceResourceEntry = {
  kind: WorkspaceResourceKind;
  uid: string;
  path: string;
  /** Canonical remote snapshot. Undefined for locally created resources. */
  base?: WorkspaceResourceSnapshot;
  /** Local working copy. `null` is a staged deletion (tombstone). */
  overlay?: {
    content: string | null;
    updatedAt: string;
  };
};

export type WorkspaceScratchFile = {
  content: string;
  mtime: number;
};

export type WorkspaceLimits = {
  maxFileBytes: number;
  /** Aggregate bytes across scratch files and resource overlays. */
  maxWorkspaceBytes: number;
  maxTmpBytes: number;
  maxFiles: number;
  maxResources: number;
  /** Bytes written by one invocation before it is aborted. */
  maxInvocationWriteBytes: number;
};

export const DEFAULT_WORKSPACE_LIMITS: WorkspaceLimits = {
  maxFileBytes: 512 * 1024,
  maxWorkspaceBytes: 8 * 1024 * 1024,
  maxTmpBytes: 2 * 1024 * 1024,
  maxFiles: 500,
  maxResources: 100,
  maxInvocationWriteBytes: 4 * 1024 * 1024,
};

export type GeneratedFile = {
  /** Eager content, or a loader for lazily computed content. */
  content?: string;
  load?: (signal?: AbortSignal) => Promise<string> | string;
};

/** Read-only mount whose files are computed from app state (artifacts, skills, live dashboard...). */
export type GeneratedMount = {
  root: string;
  description: string;
  files: () => Record<string, GeneratedFile>;
};

export type WorkspaceFileChange = {
  path: string;
  change: 'created' | 'modified' | 'deleted';
  bytes: number;
  revision?: string;
};

export type WorkspaceChangeStatus = {
  path: string;
  kind: 'resource' | 'scratch';
  change: 'created' | 'modified' | 'deleted';
  uid?: string;
  resourceVersion?: string;
  bytes: number;
};

export type PersistedWorkspace = {
  schemaVersion: 1;
  files: Record<string, WorkspaceScratchFile>;
  dirs: string[];
  resources: Array<{
    kind: WorkspaceResourceKind;
    uid: string;
    /** Base content is dropped for unmodified resources and rehydrated lazily. */
    base?: { content?: string; meta: WorkspaceResourceMeta };
    overlay?: WorkspaceResourceEntry['overlay'];
  }>;
  plans: WorkspacePlan[];
  journal: WorkspaceApplyRecord[];
};

export type WorkspacePlanOperation = {
  path: string;
  kind: WorkspaceResourceKind;
  uid: string;
  operation: 'create' | 'update' | 'delete';
  title?: string;
  folderUid?: string;
  apiVersion: string;
  baseResourceVersion?: string;
  beforeHash?: string;
  afterHash?: string;
  validation: {
    ok: boolean;
    errors: string[];
    warnings: string[];
  };
};

export type WorkspacePlan = {
  id: string;
  createdAt: string;
  digest: string;
  operations: WorkspacePlanOperation[];
  diff: string;
  /** After-content per operation path, frozen at plan time. */
  documents: Record<string, string | null>;
};

export type WorkspaceApplyOutcome = 'applied' | 'failed' | 'conflicted' | 'unknown' | 'not attempted';

export type WorkspaceApplyRecord = {
  planId: string;
  digest: string;
  startedAt: string;
  finishedAt?: string;
  approved: boolean;
  results: Array<{
    path: string;
    uid: string;
    operation: WorkspacePlanOperation['operation'];
    outcome: WorkspaceApplyOutcome;
    resourceVersion?: string;
    url?: string;
    error?: string;
  }>;
};
