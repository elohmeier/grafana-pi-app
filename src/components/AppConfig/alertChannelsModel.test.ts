import {
  alertChannelContactPoint,
  alertChannelIntegrations,
  channelTitle,
  defaultContactPointName,
} from './alertChannelsModel';

const settings = {
  url: 'http://host:8080/alerts/webex/ROOM1?investigate=auto',
  httpMethod: 'POST',
  hmacConfig: { secret: 's', header: 'X-Grafana-Alerting-Signature', timestampHeader: 'X-Grafana-Alerting-Timestamp' },
};

describe('alert channel contact points', () => {
  it('builds a webhook integration for the provisioning API', () => {
    expect(alertChannelContactPoint('  Webex: Ops  ', settings)).toEqual({
      name: 'Webex: Ops',
      type: 'webhook',
      settings,
      disableResolveMessage: false,
    });
    expect(defaultContactPointName('mattermost', 'Alerts')).toBe('Mattermost: Alerts');
  });

  it('finds the integrations that send to the host and reads their options', () => {
    const integrations = alertChannelIntegrations(
      [
        { name: 'Ops', type: 'webhook', settings: { url: 'http://host:8080/alerts/webex/ROOM1?investigate=auto' } },
        { name: 'Ops', type: 'webhook', settings: { url: 'https://obm-proxy/alerts' } },
        {
          name: 'Team',
          type: 'webhook',
          settings: { url: 'http://host:8080/alerts/mattermost/ops/town%20square?screenshots=off&format=grafana' },
        },
        { name: 'Mail', type: 'email', settings: { addresses: 'a@example.com' } },
      ],
      'http://host:8080/'
    );
    expect(integrations).toEqual([
      {
        contactPoint: 'Ops',
        platform: 'webex',
        channel: 'ROOM1',
        options: { investigate: 'auto', screenshots: true, format: 'host' },
      },
      {
        contactPoint: 'Team',
        platform: 'mattermost',
        channel: 'ops/town square',
        options: { investigate: 'mention', screenshots: false, format: 'grafana' },
      },
    ]);
    const platforms = [
      { platform: 'webex', bot: 'Bot', channels: [{ id: 'ROOM1', name: 'Ops Alerts', title: 'Ops Alerts' }] },
    ];
    expect(channelTitle(platforms, 'webex', 'ROOM1')).toBe('Ops Alerts');
    expect(channelTitle(platforms, 'webex', 'GONE')).toBe('GONE');
  });
});
