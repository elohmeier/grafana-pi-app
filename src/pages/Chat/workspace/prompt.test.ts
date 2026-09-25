import { renderWorkspacePromptSection } from './prompt';

describe('workspace prompt section', () => {
  it('documents mounts, the approval rule, and every registered command', () => {
    const text = renderWorkspacePromptSection({ pythonAvailable: true });
    expect(text).toContain('/grafana/dashboards/<uid>/dashboard.json');
    expect(text).toContain('/.agents/skills/<name>/SKILL.md');
    expect(text).toContain('`workspace apply <plan-id>`');
    for (const command of [
      'grafana search',
      'grafana-prom query',
      'grafana-dashboard validate',
      'jsonnet',
      'workspace plan',
    ]) {
      expect(text).toContain(command);
    }
    expect(text).toContain('python3');
    expect(renderWorkspacePromptSection()).not.toContain('python3 (');
  });
});
