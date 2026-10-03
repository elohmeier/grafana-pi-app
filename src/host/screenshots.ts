import type { ScreenshotParams } from '../pages/Chat/domain/types';
import type { WorkspaceBroker } from '../pages/Chat/workspace/broker';
import { checkScreenshotDatasources } from '../pages/Chat/workspace/commands/dashboards';
import type { GrafanaWebhook } from './alerts';
import type { ChannelFile } from './channel';

export type AlertPanel = { dashboardUid: string; panelId: number };

/** Panels the firing alerts of a notification link to (Grafana's `__dashboardUid__`/`__panelId__` annotations). */
export function alertPanels(payload: GrafanaWebhook): AlertPanel[] {
  const panels = new Map<string, AlertPanel>();
  for (const alert of payload.alerts) {
    const dashboardUid = alert.annotations?.__dashboardUid__;
    const panelId = Number(alert.annotations?.__panelId__);
    if (alert.status === 'firing' && dashboardUid && Number.isInteger(panelId)) {
      panels.set(`${dashboardUid}/${panelId}`, { dashboardUid, panelId });
    }
  }
  return [...panels.values()];
}

/**
 * Renders the linked panels from an hour before the first alert started until
 * now. The screenshot guard applies: a panel with data the assistant may not
 * read (logs, SQL) is not rendered.
 */
export async function renderAlertPanels(
  payload: GrafanaWebhook,
  broker: WorkspaceBroker,
  log?: (message: string) => void
): Promise<Array<{ title: string; file: ChannelFile }>> {
  const screenshot = broker.ui?.screenshot;
  if (!screenshot) {
    return [];
  }
  const started = Math.min(
    ...payload.alerts.map((alert) => Date.parse(alert.startsAt)).filter((time) => Number.isFinite(time))
  );
  const from = Number.isFinite(started) ? String(started - 3600_000) : 'now-3h';
  const rendered: Array<{ title: string; file: ChannelFile }> = [];
  for (const panel of alertPanels(payload)) {
    try {
      await checkScreenshotDatasources(panel.dashboardUid, panel.panelId, broker);
      const params: ScreenshotParams = {
        uid: panel.dashboardUid,
        panelId: panel.panelId,
        from,
        to: 'now',
        width: 1000,
        height: 500,
        theme: 'dark',
      };
      const image = await screenshot(params);
      rendered.push({
        title: `Panel ${panel.panelId} of dashboard ${panel.dashboardUid}`,
        file: {
          name: `${panel.dashboardUid}-panel-${panel.panelId}.png`,
          mimeType: image.mimeType,
          data: Uint8Array.from(Buffer.from(image.data, 'base64')),
        },
      });
    } catch (error) {
      log?.(
        `panel ${panel.dashboardUid}/${panel.panelId} not rendered: ${error instanceof Error ? error.message : error}`
      );
    }
  }
  return rendered;
}
