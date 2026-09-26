import { config } from '@grafana/runtime';
import type { DashboardImage } from '../workspace/broker';
import { backendFetch } from './client';
import { throwIfAborted } from './result';
import type { ScreenshotParams } from './types';

/** Renders a dashboard or panel through Grafana image rendering (requires the image renderer). */
export async function renderDashboardScreenshot(args: ScreenshotParams, signal?: AbortSignal): Promise<DashboardImage> {
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

  return {
    data: arrayBufferToBase64(await response.arrayBuffer()),
    mimeType: response.headers.get('content-type') || 'image/png',
    width,
    height,
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
