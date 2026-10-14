import { createHmac } from 'node:crypto';
import { isTestNotification, parseAlertRoute, verifyAlertRequest } from './alertRoutes';

describe('alert channel routes', () => {
  it('reads the platform, channel, and options, with mention as the default', () => {
    expect(parseAlertRoute('/alerts/webex/Y2lzY29zcGFyazovL3VzL1JPT00vYQ')).toEqual({
      platform: 'webex',
      channel: 'Y2lzY29zcGFyazovL3VzL1JPT00vYQ',
      options: { investigate: 'mention', screenshots: true, format: 'host' },
    });
    expect(parseAlertRoute('/alerts/webex/Ops%20Alerts?investigate=auto&screenshots=off&format=grafana')).toEqual({
      platform: 'webex',
      channel: 'Ops Alerts',
      options: { investigate: 'auto', screenshots: false, format: 'grafana' },
    });
    expect(parseAlertRoute('/alerts/mattermost/ops/alerts?investigate=off')).toMatchObject({
      platform: 'mattermost',
      channel: 'ops/alerts',
      options: { investigate: 'off' },
    });
  });

  it('refuses unknown options and leaves other paths alone', () => {
    expect(parseAlertRoute('/alerts/webex/room?investigate=always')).toEqual({
      error: expect.stringContaining('investigate=always'),
    });
    expect(parseAlertRoute('/alerts/webex/room?room=x')).toEqual({ error: expect.stringContaining('room=x') });
    expect(parseAlertRoute('/alerts/grafana')).toBeUndefined();
    expect(parseAlertRoute('/alerts/slack/room')).toBeUndefined();
  });

  it("verifies Grafana's HMAC signature, with and without a timestamp, and Bearer tokens", () => {
    const body = Buffer.from('{"status":"firing"}');
    const sign = (data: string) => createHmac('sha256', 'host-token').update(data).digest('hex');
    const now = 1_760_000_000_000;
    const ts = String(now / 1000);
    expect(verifyAlertRequest({ 'x-grafana-alerting-signature': sign(body.toString()) }, body, 'host-token', now)).toBe(
      true
    );
    expect(
      verifyAlertRequest(
        { 'x-grafana-alerting-signature': sign(`${ts}:${body}`), 'x-grafana-alerting-timestamp': ts },
        body,
        'host-token',
        now
      )
    ).toBe(true);
    // A replay ten minutes later, a signature with another secret, or one of another body.
    expect(
      verifyAlertRequest(
        { 'x-grafana-alerting-signature': sign(`${ts}:${body}`), 'x-grafana-alerting-timestamp': ts },
        body,
        'host-token',
        now + 10 * 60_000
      )
    ).toBe(false);
    expect(
      verifyAlertRequest(
        { 'x-grafana-alerting-signature': createHmac('sha256', 'other').update(body).digest('hex') },
        body,
        'host-token',
        now
      )
    ).toBe(false);
    expect(verifyAlertRequest({ 'x-grafana-alerting-signature': sign('{}') }, body, 'host-token', now)).toBe(false);
    expect(verifyAlertRequest({ authorization: 'Bearer host-token' }, body, 'host-token', now)).toBe(true);
    expect(verifyAlertRequest({ authorization: 'Bearer wrong' }, body, 'host-token', now)).toBe(false);
    expect(verifyAlertRequest({}, body, 'host-token', now)).toBe(false);
  });

  it("recognizes Grafana's test notification", () => {
    const alert = {
      status: 'firing' as const,
      labels: { alertname: 'TestAlert', instance: 'Grafana' },
      annotations: { summary: 'Notification test' },
      startsAt: '2026-10-14T10:00:00Z',
      fingerprint: 'f',
    };
    expect(isTestNotification({ status: 'firing', groupKey: 'g', alerts: [alert] })).toBe(true);
    expect(
      isTestNotification({ status: 'firing', groupKey: 'g', alerts: [{ ...alert, labels: { alertname: 'High 5xx' } }] })
    ).toBe(false);
  });
});
