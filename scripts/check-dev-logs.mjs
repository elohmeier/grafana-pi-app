#!/usr/bin/env node

// Checks the restricted log access fixture of the `logs` Compose profile
// through Grafana's Elasticsearch datasource resource API, the path the
// grafana-logs command uses. It pins down what the command must handle: the
// datasource credential reaches raw sentinel content and denied data streams,
// so the restriction cannot rely on Elasticsearch or Grafana permissions.
// See docs/restricted-logs.md.

import assert from 'node:assert/strict';
import process from 'node:process';

const GRAFANA_URL = (process.env.GRAFANA_URL ?? 'http://localhost:3001').replace(/\/+$/, '');
const GRAFANA_USER = process.env.GRAFANA_USER ?? 'admin';
const GRAFANA_PASSWORD = process.env.GRAFANA_PASSWORD ?? 'admin';
const ES_URL = (process.env.ES_URL ?? 'http://localhost:9200').replace(/\/+$/, '');
const ELASTIC_PASSWORD = process.env.ELASTIC_PASSWORD ?? 'elastic-dev';
const LOGS_UID = process.env.LOGS_DATASOURCE_UID ?? 'es-logs';
const AUDIT_UID = process.env.AUDIT_DATASOURCE_UID ?? 'es-audit';

const basic = (user, password) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
const grafanaAuth = basic(GRAFANA_USER, GRAFANA_PASSWORD);

async function getJSON(url, init = {}) {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${init.method ?? 'GET'} ${url} failed with ${response.status}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}

function grafana(path, init = {}) {
  return getJSON(`${GRAFANA_URL}${path}`, { ...init, headers: { Authorization: grafanaAuth, ...init.headers } });
}

async function msearch(uid, index, ...bodies) {
  const payload = bodies.map((body) => `${JSON.stringify({ index })}\n${JSON.stringify(body)}\n`).join('');
  const result = await grafana(`/api/datasources/uid/${uid}/resources/_msearch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-ndjson' },
    body: payload,
  });
  return bodies.length === 1 ? result.responses[0] : result.responses;
}

function range(from, to) {
  return { range: { '@timestamp': { gte: from, lt: to, format: 'strict_date_optional_time' } } };
}

const checks = [];
function check(name, fn) {
  checks.push({ name, fn });
}

const manifest = (
  await getJSON(`${ES_URL}/pi-demo-fixture/_doc/manifest`, {
    headers: { Authorization: basic('elastic', ELASTIC_PASSWORD) },
  })
)._source;
const window = manifest.window;
const incident = manifest.incident;

check('datasources are healthy', async () => {
  for (const uid of [LOGS_UID, AUDIT_UID]) {
    const health = await grafana(`/api/datasources/uid/${uid}/health`);
    assert.equal(health.status, 'OK', `${uid}: ${health.message}`);
  }
});

check('document counts per dataset match the seed manifest', async () => {
  const response = await msearch(LOGS_UID, 'logs-*', {
    size: 0,
    track_total_hits: true,
    query: { bool: { filter: [range(window.from, window.to)] } },
    aggs: { datasets: { terms: { field: 'data_stream.dataset', size: 20 } } },
  });
  assert.equal(response.hits.total.relation, 'eq');
  assert.equal(response._shards.failed, 0);
  const counts = Object.fromEntries(response.aggregations.datasets.buckets.map((b) => [b.key, b.doc_count]));
  assert.deepEqual(counts, manifest.datasets);
});

// The field rule of restricted indices: only fields whose types are all
// non-text are visible, and a keyword subfield of a text field
// (error.message.keyword) counts as text.
const VISIBLE_TYPES = new Set([
  'keyword',
  'constant_keyword',
  'long',
  'integer',
  'short',
  'byte',
  'double',
  'float',
  'half_float',
  'scaled_float',
  'unsigned_long',
  'date',
  'date_nanos',
  'boolean',
  'ip',
]);

function visibleFields(caps) {
  const types = (name) => Object.keys(caps.fields[name] ?? {});
  const isVisible = (name) => {
    if (name.startsWith('_') || !types(name).every((type) => VISIBLE_TYPES.has(type))) {
      return false;
    }
    const parts = name.split('.');
    for (let i = 1; i < parts.length; i++) {
      const parent = types(parts.slice(0, i).join('.'));
      if (parent.some((type) => type !== 'object' && type !== 'nested')) {
        return false;
      }
    }
    return true;
  };
  return Object.keys(caps.fields).filter((name) => types(name).length > 0 && isVisible(name));
}

const RESTRICTED = 'logs-app-prod,logs-nginx.access-prod';

check('the field rule hides text fields and keyword subfields of text fields', async () => {
  const caps = await grafana(`/api/datasources/uid/${LOGS_UID}/resources/${RESTRICTED}/_field_caps`);
  const visible = visibleFields(caps);
  for (const name of ['service.name', 'url.query', 'labels.session_token', 'user.email', 'http.response.status_code']) {
    assert.ok(visible.includes(name), `${name} is visible`);
  }
  for (const name of ['message', 'error.message', 'error.message.keyword', 'error.stack_trace']) {
    assert.ok(!visible.includes(name), `${name} is hidden`);
  }

  const groupable = visible.filter((name) => Object.values(caps.fields[name]).every((cap) => cap.aggregatable));
  const aggs = Object.fromEntries(groupable.map((name, i) => [`f${i}`, { terms: { field: name, size: 1000 } }]));
  aggs.subfield = { terms: { field: 'error.message.keyword', size: 10 } };
  const response = await msearch(LOGS_UID, RESTRICTED, { size: 0, aggs });
  assert.equal(response.error, undefined, JSON.stringify(response.error?.root_cause ?? response.error));
  const { subfield, ...groups } = response.aggregations;
  const keys = Object.values(groups).flatMap((agg) => agg.buckets.map((bucket) => bucket.key));
  assert.ok(keys.length > 1000, `expected many group keys, got ${keys.length}`);
  assert.doesNotMatch(JSON.stringify(keys), /PI-SENTINEL-/);
  // Why the subfield rule matters: grouping by it shows the text.
  assert.match(JSON.stringify(subfield.buckets), /PI-SENTINEL-/);
});

check('restricted documents with visible fields only contain no sentinels', async () => {
  const caps = await grafana(`/api/datasources/uid/${LOGS_UID}/resources/${RESTRICTED}/_field_caps`);
  const response = await msearch(LOGS_UID, RESTRICTED, {
    size: 500,
    _source: false,
    fields: visibleFields(caps),
    query: { bool: { filter: [range(incident.from, incident.to), { term: { 'log.level': 'ERROR' } }] } },
  });
  const documents = response.hits.hits.map((hit) => hit.fields);
  assert.ok(documents.length > 100, `expected incident error events, got ${documents.length}`);
  assert.ok(documents.some((doc) => doc['error.type']?.[0] === 'ReportRenderTimeout'));
  assert.doesNotMatch(JSON.stringify(response.hits.hits), /PI-SENTINEL-/);
});

check('the incident is visible as counts aligned with the metrics incident', async () => {
  const errors = (from, to) =>
    msearch(LOGS_UID, 'logs-app-prod', {
      size: 0,
      track_total_hits: true,
      query: {
        bool: {
          filter: [
            range(from, to),
            { term: { 'service.name': 'report-renderer' } },
            { term: { 'error.type': 'ReportRenderTimeout' } },
          ],
        },
      },
    }).then((r) => r.hits.total.value);
  const during = await errors(incident.from, incident.to);
  const before = await errors(window.from, incident.from);
  assert.ok(during > 100, `expected an error spike during the incident, got ${during}`);
  assert.equal(before, 0);

  const gateway = await msearch(LOGS_UID, 'logs-nginx.access-prod', {
    size: 0,
    query: { bool: { filter: [range(incident.from, incident.to), { term: { 'http.response.status_code': 504 } }] } },
    aggs: { hosts: { terms: { field: 'host.name' } } },
  });
  assert.equal(gateway.aggregations.hosts.buckets[0]?.key, 'vm-web-01');
});

// Documents matching the unrestricted condition are returned completely, all
// others with visible fields only: one _msearch with two searches, the
// condition as filter in one and as must_not in the other.
const UNRESTRICTED = { terms: { 'log.logger': ['deployer'] } };

check('a search returns unrestricted documents completely and others with visible fields', async () => {
  const caps = await grafana(`/api/datasources/uid/${LOGS_UID}/resources/logs-app-prod/_field_caps`);
  const filter = [range(window.from, window.to), { query_string: { query: 'service.name:report-renderer' } }];
  const sort = [{ '@timestamp': 'desc' }];
  const [unrestricted, restricted] = await msearch(
    LOGS_UID,
    'logs-app-prod',
    { size: 100, sort, query: { bool: { filter: [...filter, UNRESTRICTED] } } },
    {
      size: 100,
      sort,
      _source: false,
      fields: visibleFields(caps),
      query: { bool: { filter, must_not: [UNRESTRICTED] } },
    }
  );

  const complete = unrestricted.hits.hits.map((hit) => hit._source);
  assert.equal(complete.length, manifest.deploys.filter((deploy) => deploy.service === 'report-renderer').length);
  assert.doesNotMatch(JSON.stringify(complete), /PI-SENTINEL-/);
  const rollout = complete.find((doc) => doc.labels.change_id === 'CHG-4711' && doc.event.action === 'deploy-started');
  assert.ok(rollout['@timestamp'] < incident.to);
  assert.match(rollout.message, /report-renderer 3\.8\.0 to vm-web-01 started/);

  assert.equal(restricted.hits.hits.length, 100);
  assert.ok(
    restricted.hits.hits.every((hit) => hit._source === undefined && hit.fields['log.logger'][0] !== 'deployer')
  );
  assert.doesNotMatch(JSON.stringify(restricted.hits.hits), /PI-SENTINEL-/);
});

check('the datasource credential reaches raw restricted content', async () => {
  const app = await msearch(LOGS_UID, 'logs-app-prod', { size: 1, _source: ['message'] });
  assert.match(JSON.stringify(app.hits.hits[0]._source), /PI-SENTINEL-/);
  const audit = await msearch(LOGS_UID, 'logs-audit-prod', { size: 1, _source: ['message'] });
  assert.match(audit.hits.hits[0]._source.message, /PI-SENTINEL-AUD-/);
  const viaAudit = await msearch(AUDIT_UID, 'logs-audit-*', { size: 0, track_total_hits: true });
  assert.equal(viaAudit.hits.total.value, manifest.datasets.audit);
});

check('Elasticsearch denies indices outside the credential, with a detailed error', async () => {
  const response = await msearch(LOGS_UID, 'secrets-vault-export', { size: 1 });
  assert.equal(response.error?.type, 'security_exception');
  assert.match(response.error.reason, /secrets-vault-export/);
});

let failed = 0;
for (const { name, fn } of checks) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}\n     ${error.message.split('\n').join('\n     ')}`);
  }
}
console.log(
  `\n${checks.length - failed}/${checks.length} checks passed; fixture window ${window.from} – ${window.to}, ` +
    `incident ${incident.from} – ${incident.to}, ${manifest.documents} documents`
);
process.exitCode = failed ? 1 : 0;
