import { createTwoFilesPatch } from 'diff';
import type { WorkspaceApprovalService, WorkspaceBroker } from './broker';
import { validateDashboardDocument } from './dashboardModel';
import { canonicalJson, sha256Hex } from './hash';
import type { PromqlParser } from './promqlCheck';
import type { WorkspaceApplyRecord, WorkspaceChanges, WorkspaceWriteOperation } from './types';
import type { SessionWorkspace } from './workspace';

const MAX_APPLY_OPERATIONS = 50;

export class ApplyError extends Error {}

async function prepareChanges(
  workspace: SessionWorkspace,
  options: { paths?: string[]; allowedDatasourceUids?: string[]; promql?: PromqlParser; signal?: AbortSignal } = {}
): Promise<WorkspaceChanges> {
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
  if (entries.length > MAX_APPLY_OPERATIONS) {
    throw new ApplyError(
      `apply would contain ${entries.length} operations; select at most ${MAX_APPLY_OPERATIONS} with --path`
    );
  }

  const operations: WorkspaceWriteOperation[] = [];
  const documents: Record<string, string | null> = {};
  const diffs: string[] = [];
  for (const entry of entries) {
    const after = entry.overlay!.content;
    const before = entry.base?.content;
    const meta = entry.base?.meta;
    const operation: WorkspaceWriteOperation['operation'] =
      after === null ? 'delete' : entry.base ? 'update' : 'create';
    let title = meta?.title;
    let folderUid = meta?.folderUid;
    let apiVersion = meta?.apiVersion ?? 'dashboard.grafana.app/v1';
    let validation: WorkspaceWriteOperation['validation'] = { ok: true, errors: [], warnings: [] };
    if (after !== null) {
      const report = await validateDashboardDocument(after, {
        expectedUid: entry.uid,
        allowedDatasourceUids: options.allowedDatasourceUids,
        managedBy: meta?.managedBy,
        promql: options.promql,
        signal: options.signal,
      });
      validation = {
        ok: report.ok,
        errors: report.errors.map((error) => `${error.level}${error.path ? ` ${error.path}` : ''}: ${error.message}`),
        warnings: report.warnings.map(
          (warning) => `${warning.level}${warning.path ? ` ${warning.path}` : ''}: ${warning.message}`
        ),
      };
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
    operations.push({
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
    });
    documents[entry.path] = after;
    diffs.push(
      createTwoFilesPatch(
        before !== undefined ? `a${entry.path}` : '/dev/null',
        after !== null ? `b${entry.path}` : '/dev/null',
        before ?? '',
        after ?? '',
        meta?.resourceVersion ? `resourceVersion ${meta.resourceVersion}` : undefined,
        undefined,
        { context: 3 }
      )
    );
  }

  const failing = operations.filter((operation) => !operation.validation.ok);
  if (failing.length > 0) {
    const details = failing
      .map((operation) => `${operation.path}:\n  ${operation.validation.errors.join('\n  ')}`)
      .join('\n');
    throw new ApplyError(`validation failed; fix these errors and run \`workspace apply\` again:\n${details}`);
  }

  const digest = sha256Hex(canonicalJson({ version: 1, operations, documents }));
  const changes: WorkspaceChanges = {
    id: `apply-${digest.slice(0, 12)}`,
    createdAt: new Date().toISOString(),
    digest,
    operations,
    documents,
    diff: diffs.join('\n'),
  };
  return changes;
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
      operation: operation.operation,
      outcome: 'not attempted',
    })),
  };

  const decision = await deps.approvals.request(
    {
      applyId: changes.id,
      digest: changes.digest,
      title: `Apply ${changes.operations.length} dashboard change${changes.operations.length === 1 ? '' : 's'}`,
      summary: changes.operations
        .map((operation) => `${operation.operation} ${operation.uid}${operation.title ? ` (${operation.title})` : ''}`)
        .join('\n'),
      operations: changes.operations.map((operation) => ({
        operation: operation.operation,
        uid: operation.uid,
        title: operation.title,
        path: operation.path,
        warnings: operation.validation.warnings.length,
      })),
      diff: changes.diff,
    },
    deps.signal
  );
  if (!decision.approved) {
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

  for (const [index, operation] of changes.operations.entries()) {
    if (deps.signal?.aborted) {
      break;
    }
    const result = record.results[index];
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
  }
  record.finishedAt = new Date().toISOString();
  workspace.recordApply(record);
  return record;
}
