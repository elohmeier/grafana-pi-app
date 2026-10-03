import React from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { getDataSourceSrv } from '@grafana/runtime';
import { Button, Combobox, type ComboboxOption, Field, IconButton, Stack, TagsInput, useStyles2 } from '@grafana/ui';

import type { PiAppSqlDatasource } from '../../types';
import { testIds } from '../testIds';

type Props = {
  value: PiAppSqlDatasource[];
  onChange: (value: PiAppSqlDatasource[]) => void;
};

/**
 * Microsoft SQL Server datasources for `grafana-sql`. The assistant sees the
 * schema, counts, and visible columns: numeric, date/time, bit, and
 * uniqueidentifier columns, and the string columns listed here.
 */
export function SqlDatasourcesEditor({ value, onChange }: Props) {
  const s = useStyles2(getStyles);
  const options = mssqlOptions(value.map((entry) => entry.uid ?? ''));
  const update = (index: number, entry: PiAppSqlDatasource) =>
    onChange(value.map((current, i) => (i === index ? entry : current)));

  return (
    <div data-testid={testIds.appConfig.sqlDatasourcesEditor}>
      {value.map((entry, index) => (
        <div key={index} className={s.entry} data-testid={testIds.appConfig.sqlDatasourceRow}>
          <Stack direction="row" gap={1} alignItems="flex-end">
            <Field label="Microsoft SQL Server datasource" noMargin>
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
              tooltip="Remove SQL datasource"
              data-testid={testIds.appConfig.sqlDatasourceDelete}
              onClick={() => onChange(value.filter((_, i) => i !== index))}
            />
          </Stack>
          <Field
            label="Tables"
            description="Tables and views as schema.table, such as dbo.Incidents. Leave empty for every table of the datasource's database."
            className={s.marginTop}
          >
            <TagsInput
              tags={entry.tables ?? []}
              placeholder="Add table and press Enter"
              onChange={(tables) => update(index, { ...entry, tables })}
            />
          </Field>
          <Field
            label="Visible string columns"
            description="String columns that are safe to return, as schema.table.column, such as dbo.Incidents.State. Other string and binary columns can be filtered on but are never returned."
          >
            <TagsInput
              tags={entry.visibleColumns ?? []}
              placeholder="Add column and press Enter"
              onChange={(visibleColumns) => update(index, { ...entry, visibleColumns })}
            />
          </Field>
        </div>
      ))}
      <Button
        variant="secondary"
        icon="plus"
        data-testid={testIds.appConfig.sqlDatasourceAdd}
        onClick={() => onChange([...value, { uid: '', tables: [], visibleColumns: [] }])}
      >
        Add SQL datasource
      </Button>
    </div>
  );
}

/** Drops incomplete rows before saving. */
export function serializeSqlDatasources(value: PiAppSqlDatasource[]): PiAppSqlDatasource[] {
  const clean = (items: string[] | undefined) => (items ?? []).map((item) => item.trim()).filter(Boolean);
  return value
    .filter((entry) => entry.uid)
    .map((entry) => ({ uid: entry.uid, tables: clean(entry.tables), visibleColumns: clean(entry.visibleColumns) }));
}

function mssqlOptions(selectedUids: string[]): Array<ComboboxOption<string>> {
  const options = getDataSourceSrv()
    .getList({ type: 'mssql' })
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
