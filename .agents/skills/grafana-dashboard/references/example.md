# Dashboard Jsonnet Example

Use this as the default shape for new durable dashboards:

```jsonnet
local d = import 'github.com/g42/pi-dashboard/main.libsonnet';

d.dashboard.new(
  title='HTTP Request Rate & Errors',
  uid='http-request-rate-errors',
  tags=['http', 'requests'],
  time={ from: 'now-6h', to: 'now' },
  rows=[
    d.row('Overview', [
      d.layout.twoUp([
        d.panel.timeseries(
          title='Request rate',
          datasourceUid='prometheus',
          targets=[
            d.prom.query(
              'sum(rate(http_requests_total[$__rate_interval])) by (job)',
              'prometheus',
              legend='{{job}}',
            ),
          ],
          unit='reqps',
        ),
        d.panel.stat(
          title='5xx error rate',
          datasourceUid='prometheus',
          targets=[
            d.prom.query(
              'sum(rate(http_requests_total{status=~"5.."}[$__rate_interval]))',
              'prometheus',
              instant=true,
            ),
          ],
          unit='reqps',
        ),
      ]),
    ]),
  ],
)
```

Do not use `d.dashboard.new(...) + d.dashboard.with_*` chains unless you specifically need an optional mixin. Prefer passing title, uid, tags, time, refresh, and rows directly to `d.dashboard.new(...)`.

Do not pass `timeframe`, `timeFrom`, or `timeTo` to `d.dashboard.new`; use `time={ from: 'now-6h', to: 'now' }`.
