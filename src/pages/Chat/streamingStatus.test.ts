import {
  createInitialRunStatus,
  formatRunElapsed,
  reduceChatRunStatus,
  resolveChatRunStatusFromStreamingMessage,
  runStatusBadgeText,
  runStatusText,
  type ChatRunStatus,
} from './streamingStatus';

describe('streaming status', () => {
  it('tracks user-visible run phases from agent events', () => {
    let status: ChatRunStatus | undefined = createInitialRunStatus(1000);
    expect(runStatusText(status)).toBe('Waiting for model');
    expect(runStatusBadgeText(status)).toBe('Waiting');

    status = reduceChatRunStatus(
      status,
      {
        type: 'message_update',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'checking' }] },
        assistantMessageEvent: { type: 'thinking_delta' },
      } as any,
      1200
    );
    expect(status).toMatchObject({ phase: 'thinking', startedAt: 1000 });
    expect(runStatusText(status)).toBe('Thinking');

    status = reduceChatRunStatus(
      status,
      {
        type: 'message_update',
        message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
        assistantMessageEvent: { type: 'text_start' },
      } as any,
      1600
    );
    expect(status).toMatchObject({ phase: 'generating', startedAt: 1000 });
    expect(runStatusText(status)).toBe('Generating answer');

    expect(reduceChatRunStatus(status, { type: 'agent_end' } as any, 2000)).toBeUndefined();
  });

  it('infers phase from assistant content when stream markers are unavailable', () => {
    let status: ChatRunStatus | undefined = createInitialRunStatus(1000);

    status = reduceChatRunStatus(
      status,
      {
        type: 'message_update',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'checking' }] },
      } as any,
      1200
    );
    expect(status).toMatchObject({ phase: 'thinking', startedAt: 1000 });

    status = reduceChatRunStatus(
      status,
      {
        type: 'message_update',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'checking' },
            { type: 'text', text: 'answer' },
          ],
        },
      } as any,
      1600
    );
    expect(status).toMatchObject({ phase: 'generating', startedAt: 1000 });

    status = reduceChatRunStatus(
      status,
      {
        type: 'message_update',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'checking' },
            { type: 'text', text: 'answer' },
            { type: 'toolCall', name: 'inspect_dashboard_metric_usage', arguments: {} },
          ],
        },
      } as any,
      1800
    );
    expect(status).toMatchObject({
      phase: 'preparing_tool',
      detail: 'inspect_dashboard_metric_usage',
      startedAt: 1000,
    });
  });

  it('resolves display status from the live streaming assistant message', () => {
    const status = resolveChatRunStatusFromStreamingMessage(
      createInitialRunStatus(1000),
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'checking' },
          { type: 'text', text: 'answer' },
        ],
      } as any,
      1800
    );

    expect(status).toMatchObject({ phase: 'generating', startedAt: 1000 });
    expect(runStatusText(status)).toBe('Generating answer');
  });

  it('surfaces tool preparation, tool execution, and approval labels', () => {
    let status = reduceChatRunStatus(
      createInitialRunStatus(1000),
      {
        type: 'message_update',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', name: 'inspect_dashboard_metric_usage', arguments: {} }],
        },
        assistantMessageEvent: { type: 'toolcall_start' },
      } as any,
      1500
    );
    expect(runStatusText(status)).toBe('Preparing inspect dashboard metric usage');
    expect(runStatusBadgeText(status)).toBe('Tool call');

    status = reduceChatRunStatus(
      status,
      {
        type: 'tool_execution_start',
        toolName: 'inspect_dashboard_metric_usage',
        toolCallId: 'call-1',
        args: {},
      } as any,
      1800
    );
    expect(runStatusText(status)).toBe('Running inspect dashboard metric usage');
    expect(runStatusBadgeText(status)).toBe('Running tool');
    expect(runStatusText(status, 'workspace_apply')).toBe('Waiting for approval: workspace apply');
    expect(runStatusBadgeText(status, 'workspace_apply')).toBe('Approval');
  });

  it('treats terminal partial updates as tool result processing', () => {
    let status = reduceChatRunStatus(
      createInitialRunStatus(1000),
      {
        type: 'tool_execution_update',
        toolName: 'bash',
        toolCallId: 'call-1',
        args: {},
        partialResult: {
          content: [{ type: 'text', text: 'done' }],
          details: { status: 'completed' },
        },
      } as any,
      1500
    );
    expect(runStatusText(status)).toBe('Processing tool result');
    expect(runStatusBadgeText(status)).toBe('Waiting');

    status = resolveChatRunStatusFromStreamingMessage(
      status,
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'final answer' }],
      } as any,
      1800
    );
    expect(runStatusText(status)).toBe('Generating answer');
  });

  it('formats elapsed run time compactly', () => {
    expect(formatRunElapsed(250)).toBe('0s');
    expect(formatRunElapsed(12_000)).toBe('12s');
    expect(formatRunElapsed(65_000)).toBe('1m 05s');
  });
});
