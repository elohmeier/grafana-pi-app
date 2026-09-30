import { extractDashboardMetricUsage, metricUsageCorpus } from './dashboardMetricContext';

const panel = (id: number, exprs: string[]) => ({
  id,
  type: 'timeseries',
  title: `P${id}`,
  datasource: { uid: 'prom-main', type: 'prometheus' },
  targets: exprs.map((expr, index) => ({ refId: String.fromCharCode(65 + index), expr })),
});

function corpus(seedMetrics: string[]) {
  const http = {
    uid: 'http',
    title: 'HTTP',
    panels: [
      panel(1, [
        'sum(rate(http_requests_total[5m]))',
        'histogram_quantile(0.9, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))',
      ]),
    ],
  };
  const nodes = {
    uid: 'nodes',
    title: 'Nodes',
    panels: Array.from({ length: 30 }, (_, index) =>
      panel(index + 1, ['avg(rate(node_cpu_seconds_total{mode="idle"}[5m]))'])
    ),
  };
  return metricUsageCorpus({
    dashboards: [
      extractDashboardMetricUsage(http, { uid: 'http' }),
      extractDashboardMetricUsage(nodes, { uid: 'nodes' }),
    ],
    params: { seedMetrics },
  });
}

describe('metric usage ranking with seed metrics', () => {
  it('ranks the seeds and their co-used metrics before heavily used unrelated metrics', () => {
    expect(corpus(['http_requests_total']).metrics.map((metric) => metric.metric)).toEqual([
      'http_requests_total',
      'http_request_duration_seconds_bucket',
      'node_cpu_seconds_total',
    ]);
  });

  it('reports seeds no dashboard uses', () => {
    const result = corpus(['http_requests_total', 'ingest_samples_total']);
    expect(result.seedsNotFound).toEqual(['ingest_samples_total']);
    expect(corpus(['http_requests_total']).seedsNotFound).toBeUndefined();
  });
});
