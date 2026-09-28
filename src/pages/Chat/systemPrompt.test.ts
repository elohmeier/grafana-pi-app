import { BASE_SYSTEM_PROMPT } from './systemPrompt';

describe('chat system prompt', () => {
  it('describes a single agent working through the session filesystem tools', () => {
    expect(BASE_SYSTEM_PROMPT).toContain('Your main tools are read, write, edit, and bash');
    expect(BASE_SYSTEM_PROMPT).toContain('`workspace apply`');
    expect(BASE_SYSTEM_PROMPT).toContain('Alerting is read-only for you');
  });

  it('does not reference specialists or removed tools', () => {
    for (const removed of [
      'run_query_agent',
      'run_dashboard_agent',
      'run_investigation_agent',
      'run_alert_agent',
      'run_support_agent',
      'run_navigation_agent',
      'specialist',
      'write_dashboard_plan',
      'query_prometheus',
      'list_metrics',
      'list_datasources',
      'upload_dashboard',
    ]) {
      expect(BASE_SYSTEM_PROMPT).not.toContain(removed);
    }
  });
});
