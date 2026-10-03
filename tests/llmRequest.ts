type SystemMessage = { role: string; toolsAdded?: Array<{ name: string }>; toolsRemoved?: Array<{ name: string }> };

/** Tools offered by a proxied model request: the harness declares them in positional system messages. */
export function requestToolNames(context: { messages?: SystemMessage[] }): string[] {
  const tools = new Set<string>();
  for (const message of context.messages ?? []) {
    if (message.role !== 'system') {
      continue;
    }
    for (const tool of message.toolsRemoved ?? []) {
      tools.delete(tool.name);
    }
    for (const tool of message.toolsAdded ?? []) {
      tools.add(tool.name);
    }
  }
  return [...tools];
}
