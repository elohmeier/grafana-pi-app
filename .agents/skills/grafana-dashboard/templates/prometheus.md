# Prometheus Dashboard Template

```jsonnet
local d = import 'github.com/g42/pi-dashboard/main.libsonnet';

d.dashboard.new(
  title='Service Overview',
  uid='service-overview',
  tags=['service'],
  time={ from: 'now-6h', to: 'now' },
  rows=[
    d.row('Golden Signals', [
      d.layout.twoUp([
        d.panel.timeseries(
          title='Request rate',
          datasourceUid='prometheus',
          targets=[d.prom.query('sum(rate(http_requests_total[$__rate_interval]))', 'prometheus')],
          unit='reqps',
        ),
        d.panel.timeseries(
          title='Error rate',
          datasourceUid='prometheus',
          targets=[d.prom.query('sum(rate(http_requests_total{status=~"5.."}[$__rate_interval]))', 'prometheus')],
          unit='reqps',
        ),
      ]),
      d.layout.full(
        d.panel.table(
          title='Targets',
          datasourceUid='prometheus',
          targets=[d.prom.query('up', 'prometheus', instant=true, format='table')],
          columns=['job', 'instance', 'Value'],
          rename={ Value: 'Up' },
        ),
        h=10,
      ),
    ]),
  ],
)
```

Use only verified metrics and labels. For rate/trend panels, validate candidate PromQL with `query_prometheus` `type="range"` over the same time range as the dashboard before writing Jsonnet. If `http_requests_total` or `status` is not present, inspect available metrics and adjust before writing panels.

Use `time={ from: 'now-6h', to: 'now' }` for the dashboard time range. Do not use `timeframe`, `timeFrom`, or `timeTo` with `d.dashboard.new`.
