jest.mock('typebox', () => ({
  Type: {
    Object: jest.fn((properties) => ({ properties })),
    String: jest.fn((config) => config ?? {}),
  },
}));

import type { Skill } from '../../../generated/api';
import { getGrafanaSkills } from './catalog';
import type { GrafanaSkill } from './types';

const bundled: GrafanaSkill = {
  name: 'grafana-dashboard',
  description: 'Bundled.',
  content: '# Bundled',
  filePath: 'assistant/skills/grafana-dashboard/SKILL.md',
  resources: {},
};

const runbook: Skill = {
  name: 'team-runbook',
  description: 'Team incident workflow.',
  content: '---\nname: team-runbook\ndescription: Team incident workflow.\n---\n\n# Team Runbook',
  activation: { keywords: ['incident'] },
  resources: [{ path: 'references/escalation.md', content: '# Escalation' }],
};

describe('skills directory', () => {
  it('adds directory skills after bundled skills and before jsonData skills of the same name', () => {
    const skills = getGrafanaSkills(
      {
        customSkills: [
          { name: 'team-runbook', description: 'Old copy in jsonData.', content: 'Old.' },
          { name: 'other-skill', description: 'Only in jsonData.', content: 'Other.' },
        ],
      },
      [bundled],
      [{ ...runbook, name: 'grafana-dashboard' }, runbook]
    );

    expect(skills.map((skill) => [skill.name, skill.description])).toEqual([
      ['grafana-dashboard', 'Bundled.'],
      ['team-runbook', 'Team incident workflow.'],
      ['other-skill', 'Only in jsonData.'],
    ]);
  });

  it('maps a directory skill like a custom skill', () => {
    const [skill] = getGrafanaSkills({}, [], [runbook]);

    expect(skill).toEqual({
      name: 'team-runbook',
      description: 'Team incident workflow.',
      content: runbook.content,
      // Same file path, and so the same telemetry ID, as the skill in jsonData.
      filePath: 'plugin-config/customSkills/team-runbook',
      disableModelInvocation: false,
      resources: {
        'references/escalation.md': { path: 'references/escalation.md', content: '# Escalation', bytes: 12 },
      },
      activation: { keywords: ['incident'], explicitOnly: false },
    });
  });

  it('activates directory skills without activation only explicitly', () => {
    const [skill] = getGrafanaSkills({}, [], [{ ...runbook, activation: undefined }]);

    expect(skill.activation).toEqual({ explicitOnly: true });
  });
});
