import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { config } from '@grafana/runtime';
import { Type } from 'typebox';
import { backendFetch } from './client';
import { throwIfAborted } from './result';
import type { ScreenshotParams } from './types';

/** Screenshots through Grafana image rendering; dashboard reads and writes go through the session filesystem. */
export function createDashboardScreenshotTools(): AgentTool[] {
  return [grafanaScreenshotTool];
}

const grafanaScreenshotTool: AgentTool = {
  name: 'screenshot_dashboard',
  label: 'Render dashboard screenshot',
  description: 'Render a dashboard or panel image using Grafana image rendering, if configured.',
  parameters: Type.Object({
    uid: Type.String({ description: 'Dashboard UID.' }),
    panelId: Type.Optional(Type.Number({ description: 'Optional panel ID for d-solo rendering.' })),
    from: Type.Optional(Type.String({ description: 'Render start time. Defaults to now-1h.' })),
    to: Type.Optional(Type.String({ description: 'Render end time. Defaults to now.' })),
    width: Type.Optional(Type.Number({ description: 'Image width. Defaults to 1200.' })),
    height: Type.Optional(Type.Number({ description: 'Image height. Defaults to 700.' })),
    theme: Type.Optional(Type.Union([Type.Literal('dark'), Type.Literal('light')], { description: 'Render theme.' })),
  }),
  async execute(_toolCallId, params, signal) {
    const args = params as ScreenshotParams;
    return renderDashboardScreenshot(args, signal);
  },
};

export async function renderDashboardScreenshot(
  args: ScreenshotParams,
  signal?: AbortSignal
): Promise<AgentToolResult<Record<string, unknown>>> {
  throwIfAborted(signal);
  const dashboard = await backendFetch<{ meta: { slug: string } }>(
    `/api/dashboards/uid/${encodeURIComponent(args.uid)}`
  );
  const width = clamp(args.width ?? 1200, 300, 2400);
  const height = clamp(args.height ?? 700, 200, 2400);
  const renderPath =
    typeof args.panelId === 'number'
      ? `/render/d-solo/${encodeURIComponent(args.uid)}/${encodeURIComponent(dashboard.meta.slug)}`
      : `/render/d/${encodeURIComponent(args.uid)}/${encodeURIComponent(dashboard.meta.slug)}`;
  const renderUrl = new URL(renderPath, window.location.origin);
  renderUrl.searchParams.set('orgId', String(config.bootData.user.orgId || 1));
  renderUrl.searchParams.set('from', args.from ?? 'now-1h');
  renderUrl.searchParams.set('to', args.to ?? 'now');
  renderUrl.searchParams.set('width', String(width));
  renderUrl.searchParams.set('height', String(height));
  renderUrl.searchParams.set('theme', args.theme ?? 'dark');
  renderUrl.searchParams.set('kiosk', '1');
  if (typeof args.panelId === 'number') {
    renderUrl.searchParams.set('panelId', String(args.panelId));
  }

  const response = await fetch(renderUrl.toString(), { signal });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Grafana render failed (${response.status}). Is image rendering configured? ${errorText}`);
  }

  const data = arrayBufferToBase64(await response.arrayBuffer());
  return {
    content: [
      { type: 'text', text: `Rendered ${args.uid}${args.panelId ? ` panel ${args.panelId}` : ''}.` },
      { type: 'image', data, mimeType: response.headers.get('content-type') || 'image/png' },
    ],
    details: {
      uid: args.uid,
      panelId: args.panelId,
      width,
      height,
    },
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}
