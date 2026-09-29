import React from 'react';
import { css } from '@emotion/css';
import type { GrafanaTheme2 } from '@grafana/data';
import { useStyles2 } from '@grafana/ui';
import { testIds } from '../../components/testIds';
import type { CompletionCandidate } from './workspace/completion';

/** Candidates listed at once; more are summarized, and typing narrows them. */
const MAX_SHOWN = 60;

/**
 * Candidates of an ambiguous Tab completion in shell mode, like a shell's
 * listing after a second Tab. Clicking one completes it; typing more narrows it.
 */
export function ShellCompletions({
  candidates,
  onSelect,
}: {
  candidates: CompletionCandidate[];
  onSelect: (candidate: CompletionCandidate) => void;
}) {
  const styles = useStyles2(getStyles);
  const shown = candidates.slice(0, MAX_SHOWN);
  const described = shown.some((candidate) => candidate.description);
  return (
    <div className={styles.list} data-testid={testIds.chat.shellCompletions} role="listbox" aria-label="Completions">
      {shown.map((candidate) => (
        <button
          key={candidate.value}
          type="button"
          role="option"
          aria-selected={false}
          className={described ? styles.row : styles.cell}
          // Keep focus in the composer, like a shell completion list.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onSelect(candidate)}
        >
          <span className={candidate.kind === 'directory' ? styles.directory : styles.label}>{candidate.label}</span>
          {described && candidate.description && <span className={styles.description}>{candidate.description}</span>}
        </button>
      ))}
      {candidates.length > shown.length && (
        <div className={styles.more}>and {candidates.length - shown.length} more; type to narrow</div>
      )}
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => {
  const item = {
    display: 'flex',
    gap: theme.spacing(1.5),
    minWidth: 0,
    padding: theme.spacing(0.25, 0.75),
    border: 'none',
    borderRadius: theme.shape.radius.default,
    background: 'transparent',
    color: theme.colors.text.primary,
    font: 'inherit',
    textAlign: 'left' as const,
    cursor: 'pointer',
    '&:hover': { background: theme.colors.action.hover },
  };
  return {
    list: css({
      display: 'flex',
      flexWrap: 'wrap',
      gap: theme.spacing(0.25, 0.5),
      maxHeight: 200,
      overflowY: 'auto',
      padding: theme.spacing(0.5),
      border: `1px solid ${theme.colors.border.medium}`,
      borderRadius: theme.shape.radius.default,
      background: theme.colors.background.secondary,
      fontFamily: theme.typography.fontFamilyMonospace,
      fontSize: theme.typography.bodySmall.fontSize,
    }),
    cell: css(item),
    row: css({ ...item, flexBasis: '100%' }),
    label: css({ whiteSpace: 'nowrap' }),
    directory: css({ whiteSpace: 'nowrap', color: theme.colors.text.link }),
    description: css({
      color: theme.colors.text.secondary,
      fontFamily: theme.typography.fontFamily,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    }),
    more: css({
      flexBasis: '100%',
      padding: theme.spacing(0.25, 0.75),
      color: theme.colors.text.secondary,
    }),
  };
};
