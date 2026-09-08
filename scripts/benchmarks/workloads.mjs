export const workloadPrompts = {
  analysis: [
    'Use exactly one run_investigation_agent tool call to analyze the demo Prometheus incident.',
    'Do not call run_query_agent, query_prometheus, or any dashboard tool directly at top level; this benchmark is measuring run_investigation_agent as the top-level analysis tool.',
    'Analyze the last 6 hours of the demo Prometheus data and summarize what is wrong.',
    'Use at most eight tool calls; prefer batched query_prometheus calls for HTTP 500s by vm/route, latency, node_load1, and CPU.',
    'Final answer must be exactly five short bullets: finding, affected host, affected route/status, CPU/load/latency corroboration, validated PromQL.',
    'Do not create, render, sync, upload, or modify dashboards.',
  ].join(' '),
  'explore-metrics': [
    'Use exactly one run_query_agent tool call to discover the demo Prometheus metrics for HTTP request errors, HTTP latency histograms, node load, and CPU usage.',
    'Do not call list_datasources, list_metrics, inspect_metric_series, list_label_values, query_prometheus, or any dashboard tool directly; this benchmark is measuring run_query_agent as the only top-level tool call.',
    'Call run_query_agent with this task: Find HTTP error rate (500s), latency, node_load1, and CPU usage metrics in the default Prometheus datasource. Search by prefixes http, node_load, and node_cpu. List exact metric names and labels for HTTP requests by status code, route, and vm; histogram latency by route and vm; node load; and CPU utilization. Validate candidate PromQL with query_prometheus before returning.',
    'After the tool returns, answer with exactly four short bullets: metric coverage, labels/values, useful PromQL, caveats.',
    'Do not create, render, sync, upload, or modify dashboards.',
  ].join(' '),
};

export const followUpPrompt =
  'Using only the evidence already collected, give two short bullets with a validated PromQL expression and what it shows. Do not call tools or modify anything.';

export function finalAnswer(events) {
  const message = [...events]
    .reverse()
    .find((e) => e.type === 'message_end' && e.message?.role === 'assistant')?.message;
  return (message?.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

// A load session must perform useful work. These are evidence gates without the
// serial quality suite's latency budgets, so saturation is measured separately.
export function workloadQualityError(workload, events, followUp = false) {
  const answer = finalAnswer(events);
  const assistantError = events.find(
    (e) =>
      e.type === 'message_end' &&
      e.message?.role === 'assistant' &&
      (e.message.errorMessage || ['error', 'aborted', 'length'].includes(e.message.stopReason))
  );
  if (assistantError) {
    return assistantError.message.errorMessage || `Assistant stopped: ${assistantError.message.stopReason}`;
  }
  if (!answer) {
    return 'Empty final answer';
  }
  const starts = events.filter((e) => e.type === 'tool_execution_start');
  if (followUp) {
    return starts.length ? 'Follow-up unexpectedly called tools' : undefined;
  }
  const expected = workload === 'analysis' ? 'run_investigation_agent' : 'run_query_agent';
  if (starts.length !== 1 || starts[0].toolName !== expected) {
    return `Expected exactly one ${expected} call`;
  }
  const end = events.find((e) => e.type === 'tool_execution_end' && e.toolCallId === starts[0].toolCallId);
  if (!end || end.isError) {
    return `${expected} did not complete successfully`;
  }
  const nested = end.result?.details?.toolCalls ?? [];
  if (!nested.some((c) => c.name === 'query_prometheus' && c.status === 'completed' && !c.isError)) {
    return 'Missing successful PromQL evidence';
  }
  if (nested.some((c) => c.isError || c.status === 'failed')) {
    return 'A nested tool failed';
  }
  if (
    nested.some((c) =>
      /^(write_jsonnet|edit_jsonnet|fix_jsonnet|render_dashboard|save_dashboard|upload_dashboard|delete_dashboard)$/.test(
        c.name
      )
    )
  ) {
    return 'Workload used a dashboard write tool';
  }
  const evidence = answer + '\n' + JSON.stringify(end.result?.content ?? []);
  const patterns =
    workload === 'analysis'
      ? [/vm-web-01/i, /\/render\/report/i, /500|5xx/i, /cpu|load|latenc/i]
      : [/http_requests_total/, /http_request_duration_seconds_bucket/, /node_load1/, /node_cpu_seconds_total/];
  return patterns.some((p) => !p.test(evidence)) ? 'Missing workload evidence' : undefined;
}
