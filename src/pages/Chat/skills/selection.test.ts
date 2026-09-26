import { GRAFANA_SKILLS, getGrafanaSkills } from './catalog';
import { renderGrafanaSystemPrompt } from './prompt';
import { selectGrafanaSkills } from './selection';

describe('Grafana skill selection', () => {
  it('activates no skill for plain metric questions', () => {
    const selection = selectGrafanaSkills('show current CPU usage', GRAFANA_SKILLS);

    expect(selection.activeSkillNames).toEqual([]);
    expect(selection.activeSkills).toEqual([]);
    expect(selection.toolGroups).toEqual([]);
    expect(selection).not.toHaveProperty('supervisorOnly');
  });

  it('activates the investigation skill for diagnostic requests', () => {
    const selection = selectGrafanaSkills('why is CPU usage high on vm-web-01?', GRAFANA_SKILLS);

    expect(selection.activeSkillNames).toEqual(['investigation']);
    expect(selection.activeSkills.map((skill) => skill.name)).toEqual(['investigation']);
  });

  it('activates the investigation skill for analysis requests', () => {
    const selection = selectGrafanaSkills('Analyze the last 6 hours and summarize what is wrong', GRAFANA_SKILLS);

    expect(selection.activeSkillNames).toEqual(['investigation']);
    expect(selection.activeSkills.map((skill) => skill.name)).toEqual(['investigation']);
  });

  it('activates the alerting skill for panel-linked alert troubleshooting', () => {
    const selection = selectGrafanaSkills('Why is the alert linked to this panel firing?', GRAFANA_SKILLS, {
      pageType: 'dashboard',
      hasDashboardContext: true,
      hasPanelContext: true,
    });

    expect(selection.activeSkillNames).toEqual(expect.arrayContaining(['grafana-alerting']));
  });

  it('activates the dashboard skill for dashboard artifact requests', () => {
    const selection = selectGrafanaSkills('build a dashboard for node health panels', GRAFANA_SKILLS);

    expect(selection.activeSkillNames).toEqual(['grafana-dashboard']);
  });

  it('activates the dashboard skill for contextual sidebar dashboard prompts', () => {
    const selection = selectGrafanaSkills('why is this empty?', GRAFANA_SKILLS, {
      pageType: 'dashboard',
      hasDashboardContext: true,
      hasPanelContext: true,
      liveDashboardEditingAvailable: true,
    });

    expect(selection.activeSkillNames).toEqual(['grafana-dashboard', 'investigation']);
    expect(selection.toolGroups).toEqual(expect.arrayContaining(['dashboardRead', 'liveDashboardEditing']));
  });

  it('does not activate dashboard context for empty prompts', () => {
    const selection = selectGrafanaSkills('', GRAFANA_SKILLS, {
      pageType: 'dashboard',
      hasDashboardContext: true,
    });

    expect(selection.activeSkillNames).toEqual([]);
  });

  it('does not activate a bundled skill for SQL datasource requests', () => {
    const selection = selectGrafanaSkills('show me SQL tables and query SELECT * FROM metrics', GRAFANA_SKILLS);

    expect(selection.activeSkillNames).toEqual([]);
    expect(selection.toolGroups).toEqual([]);
  });

  it('renders only active skill instructions into the system prompt', () => {
    const prompt = renderGrafanaSystemPrompt({
      skills: GRAFANA_SKILLS,
      activeSkillNames: ['grafana-dashboard'],
    });

    expect(prompt).toContain('## Available Skills');
    expect(prompt).toContain('### grafana-dashboard');
    expect(prompt).toContain('references/dashboard-jsonnet-workflow.md');
    expect(prompt).not.toContain('### grafana-alerting');
    expect(prompt).not.toContain('### grafana-metrics');
    expect(prompt).not.toContain('references/promql-patterns.md');
  });

  it('renders live dashboard file editing guidance when available', () => {
    const prompt = renderGrafanaSystemPrompt({ liveDashboardEditingAvailable: true });

    expect(prompt).toContain('/live/dashboard/dashboard.json');
    expect(prompt).toContain('`live apply`');
    expect(prompt).not.toContain('rename_live_dashboard_panel');
  });

  it('renders a direct-edit fallback warning when live dashboard editing is unavailable', () => {
    const prompt = renderGrafanaSystemPrompt({ liveDashboardEditingAvailable: false });

    expect(prompt).toContain('Live dashboard editing is not available');
    expect(prompt).toContain('Do not claim that you can directly edit');
  });

  it('activates configured skills by explicit reference', () => {
    const skills = getGrafanaSkills(
      {
        customSkills: [
          {
            name: 'team-runbook',
            description: 'Use the team incident workflow.',
            content: '# Team Runbook\n\nFollow the team workflow.',
          },
        ],
      },
      []
    );
    const selection = selectGrafanaSkills('Use $team-runbook for this incident', skills);
    const prompt = renderGrafanaSystemPrompt({
      skills,
      activeSkillNames: selection.activeSkillNames,
    });

    expect(selection.activeSkillNames).toEqual(['team-runbook']);
    expect(selection.explicitSkillNames).toEqual(['team-runbook']);
    expect(prompt).toContain('### team-runbook');
    expect(prompt).toContain('# Team Runbook');
  });

  it('activates configured skills by configured keyword or regex only when auto activation is enabled', () => {
    const skills = getGrafanaSkills(
      {
        customSkills: [
          {
            name: 'keyword-runbook',
            description: 'Use for paging incidents.',
            content: '# Keyword Runbook',
            activation: { keywords: ['paging incident'] },
          },
          {
            name: 'regex-runbook',
            description: 'Use for database alerts.',
            content: '# Regex Runbook',
            activation: { regex: '\\bdatabase\\b' },
          },
          {
            name: 'explicit-only',
            description: 'Use only when named.',
            content: '# Explicit Only',
          },
        ],
      },
      []
    );

    expect(selectGrafanaSkills('Handle this paging incident', skills).activeSkillNames).toEqual(['keyword-runbook']);
    expect(selectGrafanaSkills('Investigate database latency', skills).activeSkillNames).toEqual(['regex-runbook']);
    expect(selectGrafanaSkills('Use an explicit only workflow', skills).activeSkillNames).toEqual([]);
  });
});
