import { applyPatch, createTwoFilesPatch, parsePatch, reversePatch, type StructuredPatch } from 'diff';
import type { WorkspaceApprovalOperation, WorkspaceApprovalService, WorkspaceBroker } from './broker';
import { groupChanges } from './changeGroups';
import { validateDashboardDocument } from './dashboardModel';
import { canonicalJson, sha256Hex } from './hash';
import type { PromqlParser } from './promqlCheck';
import type { WorkspaceApplyRecord, WorkspaceChanges, WorkspaceResourceEntry, WorkspaceWriteOperation } from './types';
import { HYDRATION_CONCURRENCY, type SessionWorkspace } from './workspace';

/** Parallel validations and dashboard writes of one apply. */
const APPLY_CONCURRENCY = HYDRATION_CONCURRENCY;

export class ApplyError extends Error {}

type PreparedChanges = WorkspaceChanges & {
  /** Per-operation review data, in operation order. */
  review: WorkspaceApprovalOperation[];
};

type ValidationOptions = { allowedDatasourceUids?: string[]; promql?: PromqlParser; signal?: AbortSignal };

async function prepareChanges(
  workspace: SessionWorkspace,
  options: ValidationOptions & { paths?: string[] } = {}
): Promise<PreparedChanges> {
  const selected = new Set(options.paths ?? []);
  const entries = workspace
    .resourceEntries()
    .filter((entry) => entry.overlay)
    .filter(
      (entry) =>
        selected.size === 0 || selected.has(entry.path) || selected.has(entry.path.replace(/\/dashboard\.json$/, ''))
    );
  if (selected.size > 0) {
    const known = new Set(entries.flatMap((entry) => [entry.path, entry.path.replace(/\/dashboard\.json$/, '')]));
    const unknown = [...selected].filter((path) => !known.has(path));
    if (unknown.length > 0) {
      throw new ApplyError(`no staged resource changes at: ${unknown.join(', ')}`);
    }
  }
  if (entries.length === 0) {
    throw new ApplyError('no staged resource changes; edit /grafana/dashboards/<uid>/dashboard.json first');
  }

  const prepared = await mapConcurrent(entries, (entry) => prepareOperation(workspace, entry, options));
  const operations = prepared.map((item) => item.operation);
  const documents: Record<string, string | null> = {};
  prepared.forEach((item) => (documents[item.operation.path] = item.after));

  const failing = operations.filter((operation) => !operation.validation.ok);
  if (failing.length > 0) {
    const details = failing
      .map((operation) => `${operation.path}:\n  ${operation.validation.errors.join('\n  ')}`)
      .join('\n');
    throw new ApplyError(
      `validation failed for ${failing.length} of ${operations.length} dashboard${operations.length === 1 ? '' : 's'}; fix these errors (errors the fetched dashboard already had do not block), or leave the dashboards out with --path, and run \`workspace apply\` again:\n${details}`
    );
  }

  const digest = sha256Hex(canonicalJson({ version: 1, operations, documents }));
  return {
    id: `apply-${digest.slice(0, 12)}`,
    createdAt: new Date().toISOString(),
    digest,
    operations,
    documents,
    diff: prepared.map((item) => item.review.diff).join('\n'),
    review: prepared.map((item) => item.review),
  };
}

async function prepareOperation(
  workspace: SessionWorkspace,
  entry: WorkspaceResourceEntry,
  options: ValidationOptions
) {
  const after = entry.overlay!.content;
  const before = entry.base?.content;
  const meta = entry.base?.meta;
  const operation: WorkspaceWriteOperation['operation'] = after === null ? 'delete' : entry.base ? 'update' : 'create';
  let title = meta?.title;
  let folderUid = meta?.folderUid;
  let apiVersion = meta?.apiVersion ?? 'dashboard.grafana.app/v1';
  let validation: WorkspaceWriteOperation['validation'] = { ok: true, errors: [], warnings: [] };
  let preexistingErrors: string[] = [];
  if (after !== null) {
    const report = await validate(after, entry, options);
    // Mass edits touch dashboards that were already invalid; only errors the change introduces block it.
    const baseErrors = before !== undefined ? new Set((await validate(before, entry, options)).errors) : new Set();
    const introduced = report.errors.filter((error) => !baseErrors.has(error));
    preexistingErrors = report.errors.filter((error) => baseErrors.has(error));
    validation = { ok: introduced.length === 0, errors: introduced, warnings: report.warnings };
    try {
      const parsed = JSON.parse(after);
      title = typeof parsed?.spec?.title === 'string' ? parsed.spec.title : title;
      folderUid = parsed?.metadata?.annotations?.['grafana.app/folder'] ?? folderUid;
      apiVersion = typeof parsed?.apiVersion === 'string' ? parsed.apiVersion : apiVersion;
    } catch {
      // Reported by validation.
    }
  } else if (meta?.managedBy) {
    validation = { ok: false, errors: [`policy: dashboard is managed by ${meta.managedBy}`], warnings: [] };
  }
  const diff = createTwoFilesPatch(
    before !== undefined ? `a${entry.path}` : '/dev/null',
    after !== null ? `b${entry.path}` : '/dev/null',
    before ?? '',
    after ?? '',
    meta?.resourceVersion ? `resourceVersion ${meta.resourceVersion}` : undefined,
    undefined,
    { context: 3 }
  );
  const writeOperation: WorkspaceWriteOperation = {
    path: entry.path,
    kind: entry.kind,
    uid: entry.uid,
    operation,
    title,
    folderUid,
    apiVersion,
    baseResourceVersion: meta?.resourceVersion,
    beforeHash: before !== undefined ? sha256Hex(before) : undefined,
    afterHash: after !== null ? sha256Hex(after) : undefined,
    validation,
  };
  const { additions, deletions } = countChangedLines(diff);
  const review: WorkspaceApprovalOperation = {
    operation,
    uid: entry.uid,
    path: entry.path,
    title,
    folderUid,
    folderTitle: workspace.describeIndexed(entry.uid)?.folderTitle,
    additions,
    deletions,
    diff,
    warnings: validation.warnings,
    preexistingErrors,
  };
  return { operation: writeOperation, after, before, review };
}

async function validate(content: string, entry: WorkspaceResourceEntry, options: ValidationOptions) {
  const report = await validateDashboardDocument(content, {
    expectedUid: entry.uid,
    allowedDatasourceUids: options.allowedDatasourceUids,
    managedBy: entry.base?.meta.managedBy,
    promql: options.promql,
    signal: options.signal,
  });
  return {
    errors: report.errors.map((error) => `${error.level}${error.path ? ` ${error.path}` : ''}: ${error.message}`),
    warnings: report.warnings.map(
      (warning) => `${warning.level}${warning.path ? ` ${warning.path}` : ''}: ${warning.message}`
    ),
  };
}

function countChangedLines(diff: string) {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      additions++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      deletions++;
    }
  }
  return { additions, deletions };
}

/** Checks that an approval still describes the current working copies and bases. */
export function staleChangeReasons(workspace: SessionWorkspace, changes: WorkspaceChanges) {
  const reasons: string[] = [];
  const recomputed = sha256Hex(
    canonicalJson({
      version: 1,
      operations: changes.operations,
      documents: changes.documents,
    })
  );
  if (recomputed !== changes.digest) {
    reasons.push('change digest does not match its contents');
  }
  for (const operation of changes.operations) {
    const entry = workspace.getResource(operation.uid);
    const current = entry?.overlay ? entry.overlay.content : undefined;
    const expected = changes.documents[operation.path];
    if (!entry?.overlay || current !== expected) {
      reasons.push(`${operation.path} changed since the approval was requested`);
      continue;
    }
    if (entry.base?.meta.resourceVersion !== operation.baseResourceVersion) {
      reasons.push(`${operation.path} base revision changed since the approval was requested`);
    }
  }
  return reasons;
}

export async function applyWorkspaceChanges(
  workspace: SessionWorkspace,
  deps: { broker: WorkspaceBroker; approvals?: WorkspaceApprovalService; signal?: AbortSignal; paths?: string[] }
): Promise<WorkspaceApplyRecord> {
  const changes = await prepareChanges(workspace, {
    paths: deps.paths,
    allowedDatasourceUids: deps.broker.dashboards?.allowedDatasourceUids?.(),
    promql: deps.broker.promql,
    signal: deps.signal,
  });
  const dashboards = deps.broker.dashboards;
  if (!dashboards) {
    throw new ApplyError('dashboard writes are not available in this session');
  }
  if (!deps.approvals) {
    throw new ApplyError('no approval channel is available; changes cannot be applied from this session');
  }

  const record: WorkspaceApplyRecord = {
    applyId: changes.id,
    diff: changes.diff,
    digest: changes.digest,
    startedAt: new Date().toISOString(),
    approved: false,
    results: changes.operations.map((operation) => ({
      path: operation.path,
      uid: operation.uid,
      title: operation.title,
      operation: operation.operation,
      outcome: 'not attempted',
      baseResourceVersion: operation.baseResourceVersion,
    })),
  };

  const count = changes.operations.length;
  const { groups, ungroupedChanges } = groupChanges(
    changes.operations.map((operation) => ({
      path: operation.path,
      before: workspace.getResource(operation.uid)?.base?.content ?? '',
      after: changes.documents[operation.path] ?? '',
    }))
  );
  const decision = await deps.approvals.request(
    {
      applyId: changes.id,
      digest: changes.digest,
      title: `Apply ${count} dashboard change${count === 1 ? '' : 's'}`,
      summary: changes.operations
        .map((operation) => `${operation.operation} ${operation.uid}${operation.title ? ` (${operation.title})` : ''}`)
        .join('\n'),
      operations: changes.review,
      groups,
      ungroupedChanges,
    },
    deps.signal
  );
  const kept = decision.paths ? new Set(decision.paths) : undefined;
  if (!decision.approved || kept?.size === 0) {
    record.finishedAt = new Date().toISOString();
    workspace.recordApply(record);
    throw new ApplyError(`changes ${changes.id} was not approved${decision.reason ? `: ${decision.reason}` : ''}`);
  }
  record.approved = true;

  // Re-check after the (possibly long) approval wait: edits made meanwhile invalidate the approval.
  const staleAfterApproval = staleChangeReasons(workspace, changes);
  if (staleAfterApproval.length > 0) {
    record.finishedAt = new Date().toISOString();
    workspace.recordApply(record);
    throw new ApplyError(`changes ${changes.id} changed while waiting for approval: ${staleAfterApproval.join('; ')}`);
  }

  await mapConcurrent([...changes.operations.entries()], async ([index, operation]) => {
    const result = record.results[index];
    if (kept && !kept.has(operation.path)) {
      result.outcome = 'declined';
      return;
    }
    if (deps.signal?.aborted) {
      return;
    }
    try {
      const document = changes.documents[operation.path];
      const write =
        operation.operation === 'delete'
          ? await dashboards.delete(operation.uid, operation.baseResourceVersion, deps.signal)
          : operation.operation === 'create'
            ? await dashboards.create(JSON.parse(document!), deps.signal)
            : await dashboards.update(JSON.parse(document!), operation.baseResourceVersion ?? '', deps.signal);
      result.outcome = write.outcome;
      result.error = write.error;
      result.url = write.url;
      result.resourceVersion = write.snapshot?.meta.resourceVersion;
      if (write.outcome === 'applied') {
        workspace.reconcileResource(operation.uid, operation.operation === 'delete' ? undefined : write.snapshot);
      }
    } catch (error) {
      result.outcome = deps.signal?.aborted ? 'unknown' : 'failed';
      result.error = error instanceof Error ? error.message : String(error);
    }
  });
  record.finishedAt = new Date().toISOString();
  workspace.recordApply(record);
  return record;
}

/**
 * Stages the dashboards of an earlier apply as they were before it: the
 * receipt's diff is reversed onto the current dashboard, so exactly the applied
 * change is undone and later edits by others are kept. Created dashboards are
 * staged for deletion. Receipts whose diff was dropped from the journal fall
 * back to the previous version from Grafana's history. The result is reviewed
 * and applied like any change with `workspace apply`.
 */
export async function stageRevert(
  workspace: SessionWorkspace,
  deps: {
    broker: WorkspaceBroker;
    applyId: string;
    paths?: string[];
    write: (path: string, content: string | null) => Promise<void>;
    /** Local changes as the invocation sees them, including writes staged earlier in it. */
    hasLocalChanges: (uid: string) => boolean;
    signal?: AbortSignal;
  }
) {
  const dashboards = deps.broker.dashboards;
  if (!dashboards) {
    throw new ApplyError('dashboard access is not available in this session');
  }
  const record = workspace.applyJournal().find((receipt) => receipt.applyId === deps.applyId);
  if (!record) {
    throw new ApplyError(`no apply receipt ${deps.applyId}; see \`workspace receipts\``);
  }
  const selected = deps.paths?.length ? new Set(deps.paths) : undefined;
  const targets = record.results.filter(
    (result) => result.outcome === 'applied' && (!selected || selected.has(result.path))
  );
  if (targets.length === 0) {
    throw new ApplyError(`apply ${deps.applyId} has no applied changes to revert`);
  }
  const patches = new Map<string, StructuredPatch>();
  for (const patch of record.diff ? parsePatch(record.diff) : []) {
    const name = patch.newFileName && patch.newFileName !== '/dev/null' ? patch.newFileName : patch.oldFileName;
    patches.set(name?.replace(/^[ab]\//, '/') ?? '', patch);
  }
  const staged: string[] = [];
  const errors: Array<{ path: string; error: string }> = [];
  await mapConcurrent(targets, async (result) => {
    try {
      if (deps.hasLocalChanges(result.uid)) {
        throw new Error('has local changes; discard or apply them first');
      }
      // Revert against the dashboard as it is now, not a copy fetched before the apply.
      const current = await dashboards.get(result.uid, deps.signal);
      if (current) {
        workspace.setResourceBase(current);
      }
      if (result.operation === 'create') {
        if (!current) {
          throw new Error('the dashboard no longer exists');
        }
        await deps.write(result.path, null);
      } else if (result.operation === 'update') {
        if (!current) {
          throw new Error('the dashboard no longer exists');
        }
        await deps.write(result.path, await previousContent(result, current.content, current.meta.apiVersion));
      } else {
        throw new Error('deleted dashboards cannot be restored from here; restore them from Grafana');
      }
      staged.push(result.path);
    } catch (error) {
      errors.push({ path: result.path, error: error instanceof Error ? error.message : String(error) });
    }
  });
  return { staged: staged.sort(), errors };

  async function previousContent(
    result: WorkspaceApplyRecord['results'][number],
    current: string,
    apiVersion: string | undefined
  ) {
    const patch = patches.get(result.path);
    if (patch) {
      const reverted = applyPatch(current, reversePatch(patch));
      if (reverted === false) {
        throw new Error('the dashboard changed since the apply in the same lines; revert it by hand');
      }
      return reverted;
    }
    if (!result.baseResourceVersion || !dashboards!.version) {
      throw new Error('the receipt no longer holds the diff or the previous revision');
    }
    const previous = await dashboards!.version(result.uid, result.baseResourceVersion, apiVersion, deps.signal);
    if (!previous) {
      throw new Error(`revision ${result.baseResourceVersion} is not in the dashboard's version history`);
    }
    return previous.content;
  }
}

async function mapConcurrent<T, R>(items: readonly T[], worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(APPLY_CONCURRENCY, items.length) }, run));
  return results;
}
