import React, { useMemo, useState } from 'react';
import { css, cx } from '@emotion/css';
import type { GrafanaTheme2 } from '@grafana/data';
import { Alert, Badge, Button, Checkbox, Input, Modal, useStyles2 } from '@grafana/ui';
import { testIds } from '../../components/testIds';
import type { WorkspaceApprovalOperation, WorkspaceApprovalRequest, WorkspaceChangeGroup } from './workspace/broker';
import { describeResourceCounts, RESOURCE_KIND_NAMES, RESOURCE_KINDS, resourceAtPath } from './workspace/resourceKinds';
import type { WorkspaceResourceKind } from './workspace/types';

/** Diffs of change sets up to this size start expanded. */
const AUTO_EXPAND_OPERATIONS = 3;
/** Resources listed per group before "show all". */
const GROUP_PATH_PREVIEW = 8;
const SECTION_TITLES: Record<WorkspaceResourceKind, string> = { dashboard: 'Dashboards', alertRule: 'Alert rules' };

type Props = {
  request?: WorkspaceApprovalRequest;
  /** `paths` lists the checked resources when the reviewer unchecked some. */
  onApprove: (paths?: string[]) => void;
  onDeny: () => void;
};

/**
 * Review of a change set of dashboards and alert rules before it is written to
 * Grafana. Large change sets are reviewed through their repeated replacements, a
 * list per resource kind grouped by folder (and evaluation group for alert rules)
 * with per-resource diffs, and checkboxes to leave resources out.
 */
export function ChangeSetReviewModal({ request, onApprove, onDeny }: Props) {
  const styles = useStyles2(getStyles);
  return (
    <Modal
      title={request?.title ?? 'Review changes'}
      isOpen={Boolean(request)}
      closeOnEscape
      onDismiss={onDeny}
      className={styles.modal}
      contentClassName={styles.modalContent}
    >
      {request && <ChangeSetReview key={request.applyId} request={request} onApprove={onApprove} onDeny={onDeny} />}
    </Modal>
  );
}

function ChangeSetReview({
  request,
  onApprove,
  onDeny,
}: Required<Pick<Props, 'onApprove' | 'onDeny'>> & {
  request: WorkspaceApprovalRequest;
}) {
  const styles = useStyles2(getStyles);
  const operations = request.operations;
  const [selected, setSelected] = useState(() => new Set(operations.map((operation) => operation.path)));
  const [filter, setFilter] = useState('');
  const titles = useMemo(
    () => new Map(operations.map((operation) => [operation.path, operation.title || operation.uid])),
    [operations]
  );
  const sections = useMemo(() => groupOperations(operations, filter), [operations, filter]);
  const totals = useMemo(
    () => ({
      additions: operations.reduce((sum, operation) => sum + operation.additions, 0),
      deletions: operations.reduce((sum, operation) => sum + operation.deletions, 0),
      folders: new Set(operations.map((operation) => operation.folderUid ?? '')).size,
      groups: new Set(operations.map(groupKey)).size,
      kinds: countKinds(operations),
    }),
    [operations]
  );
  const hasAlertRules = Boolean(totals.kinds.alertRule);
  const checkedNoun = hasAlertRules
    ? totals.kinds.dashboard
      ? 'dashboards and alert rules are'
      : 'alert rules are'
    : 'dashboards are';
  const setPaths = (paths: string[], checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      paths.forEach((path) => (checked ? next.add(path) : next.delete(path)));
      return next;
    });
  const visiblePaths = sections.flatMap((section) =>
    section.folders.flatMap((folder) => folder.operations.map((operation) => operation.path))
  );
  const approve = () =>
    onApprove(
      selected.size === operations.length ? undefined : operations.map((o) => o.path).filter((p) => selected.has(p))
    );

  return (
    <div className={styles.review} data-testid={testIds.chat.toolConfirmation}>
      <div className={styles.body}>
        <Alert severity="warning" title="Persistent Grafana write">
          The checked {checkedNoun} saved to Grafana as you. Each one is saved only if it has not changed since the
          assistant fetched it
          {hasAlertRules ? ' (for alert rules, the assistant checks this right before saving; Grafana does not)' : ''}.
          Unchecked ones keep the change in the chat workspace. To undo later, ask the assistant to revert{' '}
          <code>{request.applyId}</code>.
        </Alert>

        <div className={styles.summary}>
          <strong>{describeResourceCounts(totals.kinds)}</strong>
          <span className={styles.additions}>+{totals.additions}</span>
          <span className={styles.deletions}>−{totals.deletions}</span>
          <span>
            {totals.folders} folder{totals.folders === 1 ? '' : 's'}
          </span>
          {request.groups.length > 0 && (
            <span>
              {request.groups.length} repeated change{request.groups.length === 1 ? '' : 's'}
              {request.ungroupedChanges > 0
                ? `, ${request.ungroupedChanges} other change${request.ungroupedChanges === 1 ? '' : 's'}`
                : ''}
            </span>
          )}
        </div>

        {request.groups.length > 0 && (
          <section className={styles.section}>
            <h4 className={styles.sectionTitle}>Repeated changes</h4>
            {request.groups.map((group) => (
              <ChangeGroupRow
                key={`${group.before}\u0000${group.after}`}
                group={group}
                titles={titles}
                selected={selected}
                onSelect={setPaths}
              />
            ))}
          </section>
        )}

        <section className={styles.section}>
          <div className={styles.listToolbar}>
            <h4 className={styles.sectionTitle}>Changes</h4>
            {operations.length > AUTO_EXPAND_OPERATIONS && (
              <>
                <Input
                  className={styles.filter}
                  placeholder="Filter by title, folder, or UID"
                  value={filter}
                  onChange={(event) => setFilter(event.currentTarget.value)}
                />
                <Button size="sm" variant="secondary" fill="text" onClick={() => setPaths(visiblePaths, true)}>
                  Check {filter ? 'shown' : 'all'}
                </Button>
                <Button size="sm" variant="secondary" fill="text" onClick={() => setPaths(visiblePaths, false)}>
                  Uncheck {filter ? 'shown' : 'all'}
                </Button>
              </>
            )}
          </div>
          <div className={styles.list} data-testid="workspace-apply-diff">
            {sections.map((section) => (
              <div key={section.kind} className={styles.list}>
                {sections.length > 1 || section.kind !== 'dashboard' ? (
                  <h5 className={styles.kindTitle}>{SECTION_TITLES[section.kind]}</h5>
                ) : null}
                {section.folders.map((folder) => (
                  <div key={folder.key} className={styles.folder}>
                    {(totals.groups > 1 || folder.group !== undefined) && (
                      <div className={styles.folderHeader}>
                        <Checkbox
                          value={folder.operations.every((operation) => selected.has(operation.path))}
                          indeterminate={
                            folder.operations.some((operation) => selected.has(operation.path)) &&
                            !folder.operations.every((operation) => selected.has(operation.path))
                          }
                          onChange={(event) =>
                            setPaths(
                              folder.operations.map((operation) => operation.path),
                              event.currentTarget.checked
                            )
                          }
                          label={`${folder.title} (${folder.operations.length})`}
                        />
                      </div>
                    )}
                    {folder.operations.map((operation) => (
                      <OperationRow
                        key={operation.path}
                        operation={operation}
                        checked={selected.has(operation.path)}
                        defaultOpen={operations.length <= AUTO_EXPAND_OPERATIONS}
                        onCheck={(checked) => setPaths([operation.path], checked)}
                      />
                    ))}
                  </div>
                ))}
              </div>
            ))}
            {sections.length === 0 && <div className={styles.empty}>Nothing matches the filter.</div>}
          </div>
        </section>
      </div>

      <div className={styles.actions}>
        <Button data-testid={testIds.chat.toolConfirmationDeny} icon="times" variant="secondary" onClick={onDeny}>
          Deny
        </Button>
        <Button
          data-testid={testIds.chat.toolConfirmationApprove}
          icon="check"
          variant="primary"
          disabled={selected.size === 0}
          onClick={approve}
        >
          {selected.size === operations.length
            ? `Apply ${operations.length === 1 ? 'change' : `all ${operations.length}`}`
            : `Apply ${selected.size} of ${operations.length}`}
        </Button>
      </div>
    </div>
  );
}

function ChangeGroupRow({
  group,
  titles,
  selected,
  onSelect,
}: {
  group: WorkspaceChangeGroup;
  titles: Map<string, string>;
  selected: Set<string>;
  onSelect: (paths: string[], checked: boolean) => void;
}) {
  const styles = useStyles2(getStyles);
  const [showAll, setShowAll] = useState(false);
  const allChecked = group.paths.every((path) => selected.has(path));
  const shown = showAll ? group.paths : group.paths.slice(0, GROUP_PATH_PREVIEW);
  return (
    <details className={styles.group}>
      <summary>
        <code className={styles.removed}>{group.before || '(empty)'}</code>
        <span className={styles.arrow}>→</span>
        <code className={styles.added}>{group.after || '(empty)'}</code>
        <span className={styles.muted}>
          {group.count}× in {describeResourceCounts(countKinds(group.paths.map((path) => ({ path }))))}
        </span>
      </summary>
      <div className={styles.groupBody}>
        <div className={styles.example}>
          <div className={styles.removedLine}>- {group.example.before}</div>
          <div className={styles.addedLine}>+ {group.example.after}</div>
          <div className={styles.muted}>Example from {titles.get(group.example.path) ?? group.example.path}</div>
        </div>
        <div className={styles.groupPaths}>
          {shown.map((path) => (
            <span key={path}>{titles.get(path) ?? path}</span>
          ))}
          {group.paths.length > shown.length && (
            <Button size="sm" variant="secondary" fill="text" onClick={() => setShowAll(true)}>
              and {group.paths.length - shown.length} more
            </Button>
          )}
        </div>
        <Button size="sm" variant="secondary" onClick={() => onSelect(group.paths, !allChecked)}>
          {allChecked ? 'Uncheck these' : 'Check these'}
        </Button>
      </div>
    </details>
  );
}

function OperationRow({
  operation,
  checked,
  defaultOpen,
  onCheck,
}: {
  operation: WorkspaceApprovalOperation;
  checked: boolean;
  defaultOpen: boolean;
  onCheck: (checked: boolean) => void;
}) {
  const styles = useStyles2(getStyles);
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details
      className={cx(styles.operation, !checked && styles.unchecked)}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className={styles.operationSummary}>
        <span onClick={(event) => event.stopPropagation()}>
          <Checkbox
            value={checked}
            onChange={(event) => onCheck(event.currentTarget.checked)}
            aria-label={`Apply ${operation.title ?? operation.uid}`}
          />
        </span>
        <span className={styles.operationTitle}>{operation.title || operation.uid}</span>
        <span className={styles.muted}>{operation.uid}</span>
        {operation.operation !== 'update' && (
          <Badge text={operation.operation} color={operation.operation === 'delete' ? 'red' : 'green'} />
        )}
        <span className={styles.additions}>+{operation.additions}</span>
        <span className={styles.deletions}>−{operation.deletions}</span>
        {operation.warnings.length > 0 && (
          <Badge
            text={`${operation.warnings.length} warning${operation.warnings.length === 1 ? '' : 's'}`}
            color="orange"
          />
        )}
        {operation.preexistingErrors.length > 0 && <Badge text="already had errors" color="purple" />}
      </summary>
      {open && (
        <div className={styles.operationBody}>
          {[
            ...operation.warnings.map((text) => `warning: ${text}`),
            ...operation.preexistingErrors.map((text) => `existing error: ${text}`),
          ].map((text) => (
            <div key={text} className={styles.muted}>
              {text}
            </div>
          ))}
          <DiffView diff={operation.diff} />
        </div>
      )}
    </details>
  );
}

function DiffView({ diff }: { diff: string }) {
  const styles = useStyles2(getStyles);
  const lines = useMemo(
    () => diff.split('\n').filter((line) => !line.startsWith('===') && !line.startsWith('Index:')),
    [diff]
  );
  return (
    <pre className={styles.diff}>
      {lines.map((line, index) => (
        <div
          key={index}
          className={cx(
            line.startsWith('+') && !line.startsWith('+++') && styles.addedLine,
            line.startsWith('-') && !line.startsWith('---') && styles.removedLine,
            line.startsWith('@@') && styles.hunkLine
          )}
        >
          {line || ' '}
        </div>
      ))}
    </pre>
  );
}

function operationKind(operation: { kind?: WorkspaceResourceKind; path: string }): WorkspaceResourceKind {
  return operation.kind ?? resourceAtPath(operation.path)?.kind ?? 'dashboard';
}

function countKinds(operations: Array<{ kind?: WorkspaceResourceKind; path: string }>) {
  const counts: Partial<Record<WorkspaceResourceKind, number>> = {};
  operations.forEach((operation) => {
    const kind = operationKind(operation);
    counts[kind] = (counts[kind] ?? 0) + 1;
  });
  return counts;
}

/** Alert rules are grouped by folder and evaluation group, dashboards by folder. */
function groupKey(operation: WorkspaceApprovalOperation) {
  return `${operationKind(operation)}\u0000${operation.folderUid ?? ''}\u0000${operation.group ?? ''}`;
}

type FolderGroup = { key: string; title: string; group?: string; operations: WorkspaceApprovalOperation[] };

function groupOperations(operations: WorkspaceApprovalOperation[], filter: string) {
  const needle = filter.trim().toLowerCase();
  const sections = new Map<WorkspaceResourceKind, Map<string, FolderGroup>>();
  for (const operation of operations) {
    const kind = operationKind(operation);
    const folderTitle = operation.folderTitle || operation.folderUid || RESOURCE_KINDS[kind].plural;
    const title = operation.group ? `${folderTitle} › ${operation.group}` : folderTitle;
    if (needle && ![operation.title, operation.uid, title].some((value) => value?.toLowerCase().includes(needle))) {
      continue;
    }
    const folders = sections.get(kind) ?? new Map<string, FolderGroup>();
    const key = groupKey(operation);
    const folder = folders.get(key) ?? { key, title, group: operation.group, operations: [] };
    folder.operations.push(operation);
    folders.set(key, folder);
    sections.set(kind, folders);
  }
  return RESOURCE_KIND_NAMES.filter((kind) => sections.has(kind)).map((kind) => ({
    kind,
    folders: [...sections.get(kind)!.values()].sort((left, right) => left.title.localeCompare(right.title)),
  }));
}

const getStyles = (theme: GrafanaTheme2) => {
  const addedBackground = theme.colors.success.transparent;
  const removedBackground = theme.colors.error.transparent;
  return {
    modal: css({
      width: 'min(1100px, calc(100vw - 32px))',
    }),
    modalContent: css({
      minHeight: 260,
      overflow: 'hidden',
    }),
    review: css({
      display: 'flex',
      flexDirection: 'column',
      gap: theme.spacing(2),
      maxHeight: 'calc(90vh - 120px)',
      minWidth: 0,
    }),
    body: css({
      display: 'grid',
      gap: theme.spacing(2),
      overflowY: 'auto',
      overflowX: 'hidden',
      minHeight: 0,
      minWidth: 0,
      '& > *': { minWidth: 0 },
    }),
    summary: css({
      display: 'flex',
      flexWrap: 'wrap',
      gap: theme.spacing(2),
      alignItems: 'baseline',
    }),
    section: css({
      display: 'grid',
      gap: theme.spacing(1),
    }),
    sectionTitle: css({
      margin: 0,
      fontSize: theme.typography.h5.fontSize,
    }),
    listToolbar: css({
      display: 'flex',
      alignItems: 'center',
      gap: theme.spacing(1),
      flexWrap: 'wrap',
    }),
    filter: css({
      width: 280,
      marginLeft: 'auto',
    }),
    list: css({
      display: 'grid',
      gap: theme.spacing(1),
      minWidth: 0,
    }),
    folder: css({
      display: 'grid',
      gap: theme.spacing(0.5),
    }),
    folderHeader: css({
      fontWeight: theme.typography.fontWeightMedium,
      paddingTop: theme.spacing(0.5),
    }),
    kindTitle: css({
      margin: 0,
      fontSize: theme.typography.body.fontSize,
      fontWeight: theme.typography.fontWeightMedium,
      color: theme.colors.text.secondary,
    }),
    group: css({
      border: `1px solid ${theme.colors.border.weak}`,
      borderRadius: theme.shape.radius.default,
      padding: theme.spacing(1),
      minWidth: 0,
      '& summary': {
        cursor: 'pointer',
        display: 'flex',
        flexWrap: 'wrap',
        gap: theme.spacing(1),
        alignItems: 'baseline',
        minWidth: 0,
      },
      '& code': {
        maxWidth: '100%',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
      },
    }),
    groupBody: css({
      display: 'grid',
      gap: theme.spacing(1),
      justifyItems: 'start',
      marginTop: theme.spacing(1),
    }),
    groupPaths: css({
      display: 'flex',
      flexWrap: 'wrap',
      gap: theme.spacing(0.5, 1.5),
      color: theme.colors.text.secondary,
      fontSize: theme.typography.bodySmall.fontSize,
    }),
    example: css({
      fontFamily: theme.typography.fontFamilyMonospace,
      fontSize: theme.typography.bodySmall.fontSize,
      overflowWrap: 'anywhere',
      width: '100%',
    }),
    operation: css({
      border: `1px solid ${theme.colors.border.weak}`,
      borderRadius: theme.shape.radius.default,
    }),
    unchecked: css({
      opacity: 0.6,
    }),
    operationSummary: css({
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      gap: theme.spacing(1),
      padding: theme.spacing(0.5, 1),
      flexWrap: 'wrap',
    }),
    operationTitle: css({
      fontWeight: theme.typography.fontWeightMedium,
    }),
    operationBody: css({
      display: 'grid',
      gap: theme.spacing(0.5),
      padding: theme.spacing(0, 1, 1),
    }),
    diff: css({
      margin: 0,
      maxHeight: 360,
      overflow: 'auto',
      padding: theme.spacing(1),
      border: `1px solid ${theme.colors.border.weak}`,
      borderRadius: theme.shape.radius.default,
      background: theme.colors.background.secondary,
      fontSize: theme.typography.bodySmall.fontSize,
      whiteSpace: 'pre-wrap',
      overflowWrap: 'anywhere',
    }),
    addedLine: css({
      background: addedBackground,
    }),
    removedLine: css({
      background: removedBackground,
    }),
    hunkLine: css({
      color: theme.colors.text.secondary,
    }),
    added: css({
      background: addedBackground,
      overflowWrap: 'anywhere',
    }),
    removed: css({
      background: removedBackground,
      overflowWrap: 'anywhere',
    }),
    arrow: css({
      color: theme.colors.text.secondary,
    }),
    additions: css({
      color: theme.colors.success.text,
    }),
    deletions: css({
      color: theme.colors.error.text,
    }),
    muted: css({
      color: theme.colors.text.secondary,
      fontSize: theme.typography.bodySmall.fontSize,
    }),
    empty: css({
      color: theme.colors.text.secondary,
      padding: theme.spacing(1),
    }),
    actions: css({
      display: 'flex',
      flexShrink: 0,
      paddingTop: theme.spacing(1),
      borderTop: `1px solid ${theme.colors.border.weak}`,
      justifyContent: 'flex-end',
      gap: theme.spacing(1),
      flexWrap: 'wrap',
    }),
  };
};
