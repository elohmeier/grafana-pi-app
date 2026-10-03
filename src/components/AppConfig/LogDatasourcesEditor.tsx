import React from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { getDataSourceSrv } from '@grafana/runtime';
import {
  Button,
  Combobox,
  type ComboboxOption,
  Field,
  IconButton,
  Input,
  Stack,
  TagsInput,
  useStyles2,
} from '@grafana/ui';

import type { PiAppLogCondition, PiAppLogDatasource } from '../../types';
import { testIds } from '../testIds';

type Props = {
  value: PiAppLogDatasource[];
  onChange: (value: PiAppLogDatasource[]) => void;
};

/**
 * Elasticsearch datasources for `grafana-logs`. The assistant sees structure,
 * counts, and non-text fields; documents matching an unrestricted condition
 * are returned completely.
 */
export function LogDatasourcesEditor({ value, onChange }: Props) {
  const s = useStyles2(getStyles);
  const options = elasticsearchOptions(value.map((entry) => entry.uid ?? ''));
  const update = (index: number, entry: PiAppLogDatasource) =>
    onChange(value.map((current, i) => (i === index ? entry : current)));
  const updateCondition = (index: number, conditionIndex: number, condition: PiAppLogCondition) => {
    const entry = value[index];
    update(index, {
      ...entry,
      unrestricted: (entry.unrestricted ?? []).map((current, i) => (i === conditionIndex ? condition : current)),
    });
  };

  return (
    <div data-testid={testIds.appConfig.logDatasourcesEditor}>
      {value.map((entry, index) => (
        <div key={index} className={s.entry} data-testid={testIds.appConfig.logDatasourceRow}>
          <Stack direction="row" gap={1} alignItems="flex-end">
            <Field label="Elasticsearch datasource" noMargin>
              <Combobox
                width={40}
                options={options}
                value={entry.uid ?? null}
                placeholder="Select a datasource"
                onChange={(option) => update(index, { ...entry, uid: option?.value ?? '' })}
              />
            </Field>
            <IconButton
              name="trash-alt"
              tooltip="Remove log datasource"
              data-testid={testIds.appConfig.logDatasourceDelete}
              onClick={() => onChange(value.filter((_, i) => i !== index))}
            />
          </Stack>
          <Field
            label="Indices"
            description="Indices, data streams, aliases, or patterns such as logs-*. Leave empty for the datasource's configured index."
            className={s.marginTop}
          >
            <TagsInput
              tags={entry.indices ?? []}
              placeholder="Add index and press Enter"
              onChange={(indices) => update(index, { ...entry, indices })}
            />
          </Field>
          <Field
            label="Unrestricted documents"
            description="Documents with one of these values in a keyword field are returned completely, including message text. All other documents are returned without text fields."
          >
            <div>
              {(entry.unrestricted ?? []).map((condition, conditionIndex) => (
                <Stack key={conditionIndex} direction="row" gap={1} alignItems="flex-start">
                  <Input
                    width={30}
                    value={condition.field ?? ''}
                    placeholder="Keyword field, e.g. log.logger"
                    onChange={(event) =>
                      updateCondition(index, conditionIndex, { ...condition, field: event.currentTarget.value })
                    }
                  />
                  <TagsInput
                    tags={condition.values ?? []}
                    placeholder="Add value and press Enter"
                    onChange={(values) => updateCondition(index, conditionIndex, { ...condition, values })}
                  />
                  <IconButton
                    name="times"
                    tooltip="Remove condition"
                    onClick={() =>
                      update(index, {
                        ...entry,
                        unrestricted: (entry.unrestricted ?? []).filter((_, i) => i !== conditionIndex),
                      })
                    }
                  />
                </Stack>
              ))}
              <Button
                size="sm"
                variant="secondary"
                icon="plus"
                onClick={() =>
                  update(index, { ...entry, unrestricted: [...(entry.unrestricted ?? []), { field: '', values: [] }] })
                }
              >
                Add condition
              </Button>
            </div>
          </Field>
        </div>
      ))}
      <Button
        variant="secondary"
        icon="plus"
        data-testid={testIds.appConfig.logDatasourceAdd}
        onClick={() => onChange([...value, { uid: '', indices: [], unrestricted: [] }])}
      >
        Add log datasource
      </Button>
    </div>
  );
}

/** Drops incomplete rows and conditions before saving. */
export function serializeLogDatasources(value: PiAppLogDatasource[]): PiAppLogDatasource[] {
  return value
    .filter((entry) => entry.uid)
    .map((entry) => ({
      uid: entry.uid,
      indices: (entry.indices ?? []).map((index) => index.trim()).filter(Boolean),
      unrestricted: (entry.unrestricted ?? [])
        .map((condition) => ({ field: (condition.field ?? '').trim(), values: condition.values ?? [] }))
        .filter((condition) => condition.field && condition.values.length > 0),
    }));
}

function elasticsearchOptions(selectedUids: string[]): Array<ComboboxOption<string>> {
  const options = getDataSourceSrv()
    .getList({ type: 'elasticsearch' })
    .map((ds) => ({ label: ds.name, value: ds.uid, description: ds.uid }))
    .sort((left, right) => left.label.localeCompare(right.label));
  const available = new Set(options.map((option) => option.value));
  const missing = selectedUids
    .filter((uid) => uid && !available.has(uid))
    .map((uid) => ({ label: uid, value: uid, description: 'Configured UID not visible in this session' }));
  return [...options, ...missing];
}

const getStyles = (theme: GrafanaTheme2) => ({
  entry: css`
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    padding: ${theme.spacing(2)};
    margin-bottom: ${theme.spacing(2)};
  `,
  marginTop: css`
    margin-top: ${theme.spacing(2)};
  `,
});
