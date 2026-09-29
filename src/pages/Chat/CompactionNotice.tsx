import React, { useId, useState } from 'react';
import { css } from '@emotion/css';
import type { GrafanaTheme2 } from '@grafana/data';
import { Icon, useStyles2 } from '@grafana/ui';
import { testIds } from '../../components/testIds';
import type { CompactionEvent, CompactionState } from './compaction';
import { ContentBlocks } from './ToolRenderer';

/**
 * Marks where the model's view of the chat switches to the rolling summary.
 * The transcript above stays complete for the user; the summary can be expanded.
 */
export function CompactionDivider({ compaction }: { compaction: CompactionState }) {
  const styles = useStyles2(getStyles);
  const [isOpen, setIsOpen] = useState(false);
  const summaryId = useId();
  return (
    <div className={styles.divider} data-testid={testIds.chat.compactionDivider} role="note">
      <button
        aria-controls={summaryId}
        aria-expanded={isOpen}
        className={styles.toggle}
        type="button"
        onClick={() => setIsOpen((open) => !open)}
      >
        <Icon aria-hidden name={isOpen ? 'angle-down' : 'angle-right'} />
        <span>
          Context summarized: the model sees the earlier part of this chat as a summary
          {compaction.compactions > 1 && ` (updated ${compaction.compactions} times)`}
        </span>
      </button>
      {isOpen && (
        <div className={styles.summary} id={summaryId}>
          <ContentBlocks content={compaction.summary} />
        </div>
      )}
    </div>
  );
}

/** History was dropped without a summary for the latest reply. */
export function ContextTruncatedNotice({ event }: { event: CompactionEvent }) {
  const styles = useStyles2(getStyles);
  return (
    <div className={styles.truncated} data-testid={testIds.chat.contextTruncated} role="status">
      <Icon name="exclamation-triangle" />
      <span>
        Older messages were left out of the model&apos;s context for the latest reply (about{' '}
        {Math.round(event.budgetTokens / 1000)}k tokens fit). It may have lost details from earlier in this chat; ask it
        to reread <code>/session/findings.md</code> or start a new chat for unrelated work.
      </span>
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  divider: css({
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(1),
    margin: theme.spacing(1, 0),
    paddingTop: theme.spacing(1),
    borderTop: `1px dashed ${theme.colors.border.medium}`,
  }),
  toggle: css({
    display: 'inline-flex',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: theme.spacing(0.5),
    padding: 0,
    border: 'none',
    background: 'none',
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
    textAlign: 'left',
    cursor: 'pointer',
    '&:hover': {
      color: theme.colors.text.primary,
    },
  }),
  summary: css({
    padding: theme.spacing(1, 1.5),
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
    // The summarizer writes section headings; keep them at the size of the surrounding notes.
    'h1, h2, h3, h4, h5, h6': {
      margin: theme.spacing(1, 0, 0.5),
      fontSize: theme.typography.h6.fontSize,
    },
  }),
  truncated: css({
    display: 'flex',
    alignItems: 'flex-start',
    gap: theme.spacing(1),
    margin: theme.spacing(1, 0),
    color: theme.colors.warning.text,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
});
