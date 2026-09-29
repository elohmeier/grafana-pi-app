import React, { useEffect, useMemo, useRef, useState } from 'react';
import { css } from '@emotion/css';
import type { GrafanaTheme2 } from '@grafana/data';
import { Icon, useStyles2 } from '@grafana/ui';
import { testIds } from '../../components/testIds';
import { searchPromptHistory, searchPromptHistoryNewer } from './promptHistory';

type Props = {
  /** Earlier prompts and commands, newest first. */
  entries: string[];
  /** Puts the match into the composer for editing. */
  onAccept: (text: string) => void;
  onCancel: () => void;
};

/**
 * Reverse history search of the composer, like readline's Ctrl+R: typing
 * narrows to the newest entry containing the text, Ctrl+R or Up moves to older
 * matches, Down to newer ones, Enter or Tab accepts, and Esc cancels.
 */
export function HistorySearch({ entries, onAccept, onCancel }: Props) {
  const styles = useStyles2(getStyles);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState<number | undefined>(() => searchPromptHistory(entries, ''));
  const matches = useMemo(() => {
    const needle = query.toLowerCase();
    return entries.filter((entry) => entry.toLowerCase().includes(needle)).length;
  }, [entries, query]);
  const match = index === undefined ? undefined : entries[index];

  useEffect(() => inputRef.current?.focus(), []);

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const older = (event.key === 'r' && event.ctrlKey) || event.key === 'ArrowUp';
    if (older || event.key === 'ArrowDown') {
      event.preventDefault();
      if (index !== undefined) {
        const next = older
          ? searchPromptHistory(entries, query, index + 1)
          : searchPromptHistoryNewer(entries, query, index - 1);
        setIndex(next ?? index);
      }
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      if (match !== undefined) {
        onAccept(match);
      } else {
        onCancel();
      }
    } else if (event.key === 'Escape' || (event.key === 'g' && event.ctrlKey)) {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }
  };

  return (
    <div className={styles.search} data-testid={testIds.chat.historySearch}>
      <label className={styles.prompt}>
        <Icon name="history" /> Search history
        <input
          ref={inputRef}
          className={styles.input}
          value={query}
          aria-label="Search history"
          onChange={(event) => {
            const next = event.currentTarget.value;
            setQuery(next);
            setIndex(searchPromptHistory(entries, next));
          }}
          onKeyDown={onKeyDown}
          onBlur={onCancel}
        />
      </label>
      <div className={styles.match} aria-live="polite">
        {match !== undefined ? (
          <>
            <code className={styles.matchText}>{highlight(match, query, styles.highlight)}</code>
            <span className={styles.hint}>
              {matches > 1 ? `${matches} matches · Ctrl+R older · ` : ''}Enter to edit · Esc to cancel
            </span>
          </>
        ) : (
          <span className={styles.hint}>{entries.length ? 'No match' : 'No earlier prompts in this chat'}</span>
        )}
      </div>
    </div>
  );
}

function highlight(text: string, query: string, className: string) {
  const start = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (start < 0) {
    return text;
  }
  return (
    <>
      {text.slice(0, start)}
      <mark className={className}>{text.slice(start, start + query.length)}</mark>
      {text.slice(start + query.length)}
    </>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  search: css({
    display: 'grid',
    gap: theme.spacing(0.5),
    padding: theme.spacing(0.75, 1),
    border: `1px solid ${theme.colors.border.medium}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.secondary,
  }),
  prompt: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    margin: 0,
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  input: css({
    flex: 1,
    minWidth: 0,
    border: 'none',
    outline: 'none',
    background: 'transparent',
    color: theme.colors.text.primary,
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: theme.typography.body.fontSize,
  }),
  match: css({
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    gap: theme.spacing(1),
    minWidth: 0,
  }),
  matchText: css({
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    maxHeight: '6em',
    overflow: 'hidden',
  }),
  highlight: css({
    background: theme.colors.warning.transparent,
    color: 'inherit',
  }),
  hint: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
});
