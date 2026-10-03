import React, { useId, useState } from 'react';
import { css } from '@emotion/css';
import type { GrafanaTheme2 } from '@grafana/data';
import { Icon, useStyles2 } from '@grafana/ui';
import { testIds } from '../../components/testIds';
import type { TranscriptCompaction } from './durable/transcript';
import { ContentBlocks } from './ToolRenderer';

/**
 * Marks where the model's view of the chat switches to a summary of the
 * messages above it. The transcript stays complete for the user; the summary can be expanded.
 */
export function CompactionDivider({ compaction }: { compaction: TranscriptCompaction }) {
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
        <span>Context summarized: the model sees the earlier part of this chat as a summary</span>
      </button>
      {isOpen && (
        <div className={styles.summary} id={summaryId}>
          <ContentBlocks content={compaction.summary} />
        </div>
      )}
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
});
