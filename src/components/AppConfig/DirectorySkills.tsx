import React, { useEffect, useState } from 'react';
import { css } from '@emotion/css';
import type { GrafanaTheme2 } from '@grafana/data';
import { Alert, Badge, useStyles2 } from '@grafana/ui';
import type { SkillsResponse } from '../../generated/api';
import { fetchDirectorySkills } from '../../pages/Chat/skills/directoryClient';
import { testIds } from '../testIds';

/** The skills of the server's skills directory (`skills_path` in grafana.ini), read-only. */
export function DirectorySkills({ customSkillNames }: { customSkillNames: readonly string[] }) {
  const s = useStyles2(getStyles);
  const [response, setResponse] = useState<SkillsResponse>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let mounted = true;
    fetchDirectorySkills()
      .then((value) => mounted && setResponse(value))
      .catch((err: unknown) => mounted && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      mounted = false;
    };
  }, []);

  if (error) {
    return (
      <Alert severity="warning" title="Skills directory could not be read">
        {error}
      </Alert>
    );
  }
  if (!response?.configured) {
    return null;
  }

  const overridden = new Set(customSkillNames.map((name) => name.trim().toLowerCase()));

  return (
    <div className={s.container} data-testid={testIds.appConfig.directorySkills}>
      <div className={s.summary}>
        {response.skills.length} {response.skills.length === 1 ? 'skill' : 'skills'} from the skills directory
      </div>
      <div className={s.helpText}>
        Set by the Grafana server (skills_path in grafana.ini) and read for every chat. They are sent to the configured
        LLM like custom skills, and replace a custom skill of the same name below.
      </div>
      {response.skills.length > 0 && (
        <ul className={s.list}>
          {response.skills.map((skill) => (
            <li key={skill.name}>
              <code>{skill.name}</code> <span className={s.helpText}>{skill.description}</span>{' '}
              {skill.resources.length > 0 && (
                <Badge
                  color="blue"
                  text={`${skill.resources.length} ${skill.resources.length === 1 ? 'resource' : 'resources'}`}
                />
              )}{' '}
              {overridden.has(skill.name) && <Badge color="orange" text="replaces custom skill" />}
            </li>
          ))}
        </ul>
      )}
      {response.errors && response.errors.length > 0 && (
        <Alert severity="warning" title="Skipped skill files" className={s.marginTop}>
          <ul>
            {response.errors.map((item) => (
              <li key={`${item.path}:${item.error}`}>
                <code>{item.path}</code>: {item.error}
              </li>
            ))}
          </ul>
        </Alert>
      )}
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css`
    margin-bottom: ${theme.spacing(3)};
    max-width: 980px;
  `,
  summary: css`
    color: ${theme.colors.text.primary};
    font-weight: ${theme.typography.fontWeightMedium};
  `,
  helpText: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
    line-height: ${theme.typography.bodySmall.lineHeight};
  `,
  list: css`
    display: grid;
    gap: ${theme.spacing(0.5)};
    list-style: none;
    margin-top: ${theme.spacing(1)};
  `,
  marginTop: css`
    margin-top: ${theme.spacing(2)};
  `,
});
