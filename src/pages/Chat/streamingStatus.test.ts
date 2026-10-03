import type { LiveState } from '@earendil-works/pi-durable';
import { deriveRunStatus, formatRunElapsed, runStatusBadgeText, runStatusText } from './streamingStatus';

const assistant = (content: unknown[]) => ({ role: 'assistant', content }) as never;

describe('streaming status', () => {
  it('derives user-visible run phases from the live state', () => {
    const run = { taskId: 1, inputs: [] } as unknown as LiveState['run'];
    const status = (live: LiveState) => deriveRunStatus({ run, ...live }, 1000);

    expect(status({})).toEqual({ phase: 'waiting_model', startedAt: 1000 });
    expect(status({ generation: { attempt: 1 } })).toMatchObject({ phase: 'waiting_model' });
    expect(
      status({ generation: { attempt: 1, message: assistant([{ type: 'thinking', thinking: 'Hm' }]) } })
    ).toMatchObject({
      phase: 'thinking',
    });
    expect(
      status({ generation: { attempt: 1, message: assistant([{ type: 'text', text: 'Answer' }]) } })
    ).toMatchObject({ phase: 'generating' });
    expect(
      runStatusText(
        status({
          generation: { attempt: 1, message: assistant([{ type: 'toolCall', name: 'bash', arguments: {}, id: 'a' }]) },
        })
      )
    ).toBe('Preparing bash');
    expect(runStatusText(status({ generation: { attempt: 2, retry: { at: 2000, error: 'rate limited' } } }))).toBe(
      'Retrying after an error: rate limited'
    );
  });

  it('surfaces tool execution, tool result processing, compaction, and approval labels', () => {
    const run = { taskId: 1, inputs: [] } as unknown as LiveState['run'];
    const running = deriveRunStatus({ run, tools: [{ callId: 'a', name: 'bash', status: 'running' }] }, 1000);
    expect(runStatusText(running)).toBe('Running bash');
    expect(runStatusBadgeText(running)).toBe('Running tool');
    expect(runStatusText(running, 'workspace_apply')).toBe('Waiting for approval: workspace apply');
    expect(runStatusBadgeText(running, 'workspace_apply')).toBe('Approval');

    const processing = deriveRunStatus({ run, tools: [{ callId: 'a', name: 'bash', status: 'done' }] }, 1000);
    expect(runStatusText(processing)).toBe('Processing tool result');

    const compacting = deriveRunStatus(
      { run, compactions: [{ taskId: 2, reason: 'threshold', blocking: true, attempt: 1 }] } as unknown as LiveState,
      1000
    );
    expect(runStatusText(compacting)).toBe('Summarizing earlier conversation to fit the context window');
    expect(runStatusBadgeText(compacting)).toBe('Compacting');
  });

  it('formats elapsed run time compactly', () => {
    expect(formatRunElapsed(250)).toBe('0s');
    expect(formatRunElapsed(12_000)).toBe('12s');
    expect(formatRunElapsed(65_000)).toBe('1m 05s');
  });
});
