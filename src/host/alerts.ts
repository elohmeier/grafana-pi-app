import type { AlertEpisode } from './store';

/** One alert of a Grafana webhook notification. */
export type GrafanaWebhookAlert = {
  status: 'firing' | 'resolved';
  labels: Record<string, string>;
  annotations: Record<string, string>;
  startsAt: string;
  endsAt?: string;
  generatorURL?: string;
  fingerprint: string;
  silenceURL?: string;
  dashboardURL?: string;
  panelURL?: string;
  values?: Record<string, number> | null;
  valueString?: string;
};

/** Grafana's webhook contact point payload (version 1). */
export type GrafanaWebhook = {
  receiver?: string;
  status: 'firing' | 'resolved';
  orgId?: number;
  alerts: GrafanaWebhookAlert[];
  groupLabels?: Record<string, string>;
  commonLabels?: Record<string, string>;
  commonAnnotations?: Record<string, string>;
  externalURL?: string;
  groupKey: string;
  truncatedAlerts?: number;
  title?: string;
};

export type AlertDelivery =
  /** A new firing episode: post a new thread and ask the assistant. */
  | { action: 'open' }
  /** The firing alerts of an open episode changed. */
  | { action: 'update'; episode: AlertEpisode }
  /** Every alert of an open episode resolved. */
  | { action: 'resolve'; episode: AlertEpisode }
  /** A repeated notification without changes, or a resolution without an open episode. */
  | { action: 'skip' };

export function isGrafanaWebhook(value: unknown): value is GrafanaWebhook {
  const payload = value as Partial<GrafanaWebhook> | undefined;
  return Boolean(
    payload &&
    typeof payload.groupKey === 'string' &&
    (payload.status === 'firing' || payload.status === 'resolved') &&
    Array.isArray(payload.alerts)
  );
}

/** What a notification means for its group's thread. */
export function decideDelivery(payload: GrafanaWebhook, episode: AlertEpisode | undefined): AlertDelivery {
  const open = episode?.status === 'firing' ? episode : undefined;
  if (payload.status === 'resolved') {
    return open ? { action: 'resolve', episode: open } : { action: 'skip' };
  }
  if (!open) {
    return { action: 'open' };
  }
  const firing = firingFingerprints(payload);
  const same = firing.length === open.fingerprints.length && firing.every((print) => open.fingerprints.includes(print));
  return same ? { action: 'skip' } : { action: 'update', episode: open };
}

export function firingFingerprints(payload: GrafanaWebhook) {
  return payload.alerts
    .filter((alert) => alert.status === 'firing')
    .map((alert) => alert.fingerprint)
    .sort();
}

/** The notification as a deterministic chat message; it does not depend on the model. */
export function formatAlertMessage(payload: GrafanaWebhook, kind: 'open' | 'update' | 'resolve') {
  const firing = payload.alerts.filter((alert) => alert.status === 'firing');
  const resolved = payload.alerts.filter((alert) => alert.status === 'resolved');
  const name = payload.commonLabels?.alertname ?? payload.groupLabels?.alertname ?? 'Grafana alert';
  const scope = Object.entries(payload.groupLabels ?? {})
    .filter(([key]) => key !== 'alertname')
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
  const heading =
    kind === 'resolve'
      ? `✅ **Resolved: ${name}**`
      : `🚨 **${kind === 'update' ? 'Update: ' : ''}${name}** — ${firing.length} firing${resolved.length ? `, ${resolved.length} resolved` : ''}`;
  const lines = [heading + (scope ? ` (${scope})` : '')];
  const summary = payload.commonAnnotations?.summary ?? payload.commonAnnotations?.description;
  if (summary && kind !== 'resolve') {
    lines.push(summary);
  }
  const shown = kind === 'resolve' ? resolved : firing;
  for (const alert of shown.slice(0, 10)) {
    const labels = Object.entries(alert.labels)
      .filter(([key]) => key !== 'alertname' && !(key in (payload.groupLabels ?? {})) && !key.startsWith('__'))
      .map(([key, value]) => `${key}=${value}`)
      .join(', ');
    const value = alert.values
      ? Object.entries(alert.values)
          .map(([key, v]) => `${key}=${formatNumber(v)}`)
          .join(' ')
      : '';
    const links = [
      alert.dashboardURL && `[dashboard](${alert.dashboardURL})`,
      alert.panelURL && `[panel](${alert.panelURL})`,
      alert.generatorURL && `[rule](${alert.generatorURL})`,
      kind !== 'resolve' && alert.silenceURL && `[silence](${alert.silenceURL})`,
    ].filter(Boolean);
    lines.push(
      `- ${labels || alert.labels.alertname || alert.fingerprint}${value ? ` — ${value}` : ''}${kind === 'resolve' ? '' : ` since ${time(alert.startsAt)}`}${links.length ? ` · ${links.join(' · ')}` : ''}`
    );
  }
  if (shown.length > 10 || payload.truncatedAlerts) {
    lines.push(`- … ${shown.length - Math.min(shown.length, 10) + (payload.truncatedAlerts ?? 0)} more`);
  }
  return lines.join('\n');
}

/** The prompt that asks the assistant to investigate a new episode. */
export function analysisPrompt(payload: GrafanaWebhook) {
  const firing = payload.alerts.filter((alert) => alert.status === 'firing');
  const alerts = firing.slice(0, 20).map((alert) => ({
    labels: alert.labels,
    annotations: alert.annotations,
    startsAt: alert.startsAt,
    values: alert.values ?? undefined,
    ruleUid: ruleUid(alert.generatorURL),
    dashboardUid: alert.annotations.__dashboardUid__,
    panelId: alert.annotations.__panelId__,
  }));
  return [
    'A Grafana alert started firing and was just posted to this thread. Investigate it:',
    'what is affected, since when, how bad it is now, and the most likely cause. Look up the alert rule',
    '(`grafana-alert get`), check its query and the linked dashboard panel, and query the data around the start time.',
    'Answer for the people on call in at most about 12 lines.',
    '',
    '```json',
    JSON.stringify({ groupLabels: payload.groupLabels, alerts }, null, 2),
    '```',
  ].join('\n');
}

function ruleUid(url: string | undefined) {
  return url?.match(/\/alerting\/grafana\/([^/]+)\//)?.[1];
}

function time(value: string) {
  return value.replace(/\.\d+Z$/, 'Z').replace('T', ' ');
}

function formatNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toPrecision(4);
}
