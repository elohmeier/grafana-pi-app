import { applyPatch, createPatch } from 'diff';
import { contentRevision } from './hash';
import { ancestorDirs, isWithin, joinPath, normalizeWorkspacePath, parentPath, utf8ByteLength } from './paths';
import {
  RESOURCE_KIND_NAMES,
  RESOURCE_KINDS,
  RESOURCE_META,
  RESOURCE_UID_PATTERN,
  resourceDocumentPath,
  resourceKey,
  resourceMetaPath,
} from './resourceKinds';
import {
  DEFAULT_WORKSPACE_LIMITS,
  type GeneratedFile,
  type GeneratedMount,
  type PersistedWorkspace,
  type ResourceIndex,
  type WorkspaceApplyRecord,
  type WorkspaceChangeStatus,
  type WorkspaceFileChange,
  type WorkspaceLimits,
  type WorkspaceResourceEntry,
  type WorkspaceResourceKind,
  type WorkspaceResourceSnapshot,
  type WorkspaceScratchFile,
} from './types';

export const SCRATCH_MOUNTS = ['/workspace', '/session', '/tmp'] as const;
export const DASHBOARDS_ROOT = RESOURCE_KINDS.dashboard.root;
export const DASHBOARD_DOCUMENT = RESOURCE_KINDS.dashboard.document;
export const DASHBOARD_META = RESOURCE_META;
export const ALERT_RULES_ROOT = RESOURCE_KINDS.alertRule.root;
const PERSISTED_SCRATCH_MOUNTS = ['/workspace', '/session'];
const MAX_JOURNAL_BYTES = 16 * 1024 * 1024;
/** Parallel resource fetches while loading many dashboards or alert rules. */
export const HYDRATION_CONCURRENCY = 8;
/** Hydration misses in one transaction after which the rest of the index is prefetched. */
const SCAN_DETECTION_MISSES = 3;

export type WorkspacePathClass =
  | { type: 'scratch'; mount: string }
  | { type: 'resource'; kind: WorkspaceResourceKind; uid: string }
  | { type: 'resource-dir'; kind: WorkspaceResourceKind; uid: string }
  | { type: 'generated'; mount: string }
  | { type: 'virtual' }
  | { type: 'none' };

export type ResourceHydrator = (
  kind: WorkspaceResourceKind,
  uid: string,
  signal?: AbortSignal
) => Promise<WorkspaceResourceSnapshot | undefined>;

/** Wraps waits on remote fetches, for example to pause an execution timeout while dashboards load. */
export type RemoteWait = <T>(pending: Promise<T>) => Promise<T>;

export class WorkspaceError extends Error {
  constructor(
    readonly code:
      | 'ENOENT'
      | 'EROFS'
      | 'EISDIR'
      | 'ENOTDIR'
      | 'EEXIST'
      | 'ENOTEMPTY'
      | 'EPERM'
      | 'EQUOTA'
      | 'ECONFLICT',
    message: string
  ) {
    super(`${code}: ${message}`);
    this.name = 'WorkspaceError';
  }
}

/**
 * One persistent virtual filesystem per chat session. It separates canonical
 * resource snapshots from local overlays and scratch files, and every mutation
 * path (read/write/edit tools, bash, commands) goes through a
 * {@link WorkspaceTransaction} that validates policy and quotas before commit.
 */
export class SessionWorkspace {
  readonly limits: WorkspaceLimits;
  private files = new Map<string, WorkspaceScratchFile>();
  private dirs = new Set<string>();
  private resources = new Map<string, WorkspaceResourceEntry>();
  private generated: GeneratedMount[] = [];
  private journal: WorkspaceApplyRecord[] = [];
  private hydrator?: ResourceHydrator;
  private indexes = new Map<WorkspaceResourceKind, ResourceIndex>();
  private inflight = new Map<string, Promise<WorkspaceResourceEntry | undefined>>();
  private backgroundPrefetch = new Map<WorkspaceResourceKind, Promise<unknown>>();
  private listeners = new Set<() => void>();
  private revisionCounter = 0;
  private pathRevisionCounter = 0;

  constructor(limits: Partial<WorkspaceLimits> = {}) {
    this.limits = { ...DEFAULT_WORKSPACE_LIMITS, ...limits };
  }

  get revision() {
    return this.revisionCounter;
  }

  /** Changes whenever the set of listed paths may have changed (not on content-only changes). */
  get pathRevision() {
    return this.pathRevisionCounter;
  }

  setHydrator(hydrator: ResourceHydrator | undefined) {
    this.hydrator = hydrator;
  }

  setResourceIndex(index: ResourceIndex | undefined, kind: WorkspaceResourceKind = 'dashboard') {
    if (index) {
      this.indexes.set(kind, index);
    } else {
      this.indexes.delete(kind);
    }
    this.pathRevisionCounter++;
  }

  /** Whether resources of this kind are mounted (always true for dashboards). */
  hasResourceKind(kind: WorkspaceResourceKind) {
    return kind === 'dashboard' || this.indexes.has(kind) || this.resourceEntries(kind).length > 0;
  }

  /** Kinds whose root is mounted. */
  resourceKinds(): WorkspaceResourceKind[] {
    return RESOURCE_KIND_NAMES.filter((kind) => this.hasResourceKind(kind));
  }

  /** UIDs of every visible resource of a kind, listed before their content is fetched. */
  indexedUids(kind: WorkspaceResourceKind = 'dashboard'): readonly string[] {
    return this.indexes.get(kind)?.uids() ?? EMPTY_UIDS;
  }

  describeIndexed(uid: string, kind: WorkspaceResourceKind = 'dashboard') {
    return this.indexes.get(kind)?.describe?.(uid);
  }

  isIndexed(uid: string, kind: WorkspaceResourceKind = 'dashboard') {
    return this.indexedUidSet(kind).has(uid);
  }

  private indexedSets = new Map<WorkspaceResourceKind, { source: readonly string[]; set: Set<string> }>();
  private indexedUidSet(kind: WorkspaceResourceKind) {
    const source = this.indexedUids(kind);
    let cached = this.indexedSets.get(kind);
    if (cached?.source !== source) {
      cached = { source, set: new Set(source) };
      this.indexedSets.set(kind, cached);
    }
    return cached.set;
  }

  setGeneratedMounts(mounts: GeneratedMount[]) {
    this.generated = [...mounts].sort((left, right) => right.root.length - left.root.length);
  }

  generatedMounts() {
    return this.generated;
  }

  /** Runs mount preparation; a mount that fails to prepare stays empty for this call. */
  async prepareMounts(signal?: AbortSignal) {
    const indexes = [...this.indexes.values()];
    const before = indexes.map((index) => index.uids());
    await Promise.all([
      ...this.generated.map((mount) => mount.prepare?.(signal).catch(() => undefined)),
      ...indexes.map((index) => index.prepare(signal).catch(() => undefined)),
    ]);
    if (indexes.some((index, position) => index.uids() !== before[position])) {
      this.pathRevisionCounter++;
    }
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  classify(path: string): WorkspacePathClass {
    const generated = this.generated.find((mount) => isWithin(path, mount.root));
    if (generated) {
      return { type: 'generated', mount: generated.root };
    }
    for (const mount of SCRATCH_MOUNTS) {
      if (isWithin(path, mount)) {
        return { type: 'scratch', mount };
      }
    }
    for (const kind of this.resourceKinds()) {
      const { root, document } = RESOURCE_KINDS[kind];
      if (!isWithin(path, root) || path === root) {
        continue;
      }
      const rest = path.slice(root.length + 1).split('/');
      const uid = rest[0];
      if (RESOURCE_UID_PATTERN.test(uid)) {
        if (rest.length === 1) {
          return { type: 'resource-dir', kind, uid };
        }
        if (rest.length === 2 && rest[1] === document) {
          return { type: 'resource', kind, uid };
        }
        if (rest.length === 2 && rest[1] === RESOURCE_META) {
          return { type: 'generated', mount: root };
        }
      }
      return { type: 'none' };
    }
    for (const mount of this.generated) {
      if (isWithin(path, mount.root)) {
        return { type: 'generated', mount: mount.root };
      }
    }
    if (this.isVirtualDir(path)) {
      return { type: 'virtual' };
    }
    return { type: 'none' };
  }

  /** Directories that exist only as ancestors of mount roots, like `/` and `/grafana`. */
  isVirtualDir(path: string) {
    if (path === '/') {
      return true;
    }
    return this.mountRoots().some((root) => root === path || isWithin(root, path));
  }

  mountRoots() {
    return [
      ...SCRATCH_MOUNTS,
      ...this.resourceKinds().map((kind) => RESOURCE_KINDS[kind].root),
      ...this.generated.map((mount) => mount.root),
    ];
  }

  getScratchFile(path: string) {
    return this.files.get(path);
  }

  scratchFiles() {
    return this.files;
  }

  scratchDirs() {
    return this.dirs;
  }

  getResource(uid: string, kind: WorkspaceResourceKind = 'dashboard') {
    return this.resources.get(resourceKey(kind, uid));
  }

  /** Loaded resources, dashboards first, of one kind or all kinds. */
  resourceEntries(kind?: WorkspaceResourceKind) {
    return [...this.resources.values()]
      .filter((entry) => !kind || entry.kind === kind)
      .sort(
        (left, right) =>
          RESOURCE_KIND_NAMES.indexOf(left.kind) - RESOURCE_KIND_NAMES.indexOf(right.kind) ||
          left.uid.localeCompare(right.uid)
      );
  }

  resourcePath(uid: string, kind: WorkspaceResourceKind = 'dashboard') {
    return resourceDocumentPath(kind, uid);
  }

  /** Effective content of a resource working copy, or undefined when absent/deleted. */
  resourceContent(entry: WorkspaceResourceEntry): string | undefined {
    if (entry.overlay) {
      return entry.overlay.content ?? undefined;
    }
    return entry.base?.content;
  }

  generatedFiles(): Map<string, GeneratedFile> {
    const files = new Map<string, GeneratedFile>();
    for (const mount of this.generated) {
      for (const [path, file] of Object.entries(mount.files())) {
        files.set(normalizeWorkspacePath(path), file);
      }
    }
    for (const entry of this.resources.values()) {
      if (entry.base && entry.overlay?.content !== null) {
        files.set(resourceMetaPath(entry.kind, entry.uid), { content: metaFileContent(entry) });
      }
    }
    for (const kind of this.indexes.keys()) {
      for (const uid of this.indexedUids(kind)) {
        const path = resourceMetaPath(kind, uid);
        if (!this.resources.has(resourceKey(kind, uid)) && !files.has(path)) {
          files.set(path, {
            load: async (signal) => {
              const entry = await this.hydrate(uid, signal, kind);
              return entry?.base ? metaFileContent(entry) : '';
            },
          });
        }
      }
    }
    return files;
  }

  /**
   * Stores or replaces a canonical remote snapshot. Refuses to replace the base
   * of a resource with local changes unless `discardOverlay` is set.
   */
  setResourceBase(snapshot: WorkspaceResourceSnapshot, options: { discardOverlay?: boolean } = {}) {
    const { uid, kind } = snapshot.meta;
    if (!RESOURCE_UID_PATTERN.test(uid)) {
      throw new WorkspaceError('EPERM', `invalid resource UID ${JSON.stringify(uid)}`);
    }
    const key = resourceKey(kind, uid);
    const existing = this.resources.get(key);
    const path = this.resourcePath(uid, kind);
    if (existing?.overlay && !options.discardOverlay) {
      throw new WorkspaceError(
        'ECONFLICT',
        `${path} has local changes; run \`workspace discard ${path}\` before refreshing`
      );
    }
    if (!existing && !this.isIndexed(uid, kind)) {
      this.pathRevisionCounter++;
    }
    this.resources.set(key, {
      kind,
      uid,
      path,
      base: snapshot,
      overlay: options.discardOverlay ? undefined : existing?.overlay,
    });
    this.changed();
  }

  /** Replaces a resource's base after a successful remote write and clears its overlay. */
  reconcileResource(
    uid: string,
    snapshot: WorkspaceResourceSnapshot | undefined,
    kind: WorkspaceResourceKind = 'dashboard'
  ) {
    this.pathRevisionCounter++;
    if (!snapshot) {
      this.resources.delete(resourceKey(kind, uid));
    } else {
      this.resources.set(resourceKey(kind, uid), { kind, uid, path: this.resourcePath(uid, kind), base: snapshot });
    }
    this.changed();
  }

  discard(path: string) {
    const normalized = normalizeWorkspacePath(path);
    const target = this.classify(normalized);
    if (target.type === 'resource' || target.type === 'resource-dir') {
      const key = resourceKey(target.kind, target.uid);
      const entry = this.resources.get(key);
      if (!entry?.overlay) {
        return false;
      }
      if (entry.base) {
        this.resources.set(key, { ...entry, overlay: undefined });
      } else {
        this.resources.delete(key);
      }
      this.pathRevisionCounter++;
      this.changed();
      return true;
    }
    throw new WorkspaceError('EPERM', `only resource working copies can be discarded: ${normalized}`);
  }

  /**
   * Loads a resource snapshot through the hydrator when it is absent, or when
   * it was restored from storage without content. Working copies with local
   * changes always keep their base content, so they are never rehydrated.
   * Concurrent requests for the same UID share one fetch.
   */
  async hydrate(
    uid: string,
    signal?: AbortSignal,
    kind: WorkspaceResourceKind = 'dashboard'
  ): Promise<WorkspaceResourceEntry | undefined> {
    const key = resourceKey(kind, uid);
    const existing = this.resources.get(key);
    if (existing && (existing.overlay || isBaseLoaded(existing))) {
      return existing;
    }
    if (!this.hydrator) {
      return existing;
    }
    let pending = this.inflight.get(key);
    if (!pending) {
      const hydrator = this.hydrator;
      pending = (async () => {
        const snapshot = await hydrator(kind, uid, signal);
        const current = this.resources.get(key);
        if (!snapshot || (current && (current.overlay || isBaseLoaded(current)))) {
          // Missing remotely, or a local change landed while the fetch was in flight.
          return current;
        }
        this.setResourceBase(snapshot);
        return this.resources.get(key);
      })().finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    return pending;
  }

  /** Whether the content of a resource is in memory (no fetch needed to read it). */
  isResourceLoaded(uid: string, kind: WorkspaceResourceKind = 'dashboard') {
    const entry = this.resources.get(resourceKey(kind, uid));
    return Boolean(entry && (entry.overlay || isBaseLoaded(entry)));
  }

  /**
   * Fetches many resources of a kind in parallel (every indexed one when `uids` is
   * omitted). Unreadable resources are reported, not thrown.
   */
  async prefetch(uids?: readonly string[], signal?: AbortSignal, kind: WorkspaceResourceKind = 'dashboard') {
    const targets = [...new Set(uids ?? this.indexedUids(kind))].filter((uid) => !this.isResourceLoaded(uid, kind));
    const failed: Array<{ uid: string; error: string }> = [];
    let next = 0;
    const worker = async () => {
      while (next < targets.length && !signal?.aborted) {
        const uid = targets[next++];
        try {
          const entry = await this.hydrate(uid, signal, kind);
          if (!entry) {
            failed.push({ uid, error: 'not found or not readable by the current user' });
          }
        } catch (error) {
          failed.push({ uid, error: error instanceof Error ? error.message : String(error) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(HYDRATION_CONCURRENCY, targets.length) }, worker));
    return { requested: targets.length, failed };
  }

  /**
   * Starts loading every indexed resource of a kind without waiting, so a scan such as
   * `rg PATTERN /grafana/dashboards` reads resources that are already in flight.
   * The fetch outlives the invocation that started it; its results stay cached.
   */
  prefetchInBackground(kind: WorkspaceResourceKind = 'dashboard') {
    if (this.backgroundPrefetch.has(kind) || !this.hydrator) {
      return;
    }
    if (this.indexedUids(kind).every((uid) => this.isResourceLoaded(uid, kind))) {
      return;
    }
    this.backgroundPrefetch.set(
      kind,
      this.prefetch(undefined, undefined, kind).finally(() => {
        this.backgroundPrefetch.delete(kind);
      })
    );
  }

  status(): WorkspaceChangeStatus[] {
    const changes: WorkspaceChangeStatus[] = [];
    for (const entry of this.resourceEntries()) {
      if (!entry.overlay) {
        continue;
      }
      const content = entry.overlay.content;
      changes.push({
        path: entry.path,
        kind: 'resource',
        resource: entry.kind,
        uid: entry.uid,
        change: content === null ? 'deleted' : entry.base ? 'modified' : 'created',
        resourceVersion: entry.base?.meta.resourceVersion,
        bytes: content === null ? 0 : utf8ByteLength(content),
      });
    }
    return changes;
  }

  usage() {
    let persistedBytes = 0;
    let tmpBytes = 0;
    for (const [path, file] of this.files) {
      const bytes = utf8ByteLength(file.content);
      if (isPersistedScratch(path)) {
        persistedBytes += bytes;
      } else {
        tmpBytes += bytes;
      }
    }
    const counts = (kind: WorkspaceResourceKind) => {
      let loaded = 0;
      let modified = 0;
      for (const entry of this.resources.values()) {
        if (entry.kind === kind) {
          loaded += this.isResourceLoaded(entry.uid, kind) ? 1 : 0;
          modified += entry.overlay ? 1 : 0;
        }
      }
      return { visible: this.indexedUids(kind).length, loaded, modified };
    };
    return {
      files: this.files.size,
      persistedBytes,
      tmpBytes,
      dashboards: counts('dashboard'),
      ...(this.hasResourceKind('alertRule') ? { alertRules: counts('alertRule') } : {}),
    };
  }

  /** Detached view for inspecting staged writes without committing them. */
  snapshot() {
    const copy = new SessionWorkspace(this.limits);
    copy.files = new Map(this.files);
    copy.dirs = new Set(this.dirs);
    copy.resources = new Map(this.resources);
    copy.generated = this.generated;
    copy.hydrator = this.hydrator;
    copy.indexes = this.indexes;
    copy.journal = [...this.journal];
    return copy;
  }

  begin(options: { cwd?: string; signal?: AbortSignal; remoteWait?: RemoteWait } = {}) {
    return new WorkspaceTransaction(this, options.signal, options.remoteWait);
  }

  /** Applies a validated transaction. Only {@link WorkspaceTransaction.commit} calls this. */
  applyCommitted(
    files: Map<string, string | null>,
    dirsAdded: Set<string>,
    dirsRemoved: Set<string>,
    resources: Map<string, string | null>
  ) {
    const now = Date.now();
    if (files.size > 0 || dirsAdded.size > 0 || dirsRemoved.size > 0 || resources.size > 0) {
      this.pathRevisionCounter++;
    }
    for (const [path, content] of files) {
      if (content === null) {
        this.files.delete(path);
      } else {
        this.files.set(path, { content, mtime: now });
      }
    }
    for (const dir of dirsRemoved) {
      this.dirs.delete(dir);
    }
    for (const dir of dirsAdded) {
      this.dirs.add(dir);
    }
    for (const [key, content] of resources) {
      const { kind, uid } = parseResourceKey(key);
      const entry = this.resources.get(key);
      if (content === null) {
        if (entry?.base) {
          this.resources.set(key, { ...entry, overlay: { content: null, updatedAt: new Date(now).toISOString() } });
        } else {
          this.resources.delete(key);
        }
        continue;
      }
      if (entry?.base && entry.base.content === content) {
        this.resources.set(key, { ...entry, overlay: undefined });
        continue;
      }
      this.resources.set(key, {
        kind,
        uid,
        path: this.resourcePath(uid, kind),
        base: entry?.base,
        overlay: { content, updatedAt: new Date(now).toISOString() },
      });
    }
    this.changed();
  }

  // Apply journal ----------------------------------------------------------

  recordApply(record: WorkspaceApplyRecord) {
    this.journal = [...this.journal.filter((existing) => existing !== record), record];
    // The journal is stored with the session: over budget, the oldest diffs go first, then the oldest records.
    for (const older of this.journal.slice(0, -1)) {
      if (utf8ByteLength(JSON.stringify(this.journal)) <= MAX_JOURNAL_BYTES) {
        break;
      }
      delete older.diff;
    }
    while (this.journal.length > 1 && utf8ByteLength(JSON.stringify(this.journal)) > MAX_JOURNAL_BYTES) {
      this.journal.shift();
    }
    this.changed();
  }

  applyJournal() {
    return [...this.journal];
  }

  // Persistence -------------------------------------------------------------

  serialize(): PersistedWorkspace {
    const files: PersistedWorkspace['files'] = {};
    for (const [path, file] of this.files) {
      if (PERSISTED_SCRATCH_MOUNTS.some((mount) => isWithin(path, mount))) {
        files[path] = file;
      }
    }
    return {
      schemaVersion: 1,
      files,
      dirs: [...this.dirs].filter((dir) => PERSISTED_SCRATCH_MOUNTS.some((mount) => isWithin(dir, mount))),
      // Unmodified resources are listed by the index and fetched again on demand; working copies
      // keep their base (for diffs and revision preconditions) plus a patch against it.
      resources: this.resourceEntries()
        .filter((entry) => entry.overlay)
        .map((entry) => ({
          kind: entry.kind,
          uid: entry.uid,
          base: entry.base ? { meta: entry.base.meta, content: entry.base.content } : undefined,
          overlay: serializeOverlay(entry),
        })),
      journal: this.journal,
    };
  }

  /**
   * Rebuilds a workspace from storage. Every path is re-validated. Imported
   * sessions pass `trusted: false` so the apply journal is dropped:
   * approvals never carry over into another session.
   */
  static restore(persisted: unknown, options: { limits?: Partial<WorkspaceLimits>; trusted?: boolean } = {}) {
    const limits = options.limits;
    const workspace = new SessionWorkspace(limits);
    if (!persisted || typeof persisted !== 'object' || (persisted as PersistedWorkspace).schemaVersion !== 1) {
      return workspace;
    }
    const data = persisted as PersistedWorkspace;
    for (const [rawPath, file] of Object.entries(data.files ?? {})) {
      try {
        const path = normalizeWorkspacePath(rawPath);
        if (
          path !== '/session/context.json' &&
          !isWithin(path, '/session/receipts') &&
          PERSISTED_SCRATCH_MOUNTS.some((mount) => isWithin(path, mount)) &&
          typeof file?.content === 'string'
        ) {
          workspace.files.set(path, { content: file.content, mtime: Number(file.mtime) || Date.now() });
        }
      } catch {
        // Skip entries that no longer pass path policy.
      }
    }
    for (const dir of data.dirs ?? []) {
      try {
        const path = normalizeWorkspacePath(dir);
        if (PERSISTED_SCRATCH_MOUNTS.some((mount) => isWithin(path, mount) && path !== mount)) {
          workspace.dirs.add(path);
        }
      } catch {
        // Skip invalid directories.
      }
    }
    for (const resource of data.resources ?? []) {
      if (!resource || !RESOURCE_KIND_NAMES.includes(resource.kind) || !RESOURCE_UID_PATTERN.test(resource.uid)) {
        continue;
      }
      const base = resource.base ? { meta: resource.base.meta, content: resource.base.content ?? '' } : undefined;
      const overlay = restoreOverlay(resource.overlay, base?.content);
      if (!overlay) {
        // Unmodified dashboards from older sessions are listed by the index instead.
        continue;
      }
      workspace.resources.set(resourceKey(resource.kind, resource.uid), {
        kind: resource.kind,
        uid: resource.uid,
        path: workspace.resourcePath(resource.uid, resource.kind),
        base,
        overlay,
      });
    }
    if (options.trusted !== false) {
      workspace.journal = Array.isArray(data.journal) ? data.journal : [];
    }
    return workspace;
  }

  private changed() {
    this.revisionCounter++;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

type DirListing = Map<string, 'file' | 'dir'>;

/**
 * Copy-on-write view used for one tool call or one bash invocation. Reads fall
 * through to committed workspace state; writes are staged and validated. The
 * caller commits on success and simply drops the transaction on abort,
 * timeout, or policy failure, so partial changes never leak.
 */
export class WorkspaceTransaction {
  private files = new Map<string, string | null>();
  /** Staged resource documents keyed by {@link resourceKey}; `null` stages a deletion. */
  private resources = new Map<string, string | null>();
  private dirsAdded = new Set<string>();
  private dirsRemoved = new Set<string>();
  private generatedCache = new Map<string, string>();
  private generatedFiles?: Map<string, GeneratedFile>;
  private hydrationAttempts = new Set<string>();
  private hydrationMisses = new Map<WorkspaceResourceKind, number>();
  private closed = false;
  private checkpointed: WorkspaceFileChange[] = [];
  private pathsCache?: { key: string; paths: string[] };
  private mutations = 0;

  constructor(
    readonly workspace: SessionWorkspace,
    private readonly signal?: AbortSignal,
    private readonly remoteWait: RemoteWait = (pending) => pending
  ) {}

  /** Changes whenever {@link allPaths} may return a different list. */
  pathsKey() {
    return `${this.workspace.pathRevision}:${this.mutations}`;
  }

  // Reads -------------------------------------------------------------------

  async readFile(rawPath: string): Promise<string> {
    const path = normalizeWorkspacePath(rawPath);
    const target = this.workspace.classify(path);
    switch (target.type) {
      case 'scratch': {
        const content = this.scratchContent(path);
        if (content === undefined) {
          throw this.missingOrDir(path, 'open');
        }
        return content;
      }
      case 'resource': {
        const content = await this.resourceContent(target.kind, target.uid, true);
        if (content === undefined) {
          throw new WorkspaceError(
            'ENOENT',
            `no such file or directory, open '${path}'${this.hydrationHint(target.kind, target.uid)}`
          );
        }
        return content;
      }
      case 'generated': {
        const content = this.generatedOverlay(path) ?? (await this.generatedContent(path));
        if (content === undefined) {
          throw this.missingOrDir(path, 'open');
        }
        return content;
      }
      default:
        throw this.missingOrDir(path, 'open');
    }
  }

  async exists(rawPath: string) {
    return (await this.entryType(normalizeWorkspacePath(rawPath))) !== undefined;
  }

  async entryType(path: string): Promise<'file' | 'dir' | undefined> {
    const target = this.workspace.classify(path);
    switch (target.type) {
      case 'virtual':
        return 'dir';
      case 'scratch':
        if (this.scratchContent(path) !== undefined) {
          return 'file';
        }
        return this.scratchDirExists(path) ? 'dir' : undefined;
      case 'resource':
        if (
          !this.resources.has(resourceKey(target.kind, target.uid)) &&
          this.workspace.isIndexed(target.uid, target.kind) &&
          this.resourceDirExists(target.kind, target.uid)
        ) {
          return 'file';
        }
        return (await this.resourceContent(target.kind, target.uid, true)) !== undefined ? 'file' : undefined;
      case 'resource-dir':
        return this.resourceDirExists(target.kind, target.uid) ? 'dir' : undefined;
      case 'generated': {
        const files = this.generated();
        if (files.has(path)) {
          return 'file';
        }
        for (const filePath of files.keys()) {
          if (isWithin(filePath, path)) {
            return 'dir';
          }
        }
        return this.workspace.generatedMounts().some((mount) => mount.root === path) ? 'dir' : undefined;
      }
      default:
        return undefined;
    }
  }

  async size(path: string) {
    const type = await this.entryType(path);
    if (type !== 'file') {
      return 0;
    }
    const target = this.workspace.classify(path);
    if (target.type === 'generated') {
      const file = this.generated().get(path);
      const overlay = this.generatedOverlay(path);
      if (overlay !== undefined) {
        return utf8ByteLength(overlay);
      }
      if (file?.content !== undefined) {
        return utf8ByteLength(file.content);
      }
      if (this.generatedCache.has(path)) {
        return utf8ByteLength(this.generatedCache.get(path)!);
      }
      return 0;
    }
    return utf8ByteLength(await this.readFile(path));
  }

  async readdir(rawPath: string): Promise<Array<{ name: string; type: 'file' | 'dir' }>> {
    const path = normalizeWorkspacePath(rawPath);
    const type = await this.entryType(path);
    if (type === undefined) {
      throw new WorkspaceError('ENOENT', `no such file or directory, scandir '${path}'`);
    }
    if (type === 'file') {
      throw new WorkspaceError('ENOTDIR', `not a directory, scandir '${path}'`);
    }
    const target = this.workspace.classify(path);
    if (target.type === 'resource-dir' && !this.workspace.isResourceLoaded(target.uid, target.kind)) {
      // Descending into resource directories is how rg, grep -r, and find scan.
      this.noteResourceMiss(target.kind);
    }
    const listing: DirListing = new Map();
    const addPath = (candidate: string, kind: 'file' | 'dir') => {
      if (!isWithin(candidate, path) || candidate === path) {
        return;
      }
      const rest = candidate.slice(path === '/' ? 1 : path.length + 1);
      const [name, ...more] = rest.split('/');
      listing.set(name, more.length > 0 ? 'dir' : kind);
    };
    for (const root of this.workspace.mountRoots()) {
      addPath(root, 'dir');
    }
    for (const file of this.allScratchFiles()) {
      addPath(file, 'file');
    }
    for (const dir of this.allScratchDirs()) {
      addPath(dir, 'dir');
    }
    for (const kind of this.workspace.resourceKinds()) {
      const root = RESOURCE_KINDS[kind].root;
      if (!isWithin(root, path) && !isWithin(path, root)) {
        continue;
      }
      for (const uid of this.allResourceUids(kind)) {
        if (this.resourceDirExists(kind, uid)) {
          addPath(`${root}/${uid}`, 'dir');
          if (this.resourceFileListed(kind, uid)) {
            addPath(this.workspace.resourcePath(uid, kind), 'file');
          }
        }
      }
    }
    for (const file of this.generated().keys()) {
      addPath(file, 'file');
    }
    return [...listing.entries()]
      .map(([name, kind]) => ({ name, type: kind }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  /** Every existing file path, used for glob expansion and search commands. */
  allPaths(): string[] {
    const key = this.pathsKey();
    if (this.pathsCache?.key !== key) {
      this.pathsCache = { key, paths: this.computeAllPaths() };
    }
    return this.pathsCache.paths;
  }

  private computeAllPaths(): string[] {
    const paths = new Set<string>(['/']);
    for (const root of this.workspace.mountRoots()) {
      for (const dir of [...ancestorDirs(root), root]) {
        paths.add(dir);
      }
    }
    for (const file of this.allScratchFiles()) {
      paths.add(file);
      ancestorDirs(file).forEach((dir) => paths.add(dir));
    }
    for (const dir of this.allScratchDirs()) {
      paths.add(dir);
    }
    for (const kind of this.workspace.resourceKinds()) {
      for (const uid of this.allResourceUids(kind)) {
        if (this.resourceDirExists(kind, uid) && this.resourceFileListed(kind, uid)) {
          paths.add(`${RESOURCE_KINDS[kind].root}/${uid}`);
          paths.add(this.workspace.resourcePath(uid, kind));
        }
      }
    }
    for (const file of this.generated().keys()) {
      paths.add(file);
      ancestorDirs(file).forEach((dir) => paths.add(dir));
    }
    return [...paths].sort();
  }

  // Writes ------------------------------------------------------------------

  async writeFile(rawPath: string, content: string) {
    this.assertOpen();
    const path = normalizeWorkspacePath(rawPath);
    const target = this.workspace.classify(path);
    this.mutations++;

    if (target.type === 'scratch') {
      if (path === target.mount) {
        throw new WorkspaceError('EISDIR', `illegal operation on a directory, write '${path}'`);
      }
      if (this.scratchDirExists(path)) {
        throw new WorkspaceError('EISDIR', `illegal operation on a directory, write '${path}'`);
      }
      for (const dir of ancestorDirs(path)) {
        if (isWithin(dir, target.mount) && dir !== target.mount && this.scratchContent(dir) !== undefined) {
          throw new WorkspaceError('ENOTDIR', `not a directory, write '${path}'`);
        }
      }
      this.files.set(path, content);
      return;
    }
    if (target.type === 'resource') {
      // Resource documents end with a newline like fetched ones; scripts that drop it would change every file's last line.
      content = content.endsWith('\n') ? content : `${content}\n`;
      const { kind, uid } = target;
      let entry = this.workspace.getResource(uid, kind);
      if ((entry && !entry.overlay && !isBaseLoaded(entry)) || (!entry && this.workspace.isIndexed(uid, kind))) {
        // Writing over an unfetched resource still needs its base for the diff and revision precondition.
        entry = await this.remoteWait(this.workspace.hydrate(uid, this.signal, kind));
      }
      if (entry?.base?.meta.managedBy) {
        throw new WorkspaceError(
          'EROFS',
          `read-only file system, write '${path}' (managed by ${entry.base.meta.managedBy}; change it in its source)`
        );
      }
      this.resources.set(resourceKey(kind, uid), content);
      return;
    }
    if (target.type === 'generated' && this.generated().get(path)?.writable) {
      this.files.set(path, content);
      return;
    }
    throw this.readOnly(path, 'write');
  }

  async appendFile(rawPath: string, content: string) {
    const path = normalizeWorkspacePath(rawPath);
    let current = '';
    try {
      current = await this.readFile(path);
    } catch (error) {
      if (!(error instanceof WorkspaceError && error.code === 'ENOENT')) {
        throw error;
      }
    }
    await this.writeFile(path, current + content);
  }

  async mkdir(rawPath: string, options: { recursive?: boolean } = {}) {
    this.assertOpen();
    const path = normalizeWorkspacePath(rawPath);
    this.mutations++;
    const existing = await this.entryType(path);
    if (existing) {
      if (options.recursive && existing === 'dir') {
        return;
      }
      throw new WorkspaceError('EEXIST', `file already exists, mkdir '${path}'`);
    }
    const target = this.workspace.classify(path);
    if (target.type === 'resource-dir') {
      // Creating a resource directory is allowed; it becomes real once dashboard.json is written.
      return;
    }
    if (target.type !== 'scratch') {
      throw this.readOnly(path, 'mkdir');
    }
    const parent = parentPath(path);
    if (!options.recursive && (await this.entryType(parent)) !== 'dir') {
      throw new WorkspaceError('ENOENT', `no such file or directory, mkdir '${path}'`);
    }
    for (const dir of [...ancestorDirs(path), path]) {
      if (isWithin(dir, target.mount) && dir !== target.mount) {
        if (this.scratchContent(dir) !== undefined) {
          throw new WorkspaceError('ENOTDIR', `not a directory, mkdir '${path}'`);
        }
        this.dirsAdded.add(dir);
        this.dirsRemoved.delete(dir);
      }
    }
  }

  async rm(rawPath: string, options: { recursive?: boolean; force?: boolean } = {}) {
    this.assertOpen();
    const path = normalizeWorkspacePath(rawPath);
    this.mutations++;
    const type = await this.entryType(path);
    if (!type) {
      if (options.force) {
        return;
      }
      throw new WorkspaceError('ENOENT', `no such file or directory, rm '${path}'`);
    }
    const target = this.workspace.classify(path);
    if (target.type === 'resource' || target.type === 'resource-dir') {
      if (target.type === 'resource-dir' && !options.recursive) {
        throw new WorkspaceError('EISDIR', `is a directory, rm '${path}'`);
      }
      const { kind, uid } = target;
      let entry = this.workspace.getResource(uid, kind);
      if (!entry?.base && this.workspace.isIndexed(uid, kind)) {
        // A deletion needs the base revision as its precondition.
        entry = await this.remoteWait(this.workspace.hydrate(uid, this.signal, kind));
      }
      if (entry?.base?.meta.managedBy) {
        throw new WorkspaceError(
          'EROFS',
          `read-only file system, rm '${path}' (managed by ${entry.base.meta.managedBy}; change it in its source)`
        );
      }
      // Deleting a mounted resource stages a reviewable tombstone.
      this.resources.set(resourceKey(kind, uid), null);
      return;
    }
    if (target.type === 'generated' && this.generated().get(path)?.writable) {
      // Removing a writable generated file drops its local overlay.
      this.files.set(path, null);
      return;
    }
    if (target.type !== 'scratch' || path === target.mount) {
      throw this.readOnly(path, 'rm');
    }
    if (type === 'file') {
      this.files.set(path, null);
      return;
    }
    const children = [...this.allScratchFiles(), ...this.allScratchDirs()].filter(
      (candidate) => candidate !== path && isWithin(candidate, path)
    );
    if (children.length > 0 && !options.recursive) {
      throw new WorkspaceError('ENOTEMPTY', `directory not empty, rm '${path}'`);
    }
    for (const child of children) {
      if (this.scratchContent(child) !== undefined) {
        this.files.set(child, null);
      } else {
        this.dirsAdded.delete(child);
        this.dirsRemoved.add(child);
      }
    }
    this.dirsAdded.delete(path);
    this.dirsRemoved.add(path);
  }

  async cp(rawSrc: string, rawDest: string, options: { recursive?: boolean } = {}) {
    const src = normalizeWorkspacePath(rawSrc);
    const dest = normalizeWorkspacePath(rawDest);
    const type = await this.entryType(src);
    if (!type) {
      throw new WorkspaceError('ENOENT', `no such file or directory, cp '${src}'`);
    }
    if (type === 'file') {
      await this.writeFile(dest, await this.readFile(src));
      return;
    }
    if (!options.recursive) {
      throw new WorkspaceError('EISDIR', `is a directory, cp '${src}'`);
    }
    await this.mkdir(dest, { recursive: true });
    for (const child of await this.readdir(src)) {
      await this.cp(joinPath(src, child.name), joinPath(dest, child.name), options);
    }
  }

  async mv(rawSrc: string, rawDest: string) {
    const src = normalizeWorkspacePath(rawSrc);
    const dest = normalizeWorkspacePath(rawDest);
    if (src === dest) {
      return;
    }
    const srcTarget = this.workspace.classify(src);
    if (srcTarget.type !== 'scratch' && srcTarget.type !== 'resource') {
      throw this.readOnly(src, 'rename');
    }
    await this.cp(src, dest, { recursive: true });
    await this.rm(src, { recursive: true });
  }

  // Commit ------------------------------------------------------------------

  hasChanges() {
    return this.files.size > 0 || this.resources.size > 0 || this.dirsAdded.size > 0 || this.dirsRemoved.size > 0;
  }

  /** Current invocation state, including writes not yet committed. */
  view() {
    this.assertOpen();
    const view = this.workspace.snapshot();
    view.applyCommitted(this.files, this.dirsAdded, this.dirsRemoved, this.resources);
    return view;
  }

  /** Whether this transaction staged a write or deletion of the resource. */
  stagedResource(uid: string, kind: WorkspaceResourceKind = 'dashboard') {
    return this.resources.has(resourceKey(kind, uid));
  }

  stagedFile(path: string) {
    this.assertOpen();
    return this.scratchContent(normalizeWorkspacePath(path));
  }

  async discardResource(path: string) {
    const target = this.workspace.classify(path);
    if (target.type !== 'resource' && target.type !== 'resource-dir') {
      throw new WorkspaceError('EPERM', `only resource working copies can be discarded: ${path}`);
    }
    const entry = this.view().getResource(target.uid, target.kind);
    if (!entry?.overlay) {
      return false;
    }
    if (entry.base) {
      await this.writeFile(entry.path, entry.base.content);
    } else {
      await this.rm(entry.path, { force: true });
    }
    return true;
  }

  committedChanges() {
    return mergeChanges(this.checkpointed);
  }

  /**
   * Validates the staged changes as a unit and applies them. Nothing is
   * applied if any check fails.
   */
  commit(): WorkspaceFileChange[] {
    this.assertOpen();
    this.closed = true;
    return mergeChanges([...this.checkpointed, ...this.applyStaged()]);
  }

  /**
   * Validates and applies the changes staged so far while keeping the
   * transaction open. Only explicit apply commands cross this boundary;
   * status and diff use view() without committing. Checkpointed changes are no longer discarded if the
   * invocation later times out.
   */
  checkpoint(): WorkspaceFileChange[] {
    this.assertOpen();
    this.mutations++;
    const changes = this.applyStaged();
    this.checkpointed.push(...changes);
    return changes;
  }

  private applyStaged(): WorkspaceFileChange[] {
    const limits = this.workspace.limits;
    const changes: WorkspaceFileChange[] = [];
    const effectiveFiles = new Map<string, string | null>();

    for (const [path, content] of this.files) {
      const before = this.workspace.getScratchFile(path)?.content;
      if (content === null && before === undefined) {
        continue;
      }
      if (content !== null && content === before) {
        continue;
      }
      effectiveFiles.set(path, content);
      changes.push({
        path,
        change: content === null ? 'deleted' : before === undefined ? 'created' : 'modified',
        bytes: content === null ? 0 : utf8ByteLength(content),
        revision: content === null ? undefined : contentRevision(content),
      });
    }

    const effectiveResources = new Map<string, string | null>();
    for (const [key, content] of this.resources) {
      const { kind, uid } = parseResourceKey(key);
      const entry = this.workspace.getResource(uid, kind);
      const before = entry ? this.workspace.resourceContent(entry) : undefined;
      if (content === before || (content === null && before === undefined)) {
        continue;
      }
      effectiveResources.set(key, content);
      changes.push({
        path: this.workspace.resourcePath(uid, kind),
        change: content === null ? 'deleted' : before === undefined ? 'created' : 'modified',
        bytes: content === null ? 0 : utf8ByteLength(content),
        revision: content === null ? undefined : contentRevision(content),
      });
    }

    let persistedBytes = this.workspace.usage().persistedBytes;
    for (const [path, content] of effectiveFiles) {
      if (!isPersistedScratch(path)) {
        continue;
      }
      const before = this.workspace.getScratchFile(path);
      persistedBytes +=
        (content === null ? 0 : utf8ByteLength(content)) - (before ? utf8ByteLength(before.content) : 0);
    }
    if (persistedBytes > limits.maxWorkspaceBytes) {
      throw new WorkspaceError(
        'EQUOTA',
        `files under /workspace and /session exceed the stored session budget (${persistedBytes}/${limits.maxWorkspaceBytes} bytes); keep large intermediate files in /tmp`
      );
    }

    const dirsAdded = new Set([...this.dirsAdded].filter((dir) => !this.workspace.scratchDirs().has(dir)));
    const dirsRemoved = new Set([...this.dirsRemoved].filter((dir) => this.workspace.scratchDirs().has(dir)));
    if (changes.length > 0 || dirsAdded.size > 0 || dirsRemoved.size > 0) {
      this.workspace.applyCommitted(effectiveFiles, dirsAdded, dirsRemoved, effectiveResources);
    }
    this.files.clear();
    this.resources.clear();
    this.dirsAdded.clear();
    this.dirsRemoved.clear();
    return changes.sort((left, right) => left.path.localeCompare(right.path));
  }

  abort() {
    this.closed = true;
  }

  // Internals ---------------------------------------------------------------

  private assertOpen() {
    if (this.closed) {
      throw new WorkspaceError('EPERM', 'workspace transaction is closed');
    }
    if (this.signal?.aborted) {
      throw new WorkspaceError('EPERM', 'workspace operation was aborted');
    }
  }

  private scratchContent(path: string): string | undefined {
    if (this.files.has(path)) {
      return this.files.get(path) ?? undefined;
    }
    return this.workspace.getScratchFile(path)?.content;
  }

  private scratchDirExists(path: string) {
    if (SCRATCH_MOUNTS.includes(path as (typeof SCRATCH_MOUNTS)[number])) {
      return true;
    }
    if (this.dirsRemoved.has(path)) {
      return false;
    }
    if (this.dirsAdded.has(path) || this.workspace.scratchDirs().has(path)) {
      return true;
    }
    return this.allScratchFiles().some((file) => isWithin(file, path) && file !== path);
  }

  private allScratchFiles() {
    const files = new Set(this.workspace.scratchFiles().keys());
    for (const [path, content] of this.files) {
      if (content === null) {
        files.delete(path);
      } else {
        files.add(path);
      }
    }
    return [...files];
  }

  private allScratchDirs() {
    const dirs = new Set(this.workspace.scratchDirs());
    this.dirsAdded.forEach((dir) => dirs.add(dir));
    this.dirsRemoved.forEach((dir) => dirs.delete(dir));
    return [...dirs];
  }

  private allResourceUids(kind: WorkspaceResourceKind) {
    const uids = new Set(this.workspace.indexedUids(kind));
    this.workspace.resourceEntries(kind).forEach((entry) => uids.add(entry.uid));
    this.resources.forEach((_content, key) => {
      const staged = parseResourceKey(key);
      if (staged.kind === kind) {
        uids.add(staged.uid);
      }
    });
    return [...uids].sort();
  }

  private resourceDirExists(kind: WorkspaceResourceKind, uid: string) {
    const key = resourceKey(kind, uid);
    const staged = this.resources.has(key) ? this.resources.get(key) : undefined;
    if (staged !== undefined) {
      return staged !== null;
    }
    const entry = this.workspace.getResource(uid, kind);
    if (entry) {
      return entry.overlay?.content !== null;
    }
    return this.workspace.isIndexed(uid, kind);
  }

  /** Whether the document is listed: indexed resources are listed before their content is fetched. */
  private resourceFileListed(kind: WorkspaceResourceKind, uid: string) {
    const key = resourceKey(kind, uid);
    if (this.resources.has(key)) {
      return this.resources.get(key) !== null;
    }
    const entry = this.workspace.getResource(uid, kind);
    if (entry) {
      return this.workspace.resourceContent(entry) !== undefined || this.workspace.isIndexed(uid, kind);
    }
    return this.workspace.isIndexed(uid, kind);
  }

  private async resourceContent(
    kind: WorkspaceResourceKind,
    uid: string,
    hydrate: boolean
  ): Promise<string | undefined> {
    const key = resourceKey(kind, uid);
    if (this.resources.has(key)) {
      return this.resources.get(key) ?? undefined;
    }
    let entry = this.workspace.getResource(uid, kind);
    const needsHydration = !entry || (!entry.overlay && !isBaseLoaded(entry));
    if (hydrate && needsHydration && !this.hydrationAttempts.has(key)) {
      this.hydrationAttempts.add(key);
      if (this.workspace.isIndexed(uid, kind)) {
        this.noteResourceMiss(kind);
      }
      try {
        entry = await this.remoteWait(this.workspace.hydrate(uid, this.signal, kind));
      } catch (error) {
        if (error instanceof WorkspaceError) {
          throw error;
        }
        // A missing or unreadable remote resource behaves like a missing file.
      }
    }
    return entry ? this.workspace.resourceContent(entry) : undefined;
  }

  /**
   * Several unloaded resources touched in one invocation (a recursive search, a
   * glob, xargs, a loop) mean a scan: load the rest of the index in parallel.
   */
  private noteResourceMiss(kind: WorkspaceResourceKind) {
    const misses = (this.hydrationMisses.get(kind) ?? 0) + 1;
    this.hydrationMisses.set(kind, misses);
    if (misses === SCAN_DETECTION_MISSES) {
      this.workspace.prefetchInBackground(kind);
    }
  }

  private hydrationHint(kind: WorkspaceResourceKind, uid: string) {
    if (this.workspace.getResource(uid, kind)?.overlay?.content === null) {
      return ' (staged for deletion)';
    }
    return kind === 'dashboard'
      ? ` (dashboard ${uid} was not found or is not readable; use \`grafana search\` to find UIDs)`
      : ` (alert rule ${uid} was not found or is not readable; see /grafana/catalog/alert-rules.ndjson)`;
  }

  private generated() {
    if (!this.generatedFiles) {
      this.generatedFiles = this.workspace.generatedFiles();
    }
    return this.generatedFiles;
  }

  refreshGeneratedFiles() {
    this.mutations++;
    this.generatedFiles = undefined;
    this.generatedCache.delete('/artifacts/index.ndjson');
  }

  /** Drops the cached content of a generated file so the next read loads it again (after a remote change). */
  forgetGenerated(path: string) {
    this.generatedCache.delete(normalizeWorkspacePath(path));
  }

  /** Local overlay of a writable generated file, staged or committed. */
  private generatedOverlay(path: string) {
    return this.generated().get(path)?.writable ? this.scratchContent(path) : undefined;
  }

  private async generatedContent(path: string) {
    const file = this.generated().get(path);
    if (!file) {
      return undefined;
    }
    if (file.content !== undefined) {
      return file.content;
    }
    if (this.generatedCache.has(path)) {
      return this.generatedCache.get(path);
    }
    const content = (await file.load?.(this.signal)) ?? '';
    this.generatedCache.set(path, content);
    return content;
  }

  private missingOrDir(path: string, op: string) {
    if (this.workspace.isVirtualDir(path) || this.scratchDirExists(path)) {
      return new WorkspaceError('EISDIR', `illegal operation on a directory, ${op} '${path}'`);
    }
    return new WorkspaceError('ENOENT', `no such file or directory, ${op} '${path}'`);
  }

  private readOnly(path: string, op: string) {
    const target = this.workspace.classify(path);
    const hint =
      target.type === 'generated'
        ? ' (generated, read-only mount)'
        : target.type === 'none' || target.type === 'virtual'
          ? ' (writable locations: /workspace, /session, /tmp, /grafana/dashboards/<uid>/dashboard.json, /grafana/alert-rules/<uid>/rule.json, /live/dashboard/dashboard.json)'
          : '';
    return new WorkspaceError('EROFS', `read-only file system, ${op} '${path}'${hint}`);
  }
}

const EMPTY_UIDS: readonly string[] = [];

function parseResourceKey(key: string): { kind: WorkspaceResourceKind; uid: string } {
  const separator = key.indexOf(':');
  return { kind: key.slice(0, separator) as WorkspaceResourceKind, uid: key.slice(separator + 1) };
}

/** Restored unmodified resources keep metadata only; their content is refetched on first read. */
export function isBaseLoaded(entry: WorkspaceResourceEntry) {
  return Boolean(entry.base && entry.base.content !== '');
}

/** Combines per-checkpoint change lists into one entry per path (a created file stays "created"). */
function mergeChanges(changes: WorkspaceFileChange[]) {
  const byPath = new Map<string, WorkspaceFileChange>();
  for (const change of changes) {
    const previous = byPath.get(change.path);
    if (previous?.change === 'created' && change.change === 'deleted') {
      byPath.delete(change.path);
      continue;
    }
    byPath.set(change.path, previous?.change === 'created' ? { ...change, change: 'created' } : change);
  }
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function isPersistedScratch(path: string) {
  return PERSISTED_SCRATCH_MOUNTS.some((mount) => isWithin(path, mount));
}

function serializeOverlay(entry: WorkspaceResourceEntry): PersistedWorkspace['resources'][number]['overlay'] {
  const overlay = entry.overlay!;
  const base = entry.base?.content;
  if (overlay.content === null || base === undefined || base === '') {
    return { content: overlay.content, updatedAt: overlay.updatedAt };
  }
  const patch = createPatch(entry.path, base, overlay.content, undefined, undefined, { context: 0 });
  // Keep the full copy when a patch would not be smaller (for example a complete rewrite).
  return patch.length < overlay.content.length
    ? { patch, updatedAt: overlay.updatedAt }
    : { content: overlay.content, updatedAt: overlay.updatedAt };
}

function restoreOverlay(
  overlay: PersistedWorkspace['resources'][number]['overlay'],
  base: string | undefined
): WorkspaceResourceEntry['overlay'] {
  if (!overlay || typeof overlay !== 'object') {
    return undefined;
  }
  const updatedAt = typeof overlay.updatedAt === 'string' ? overlay.updatedAt : new Date().toISOString();
  if (typeof overlay.patch === 'string' && base !== undefined) {
    const content = applyPatch(base, overlay.patch);
    return typeof content === 'string' ? { content, updatedAt } : undefined;
  }
  if (overlay.content === null || typeof overlay.content === 'string') {
    return { content: overlay.content, updatedAt };
  }
  return undefined;
}

function metaFileContent(entry: WorkspaceResourceEntry) {
  const meta = entry.base!.meta;
  return `${JSON.stringify({ ...meta, writable: !meta.managedBy, localChange: entry.overlay ? 'modified' : 'none' }, null, 2)}\n`;
}
