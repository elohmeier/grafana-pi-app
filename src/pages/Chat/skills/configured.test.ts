jest.mock('typebox', () => ({
  Type: {
    Object: jest.fn((properties) => ({ properties })),
    String: jest.fn((config) => config ?? {}),
  },
}));

import { getGrafanaSkills } from './catalog';
import { parseCustomSkillsJson, validateCustomSkillsJson } from './configured';

describe('configured Grafana skills', () => {
  it('normalizes enabled custom skills without allowing bundled skill overrides', () => {
    const skills = getGrafanaSkills(
      {
        customSkills: [
          {
            name: 'grafana-dashboard',
            description: 'Attempted override',
            content: 'Do something else.',
          },
          {
            name: 'team-runbook',
            description: 'Team incident workflow.',
            content: '# Team Runbook\n\nUse the internal incident workflow.',
            toolGroups: ['metrics', 'dashboardRead', 'adHocDashboards'],
            resources: [
              {
                path: 'references/runbook.md',
                content: '# Runbook\n\nEscalate after 15 minutes.',
              },
            ],
          },
        ],
      },
      []
    );

    expect(skills).toHaveLength(2);
    expect(skills[0]).toMatchObject({
      name: 'grafana-dashboard',
      filePath: 'plugin-config/customSkills/grafana-dashboard',
    });
    expect(skills[1]).toMatchObject({
      name: 'team-runbook',
      filePath: 'plugin-config/customSkills/team-runbook',
      toolGroups: expect.arrayContaining(['skillResources', 'metrics', 'dashboardRead']),
    });
    expect(skills[1].toolGroups).not.toContain('adHocDashboards');
    expect(skills[1].resources['references/runbook.md']).toMatchObject({
      path: 'references/runbook.md',
      content: '# Runbook\n\nEscalate after 15 minutes.',
    });

    const withBundledNameReserved = getGrafanaSkills(
      {
        customSkills: [
          {
            name: 'grafana-dashboard',
            description: 'Attempted override',
            content: 'Do something else.',
          },
        ],
      },
      [
        {
          name: 'grafana-dashboard',
          description: 'Bundled dashboard skill.',
          content: '# Bundled',
          filePath: '.agents/skills/grafana-dashboard/SKILL.md',
          resources: {},
          toolGroups: ['skillResources'],
        },
      ]
    );

    expect(withBundledNameReserved).toHaveLength(1);
    expect(withBundledNameReserved[0].content).toBe('# Bundled');
  });

  it('validates custom skill JSON before saving plugin config', () => {
    expect(
      parseCustomSkillsJson(`[
        {
          "name": "team-runbook",
          "description": "Team incident workflow.",
          "content": "# Team Runbook",
          "activation": { "keywords": ["incident"] },
          "toolGroups": ["metrics", "skillResources"]
        }
      ]`)
    ).toEqual([
      {
        name: 'team-runbook',
        description: 'Team incident workflow.',
        content: '# Team Runbook',
        activation: { keywords: ['incident'] },
        toolGroups: ['metrics', 'skillResources'],
      },
    ]);

    expect(
      validateCustomSkillsJson(`[
        {
          "name": "unsupported-runbook",
          "description": "Unsupported group.",
          "content": "# Unsupported",
          "toolGroups": ["sql"]
        }
      ]`)
    ).toContain('unsupported group "sql"');

    expect(validateCustomSkillsJson('{"name":"not-array"}')).toContain('must be an array');
    expect(
      validateCustomSkillsJson(`[
        {
          "name": "bad name",
          "description": "Invalid",
          "content": "# Invalid",
          "toolGroups": ["adHocDashboards"]
        }
      ]`)
    ).toContain('name must be kebab-case');
  });

  it('accepts legacy Jsonnet tool groups without selecting them', () => {
    expect(
      validateCustomSkillsJson(`[
        {
          "name": "legacy-runbook",
          "description": "Legacy groups.",
          "content": "# Legacy",
          "toolGroups": ["metrics", "jsonnetFiles", "jsonnetDashboards"]
        }
      ]`)
    ).toBeUndefined();

    const [skill] = getGrafanaSkills({
      customSkills: [
        {
          name: 'legacy-runbook',
          description: 'Legacy groups.',
          content: '# Legacy',
          toolGroups: ['metrics', 'jsonnetFiles', 'jsonnetDashboards'] as any,
        },
      ],
    }).filter((candidate) => candidate.name === 'legacy-runbook');

    expect(skill.toolGroups).toContain('metrics');
    expect(skill.toolGroups).not.toContain('jsonnetFiles');
    expect(skill.toolGroups).not.toContain('jsonnetDashboards');
  });
});
