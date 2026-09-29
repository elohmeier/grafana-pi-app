export type WorkspaceResourceKind = 'dashboard' | 'alertRule';

/** Provider-owned resource metadata. It lives outside the editable document. */
export type WorkspaceResourceMeta = {
  kind: WorkspaceResourceKind;
  uid: string;
  /** API version of the editable document, for example dashboard.grafana.app/v1. */
  apiVersion: string;
  /**
   * Set when Grafana could not convert the resource to the preferred API version. The document
   * is then the stored version (apiVersion), which round-trips without loss.
   */
  conversion?: { preferredVersion: string; error?: string };
  namespace?: string;
  resourceVersion?: string;
  generation?: number;
  title?: string;
  folderUid?: string;
  url?: string;
  /** Manager/provenance annotation. Managed resources are read-only in the workspace. */
  managedBy?: string;
  /** Alert rules: evaluation group and its folder-scoped position; ungrouped rules have none. */
  group?: string;
  groupIndex?: number;
  /**
   * How writes guard against concurrent changes. `server`: the API rejects a stale resourceVersion.
   * `client`: the API does not, so the workspace compares the current revision right before writing.
   */
  preconditions?: 'server' | 'client';
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
  /**
   * Aggregate bytes of the scratch files persisted with the session (/workspace, /session). This
   * protects the stored session size; dashboards, their working copies, and /tmp are not counted.
   */
  maxWorkspaceBytes: number;
};

export const DEFAULT_WORKSPACE_LIMITS: WorkspaceLimits = {
  maxWorkspaceBytes: 8 * 1024 * 1024,
};

/**
 * Every resource of one kind visible to the current user (dashboards, alert rules), listed before
 * its content is fetched. `prepare` loads the listing before a tool call or bash invocation reads
 * the filesystem; `uids` returns the loaded listing synchronously.
 */
export type ResourceIndex = {
  prepare: (signal?: AbortSignal) => Promise<void>;
  uids: () => readonly string[];
  /** Listing metadata of an indexed resource. */
  describe?: (uid: string) => { title?: string; folderUid?: string; folderTitle?: string; group?: string } | undefined;
};

export type GeneratedFile = {
  /** Eager content, or a loader for lazily computed content. */
  content?: string;
  load?: (signal?: AbortSignal) => Promise<string> | string;
  /**
   * Writes stage a local overlay (stored like a /tmp scratch file: committed
   * with the transaction, not persisted with the session). Reads return the
   * overlay until it is removed; `rm` drops it.
   */
  writable?: boolean;
};

/** Read-only mount whose files are computed from app state (artifacts, skills, live dashboard...). */
export type GeneratedMount = {
  root: string;
  description: string;
  files: () => Record<string, GeneratedFile>;
  /** Loads what files() needs to list, before a tool call or bash invocation reads the filesystem. */
  prepare?: (signal?: AbortSignal) => Promise<void>;
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
  resource?: WorkspaceResourceKind;
  change: 'created' | 'modified' | 'deleted';
  uid?: string;
  resourceVersion?: string;
  bytes: number;
};

export type PersistedWorkspace = {
  schemaVersion: 1;
  files: Record<string, WorkspaceScratchFile>;
  dirs: string[];
  /** Resources with local changes only; unmodified resources are fetched again on demand. */
  resources: Array<{
    kind: WorkspaceResourceKind;
    uid: string;
    base?: { content?: string; meta: WorkspaceResourceMeta };
    /** Working copy. `patch` is a unified diff against the base content (smaller than a full copy). */
    overlay?: { content?: string | null; patch?: string; updatedAt: string };
  }>;
  journal: WorkspaceApplyRecord[];
};

export type WorkspaceWriteOperation = {
  path: string;
  kind: WorkspaceResourceKind;
  uid: string;
  operation: 'create' | 'update' | 'delete';
  title?: string;
  folderUid?: string;
  /** Alert rules: evaluation group. */
  group?: string;
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

export type WorkspaceChanges = {
  id: string;
  createdAt: string;
  digest: string;
  operations: WorkspaceWriteOperation[];
  diff: string;
  /** After-content per operation path, captured at apply time. */
  documents: Record<string, string | null>;
};

/** `declined`: the reviewer unchecked the resource; its working copy keeps the change. */
export type WorkspaceApplyOutcome = 'applied' | 'failed' | 'conflicted' | 'unknown' | 'not attempted' | 'declined';

export type WorkspaceApplyRecord = {
  applyId: string;
  diff?: string;
  digest: string;
  startedAt: string;
  finishedAt?: string;
  approved: boolean;
  results: Array<{
    path: string;
    /** Missing in receipts written before alert rules could be applied: a dashboard. */
    kind?: WorkspaceResourceKind;
    uid: string;
    title?: string;
    operation: WorkspaceWriteOperation['operation'];
    outcome: WorkspaceApplyOutcome;
    /** Revision the change was made against; `workspace revert` restores it from Grafana's history. */
    baseResourceVersion?: string;
    resourceVersion?: string;
    url?: string;
    error?: string;
  }>;
};
