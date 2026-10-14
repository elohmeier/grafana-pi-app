import { createHmac, timingSafeEqual } from 'node:crypto';
import type { GrafanaWebhook } from './alerts';

/**
 * Alert channels: a Grafana webhook contact point per chat channel
 * (docs/alert-channels.md). The URL names the platform and channel, and the
 * query its options, so notification policies decide where an alert goes and
 * how the host treats it:
 *
 *   POST /alerts/webex/<room ID or title>?investigate=mention&screenshots=on&format=host
 *   POST /alerts/mattermost/<team>/<channel>?investigate=auto
 */

/** `auto`: investigate each new episode; `mention`: when someone mentions the bot in the thread; `off`: no hint. */
export type InvestigateMode = 'auto' | 'mention' | 'off';
/** `host`: the host's message; `grafana`: the contact point's Message template (`message` of the payload). */
export type AlertFormat = 'host' | 'grafana';

export type AlertOptions = { investigate: InvestigateMode; screenshots: boolean; format: AlertFormat };

export const DEFAULT_ALERT_OPTIONS: AlertOptions = { investigate: 'mention', screenshots: true, format: 'host' };

export type AlertRoute = { platform: string; channel: string; options: AlertOptions };

/** Grafana's default signature header; the timestamp header has no default and is named in the contact point. */
export const HMAC_HEADER = 'X-Grafana-Alerting-Signature';
export const HMAC_TIMESTAMP_HEADER = 'X-Grafana-Alerting-Timestamp';
/** Signed timestamps older or newer than this are refused (replays). */
const MAX_CLOCK_SKEW_S = 5 * 60;

/** The route of `/alerts/<platform>/<channel>`, or an error message for a malformed one; undefined for other paths. */
export function parseAlertRoute(url: string): AlertRoute | { error: string } | undefined {
  const parsed = new URL(url, 'http://host');
  const match = parsed.pathname.match(/^\/alerts\/(webex|mattermost)\/(.+)$/);
  if (!match) {
    return undefined;
  }
  let channel: string;
  try {
    channel = decodeURIComponent(match[2]);
  } catch {
    return { error: 'malformed channel in the URL' };
  }
  const options = parseAlertOptions(parsed.searchParams);
  return 'error' in options ? options : { platform: match[1], channel, options };
}

export function parseAlertOptions(query: URLSearchParams): AlertOptions | { error: string } {
  const options = { ...DEFAULT_ALERT_OPTIONS };
  for (const [key, value] of query) {
    if (key === 'investigate' && ['auto', 'mention', 'off'].includes(value)) {
      options.investigate = value as InvestigateMode;
    } else if (key === 'screenshots' && ['on', 'off'].includes(value)) {
      options.screenshots = value === 'on';
    } else if (key === 'format' && ['host', 'grafana'].includes(value)) {
      options.format = value as AlertFormat;
    } else {
      return {
        error: `unsupported option ${key}=${value} (investigate=auto|mention|off, screenshots=on|off, format=host|grafana)`,
      };
    }
  }
  return options;
}

type Headers = Record<string, string | string[] | undefined>;

/**
 * Whether a notification comes from a contact point that knows the token: as a
 * Bearer token, or as Grafana's HMAC signature of the body (hex SHA-256, with
 * `<timestamp>:` in front when the contact point names a timestamp header).
 */
export function verifyAlertRequest(headers: Headers, body: Buffer, token: string, now = Date.now()) {
  const header = (name: string) => {
    const value = headers[name.toLowerCase()];
    return typeof value === 'string' ? value : undefined;
  };
  const authorization = header('authorization');
  if (authorization && sameSecret(authorization, `Bearer ${token}`)) {
    return true;
  }
  const signature = header(HMAC_HEADER);
  if (!signature) {
    return false;
  }
  const hmac = createHmac('sha256', token);
  const timestamp = header(HMAC_TIMESTAMP_HEADER);
  if (timestamp !== undefined) {
    const seconds = Number(timestamp);
    if (!Number.isInteger(seconds) || Math.abs(now / 1000 - seconds) > MAX_CLOCK_SKEW_S) {
      return false;
    }
    hmac.update(`${timestamp}:`);
  }
  return sameSecret(signature.toLowerCase(), hmac.update(body).digest('hex'));
}

export function sameSecret(actual: string, expected: string) {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Grafana's "Test" button: one alert `TestAlert` from instance `Grafana`, with the summary "Notification test". */
export function isTestNotification(payload: GrafanaWebhook) {
  return payload.alerts.some(
    (alert) =>
      alert.labels.alertname === 'TestAlert' &&
      alert.labels.instance === 'Grafana' &&
      alert.annotations.summary === 'Notification test'
  );
}
