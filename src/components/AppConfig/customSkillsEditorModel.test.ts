import {
  formatCustomSkillValidationIssues,
  serializeCustomSkills,
  validateCustomSkillsForEditor,
} from './customSkillsEditorModel';

describe('custom skills editor model', () => {
  it('serializes custom skills into the persisted jsonData shape', () => {
    expect(
      serializeCustomSkills([
        {
          name: 'Team-Runbook',
          description: ' Team incident workflow. ',
          content: '# Team Runbook\n',
          activation: {
            keywords: ['incident', 'incident', ''],
          },
          resources: [{ path: 'references/runbook.md', content: '# Runbook\n' }],
        },
      ])
    ).toEqual([
      {
        name: 'team-runbook',
        description: 'Team incident workflow.',
        content: '# Team Runbook',
        activation: {
          explicitOnly: false,
          keywords: ['incident'],
        },
        resources: [{ path: 'references/runbook.md', content: '# Runbook' }],
      },
    ]);
  });

  it('surfaces validation issues that would otherwise be ignored at runtime', () => {
    const issues = validateCustomSkillsForEditor(
      [
        {
          name: 'grafana-dashboard',
          description: 'Override bundled skill.',
          content: '# Override',
          resources: [
            { path: 'references/runbook.md', content: '# Runbook' },
            { path: 'references/runbook.md', content: '# Duplicate' },
          ],
        },
      ],
      { reservedNames: ['grafana-dashboard'] }
    );

    expect(formatCustomSkillValidationIssues(issues)).toContain('name is reserved by a bundled skill');
    expect(formatCustomSkillValidationIssues(issues)).toContain('path duplicates another resource');
  });
});
