/**
 * Cleans an error message that Grafana's Prometheus backend produced from an upstream error.
 *
 * Grafana formats Prometheus API errors as `<errorType>: <error>`. Upstreams that omit
 * `errorType` (some Thanos and proxy deployments) yield `: parse error: ...`.
 */
export function cleanPrometheusError(message: string): string {
  return message.replace(/^\s*:\s+/, '').trim();
}
