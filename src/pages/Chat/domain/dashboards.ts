import { config } from '@grafana/runtime';
import type { DashboardImage } from '../workspace/broker';
import { backendFetch } from './client';
import { throwIfAborted } from './result';
import type { ScreenshotParams } from './types';

/** Renders a dashboard or panel through Grafana image rendering (requires the image renderer). */
/** Where the image renderer is called: the page's Grafana with its session, or (assistant host) a URL with a token. */
export type RenderTarget = { origin: string; headers?: Record<string, string> };

export async function renderDashboardScreenshot(
  args: ScreenshotParams,
  signal?: AbortSignal,
  target: RenderTarget = { origin: window.location.origin }
): Promise<DashboardImage> {
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
  const renderUrl = new URL(renderPath, target.origin);
  renderUrl.searchParams.set('orgId', String(config.bootData.user.orgId || 1));
  renderUrl.searchParams.set('from', renderTime(args.from ?? 'now-1h'));
  renderUrl.searchParams.set('to', renderTime(args.to ?? 'now'));
  renderUrl.searchParams.set('width', String(width));
  renderUrl.searchParams.set('height', String(height));
  renderUrl.searchParams.set('theme', args.theme ?? 'dark');
  renderUrl.searchParams.set('kiosk', '1');
  if (typeof args.panelId === 'number') {
    renderUrl.searchParams.set('panelId', String(args.panelId));
  }

  const response = await fetch(renderUrl.toString(), { signal, headers: target.headers });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Grafana render failed (${response.status}). Is image rendering configured? ${errorText}`);
  }

  return {
    data: arrayBufferToBase64(await response.arrayBuffer()),
    mimeType: response.headers.get('content-type') || 'image/png',
    width,
    height,
  };
}

/** Dashboard URLs take date math or epoch milliseconds; an ISO timestamp renders an empty range. */
export function renderTime(value: string): string {
  if (/^now/.test(value) || /^\d+$/.test(value)) {
    return value;
  }
  const time = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(value) || !value.includes(':') ? value : `${value}Z`);
  return Number.isNaN(time) ? value : String(time);
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
