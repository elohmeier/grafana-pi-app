/** Server-sent event bodies of the plugin LLM proxy, for scripted model turns in e2e tests. */

export function sseResponse(events: unknown[]) {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
}

export function toolCallResponse(toolName: string, args: unknown, id = `call_${toolName}`) {
  return sseResponse([
    { type: 'start' },
    { type: 'toolcall_start', contentIndex: 0, id, toolName },
    { type: 'toolcall_delta', contentIndex: 0, delta: JSON.stringify(args) },
    { type: 'toolcall_end', contentIndex: 0 },
    doneEvent('toolUse'),
  ]);
}

export function textResponse(text: string) {
  return sseResponse([
    { type: 'start' },
    { type: 'text_start', contentIndex: 0 },
    { type: 'text_delta', contentIndex: 0, delta: text },
    { type: 'text_end', contentIndex: 0 },
    doneEvent('stop'),
  ]);
}

function doneEvent(reason: 'stop' | 'toolUse') {
  return {
    type: 'done',
    reason,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
