import { createTwoFilesPatch } from 'diff';
import type { WorkspaceApprovalService, WorkspaceBroker } from './broker';
import { validateDashboardDocument } from './dashboardModel';
import { canonicalJson, sha256Hex } from './hash';
import type { PromqlParser } from './promqlCheck';
import { truncateUtf8 } from './paths';
import type { WorkspaceApplyRecord, WorkspacePlan, WorkspacePlanOperation } from './types';
import type { SessionWorkspace } from './workspace';

const MAX_PLAN_DIFF_BYTES = 60_000;
const MAX_PLAN_OPERATIONS = 50;

export class PlanError extends Error {}

export async function createWorkspacePlan(
  workspace: SessionWorkspace,
  options: { paths?: string[]; allowedDatasourceUids?: string[]; promql?: PromqlParser; signal?: AbortSignal } = {}
): Promise<WorkspacePlan> {
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
      throw new PlanError(`no staged resource changes at: ${unknown.join(', ')}`);
    }
  }
  if (entries.length === 0) {
    throw new PlanError('no staged resource changes; edit /grafana/dashboards/<uid>/dashboard.json first');
  }
  if (entries.length > MAX_PLAN_OPERATIONS) {
    throw new PlanError(
      `plan would contain ${entries.length} operations; select at most ${MAX_PLAN_OPERATIONS} with --path`
    );
  }

  const operations: WorkspacePlanOperation[] = [];
  const documents: Record<string, string | null> = {};
  const diffs: string[] = [];
  for (const entry of entries) {
    const after = entry.overlay!.content;
    const before = entry.base?.content;
    const meta = entry.base?.meta;
    const operation: WorkspacePlanOperation['operation'] = after === null ? 'delete' : entry.base ? 'update' : 'create';
    let title = meta?.title;
    let folderUid = meta?.folderUid;
    let apiVersion = meta?.apiVersion ?? 'dashboard.grafana.app/v1';
    let validation: WorkspacePlanOperation['validation'] = { ok: true, errors: [], warnings: [] };
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
    throw new PlanError(`validation failed; fix these errors and run \`workspace plan\` again:\n${details}`);
  }

  const digest = sha256Hex(canonicalJson({ version: 1, operations, documents }));
  const plan: WorkspacePlan = {
    id: `plan-${digest.slice(0, 12)}`,
    createdAt: new Date().toISOString(),
    digest,
    operations,
    documents,
    diff: truncateUtf8(diffs.join('\n'), MAX_PLAN_DIFF_BYTES).text,
  };
  workspace.addPlan(plan);
  return plan;
}

/** Checks that a plan still describes the current working copies and bases. */
export function stalePlanReasons(workspace: SessionWorkspace, plan: WorkspacePlan) {
  const reasons: string[] = [];
  const recomputed = sha256Hex(
    canonicalJson({
      version: 1,
      operations: plan.operations,
      documents: plan.documents,
    })
  );
  if (recomputed !== plan.digest) {
    reasons.push('plan digest does not match its contents');
  }
  for (const operation of plan.operations) {
    const entry = workspace.getResource(operation.uid);
    const current = entry?.overlay ? entry.overlay.content : undefined;
    const expected = plan.documents[operation.path];
    if (!entry?.overlay || current !== expected) {
      reasons.push(`${operation.path} changed since the plan was created`);
      continue;
    }
    if (entry.base?.meta.resourceVersion !== operation.baseResourceVersion) {
      reasons.push(`${operation.path} base revision changed since the plan was created`);
    }
  }
  return reasons;
}

export async function applyWorkspacePlan(
  workspace: SessionWorkspace,
  planId: string,
  deps: { broker: WorkspaceBroker; approvals?: WorkspaceApprovalService; signal?: AbortSignal }
): Promise<WorkspaceApplyRecord> {
  const plan = workspace.getPlan(planId);
  if (!plan) {
    throw new PlanError(`unknown plan ${planId}; run \`workspace plan\` to create one`);
  }
  const previous = workspace.applyJournal().find((record) => record.digest === plan.digest && record.approved);
  if (previous && previous.results.every((result) => result.outcome === 'applied')) {
    return previous;
  }
  const stale = stalePlanReasons(workspace, plan);
  if (stale.length > 0) {
    throw new PlanError(`plan ${plan.id} is stale: ${stale.join('; ')}. Run \`workspace plan\` again.`);
  }
  const dashboards = deps.broker.dashboards;
  if (!dashboards) {
    throw new PlanError('dashboard writes are not available in this session');
  }
  if (!deps.approvals) {
    throw new PlanError('no approval channel is available; changes cannot be applied from this session');
  }

  const record: WorkspaceApplyRecord = {
    planId: plan.id,
    digest: plan.digest,
    startedAt: new Date().toISOString(),
    approved: false,
    results: plan.operations.map((operation) => ({
      path: operation.path,
      uid: operation.uid,
      operation: operation.operation,
      outcome: 'not attempted',
    })),
  };

  const decision = await deps.approvals.request(
    {
      planId: plan.id,
      digest: plan.digest,
      title: `Apply ${plan.operations.length} dashboard change${plan.operations.length === 1 ? '' : 's'}`,
      summary: plan.operations
        .map((operation) => `${operation.operation} ${operation.uid}${operation.title ? ` (${operation.title})` : ''}`)
        .join('\n'),
      operations: plan.operations.map((operation) => ({
        operation: operation.operation,
        uid: operation.uid,
        title: operation.title,
        path: operation.path,
        warnings: operation.validation.warnings.length,
      })),
      diff: plan.diff,
    },
    deps.signal
  );
  if (!decision.approved) {
    record.finishedAt = new Date().toISOString();
    workspace.recordApply(record);
    throw new PlanError(`plan ${plan.id} was not approved${decision.reason ? `: ${decision.reason}` : ''}`);
  }
  record.approved = true;

  // Re-check after the (possibly long) approval wait: edits made meanwhile invalidate the approval.
  const staleAfterApproval = stalePlanReasons(workspace, plan);
  if (staleAfterApproval.length > 0) {
    record.finishedAt = new Date().toISOString();
    workspace.recordApply(record);
    throw new PlanError(`plan ${plan.id} changed while waiting for approval: ${staleAfterApproval.join('; ')}`);
  }

  for (const [index, operation] of plan.operations.entries()) {
    if (deps.signal?.aborted) {
      break;
    }
    const result = record.results[index];
    try {
      const document = plan.documents[operation.path];
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
