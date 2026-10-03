import { ArtifactStore } from '../session/artifactStore';
import { createLogsBroker, describeFields, type FieldCapsResponse, type LogsTransport } from './logs';
import { createArtifactsMount } from './mounts';
import { runWorkspaceBash } from './shell';
import { SessionWorkspace } from './workspace';

const SENTINEL = 'PI-SENTINEL-MSG-0000001';

const keyword = { type: 'keyword', searchable: true, aggregatable: true };
const CAPS: FieldCapsResponse = {
  indices: ['.ds-logs-app-prod-2026.10.03-000001'],
  fields: {
    _id: { _id: { type: '_id', searchable: true, aggregatable: false, metadata_field: true } },
    '@timestamp': { date: { type: 'date', searchable: true, aggregatable: true } },
    message: { text: { type: 'text', searchable: true, aggregatable: false } },
    'message.keyword': { keyword },
    error: { object: { type: 'object', searchable: false, aggregatable: false } },
    'error.type': { keyword },
    'error.stack_trace': { match_only_text: { type: 'match_only_text', searchable: true, aggregatable: false } },
    'service.name': { keyword },
    'labels.session_token': { keyword },
    'log.logger': { keyword },
    'log.level': { keyword },
    'http.response.status_code': { long: { type: 'long', searchable: true, aggregatable: true } },
    'client.ip': { ip: { type: 'ip', searchable: true, aggregatable: true } },
    mixed: { keyword, text: { type: 'text', searchable: true, aggregatable: false } },
    payload: { flattened: { type: 'flattened', searchable: true, aggregatable: true } },
  },
};

function setup(
  options: {
    responses?: (searches: Array<{ index: string; body: Record<string, any> }>) => unknown[];
    unrestricted?: Array<{ field?: string; values?: string[] }>;
  } = {}
) {
  const calls: Array<{ uid: string; searches: Array<{ index: string; body: Record<string, any> }> }> = [];
  const transport: LogsTransport = {
    datasources: () => [
      { uid: 'es-logs', name: 'Logs', type: 'elasticsearch', jsonData: { timeField: '@timestamp', index: 'logs-*' } },
      { uid: 'es-audit', name: 'Audit logs', type: 'elasticsearch', jsonData: { index: 'logs-audit-*' } },
      { uid: 'prometheus', name: 'Prometheus', type: 'prometheus' },
    ],
    fieldCaps: async () => CAPS,
    msearch: async (uid, searches) => {
      calls.push({ uid, searches: searches as Array<{ index: string; body: Record<string, any> }> });
      return options.responses?.(searches as Array<{ index: string; body: Record<string, any> }>) ?? [];
    },
  };
  const broker = createLogsBroker(
    [
      {
        uid: 'es-logs',
        indices: ['logs-app-prod', 'logs-nginx.*'],
        unrestricted: options.unrestricted ?? [{ field: 'log.logger', values: ['deployer'] }],
      },
      { uid: 'prometheus', indices: ['x'] },
    ],
    transport
  );
  return { broker, calls };
}

function searchResponse(hits: unknown[], total = hits.length) {
  return {
    took: 1,
    timed_out: false,
    _shards: { total: 1, successful: 1, skipped: 0, failed: 0 },
    hits: { total: { value: total, relation: 'eq' }, hits },
  };
}

describe('field rule', () => {
  it('shows non-text fields and hides text fields, their keyword subfields, mixed and unknown types', () => {
    const fields = Object.fromEntries(describeFields(CAPS).map((field) => [field.name, field.visible]));
    expect(fields).toEqual({
      '@timestamp': true,
      'client.ip': true,
      'error.stack_trace': false,
      'error.type': true,
      'http.response.status_code': true,
      'labels.session_token': true,
      'log.level': true,
      'log.logger': true,
      message: false,
      'message.keyword': false,
      mixed: false,
      payload: false,
      'service.name': true,
    });
  });
});

describe('policy', () => {
  it('lists only configured Elasticsearch datasources', () => {
    const { broker } = setup();
    expect(broker.datasources()).toEqual([
      {
        uid: 'es-logs',
        name: 'Logs',
        indices: ['logs-app-prod', 'logs-nginx.*'],
        timeField: '@timestamp',
        unrestricted: [{ field: 'log.logger', values: ['deployer'] }],
      },
    ]);
  });

  it.each([
    [{ datasource: 'es-audit' }, /not a log datasource/],
    [{ datasource: 'prometheus' }, /not a log datasource/],
    [{ index: 'logs-audit-prod' }, /not available to the assistant/],
    [{ index: 'logs-*' }, /not available to the assistant/],
    [{ index: 'logs-nginx.access-prod,logs-audit-prod' }, /not available to the assistant/],
    [{ index: 'remote:logs-nginx.access' }, /not available to the assistant/],
  ])('refuses %j', async (target, message) => {
    const { broker, calls } = setup();
    await expect(broker.count({ ...target, from: 'now-1h', to: 'now' })).rejects.toThrow(message);
    expect(calls).toEqual([]);
  });

  it('uses every configured index by default', async () => {
    const { broker, calls } = setup({ responses: () => [searchResponse([])] });
    await broker.count({ from: 'now-1h', to: 'now' });
    expect(calls[0].searches[0].index).toBe('logs-app-prod,logs-nginx.*');
  });

  it('accepts indices matching a configured pattern', async () => {
    const { broker, calls } = setup({ responses: () => [searchResponse([])] });
    await broker.count({ index: 'logs-nginx.access-prod', from: 'now-1h', to: 'now' });
    expect(calls[0].searches[0].index).toBe('logs-nginx.access-prod');
  });
});

describe('count', () => {
  it('never fetches documents and decodes groups with time series', async () => {
    const { broker, calls } = setup({
      responses: () => [
        {
          ...searchResponse([], 42),
          aggregations: {
            groups: {
              sum_other_doc_count: 2,
              buckets: [
                {
                  key: 'ReportRenderTimeout',
                  doc_count: 40,
                  time: { buckets: [{ key: Date.UTC(2026, 9, 3, 6), doc_count: 40 }] },
                },
              ],
            },
          },
        },
      ],
    });
    const result = await broker.count({
      from: 'now-1h',
      to: 'now',
      query: 'message:"timed out"',
      by: 'error.type',
      top: 5,
      interval: '5m',
    });
    const body = calls[0].searches[0].body;
    expect(body.size).toBe(0);
    expect(body._source).toBeUndefined();
    expect(body.query.bool.filter).toEqual([
      { range: { '@timestamp': { gte: 'now-1h', lte: 'now' } } },
      { query_string: { query: 'message:"timed out"' } },
    ]);
    expect(body.aggs.groups.terms).toEqual({ field: 'error.type', size: 5 });
    expect(body.aggs.groups.aggs.time.date_histogram.fixed_interval).toBe('5m');
    expect(result).toMatchObject({
      total: 42,
      exact: true,
      groups: [{ key: 'ReportRenderTimeout', count: 40, series: [{ time: '2026-10-03T06:00:00.000Z', count: 40 }] }],
      otherCount: 2,
    });
  });

  it('suggests the field for --by NAME.keyword', async () => {
    const { broker } = setup();
    await expect(broker.count({ from: 'now-1h', to: 'now', by: 'error.type.keyword' })).rejects.toThrow(
      '--by error.type.keyword: no such field in logs-app-prod,logs-nginx.*; did you mean error.type?'
    );
  });

  it('names unknown query fields and range syntax when nothing matched', async () => {
    const { broker } = setup({ responses: () => [searchResponse([], 0)] });
    const result = await broker.count({
      from: 'now-1h',
      to: 'now',
      query: 'level:ERROR AND status>=500 AND message:"a:b" AND service.name:x',
    });
    expect(result.notices).toEqual([
      'no documents matched, and field level does not exist in this index: did you mean log.level?',
      'no documents matched; write a range as status:>=VALUE (Lucene syntax)',
    ]);
  });

  it.each(['message', 'message.keyword', 'error.stack_trace', 'payload'])('refuses --by %s', async (by) => {
    const { broker, calls } = setup();
    await expect(broker.count({ from: 'now-1h', to: 'now', by })).rejects.toThrow(/only non-text, aggregatable/);
    expect(calls).toEqual([]);
  });

  it('refuses invalid time values and intervals', async () => {
    const { broker } = setup();
    await expect(broker.count({ from: 'yesterday', to: 'now' })).rejects.toThrow(/--from/);
    await expect(broker.count({ from: 'now-1h', to: 'now', interval: '5 minutes' })).rejects.toThrow(/--interval/);
  });

  it('reports Elasticsearch errors', async () => {
    const { broker } = setup({
      responses: () => [
        {
          error: {
            type: 'search_phase_execution_exception',
            root_cause: [{ type: 'query_shard_exception', reason: 'bad' }],
          },
        },
      ],
    });
    await expect(broker.count({ from: 'now-1h', to: 'now', query: 'a:(' })).rejects.toThrow(
      'Elasticsearch query_shard_exception: bad'
    );
  });
});

describe('search', () => {
  const complete = {
    _index: '.ds-logs-app-prod',
    _id: 'deploy',
    sort: [3000],
    _source: { '@timestamp': '2026-10-03T06:00:03Z', message: 'Deployment of report-renderer 3.8.0 started' },
  };
  // An Elasticsearch response with more than was requested must still not leak.
  const restricted = (id: string, time: number) => ({
    _index: '.ds-logs-app-prod',
    _id: id,
    sort: [time],
    _source: { message: SENTINEL },
    fields: { 'error.type': ['ReportRenderTimeout'], message: [SENTINEL], 'message.keyword': [SENTINEL] },
  });

  it('returns unrestricted documents completely and restricted ones with visible fields only', async () => {
    const { broker, calls } = setup({
      responses: (searches) =>
        searches.length === 2
          ? [searchResponse([complete]), searchResponse([restricted('a', 4000), restricted('b', 2000)], 7)]
          : [],
    });
    const result = await broker.search({ from: 'now-1h', to: 'now', query: 'service.name:report-renderer', limit: 2 });

    const [unrestrictedSearch, restrictedSearch] = calls[0].searches;
    const condition = { terms: { 'log.logger': ['deployer'] } };
    expect(unrestrictedSearch.body.query.bool.filter).toContainEqual({
      bool: { should: [condition], minimum_should_match: 1 },
    });
    expect(restrictedSearch.body._source).toBe(false);
    expect(restrictedSearch.body.query.bool.must_not).toEqual([condition]);
    expect(restrictedSearch.body.fields).toEqual([
      '@timestamp',
      'client.ip',
      'error.type',
      'http.response.status_code',
      'labels.session_token',
      'log.level',
      'log.logger',
      'service.name',
    ]);

    expect(result.documents).toEqual([
      { index: '.ds-logs-app-prod', id: 'a', restricted: true, fields: { 'error.type': 'ReportRenderTimeout' } },
      { index: '.ds-logs-app-prod', id: 'deploy', restricted: false, fields: complete._source },
    ]);
    expect(result.total).toEqual({ unrestricted: 1, restricted: 7, exact: true });
    expect(JSON.stringify(result)).not.toContain('PI-SENTINEL');
  });

  it('returns unrestricted documents with dotted field names', async () => {
    const nested = { ...complete, _source: { service: { name: 'report-renderer', version: '3.8.0' }, tags: ['a'] } };
    const { broker } = setup({ responses: () => [searchResponse([nested]), searchResponse([])] });
    const result = await broker.search({ from: 'now-1h', to: 'now', limit: 10 });
    expect(result.documents[0].fields).toEqual({
      'service.name': 'report-renderer',
      'service.version': '3.8.0',
      tags: ['a'],
    });
  });

  it('sends one restricted search without conditions', async () => {
    const { broker, calls } = setup({ unrestricted: [], responses: () => [searchResponse([])] });
    await broker.search({ from: 'now-1h', to: 'now', limit: 10 });
    expect(calls[0].searches).toHaveLength(1);
    expect(calls[0].searches[0].body.query.bool.must_not).toBeUndefined();
  });

  it('rejects unrestricted conditions on text fields', async () => {
    const { broker, calls } = setup({ unrestricted: [{ field: 'message.keyword', values: ['x'] }] });
    await expect(broker.search({ from: 'now-1h', to: 'now', limit: 10 })).rejects.toThrow(/fix the plugin settings/);
    expect(calls).toEqual([]);
  });
});

describe('grafana-logs command', () => {
  function shell() {
    const { broker } = setup({
      responses: (searches) =>
        searches.length === 2
          ? [
              searchResponse([]),
              searchResponse([
                {
                  _index: 'i',
                  _id: 'a',
                  sort: [1],
                  fields: { 'service.name': ['report-renderer'], message: [SENTINEL] },
                },
              ]),
            ]
          : [{ ...searchResponse([], 3), aggregations: { time: { buckets: [{ key: 0, doc_count: 3 }] } } }],
    });
    const workspace = new SessionWorkspace();
    const artifacts = new ArtifactStore();
    workspace.setGeneratedMounts([createArtifactsMount(artifacts)]);
    const deps = { workspace, broker: { logs: broker }, artifacts };
    return (command: string) => runWorkspaceBash(deps, { command });
  }

  it('prints counts as JSON and documents as NDJSON', async () => {
    const run = shell();
    const count = await run(`grafana-logs count --since 6h --interval 1h | jq -c '[.total, .from, .series[0].count]'`);
    expect(count.stdout).toBe('[3,"now-6h",3]\n');
    const search = await run(`grafana-logs search -q 'service.name:report-renderer'`);
    expect(search.stdout).toBe('{"_index":"i","_id":"a","_restricted":true,"service.name":"report-renderer"}\n');
    expect(search.stderr).toContain('1 of 1 matching documents (0 complete, 1 restricted to visible fields)');
    expect(JSON.stringify(search)).not.toContain('PI-SENTINEL');
  });

  it('combines repeated -q with AND', async () => {
    const run = shell();
    const result = await run(`grafana-logs count -q 'log.level:ERROR' -q 'host.name:vm-web-01' | jq -r .query`);
    expect(result.stdout).toBe('(log.level:ERROR) AND (host.name:vm-web-01)\n');
  });

  it('lists sources', async () => {
    const run = shell();
    const result = await run(`grafana-logs sources | jq -c '.datasources[] | [.uid, .indices]'`);
    expect(result.stdout).toBe('["es-logs",["logs-app-prod","logs-nginx.*"]]\n');
  });

  it('reports policy refusals as usage errors', async () => {
    const run = shell();
    const result = await run('grafana-logs count --index logs-audit-prod');
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('index "logs-audit-prod" is not available to the assistant');
  });

  it('lists visible fields', async () => {
    const run = shell();
    const result = await run(`grafana-logs fields --visible | jq -r .name | tr '\\n' ' '`);
    expect(result.stdout).toBe(
      '@timestamp client.ip error.type http.response.status_code labels.session_token log.level log.logger service.name '
    );
  });
});
