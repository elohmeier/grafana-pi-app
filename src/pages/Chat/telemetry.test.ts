import { createAssistantTelemetryReporter, type AssistantTelemetryEvent } from './telemetry';

jest.mock('./tools/client', () => ({
  pluginResourceFetch: jest.fn(),
}));

describe('assistant telemetry reporter', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reports skills, QoL wait timings, usage, and tool efficiency metrics without raw prompts', async () => {
    const sent: AssistantTelemetryEvent[] = [];
    const reporter = createAssistantTelemetryReporter(async (events) => {
      sent.push(...events);
    });
    let now = 10_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);

    reporter.recordPromptStart({
      prompt: 'Use $team-runbook to inspect latency',
      systemPrompt: 'system prompt',
      messages: [{ role: 'user', content: 'previous prompt' }] as any,
      toolCount: 7,
      activeSkills: [
        {
          name: 'team-runbook',
          description: 'Team runbook',
          content: 'Runbook content',
          filePath: 'plugin-config/customSkills/team-runbook',
          resources: {},
          toolGroups: ['skillResources'],
        },
      ],
      explicitSkillNames: ['team-runbook'],
    });

    now = 10_050;
    reporter.recordAgentEvent({ type: 'agent_start' } as any);
    now = 10_300;
    reporter.recordAgentEvent({ type: 'message_start', message: { role: 'assistant', content: [] } } as any);
    now = 10_350;
    reporter.recordAgentEvent({
      type: 'message_update',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Considering tools' }] },
      assistantMessageEvent: {} as any,
    } as any);
    now = 10_450;
    reporter.recordAgentEvent({
      type: 'message_update',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Working' }] },
      assistantMessageEvent: {} as any,
    } as any);
    now = 10_600;
    reporter.recordAgentEvent({
      type: 'tool_execution_start',
      toolCallId: 'call-1',
      toolName: 'bash',
      args: { command: 'grafana-prom query "inspect latency"' },
    } as any);
    now = 11_250;
    reporter.recordAgentEvent({
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'bash',
      isError: false,
      result: {
        content: [{ type: 'text', text: 'done' }],
        details: { command: 'grafana-prom query "inspect latency"', exitCode: 0 },
      },
    } as any);
    now = 11_300;
    reporter.recordAgentEvent({
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'Done' }],
        usage: { input: 100, output: 25, cacheRead: 3, cacheWrite: 2, totalTokens: 130 },
      },
    } as any);
    now = 11_350;
    reporter.recordAgentEvent({
      type: 'agent_end',
      messages: [
        {
          role: 'assistant',
          stopReason: 'stop',
          content: [{ type: 'text', text: 'Done' }],
        },
      ],
    } as any);

    await reporter.flush();

    const prompt = sent.find((event) => event.type === 'prompt_start');
    expect(prompt).toMatchObject({
      promptBytes: expect.any(Number),
      contextBytes: expect.any(Number),
      contextMessageCount: 1,
      toolCount: 7,
      skills: [
        {
          id: 'plugin-config/customSkills/team-runbook',
          name: 'team-runbook',
          source: 'custom',
          activation: 'explicit',
        },
      ],
    });
    expect(JSON.stringify(prompt)).not.toContain('inspect latency');

    expect(sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'qol_timing', phase: 'first_assistant_message', durationMs: 300 }),
        expect.objectContaining({ type: 'qol_timing', phase: 'first_assistant_thinking', durationMs: 350 }),
        expect.objectContaining({ type: 'qol_timing', phase: 'first_assistant_content', durationMs: 450 }),
        expect.objectContaining({ type: 'qol_timing', phase: 'first_visible_assistant_content', durationMs: 450 }),
        expect.objectContaining({ type: 'qol_timing', phase: 'first_tool_call', durationMs: 600 }),
        expect.objectContaining({ type: 'qol_timing', phase: 'first_tool_result', durationMs: 1250 }),
        expect.objectContaining({ type: 'qol_timing', phase: 'run_complete', durationMs: 1350 }),
      ])
    );

    expect(sent.find((event) => event.type === 'tool_execution_end')).toMatchObject({
      toolName: 'bash',
      status: 'completed',
      durationMs: 650,
    });
    expect(sent.find((event) => event.type === 'tool_execution_end')).not.toHaveProperty('nestedToolCalls');
    expect(sent.find((event) => event.type === 'message_end')).toMatchObject({
      usage: { input: 100, output: 25, cacheRead: 3, cacheWrite: 2, totalTokens: 130 },
    });
  });

  it('falls back to final transcript tool results when live agent events are missing', async () => {
    const sent: AssistantTelemetryEvent[] = [];
    const reporter = createAssistantTelemetryReporter(async (events) => {
      sent.push(...events);
    });
    let now = 20_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);

    reporter.recordPromptStart({
      prompt: 'inspect metrics',
      systemPrompt: 'system prompt',
      messages: [],
      toolCount: 1,
      activeSkills: [],
      explicitSkillNames: [],
    });

    now = 22_000;
    reporter.recordTranscriptSnapshot([
      { role: 'user', content: 'inspect metrics' },
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'grafana-prom query up' } }],
      },
      {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'bash',
        isError: false,
        content: [{ type: 'text', text: 'done' }],
        details: { command: 'grafana-prom query up', exitCode: 0 },
      },
      {
        role: 'assistant',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'final answer' }],
        usage: { input: 12, output: 3, totalTokens: 15 },
      },
    ] as any);

    await reporter.flush();

    expect(sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool_execution_end',
          toolName: 'bash',
          status: 'completed',
        }),
        expect.objectContaining({ type: 'turn_end', toolResultCount: 1 }),
        expect.objectContaining({
          type: 'message_end',
          messageRole: 'assistant',
          usage: { input: 12, output: 3, totalTokens: 15 },
        }),
        expect.objectContaining({ type: 'agent_end', status: 'completed', messageCount: 4 }),
        expect.objectContaining({ type: 'qol_timing', phase: 'run_complete', durationMs: 2000 }),
      ])
    );
  });
});
