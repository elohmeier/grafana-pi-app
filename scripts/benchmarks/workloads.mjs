export const workloadPrompts = {
  analysis: [
    'Analyze the last 6 hours of the demo Prometheus data and summarize what is wrong.',
    'Check HTTP 500s by vm and route, latency, node_load1, and CPU, and validate the PromQL your conclusions rely on.',
    'Final answer must be exactly five short bullets: finding, affected host, affected route/status, CPU/load/latency corroboration, validated PromQL.',
    'Do not create or modify dashboards.',
  ].join(' '),
  'explore-metrics': [
    'Find the metrics for HTTP request errors (500s), HTTP latency histograms, node load, and CPU usage in the default demo Prometheus datasource.',
    'List the exact metric names and the labels for HTTP requests by status code, route, and vm; histogram latency by route and vm; node load; and CPU utilization.',
    'Validate useful PromQL for each signal before answering.',
    'Answer with exactly four short bullets: metric coverage, labels/values, useful PromQL, caveats.',
    'Do not create or modify dashboards.',
  ].join(' '),
  'log-incident': [
    'Users report that report downloads started failing recently.',
    'Investigate with the application and access logs of the last 6 hours: when did the failures start, which service, host, and error types are affected, and did a change precede them?',
    'Answer with exactly four short bullets: onset (UTC), affected scope, error types, preceding change.',
    'Do not create or modify dashboards.',
  ].join(' '),
};

export const followUpPrompt =
  'Using only the evidence already collected, give two short bullets with a validated PromQL expression and what it shows. Do not call tools or modify anything.';

// Budgets for one workload turn. Generous enough for recovery, finite to catch loops.
export const workloadBudgets = {
  analysis: { maxToolCalls: 16 },
  'explore-metrics': { maxToolCalls: 14 },
  // One count per dimension (time, error type, host, version) plus the deployment lookup; loops exceed 40.
  'log-incident': { maxToolCalls: 20 },
};

const LIVE_DASHBOARD_WRITE_TOOL =
  /^(rename_live_dashboard_panel|update_live_dashboard_|add_live_dashboard_|move_or_resize_live_dashboard_|apply_live_dashboard_)/;

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

/** Completed bash tool calls with the details reported by the session shell. */
export function bashToolCalls(events) {
  const starts = new Map(
    events.filter((e) => e.type === 'tool_execution_start' && e.toolName === 'bash').map((e) => [e.toolCallId, e])
  );
  return events
    .filter((e) => e.type === 'tool_execution_end' && starts.has(e.toolCallId))
    .map((end) => {
      const details = end.result?.details ?? {};
      return {
        command:
          typeof details.command === 'string' ? details.command : (starts.get(end.toolCallId).args?.command ?? ''),
        exitCode: details.exitCode,
        stdout: typeof details.stdout === 'string' ? details.stdout : '',
        isError: end.isError === true,
        timedOut: details.timedOut === true,
      };
    });
}

export function successfulPromQueries(events) {
  return bashToolCalls(events).filter(
    (call) => /\bgrafana-prom\s+query\b/.test(call.command) && !call.isError && !call.timedOut && call.exitCode === 0
  );
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
  const budget = workloadBudgets[workload];
  if (budget && starts.length > budget.maxToolCalls) {
    return `Used ${starts.length} tool calls, budget is ${budget.maxToolCalls}`;
  }
  const bash = bashToolCalls(events);
  if (
    bash.some((call) => /\bworkspace\s+apply\b/.test(call.command)) ||
    starts.some((e) => LIVE_DASHBOARD_WRITE_TOOL.test(e.toolName ?? ''))
  ) {
    return 'Workload attempted a dashboard write';
  }
  const queries = successfulPromQueries(events);
  if (!queries.length) {
    return 'Missing successful PromQL evidence (grafana-prom query)';
  }
  const evidence = [answer, ...queries.map((call) => `${call.command}\n${call.stdout}`)].join('\n');
  const patterns =
    workload === 'analysis'
      ? [/vm-web-01/i, /\/render\/report/i, /500|5xx/i, /cpu|load|latenc/i]
      : [/http_requests_total/, /http_request_duration_seconds_bucket/, /node_load1/, /node_cpu_seconds_total/];
  return patterns.some((p) => !p.test(evidence)) ? 'Missing workload evidence' : undefined;
}
