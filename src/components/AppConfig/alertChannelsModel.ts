import type { AlertChannelPlatform, AlertWebhookSettings } from '../../generated/api';

/** Options of an alert channel, as the assistant host reads them from the contact point URL. */
export type AlertChannelOptions = {
  investigate: 'mention' | 'auto' | 'off';
  screenshots: boolean;
  format: 'host' | 'grafana';
};

export const DEFAULT_ALERT_CHANNEL_OPTIONS: AlertChannelOptions = {
  investigate: 'mention',
  screenshots: true,
  format: 'host',
};

/** A webhook integration of Grafana's provisioning API (`/api/v1/provisioning/contact-points`). */
export type ProvisionedContactPoint = {
  uid?: string;
  name: string;
  type: string;
  settings: Record<string, unknown>;
  disableResolveMessage?: boolean;
};

/** An existing integration that sends to the assistant host. */
export type AlertChannelIntegration = {
  contactPoint: string;
  platform: string;
  channel: string;
  options: AlertChannelOptions;
};

export function platformLabel(platform: string) {
  return platform === 'webex' ? 'Webex' : platform === 'mattermost' ? 'Mattermost' : platform;
}

export function defaultContactPointName(platform: string, channelTitle: string) {
  return `${platformLabel(platform)}: ${channelTitle}`;
}

/**
 * The integration for the provisioning API. A contact point with the same
 * name gets it as a further integration, next to the ones it has.
 */
export function alertChannelContactPoint(name: string, settings: AlertWebhookSettings): ProvisionedContactPoint {
  return {
    name: name.trim(),
    type: 'webhook',
    settings: { ...settings },
    disableResolveMessage: false,
  };
}

/** Integrations of the contact points that send to the host, read from their URLs. */
export function alertChannelIntegrations(
  contactPoints: ProvisionedContactPoint[],
  hostUrl: string
): AlertChannelIntegration[] {
  const prefix = `${hostUrl.replace(/\/$/, '')}/alerts/`;
  return contactPoints.flatMap((contactPoint) => {
    const url = typeof contactPoint.settings?.url === 'string' ? contactPoint.settings.url : '';
    if (contactPoint.type !== 'webhook' || !url.startsWith(prefix)) {
      return [];
    }
    const parsed = new URL(url);
    const [platform, ...rest] = parsed.pathname.slice(new URL(prefix).pathname.length).split('/');
    if (!platform || rest.length === 0) {
      return [];
    }
    const query = parsed.searchParams;
    const investigate = query.get('investigate');
    return [
      {
        contactPoint: contactPoint.name,
        platform,
        channel: rest.map(decodeURIComponent).join('/'),
        options: {
          investigate: investigate === 'auto' || investigate === 'off' ? investigate : 'mention',
          screenshots: query.get('screenshots') !== 'off',
          format: query.get('format') === 'grafana' ? 'grafana' : 'host',
        },
      },
    ];
  });
}

/** A channel's title for the integration list: Webex names rooms by ID in URLs, Mattermost by team/channel. */
export function channelTitle(platforms: AlertChannelPlatform[], platform: string, channel: string) {
  const found = platforms
    .find((item) => item.platform === platform)
    ?.channels.find((item) => item.id === channel || item.name === channel);
  return found?.title ?? channel;
}
