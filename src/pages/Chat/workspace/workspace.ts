import { contentRevision } from './hash';
import { ancestorDirs, isWithin, joinPath, normalizeWorkspacePath, parentPath, utf8ByteLength } from './paths';
import {
  DEFAULT_WORKSPACE_LIMITS,
  type GeneratedFile,
  type GeneratedMount,
  type PersistedWorkspace,
  type WorkspaceApplyRecord,
  type WorkspaceChangeStatus,
  type WorkspaceFileChange,
  type WorkspaceLimits,
  type WorkspaceResourceEntry,
  type WorkspaceResourceSnapshot,
  type WorkspaceScratchFile,
} from './types';

export const SCRATCH_MOUNTS = ['/workspace', '/session', '/tmp'] as const;
export const DASHBOARDS_ROOT = '/grafana/dashboards';
export const DASHBOARD_DOCUMENT = 'dashboard.json';
export const DASHBOARD_META = 'meta.json';
const PERSISTED_SCRATCH_MOUNTS = ['/workspace', '/session'];
const RESOURCE_UID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_JOURNAL = 50;
const MAX_JOURNAL_BYTES = 16 * 1024 * 1024;

export type WorkspacePathClass =
  | { type: 'scratch'; mount: string }
  | { type: 'resource'; kind: 'dashboard'; uid: string }
  | { type: 'resource-dir'; kind: 'dashboard'; uid: string }
  | { type: 'generated'; mount: string }
  | { type: 'virtual' }
  | { type: 'none' };

export type ResourceHydrator = (
  kind: 'dashboard',
  uid: string,
  signal?: AbortSignal
) => Promise<WorkspaceResourceSnapshot | undefined>;

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
  private listeners = new Set<() => void>();
  private revisionCounter = 0;

  constructor(limits: Partial<WorkspaceLimits> = {}) {
    this.limits = { ...DEFAULT_WORKSPACE_LIMITS, ...limits };
  }

  get revision() {
    return this.revisionCounter;
  }

  setHydrator(hydrator: ResourceHydrator | undefined) {
    this.hydrator = hydrator;
  }

  setGeneratedMounts(mounts: GeneratedMount[]) {
    this.generated = [...mounts].sort((left, right) => right.root.length - left.root.length);
  }

  generatedMounts() {
    return this.generated;
  }

  /** Runs mount preparation; a mount that fails to prepare stays empty for this call. */
  async prepareMounts(signal?: AbortSignal) {
    await Promise.all(this.generated.map((mount) => mount.prepare?.(signal).catch(() => undefined)));
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
    if (isWithin(path, DASHBOARDS_ROOT) && path !== DASHBOARDS_ROOT) {
      const rest = path.slice(DASHBOARDS_ROOT.length + 1).split('/');
      const uid = rest[0];
      if (RESOURCE_UID_PATTERN.test(uid)) {
        if (rest.length === 1) {
          return { type: 'resource-dir', kind: 'dashboard', uid };
        }
        if (rest.length === 2 && rest[1] === DASHBOARD_DOCUMENT) {
          return { type: 'resource', kind: 'dashboard', uid };
        }
        if (rest.length === 2 && rest[1] === DASHBOARD_META) {
          return { type: 'generated', mount: DASHBOARDS_ROOT };
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
    const roots = [...SCRATCH_MOUNTS, DASHBOARDS_ROOT, ...this.generated.map((mount) => mount.root)];
    return roots.some((root) => root === path || isWithin(root, path));
  }

  mountRoots() {
    return [...SCRATCH_MOUNTS, DASHBOARDS_ROOT, ...this.generated.map((mount) => mount.root)];
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

  getResource(uid: string) {
    return this.resources.get(uid);
  }

  resourceEntries() {
    return [...this.resources.values()].sort((left, right) => left.uid.localeCompare(right.uid));
  }

  resourcePath(uid: string) {
    return `${DASHBOARDS_ROOT}/${uid}/${DASHBOARD_DOCUMENT}`;
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
        const meta = entry.base.meta;
        files.set(`${DASHBOARDS_ROOT}/${entry.uid}/${DASHBOARD_META}`, {
          content: `${JSON.stringify(
            {
              ...meta,
              writable: !meta.managedBy,
              localChange: entry.overlay ? 'modified' : 'none',
            },
            null,
            2
          )}\n`,
        });
      }
    }
    return files;
  }

  /**
   * Stores or replaces a canonical remote snapshot. Refuses to replace the base
   * of a resource with local changes unless `discardOverlay` is set.
   */
  setResourceBase(snapshot: WorkspaceResourceSnapshot, options: { discardOverlay?: boolean } = {}) {
    const uid = snapshot.meta.uid;
    if (!RESOURCE_UID_PATTERN.test(uid)) {
      throw new WorkspaceError('EPERM', `invalid resource UID ${JSON.stringify(uid)}`);
    }
    const existing = this.resources.get(uid);
    if (existing?.overlay && !options.discardOverlay) {
      throw new WorkspaceError(
        'ECONFLICT',
        `${this.resourcePath(uid)} has local changes; run \`workspace discard ${this.resourcePath(uid)}\` before refreshing`
      );
    }
    if (!existing && this.resources.size >= this.limits.maxResources) {
      throw new WorkspaceError('EQUOTA', `workspace already holds ${this.limits.maxResources} resources`);
    }
    this.resources.set(uid, {
      kind: 'dashboard',
      uid,
      path: this.resourcePath(uid),
      base: snapshot,
      overlay: options.discardOverlay ? undefined : existing?.overlay,
    });
    this.changed();
  }

  /** Replaces a resource's base after a successful remote write and clears its overlay. */
  reconcileResource(uid: string, snapshot: WorkspaceResourceSnapshot | undefined) {
    if (!snapshot) {
      this.resources.delete(uid);
    } else {
      this.resources.set(uid, { kind: 'dashboard', uid, path: this.resourcePath(uid), base: snapshot });
    }
    this.changed();
  }

  discard(path: string) {
    const normalized = normalizeWorkspacePath(path);
    const target = this.classify(normalized);
    if (target.type === 'resource' || target.type === 'resource-dir') {
      const entry = this.resources.get(target.uid);
      if (!entry?.overlay) {
        return false;
      }
      if (entry.base) {
        this.resources.set(target.uid, { ...entry, overlay: undefined });
      } else {
        this.resources.delete(target.uid);
      }
      this.changed();
      return true;
    }
    throw new WorkspaceError('EPERM', `only resource working copies can be discarded: ${normalized}`);
  }

  /**
   * Loads a resource snapshot through the hydrator when it is absent, or when
   * it was restored from storage without content. Working copies with local
   * changes always keep their base content, so they are never rehydrated.
   */
  async hydrate(uid: string, signal?: AbortSignal) {
    const existing = this.resources.get(uid);
    if (existing && (existing.overlay || isBaseLoaded(existing))) {
      return existing;
    }
    if (!this.hydrator) {
      return existing;
    }
    const snapshot = await this.hydrator('dashboard', uid, signal);
    if (!snapshot) {
      return existing;
    }
    this.setResourceBase(snapshot);
    return this.resources.get(uid);
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
        uid: entry.uid,
        change: content === null ? 'deleted' : entry.base ? 'modified' : 'created',
        resourceVersion: entry.base?.meta.resourceVersion,
        bytes: content === null ? 0 : utf8ByteLength(content),
      });
    }
    return changes;
  }

  usage() {
    let scratchBytes = 0;
    let tmpBytes = 0;
    for (const [path, file] of this.files) {
      const bytes = utf8ByteLength(file.content);
      scratchBytes += bytes;
      if (isWithin(path, '/tmp')) {
        tmpBytes += bytes;
      }
    }
    let overlayBytes = 0;
    for (const entry of this.resources.values()) {
      if (entry.overlay?.content) {
        overlayBytes += utf8ByteLength(entry.overlay.content);
      }
    }
    return {
      files: this.files.size,
      resources: this.resources.size,
      scratchBytes,
      tmpBytes,
      overlayBytes,
      totalBytes: scratchBytes + overlayBytes,
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
    copy.journal = [...this.journal];
    return copy;
  }

  begin(options: { cwd?: string; signal?: AbortSignal } = {}) {
    return new WorkspaceTransaction(this, options.signal);
  }

  /** Applies a validated transaction. Only {@link WorkspaceTransaction.commit} calls this. */
  applyCommitted(
    files: Map<string, string | null>,
    dirsAdded: Set<string>,
    dirsRemoved: Set<string>,
    resources: Map<string, string | null>
  ) {
    const now = Date.now();
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
    for (const [uid, content] of resources) {
      const entry = this.resources.get(uid);
      if (content === null) {
        if (entry?.base) {
          this.resources.set(uid, { ...entry, overlay: { content: null, updatedAt: new Date(now).toISOString() } });
        } else {
          this.resources.delete(uid);
        }
        continue;
      }
      if (entry?.base && entry.base.content === content) {
        this.resources.set(uid, { ...entry, overlay: undefined });
        continue;
      }
      this.resources.set(uid, {
        kind: 'dashboard',
        uid,
        path: this.resourcePath(uid),
        base: entry?.base,
        overlay: { content, updatedAt: new Date(now).toISOString() },
      });
    }
    this.changed();
  }

  // Apply journal ----------------------------------------------------------

  recordApply(record: WorkspaceApplyRecord) {
    this.journal = [...this.journal.filter((existing) => existing !== record), record].slice(-MAX_JOURNAL);
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
      resources: this.resourceEntries().map((entry) => ({
        kind: entry.kind,
        uid: entry.uid,
        // Unmodified snapshots are cheap to refetch; keep bases only where an
        // overlay needs them for diffs and revision preconditions.
        base: entry.base
          ? { meta: entry.base.meta, content: entry.overlay ? entry.base.content : undefined }
          : undefined,
        overlay: entry.overlay,
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
      if (!resource || resource.kind !== 'dashboard' || !RESOURCE_UID_PATTERN.test(resource.uid)) {
        continue;
      }
      workspace.resources.set(resource.uid, {
        kind: 'dashboard',
        uid: resource.uid,
        path: workspace.resourcePath(resource.uid),
        base: resource.base ? { meta: resource.base.meta, content: resource.base.content ?? '' } : undefined,
        overlay: resource.overlay,
      });
    }
    if (options.trusted !== false) {
      workspace.journal = Array.isArray(data.journal) ? data.journal.slice(-MAX_JOURNAL) : [];
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
  private resources = new Map<string, string | null>();
  private dirsAdded = new Set<string>();
  private dirsRemoved = new Set<string>();
  private generatedCache = new Map<string, string>();
  private generatedFiles?: Map<string, GeneratedFile>;
  private hydrationAttempts = new Set<string>();
  private writtenBytes = 0;
  private closed = false;
  private checkpointed: WorkspaceFileChange[] = [];

  constructor(
    readonly workspace: SessionWorkspace,
    private readonly signal?: AbortSignal
  ) {}

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
        const content = await this.resourceContent(target.uid, true);
        if (content === undefined) {
          throw new WorkspaceError(
            'ENOENT',
            `no such file or directory, open '${path}'${this.hydrationHint(target.uid)}`
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
        return (await this.resourceContent(target.uid, true)) !== undefined ? 'file' : undefined;
      case 'resource-dir':
        return this.resourceDirExists(target.uid) ? 'dir' : undefined;
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
    for (const uid of this.allResourceUids()) {
      if (this.resourceDirExists(uid)) {
        addPath(`${DASHBOARDS_ROOT}/${uid}`, 'dir');
        if ((await this.resourceContent(uid, false)) !== undefined) {
          addPath(this.workspace.resourcePath(uid), 'file');
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
    for (const uid of this.allResourceUids()) {
      const content = this.syncResourceContent(uid);
      if (content !== undefined) {
        paths.add(`${DASHBOARDS_ROOT}/${uid}`);
        paths.add(this.workspace.resourcePath(uid));
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
    const bytes = utf8ByteLength(content);
    if (bytes > this.workspace.limits.maxFileBytes) {
      throw new WorkspaceError(
        'EQUOTA',
        `file exceeds ${this.workspace.limits.maxFileBytes} bytes, write '${path}' (${bytes} bytes)`
      );
    }
    this.writtenBytes += bytes;
    if (this.writtenBytes > this.workspace.limits.maxInvocationWriteBytes) {
      throw new WorkspaceError(
        'EQUOTA',
        `invocation wrote more than ${this.workspace.limits.maxInvocationWriteBytes} bytes, write '${path}'`
      );
    }

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
      const entry = this.workspace.getResource(target.uid);
      if (entry?.base?.meta.managedBy) {
        throw new WorkspaceError(
          'EROFS',
          `read-only file system, write '${path}' (managed by ${entry.base.meta.managedBy}; change it in its source)`
        );
      }
      if (entry && !entry.overlay && !isBaseLoaded(entry)) {
        await this.workspace.hydrate(target.uid, this.signal);
      }
      this.resources.set(target.uid, content);
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
      const entry = this.workspace.getResource(target.uid);
      if (entry?.base?.meta.managedBy) {
        throw this.readOnly(path, 'rm');
      }
      // Deleting a mounted resource stages a reviewable tombstone.
      this.resources.set(target.uid, null);
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

  stagedFile(path: string) {
    this.assertOpen();
    return this.scratchContent(normalizeWorkspacePath(path));
  }

  async discardResource(path: string) {
    const target = this.workspace.classify(path);
    if (target.type !== 'resource' && target.type !== 'resource-dir') {
      throw new WorkspaceError('EPERM', `only resource working copies can be discarded: ${path}`);
    }
    const entry = this.view().getResource(target.uid);
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
    for (const [uid, content] of this.resources) {
      const entry = this.workspace.getResource(uid);
      const before = entry ? this.workspace.resourceContent(entry) : undefined;
      if (content === before || (content === null && before === undefined)) {
        continue;
      }
      effectiveResources.set(uid, content);
      changes.push({
        path: this.workspace.resourcePath(uid),
        change: content === null ? 'deleted' : before === undefined ? 'created' : 'modified',
        bytes: content === null ? 0 : utf8ByteLength(content),
        revision: content === null ? undefined : contentRevision(content),
      });
    }

    const usage = this.workspace.usage();
    let fileCount = usage.files;
    let scratchBytes = usage.scratchBytes;
    let tmpBytes = usage.tmpBytes;
    for (const [path, content] of effectiveFiles) {
      const before = this.workspace.getScratchFile(path);
      const beforeBytes = before ? utf8ByteLength(before.content) : 0;
      const afterBytes = content === null ? 0 : utf8ByteLength(content);
      fileCount += (content === null ? 0 : 1) - (before ? 1 : 0);
      scratchBytes += afterBytes - beforeBytes;
      if (isWithin(path, '/tmp')) {
        tmpBytes += afterBytes - beforeBytes;
      }
    }
    let overlayBytes = usage.overlayBytes;
    let resourceCount = usage.resources;
    for (const [uid, content] of effectiveResources) {
      const entry = this.workspace.getResource(uid);
      overlayBytes +=
        (content ? utf8ByteLength(content) : 0) - (entry?.overlay?.content ? utf8ByteLength(entry.overlay.content) : 0);
      if (!entry) {
        resourceCount++;
      }
    }
    if (fileCount > limits.maxFiles) {
      throw new WorkspaceError('EQUOTA', `workspace file limit exceeded (${fileCount}/${limits.maxFiles} files)`);
    }
    if (tmpBytes > limits.maxTmpBytes) {
      throw new WorkspaceError('EQUOTA', `/tmp quota exceeded (${tmpBytes}/${limits.maxTmpBytes} bytes)`);
    }
    if (scratchBytes + overlayBytes > limits.maxWorkspaceBytes) {
      throw new WorkspaceError(
        'EQUOTA',
        `workspace quota exceeded (${scratchBytes + overlayBytes}/${limits.maxWorkspaceBytes} bytes)`
      );
    }
    if (resourceCount > limits.maxResources) {
      throw new WorkspaceError('EQUOTA', `workspace resource limit exceeded (${resourceCount}/${limits.maxResources})`);
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

  private allResourceUids() {
    const uids = new Set(this.workspace.resourceEntries().map((entry) => entry.uid));
    this.resources.forEach((_content, uid) => uids.add(uid));
    return [...uids].sort();
  }

  private resourceDirExists(uid: string) {
    const staged = this.resources.has(uid) ? this.resources.get(uid) : undefined;
    if (staged !== undefined) {
      return staged !== null;
    }
    const entry = this.workspace.getResource(uid);
    return Boolean(entry && entry.overlay?.content !== null);
  }

  private syncResourceContent(uid: string): string | undefined {
    if (this.resources.has(uid)) {
      return this.resources.get(uid) ?? undefined;
    }
    const entry = this.workspace.getResource(uid);
    return entry ? this.workspace.resourceContent(entry) : undefined;
  }

  private async resourceContent(uid: string, hydrate: boolean): Promise<string | undefined> {
    if (this.resources.has(uid)) {
      return this.resources.get(uid) ?? undefined;
    }
    let entry = this.workspace.getResource(uid);
    const needsHydration = !entry || (!entry.overlay && !isBaseLoaded(entry));
    if (hydrate && needsHydration && !this.hydrationAttempts.has(uid)) {
      this.hydrationAttempts.add(uid);
      try {
        entry = await this.workspace.hydrate(uid, this.signal);
      } catch (error) {
        if (error instanceof WorkspaceError) {
          throw error;
        }
        // A missing or unreadable remote resource behaves like a missing file.
      }
    }
    return entry ? this.workspace.resourceContent(entry) : undefined;
  }

  private hydrationHint(uid: string) {
    return this.workspace.getResource(uid)?.overlay?.content === null
      ? ' (staged for deletion)'
      : ` (dashboard ${uid} was not found or is not readable; use \`grafana search\` to find UIDs)`;
  }

  private generated() {
    if (!this.generatedFiles) {
      this.generatedFiles = this.workspace.generatedFiles();
    }
    return this.generatedFiles;
  }

  refreshGeneratedFiles() {
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
          ? ' (writable locations: /workspace, /session, /tmp, /grafana/dashboards/<uid>/dashboard.json, /live/dashboard/dashboard.json)'
          : '';
    return new WorkspaceError('EROFS', `read-only file system, ${op} '${path}'${hint}`);
  }
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
