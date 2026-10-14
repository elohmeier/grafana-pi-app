import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { css } from '@emotion/css';
import type { GrafanaTheme2 } from '@grafana/data';
import { getBackendSrv } from '@grafana/runtime';
import {
  Alert,
  Button,
  Checkbox,
  Combobox,
  Field,
  FieldSet,
  LoadingPlaceholder,
  RadioButtonGroup,
  TextLink,
  useStyles2,
  type ComboboxOption,
} from '@grafana/ui';
import type { AlertChannelsResponse, AlertWebhookSettings } from '../../generated/api';
import { testIds } from '../testIds';
import {
  alertChannelContactPoint,
  alertChannelIntegrations,
  channelTitle,
  defaultContactPointName,
  DEFAULT_ALERT_CHANNEL_OPTIONS,
  platformLabel,
  type AlertChannelOptions,
  type ProvisionedContactPoint,
} from './alertChannelsModel';

const CONTACT_POINTS_URL = '/api/v1/provisioning/contact-points';

const investigateOptions: Array<{ label: string; value: AlertChannelOptions['investigate']; description: string }> = [
  { label: 'On mention', value: 'mention', description: 'The thread says to mention the bot; it investigates then.' },
  { label: 'Automatically', value: 'auto', description: 'Investigate each new alert episode (model cost per alert).' },
  { label: 'Off', value: 'off', description: 'No hint; mentions in the thread are still answered.' },
];

const formatOptions: Array<{ label: string; value: AlertChannelOptions['format']; description: string }> = [
  {
    label: 'Assistant',
    value: 'host',
    description: "The assistant host's alert message with labels, values, and links.",
  },
  {
    label: 'Contact point template',
    value: 'grafana',
    description: "The integration's Message template, rendered by Grafana.",
  },
];

/**
 * Alert channels (docs/alert-channels.md): creates Grafana webhook contact
 * points that send to a chat channel of the assistant host. The plugin backend
 * lists the bot's channels and provides the webhook settings with the host
 * token; the contact point is created as the signed-in admin, so notification
 * policies route to it like to any other contact point.
 */
export function AlertChannels({ pluginId }: { pluginId: string }) {
  const s = useStyles2(getStyles);
  const [host, setHost] = useState<AlertChannelsResponse>();
  const [contactPoints, setContactPoints] = useState<ProvisionedContactPoint[]>([]);
  const [loadError, setLoadError] = useState<string>();
  const [platform, setPlatform] = useState('');
  const [channelId, setChannelId] = useState('');
  const [name, setName] = useState('');
  /** The admin typed or picked a name; until then it follows the channel. */
  const [nameEdited, setNameEdited] = useState(false);
  const [options, setOptions] = useState<AlertChannelOptions>(DEFAULT_ALERT_CHANNEL_OPTIONS);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string }>();

  const apply = useCallback((loaded: Loaded) => {
    setLoadError(undefined);
    setHost(loaded.channels);
    setContactPoints(loaded.contactPoints);
    setPlatform((current) => current || loaded.channels.platforms[0]?.platform || '');
  }, []);

  /** Loads again after a change or on Retry. */
  const load = useCallback(
    () => fetchAlertChannels(pluginId).then(apply, (error) => setLoadError(errorMessage(error))),
    [pluginId, apply]
  );

  useEffect(() => {
    let active = true;
    fetchAlertChannels(pluginId).then(
      (loaded) => active && apply(loaded),
      (error) => active && setLoadError(errorMessage(error))
    );
    return () => {
      active = false;
    };
  }, [pluginId, apply]);

  const platforms = useMemo(() => host?.platforms ?? [], [host]);
  const current = platforms.find((item) => item.platform === platform);
  const channel = current?.channels.find((item) => item.id === channelId);
  const integrations = useMemo(
    () => (host ? alertChannelIntegrations(contactPoints, host.hostUrl) : []),
    [contactPoints, host]
  );
  const contactPointNames = useMemo(
    () => [...new Set(contactPoints.map((contactPoint) => contactPoint.name))].sort(),
    [contactPoints]
  );
  const existing = contactPointNames.includes(name.trim());

  const onChannel = (option: ComboboxOption<string>) => {
    setChannelId(option.value);
    const title = current?.channels.find((item) => item.id === option.value)?.title ?? option.value;
    if (!nameEdited) {
      setName(defaultContactPointName(platform, title));
    }
  };

  const onCreate = async () => {
    setBusy(true);
    setResult(undefined);
    try {
      const settings = await getBackendSrv().post<AlertWebhookSettings>(
        `/api/plugins/${pluginId}/resources/alert-channels/webhook`,
        {
          platform,
          channelId,
          investigate: options.investigate,
          screenshots: options.screenshots,
          format: options.format,
        },
        { showErrorAlert: false }
      );
      // Without provenance, the contact point stays editable in Grafana's alerting UI.
      await getBackendSrv().post(CONTACT_POINTS_URL, alertChannelContactPoint(name, settings), {
        headers: { 'X-Disable-Provenance': 'true' },
        showErrorAlert: false,
      });
      setResult({
        ok: true,
        text: existing
          ? `Added the ${platformLabel(platform)} integration to contact point "${name.trim()}".`
          : `Created contact point "${name.trim()}". Route alerts to it in a notification policy or an alert rule.`,
      });
      await load();
    } catch (error) {
      setResult({ ok: false, text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <FieldSet label="Alert channels" className={s.marginTopXl} data-testid={testIds.appConfig.alertChannels}>
      <p className={s.colorWeak}>
        Contact points that post alerts to a chat channel through the assistant host: one thread per alert group,
        updates and the resolution in it, panel screenshots, and the assistant in the thread. Notification policies
        decide which alerts reach which channel.
      </p>
      {loadError && (
        <Alert severity="error" title="Cannot load the alert channels">
          {loadError}{' '}
          <Button size="sm" variant="secondary" onClick={() => void load()}>
            Retry
          </Button>
        </Alert>
      )}
      {!host && !loadError && <LoadingPlaceholder text="Loading the bot's channels…" />}
      {host && platforms.length === 0 && (
        <Alert severity="info" title="No chat platform">
          The assistant host has no chat platform configured.
        </Alert>
      )}
      {host && platforms.length > 0 && (
        <>
          {platforms.length > 1 && (
            <Field label="Platform">
              <RadioButtonGroup
                options={platforms.map((item) => ({ label: platformLabel(item.platform), value: item.platform }))}
                value={platform}
                onChange={(value) => {
                  setPlatform(value);
                  setChannelId('');
                  if (!nameEdited) {
                    setName('');
                  }
                }}
              />
            </Field>
          )}
          <Field
            label="Channel"
            description={`Channels the ${platformLabel(platform)} bot ${current?.bot ? `"${current.bot}" ` : ''}is a member of. Add the bot to a channel to see it here.`}
          >
            <Combobox<string>
              width={60}
              placeholder="Choose a channel"
              options={(current?.channels ?? []).map((item) => ({
                label: item.title,
                value: item.id,
                description: item.name !== item.title ? item.name : undefined,
              }))}
              value={channelId || null}
              onChange={onChannel}
            />
          </Field>
          <Field
            label="Contact point"
            description="A new name creates a contact point; an existing name adds this integration to it, next to its other integrations."
          >
            <Combobox<string>
              width={60}
              placeholder="Contact point name"
              createCustomValue
              options={contactPointNames.map((item) => ({ label: item, value: item }))}
              value={name || null}
              onChange={(option) => {
                setName(option.value);
                setNameEdited(true);
              }}
            />
          </Field>
          <Field label="Investigation">
            <RadioButtonGroup
              options={investigateOptions}
              value={options.investigate}
              onChange={(investigate) => setOptions({ ...options, investigate })}
            />
          </Field>
          <Field label="Message">
            <RadioButtonGroup
              options={formatOptions}
              value={options.format}
              onChange={(format) => setOptions({ ...options, format })}
            />
          </Field>
          <Checkbox
            label="Post panel screenshots"
            description="Screenshots of the panels the alerts link to, in the new thread."
            value={options.screenshots}
            onChange={(event) => setOptions({ ...options, screenshots: event.currentTarget.checked })}
          />
          <div className={s.marginTop}>
            <Button
              type="button"
              data-testid={testIds.appConfig.alertChannelCreate}
              disabled={busy || !channel || !name.trim()}
              icon={busy ? 'spinner' : undefined}
              onClick={() => void onCreate()}
            >
              {existing ? 'Add to contact point' : 'Create contact point'}
            </Button>
          </div>
          {result && (
            <Alert
              className={s.marginTop}
              severity={result.ok ? 'success' : 'error'}
              title={result.ok ? 'Done' : 'Failed'}
            >
              {result.text}
            </Alert>
          )}
          <h4 className={s.marginTop}>Contact points with alert channels</h4>
          {integrations.length === 0 ? (
            <p className={s.colorWeak}>None yet.</p>
          ) : (
            <table className={s.table}>
              <thead>
                <tr>
                  <th>Contact point</th>
                  <th>Channel</th>
                  <th>Investigation</th>
                  <th>Message</th>
                  <th>Screenshots</th>
                </tr>
              </thead>
              <tbody>
                {integrations.map((item, index) => (
                  <tr key={`${item.contactPoint}-${index}`}>
                    <td>{item.contactPoint}</td>
                    <td>
                      {platformLabel(item.platform)}: {channelTitle(platforms, item.platform, item.channel)}
                    </td>
                    <td>{investigateOptions.find((option) => option.value === item.options.investigate)?.label}</td>
                    <td>{formatOptions.find((option) => option.value === item.options.format)?.label}</td>
                    <td>{item.options.screenshots ? 'Yes' : 'No'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className={s.colorWeak}>
            Edit or delete them under{' '}
            <TextLink href="/alerting/notifications" inline>
              Alerting › Contact points
            </TextLink>
            .
          </p>
        </>
      )}
    </FieldSet>
  );
}

type Loaded = { channels: AlertChannelsResponse; contactPoints: ProvisionedContactPoint[] };

/** The bot's channels from the plugin backend and the contact points from Grafana's provisioning API. */
async function fetchAlertChannels(pluginId: string): Promise<Loaded> {
  const quiet = { showErrorAlert: false };
  const [channels, contactPoints] = await Promise.all([
    getBackendSrv().get<AlertChannelsResponse>(
      `/api/plugins/${pluginId}/resources/alert-channels`,
      undefined,
      undefined,
      quiet
    ),
    getBackendSrv().get<ProvisionedContactPoint[]>(CONTACT_POINTS_URL, undefined, undefined, quiet),
  ]);
  return { channels, contactPoints: contactPoints ?? [] };
}

function errorMessage(error: unknown) {
  const data = (error as { data?: { error?: string; message?: string } })?.data;
  return data?.error ?? data?.message ?? (error instanceof Error ? error.message : String(error));
}

const getStyles = (theme: GrafanaTheme2) => ({
  colorWeak: css`
    color: ${theme.colors.text.secondary};
  `,
  marginTop: css`
    margin-top: ${theme.spacing(2)};
  `,
  marginTopXl: css`
    margin-top: ${theme.spacing(6)};
  `,
  table: css`
    border-collapse: collapse;
    max-width: 900px;
    width: 100%;
    th,
    td {
      border-bottom: 1px solid ${theme.colors.border.weak};
      padding: ${theme.spacing(0.75, 1)};
      text-align: left;
    }
  `,
});
