import React, { useMemo, useState } from 'react';
import { css, cx } from '@emotion/css';
import type { GrafanaTheme2 } from '@grafana/data';
import { Alert, Badge, Button, Checkbox, Input, Modal, useStyles2 } from '@grafana/ui';
import { testIds } from '../../components/testIds';
import type { WorkspaceApprovalOperation, WorkspaceApprovalRequest, WorkspaceChangeGroup } from './workspace/broker';

/** Diffs of change sets up to this size start expanded. */
const AUTO_EXPAND_OPERATIONS = 3;
/** Dashboards listed per group before "show all". */
const GROUP_PATH_PREVIEW = 8;

type Props = {
  request?: WorkspaceApprovalRequest;
  /** `paths` lists the checked dashboards when the reviewer unchecked some. */
  onApprove: (paths?: string[]) => void;
  onDeny: () => void;
};

/**
 * Review of a dashboard change set before it is written to Grafana. Large
 * change sets are reviewed through their repeated replacements, a folder-grouped
 * dashboard list with per-dashboard diffs, and checkboxes to leave dashboards out.
 */
export function ChangeSetReviewModal({ request, onApprove, onDeny }: Props) {
  const styles = useStyles2(getStyles);
  return (
    <Modal
      title={request?.title ?? 'Review dashboard changes'}
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
  const folders = useMemo(() => groupByFolder(operations, filter), [operations, filter]);
  const totals = useMemo(
    () => ({
      additions: operations.reduce((sum, operation) => sum + operation.additions, 0),
      deletions: operations.reduce((sum, operation) => sum + operation.deletions, 0),
      folders: new Set(operations.map((operation) => operation.folderUid ?? '')).size,
    }),
    [operations]
  );
  const setPaths = (paths: string[], checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      paths.forEach((path) => (checked ? next.add(path) : next.delete(path)));
      return next;
    });
  const visiblePaths = folders.flatMap((folder) => folder.operations.map((operation) => operation.path));
  const approve = () =>
    onApprove(
      selected.size === operations.length ? undefined : operations.map((o) => o.path).filter((p) => selected.has(p))
    );

  return (
    <div className={styles.review} data-testid={testIds.chat.toolConfirmation}>
      <div className={styles.body}>
        <Alert severity="warning" title="Persistent Grafana write">
          The checked dashboards are saved to Grafana as you. Each one is saved only if it has not changed since the
          assistant fetched it. Unchecked dashboards keep the change in the chat workspace. To undo later, ask the
          assistant to revert <code>{request.applyId}</code>.
        </Alert>

        <div className={styles.summary}>
          <strong>
            {operations.length} dashboard{operations.length === 1 ? '' : 's'}
          </strong>
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
            <h4 className={styles.sectionTitle}>Dashboards</h4>
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
            {folders.map((folder) => (
              <div key={folder.key} className={styles.folder}>
                {totals.folders > 1 && (
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
            {folders.length === 0 && <div className={styles.empty}>No dashboard matches the filter.</div>}
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
          {group.count}× in {group.paths.length} dashboard{group.paths.length === 1 ? '' : 's'}
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
          {allChecked ? 'Uncheck these dashboards' : 'Check these dashboards'}
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

function groupByFolder(operations: WorkspaceApprovalOperation[], filter: string) {
  const needle = filter.trim().toLowerCase();
  const folders = new Map<string, { key: string; title: string; operations: WorkspaceApprovalOperation[] }>();
  for (const operation of operations) {
    const title = operation.folderTitle || (operation.folderUid ? operation.folderUid : 'Dashboards');
    if (needle && ![operation.title, operation.uid, title].some((value) => value?.toLowerCase().includes(needle))) {
      continue;
    }
    const key = operation.folderUid ?? '';
    const folder = folders.get(key) ?? { key, title, operations: [] };
    folder.operations.push(operation);
    folders.set(key, folder);
  }
  return [...folders.values()].sort((left, right) => left.title.localeCompare(right.title));
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
