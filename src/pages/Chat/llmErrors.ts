export type AssistantErrorView = {
  title: string;
  message: string;
  details?: string;
  severity: 'error' | 'warning';
};

/**
 * Error notice for a failed assistant message. Aborted messages are not errors:
 * every abort is the user stopping the run (Stop, or leaving or switching the
 * chat), and the transcript shows them as stopped with their partial content.
 */
export function formatAssistantError(errorMessage?: string, stopReason?: string): AssistantErrorView | undefined {
  if (!errorMessage || stopReason === 'aborted') {
    return undefined;
  }

  const rawMessage = errorMessage ?? 'Unknown LLM request failure';
  const normalized = normalizeProxyError(rawMessage);
  const upstream = parseGoHTTPError(normalized);

  if (upstream?.detail.includes('connect: connection refused')) {
    return {
      title: 'LLM endpoint is unreachable',
      message: `Could not connect to the configured OpenAI-compatible endpoint at ${upstream.url}. The connection was refused. Check that the model server is running and reachable from the Grafana container.`,
      details: rawMessage,
      severity: 'error',
    };
  }

  if (upstream?.detail.includes('dial tcp')) {
    return {
      title: 'LLM endpoint connection failed',
      message: `Could not connect to the configured OpenAI-compatible endpoint at ${upstream.url}. ${upstream.detail}`,
      details: rawMessage,
      severity: 'error',
    };
  }

  if (/^Proxy error: 401\b/.test(rawMessage.trim())) {
    return {
      title: 'Grafana session expired',
      message:
        'Grafana rejected the request because the login session is no longer valid. Reload the page and sign in again if asked, then send the message again. Work in the chat and unsaved dashboard changes in the browser are kept.',
      details: rawMessage,
      severity: 'error',
    };
  }

  if (normalized === 'OpenAI-compatible API key is not configured') {
    return {
      title: 'LLM API key is not configured',
      message: 'Configure the app plugin with an OpenAI-compatible API key before sending prompts.',
      details: rawMessage,
      severity: 'error',
    };
  }

  return {
    title: 'LLM request failed',
    message: normalized,
    details: normalized === rawMessage ? undefined : rawMessage,
    severity: 'error',
  };
}

function normalizeProxyError(errorMessage: string): string {
  let message = errorMessage
    .trim()
    .replace(/^Proxy error:\s*/i, '')
    .trim();
  const parsed = parseJSONErrorMessage(message);
  if (parsed) {
    message = parsed;
  }
  return message || errorMessage;
}

function parseJSONErrorMessage(message: string): string | undefined {
  if (!message.startsWith('{')) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(message) as Record<string, unknown>;
    for (const key of ['error', 'message', 'status']) {
      const value = parsed[key];
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function parseGoHTTPError(message: string): { method: string; url: string; detail: string } | undefined {
  const match = message.match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) "([^"]+)":\s*(.+)$/i);
  if (!match) {
    return undefined;
  }

  return {
    method: match[1].toUpperCase(),
    url: match[2],
    detail: match[3],
  };
}
