import { formatAssistantError } from './llmErrors';

describe('formatAssistantError', () => {
  it('explains refused OpenAI-compatible endpoint connections', () => {
    const error = formatAssistantError(
      'Proxy error: Post "http://host.docker.internal:8080/v1/chat/completions": dial tcp 172.17.0.1:8080: connect: connection refused',
      'error'
    );

    expect(error).toEqual({
      title: 'LLM endpoint is unreachable',
      message:
        'Could not connect to the configured OpenAI-compatible endpoint at http://host.docker.internal:8080/v1/chat/completions. The connection was refused. Check that the model server is running and reachable from the Grafana container.',
      details:
        'Proxy error: Post "http://host.docker.internal:8080/v1/chat/completions": dial tcp 172.17.0.1:8080: connect: connection refused',
      severity: 'error',
    });
  });

  it('extracts error text from JSON proxy failures', () => {
    const error = formatAssistantError(
      '{"error":"Post \\"http://host.docker.internal:8080/v1/chat/completions\\": dial tcp 172.17.0.1:8080: connect: connection refused"}',
      'error'
    );

    expect(error?.title).toBe('LLM endpoint is unreachable');
    expect(error?.message).toContain('http://host.docker.internal:8080/v1/chat/completions');
  });

  it('explains a rejected Grafana session instead of a bare 401', () => {
    const error = formatAssistantError('Proxy error: 401 Unauthorized', 'error');
    expect(error?.title).toBe('Grafana session expired');
    expect(error?.message).toMatch(/sign in again.*send the message again/i);
    expect(error?.details).toBe('Proxy error: 401 Unauthorized');
  });

  it('does not report a request the user stopped as an error', () => {
    expect(formatAssistantError('Request aborted by user', 'aborted')).toBeUndefined();
  });
});
