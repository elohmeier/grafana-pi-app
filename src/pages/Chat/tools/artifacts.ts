import type { AfterToolCallResult, AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';

type JqModule = typeof import('jq-wasm');

export type ArtifactKind = 'json' | 'table' | 'dashboard' | 'image' | 'text';

export type ArtifactRef = {
  id: string;
  kind: ArtifactKind;
  title: string;
  toolName: string;
  createdAt: string;
  bytes: number;
  summary: string;
};

export type ArtifactPreview =
  | {
      type: 'json';
      data: unknown;
      truncated: boolean;
    }
  | {
      type: 'text';
      text: string;
      truncated: boolean;
    }
  | {
      type: 'image';
      mimeType: string;
      data: string;
    };

export type Artifact = ArtifactRef & {
  data: unknown;
  preview?: ArtifactPreview;
  mimeType?: string;
  toolDetails?: unknown;
};

export type RegisterArtifactInput = {
  kind: ArtifactKind;
  title: string;
  toolName: string;
  data: unknown;
  summary: string;
  bytes?: number;
  preview?: ArtifactPreview;
  mimeType?: string;
  toolDetails?: unknown;
};

export type ArtifactRuntime = {
  register: (artifact: RegisterArtifactInput) => Artifact;
  get: (id: string) => Artifact | undefined;
  list: () => Artifact[];
};

type ReadArtifactParams = {
  id?: string;
  mode?: 'summary' | 'preview' | 'field' | 'slice' | 'jq' | 'full';
  path?: string;
  offset?: number;
  limit?: number;
  jq?: string;
};

type ToolImageBlock = {
  type: 'image';
  mimeType: string;
  data: string;
};

const ARTIFACT_MIN_BYTES = 6000;
const ARTIFACT_READ_TEXT_LIMIT = 80000;
const ARTIFACT_PREVIEW_TEXT_LIMIT = 6000;
const ARTIFACT_HANDLE_PREVIEW_TEXT_LIMIT = 2400;
const ARTIFACT_PREVIEW_STRING_FIELD_LIMIT = 1200;
const ARTIFACT_DEFAULT_SLICE_LIMIT = 50;
const ARTIFACT_MAX_SLICE_LIMIT = 500;
const JQ_OUTPUT_LIMIT = 80000;

const ARTIFACT_TOOL_NAMES = new Set([
  'inspect_dashboard_context',
  'inspect_dashboard_metric_usage',
  'search_dashboard_metric_usage',
  'get_metric_neighborhood',
  'list_live_dashboard_panels',
  'get_live_dashboard_layout',
  'get_live_dashboard_info',
  'list_live_dashboard_variables',
  'add_live_dashboard_panel',
  'move_or_resize_live_dashboard_panel',
  'screenshot_dashboard',
  'grafana_screenshot',
]);

const ALWAYS_ARTIFACT_TOOL_NAMES = new Set([
  'inspect_dashboard_context',
  'list_live_dashboard_panels',
  'get_live_dashboard_layout',
  'get_live_dashboard_info',
  'list_live_dashboard_variables',
  'add_live_dashboard_panel',
  'move_or_resize_live_dashboard_panel',
  'screenshot_dashboard',
  'grafana_screenshot',
]);

const LIVE_DASHBOARD_READ_ARTIFACT_TOOL_NAMES = new Set([
  'list_live_dashboard_panels',
  'get_live_dashboard_layout',
  'get_live_dashboard_info',
  'list_live_dashboard_variables',
]);

let jqModulePromise: Promise<JqModule> | undefined;

export function createArtifactTools(artifacts?: ArtifactRuntime): AgentTool[] {
  if (!artifacts) {
    return [];
  }

  return [
    {
      name: 'read_artifact',
      label: 'Read artifact',
      description:
        'Read a stored bulky tool artifact by id. Prefer field, slice, or jq mode instead of full when inspecting large JSON.',
      executionMode: 'sequential',
      parameters: Type.Object({
        id: Type.String({ description: 'Artifact id, such as artifact_1.' }),
        mode: Type.Optional(
          Type.Union(
            [
              Type.Literal('summary'),
              Type.Literal('preview'),
              Type.Literal('field'),
              Type.Literal('slice'),
              Type.Literal('jq'),
              Type.Literal('full'),
            ],
            {
              description:
                'Read mode. Defaults to jq when jq is provided, field when path is provided, otherwise preview.',
            }
          )
        ),
        path: Type.Optional(
          Type.String({
            description:
              'Optional JSON path for field or slice mode, for example dashboard.panels, results.0.series, or $.data.items.',
          })
        ),
        offset: Type.Optional(Type.Number({ description: 'Zero-based offset for slice mode. Defaults to 0.' })),
        limit: Type.Optional(
          Type.Number({
            description: `Maximum items or lines for slice mode. Defaults to ${ARTIFACT_DEFAULT_SLICE_LIMIT}.`,
          })
        ),
        jq: Type.Optional(
          Type.String({ description: 'jq filter to run in jq mode, for example .results[] | .query.' })
        ),
      }),
      async execute(_toolCallId, params, signal) {
        throwIfAborted(signal);
        return readArtifact(artifacts, params as ReadArtifactParams, signal);
      },
    },
  ];
}

export async function readArtifact(
  artifacts: ArtifactRuntime,
  params: ReadArtifactParams,
  signal?: AbortSignal
): Promise<AgentToolResult<Record<string, unknown>>> {
  const id = params.id?.trim();
  if (!id) {
    throw new Error('read_artifact requires id.');
  }

  const artifact = artifacts.get(id);
  if (!artifact) {
    const available = artifacts.list().map((item) => item.id);
    throw new Error(
      available.length > 0
        ? `Unknown artifact id ${id}. Available artifacts: ${available.join(', ')}.`
        : `Unknown artifact id ${id}. No artifacts are stored in this session.`
    );
  }

  const mode = params.mode ?? (params.jq ? 'jq' : params.path ? 'field' : 'preview');
  const selected = params.path ? selectArtifactPath(artifact.data, params.path) : artifact.data;
  const artifactRef = toArtifactRef(artifact);

  if (mode === 'summary') {
    return artifactReadResult(JSON.stringify(artifactSummary(artifact), null, 2), {
      artifactRead: true,
      artifactRef,
      mode,
    });
  }

  if (mode === 'preview') {
    return artifactReadResult(formatArtifactPreview(artifact), {
      artifactRead: true,
      artifactRef,
      mode,
      truncated: artifact.preview ? previewIsTruncated(artifact.preview) : false,
    });
  }

  if (mode === 'jq') {
    if (!params.jq?.trim()) {
      throw new Error('read_artifact jq mode requires jq.');
    }
    throwIfAborted(signal);
    const jq = await loadJq();
    throwIfAborted(signal);
    const result = await jq.raw(toJqInput(selected), params.jq, ['-c']);
    const stdout = truncateText(result.stdout.trim(), JQ_OUTPUT_LIMIT);
    const stderr = truncateText(result.stderr.trim(), 4000);
    return artifactReadResult(
      [stdout || '(jq returned no output)', stderr ? `stderr:\n${stderr}` : ''].filter(Boolean).join('\n\n'),
      {
        artifactRead: true,
        artifactRef,
        mode,
        path: params.path,
        jq: params.jq,
        exitCode: result.exitCode,
        stderr: result.stderr || undefined,
        truncated: result.stdout.length > stdout.length,
      }
    );
  }

  const value =
    mode === 'slice'
      ? sliceArtifactValue(selected, params.offset, params.limit)
      : mode === 'field'
        ? selected
        : artifact.data;
  const text = formatArtifactValue(value);

  return artifactReadResult(truncateText(text, ARTIFACT_READ_TEXT_LIMIT), {
    artifactRead: true,
    artifactRef,
    mode,
    path: params.path,
    offset: mode === 'slice' ? clampInteger(params.offset ?? 0, 0, Number.MAX_SAFE_INTEGER) : undefined,
    limit:
      mode === 'slice'
        ? clampInteger(params.limit ?? ARTIFACT_DEFAULT_SLICE_LIMIT, 1, ARTIFACT_MAX_SLICE_LIMIT)
        : undefined,
    truncated: text.length > ARTIFACT_READ_TEXT_LIMIT,
  });
}

export function artifactizeToolResult(
  artifacts: ArtifactRuntime | undefined,
  toolName: string | undefined,
  result: AgentToolResult<any>
): AfterToolCallResult | undefined {
  if (!artifacts || !toolName || toolName === 'read_artifact' || !ARTIFACT_TOOL_NAMES.has(toolName)) {
    return undefined;
  }
  if (hasArtifactRef(result.details)) {
    return undefined;
  }

  const extraction = extractArtifactData(toolName, result);
  if (!extraction) {
    return undefined;
  }

  if (!ALWAYS_ARTIFACT_TOOL_NAMES.has(toolName) && extraction.bytes < ARTIFACT_MIN_BYTES) {
    return undefined;
  }

  const artifact = artifacts.register({
    kind: extraction.kind,
    title: extraction.title,
    toolName,
    data: extraction.data,
    summary: extraction.summary,
    bytes: extraction.bytes,
    preview: extraction.preview,
    mimeType: extraction.mimeType,
    toolDetails: result.details,
  });
  const artifactRef = toArtifactRef(artifact);
  const details = mergeArtifactDetails(result.details, artifactRef, artifact.preview);

  return {
    content: [{ type: 'text', text: artifactHandleText(artifactRef, artifact.preview) }],
    details,
  };
}

export function toArtifactRef(artifact: Artifact): ArtifactRef {
  const { id, kind, title, toolName, createdAt, bytes, summary } = artifact;
  return { id, kind, title, toolName, createdAt, bytes, summary };
}

export function artifactByteSize(value: unknown): number {
  return utf8ByteLength(formatArtifactValue(value));
}

function artifactReadResult(text: string, details: Record<string, unknown>): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: 'text', text }],
    details,
  };
}

function extractArtifactData(
  toolName: string,
  result: AgentToolResult<any>
):
  | {
      kind: ArtifactKind;
      title: string;
      data: unknown;
      summary: string;
      bytes: number;
      preview?: ArtifactPreview;
      mimeType?: string;
    }
  | undefined {
  const liveDashboardData = extractLiveDashboardReadArtifactData(toolName, result);
  if (liveDashboardData) {
    return liveDashboardData;
  }

  const image = firstImageBlock(result.content);
  if (image) {
    const data = {
      image: {
        mimeType: image.mimeType,
        data: image.data,
      },
      details: result.details,
    };
    return {
      kind: 'image',
      title: artifactTitle(toolName, result.details),
      data,
      summary: artifactSummaryLine(toolName, data, result.details),
      bytes: utf8ByteLength(image.data),
      preview: { type: 'image', mimeType: image.mimeType, data: image.data },
      mimeType: image.mimeType,
    };
  }

  const text = getSingleTextContent(result.content);
  if (text === undefined) {
    return undefined;
  }

  const parsed = parseJson(text);
  const data = parsed.ok ? parsed.value : text;
  const kind = artifactKind(toolName, data, result.details);
  const bytes = utf8ByteLength(text);

  return {
    kind,
    title: artifactTitle(toolName, result.details, data),
    data,
    summary: artifactSummaryLine(toolName, data, result.details),
    bytes,
    preview: makePreview(data, bytes),
  };
}

function extractLiveDashboardReadArtifactData(
  toolName: string,
  result: AgentToolResult<any>
):
  | {
      kind: ArtifactKind;
      title: string;
      data: unknown;
      summary: string;
      bytes: number;
      preview?: ArtifactPreview;
      mimeType?: string;
    }
  | undefined {
  if (!LIVE_DASHBOARD_READ_ARTIFACT_TOOL_NAMES.has(toolName) || !isRecord(result.details)) {
    return undefined;
  }

  const command = stringField(result.details, 'command');
  if (!command) {
    return undefined;
  }

  const data = compactObject({
    command,
    success: booleanField(result.details, 'success'),
    error: stringField(result.details, 'error'),
    warnings: arrayField(result.details, 'warnings'),
    changes: arrayField(result.details, 'changes'),
    summary: liveDashboardArtifactQuickView(command, result.details.data),
    data: result.details.data,
    availableCommands: arrayField(result.details, 'availableCommands'),
  });
  const bytes = artifactByteSize(data);

  return {
    kind: 'dashboard',
    title: artifactTitle(toolName, result.details, data),
    data,
    summary: liveDashboardArtifactSummary(toolName, command, data),
    bytes,
    preview: makePreview(data, bytes),
  };
}

function liveDashboardArtifactSummary(toolName: string, command: string, data: unknown) {
  const dashboardData = isRecord(data) ? recordField(data, 'data') : undefined;
  if (command === 'LIST_PANELS' && dashboardData) {
    const count = recordsField(dashboardData, 'elements').length;
    return `${toolName} returned ${count} ${count === 1 ? 'panel' : 'panels'}.`;
  }
  if (command === 'LIST_VARIABLES' && dashboardData) {
    const count = recordsField(dashboardData, 'variables').length;
    return `${toolName} returned ${count} ${count === 1 ? 'variable' : 'variables'}.`;
  }
  return `${toolName} ${command} result stored as JSON.`;
}

function liveDashboardArtifactQuickView(command: string, data: unknown): unknown {
  if (!isRecord(data)) {
    return undefined;
  }

  if (command === 'LIST_PANELS') {
    const panels = recordsField(data, 'elements').map(compactLiveDashboardArtifactPanel);
    return { panelCount: panels.length, panels };
  }

  if (command === 'GET_LAYOUT') {
    return compactObject({
      layout: compactLiveDashboardLayoutNode(recordField(data, 'layout')),
      elements: compactLiveDashboardLayoutElements(recordField(data, 'elements')),
    });
  }

  if (command === 'LIST_VARIABLES') {
    const variables = recordsField(data, 'variables').map((variable) => {
      const spec = recordField(variable, 'spec') ?? variable;
      return compactObject({
        kind: stringField(variable, 'kind'),
        name: stringField(spec, 'name'),
        label: stringField(spec, 'label'),
        query: stringField(spec, 'query'),
        multi: booleanField(spec, 'multi'),
        includeAll: booleanField(spec, 'includeAll'),
      });
    });
    return { variableCount: variables.length, variables };
  }

  if (command === 'GET_DASHBOARD_INFO') {
    return compactObject({
      uid: stringField(data, 'uid'),
      title: stringField(data, 'title'),
      description: stringField(data, 'description'),
      folderUid: stringField(data, 'folderUid'),
      folderTitle: stringField(data, 'folderTitle'),
      tags: arrayField(data, 'tags'),
      editable: booleanField(data, 'editable'),
    });
  }

  return undefined;
}

function compactLiveDashboardArtifactPanel(panel: Record<string, unknown>) {
  const element = recordField(panel, 'element');
  const spec = recordField(element, 'spec');
  const layoutSpec = recordField(recordField(panel, 'layoutItem'), 'spec');
  const layoutElement = recordField(layoutSpec, 'element');
  const vizConfig = recordField(spec, 'vizConfig');

  return compactObject({
    elementName: stringField(panel, 'name') ?? stringField(element, 'name') ?? stringField(layoutElement, 'name'),
    kind: stringField(element, 'kind'),
    title: stringField(spec, 'title'),
    description: stringField(spec, 'description'),
    visualizationType: stringField(vizConfig, 'group'),
    grid: compactLiveDashboardGrid(layoutSpec),
  });
}

function compactLiveDashboardLayoutElements(elements: Record<string, unknown> | undefined) {
  if (!elements) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(elements).map(([name, element]) => {
      const elementRecord = isRecord(element) ? element : undefined;
      const spec = recordField(elementRecord, 'spec');
      const vizConfig = recordField(spec, 'vizConfig');

      return [
        name,
        compactObject({
          kind: stringField(elementRecord, 'kind'),
          title: stringField(spec, 'title'),
          visualizationType: stringField(vizConfig, 'group'),
        }),
      ];
    })
  );
}

function compactLiveDashboardLayoutNode(node: Record<string, unknown> | undefined): unknown {
  if (!node) {
    return undefined;
  }

  const spec = recordField(node, 'spec');
  const element = recordField(spec, 'element');
  const items = recordsField(spec, 'items').map(compactLiveDashboardLayoutNode).filter(Boolean);

  return compactObject({
    kind: stringField(node, 'kind'),
    elementName: stringField(element, 'name'),
    grid: compactLiveDashboardGrid(spec),
    items: items.length > 0 ? items : undefined,
  });
}

function compactLiveDashboardGrid(spec: Record<string, unknown> | undefined) {
  const grid = compactObject({
    x: numberField(spec, 'x'),
    y: numberField(spec, 'y'),
    width: numberField(spec, 'width') ?? numberField(spec, 'w'),
    height: numberField(spec, 'height') ?? numberField(spec, 'h'),
  });
  return Object.keys(grid).length > 0 ? grid : undefined;
}

function artifactKind(toolName: string, data: unknown, details: unknown): ArtifactKind {
  if (
    toolName === 'inspect_dashboard_context' ||
    toolName === 'inspect_dashboard_metric_usage' ||
    toolName === 'search_dashboard_metric_usage' ||
    toolName === 'get_metric_neighborhood' ||
    toolName === 'list_live_dashboard_panels' ||
    toolName === 'get_live_dashboard_layout'
  ) {
    return 'dashboard';
  }
  if (isRecord(details) && details.format === 'table') {
    return 'table';
  }
  return typeof data === 'string' ? 'text' : 'json';
}

function artifactTitle(toolName: string, details: unknown, data?: unknown) {
  const detailsRecord = isRecord(details) ? details : undefined;
  const dataRecord = isRecord(data) ? data : undefined;
  const dashboard = recordField(dataRecord, 'dashboard') ?? dataRecord;
  const title =
    stringField(detailsRecord, 'title') ??
    stringField(dashboard, 'title') ??
    stringField(dataRecord, 'title') ??
    stringField(dataRecord, 'uid') ??
    stringField(detailsRecord, 'uid');

  return title ? `${toolName}: ${title}` : toolName;
}

function artifactSummaryLine(toolName: string, data: unknown, details: unknown) {
  const dashboard = isRecord(data) ? (recordField(data, 'dashboard') ?? data) : undefined;
  const panels = dashboard ? recordsField(dashboard, 'panels').length : undefined;
  const title = stringField(dashboard, 'title');
  if (title) {
    return `${title}${panels !== undefined ? ` with ${panels} panels` : ''}.`;
  }

  if (Array.isArray(data)) {
    return `${toolName} returned ${data.length} items.`;
  }

  return `${toolName} result stored as artifact.`;
}

function makePreview(data: unknown, bytes: number): ArtifactPreview {
  if (typeof data === 'string') {
    return {
      type: 'text',
      text: truncateText(data, ARTIFACT_PREVIEW_TEXT_LIMIT),
      truncated: data.length > ARTIFACT_PREVIEW_TEXT_LIMIT || bytes > ARTIFACT_PREVIEW_TEXT_LIMIT,
    };
  }

  return {
    type: 'json',
    data: previewJsonValue(data),
    truncated: bytes > ARTIFACT_PREVIEW_TEXT_LIMIT,
  };
}

function previewJsonValue(data: unknown): unknown {
  if (Array.isArray(data)) {
    return data.slice(0, 20).map(previewJsonValue);
  }
  if (typeof data === 'string') {
    return truncateText(data, ARTIFACT_PREVIEW_STRING_FIELD_LIMIT);
  }
  if (!isRecord(data)) {
    return data;
  }
  if (Array.isArray(data.results)) {
    return {
      ...Object.fromEntries(
        Object.entries(data)
          .filter(([key]) => key !== 'results')
          .slice(0, 10)
      ),
      results: data.results.slice(0, 10).map(previewQueryResult),
    };
  }

  const entries = Object.entries(data).slice(0, 20);
  return Object.fromEntries(
    entries.map(([key, value]) => [
      key,
      Array.isArray(value) || typeof value === 'string' || isRecord(value) ? previewJsonValue(value) : value,
    ])
  );
}

function previewQueryResult(value: unknown) {
  if (!isRecord(value)) {
    return value;
  }

  const series = Array.isArray(value.series)
    ? value.series.slice(0, 3).map((item) => {
        if (!isRecord(item)) {
          return item;
        }
        return {
          name: item.name,
          labels: item.labels,
          points: item.points,
          nonNullPoints: item.nonNullPoints,
          nullPoints: item.nullPoints,
          last: item.last,
          min: item.min,
          max: item.max,
          mean: item.mean,
          delta: item.delta,
          deltaPercent: item.deltaPercent,
        };
      })
    : undefined;

  return {
    datasourceUid: value.datasourceUid,
    query: value.query,
    queryType: value.queryType,
    interval: value.interval,
    range: value.range,
    frameCount: value.frameCount,
    validationError: value.validationError,
    totalSeries: value.totalSeries,
    truncatedSeries: value.truncatedSeries,
    notices: Array.isArray(value.notices) ? value.notices.slice(0, 3) : value.notices,
    executedQueryStrings: Array.isArray(value.executedQueryStrings)
      ? value.executedQueryStrings.slice(0, 3)
      : value.executedQueryStrings,
    series,
  };
}

function artifactHandleText(artifact: ArtifactRef, preview: ArtifactPreview | undefined) {
  const lines = [
    `Stored artifact [artifact: ${artifact.id}] ${artifact.title}`,
    `Kind: ${artifact.kind}`,
    `Size: ${artifact.bytes} bytes`,
    `Summary: ${artifact.summary}`,
    `Use read_artifact with id "${artifact.id}" to inspect preview, fields, slices, or jq queries.`,
  ];
  const previewText = artifactHandlePreview(preview);
  if (previewText) {
    lines.push('Inline preview:', previewText);
  }
  return lines.join('\n');
}

function artifactHandlePreview(preview: ArtifactPreview | undefined) {
  if (!preview || preview.type === 'image') {
    return undefined;
  }

  const text =
    preview.type === 'text'
      ? preview.text
      : (() => {
          try {
            return JSON.stringify(preview.data, null, 2);
          } catch {
            return String(preview.data);
          }
        })();

  const truncated = truncateText(text, ARTIFACT_HANDLE_PREVIEW_TEXT_LIMIT);
  return preview.truncated || text.length > ARTIFACT_HANDLE_PREVIEW_TEXT_LIMIT
    ? `${truncated}\nPreview truncated; use read_artifact for more.`
    : truncated;
}

function mergeArtifactDetails(details: unknown, artifactRef: ArtifactRef, preview: ArtifactPreview | undefined) {
  const base = isRecord(details) ? details : details === undefined ? {} : { value: details };
  return {
    ...base,
    artifactRef,
    artifactPreview: preview,
  };
}

function artifactSummary(artifact: Artifact) {
  return {
    id: artifact.id,
    title: artifact.title,
    kind: artifact.kind,
    toolName: artifact.toolName,
    createdAt: artifact.createdAt,
    bytes: artifact.bytes,
    summary: artifact.summary,
  };
}

function formatArtifactPreview(artifact: Artifact) {
  if (!artifact.preview) {
    return JSON.stringify(artifactSummary(artifact), null, 2);
  }

  if (artifact.preview.type === 'image') {
    return JSON.stringify(
      {
        ...artifactSummary(artifact),
        preview: {
          type: 'image',
          mimeType: artifact.preview.mimeType,
          dataBytes: utf8ByteLength(artifact.preview.data),
        },
      },
      null,
      2
    );
  }

  if (artifact.preview.type === 'text') {
    return artifact.preview.text;
  }

  return JSON.stringify(artifact.preview.data, null, 2);
}

function previewIsTruncated(preview: ArtifactPreview) {
  return preview.type !== 'image' && preview.truncated;
}

function sliceArtifactValue(value: unknown, rawOffset: number | undefined, rawLimit: number | undefined) {
  const offset = clampInteger(rawOffset ?? 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = clampInteger(rawLimit ?? ARTIFACT_DEFAULT_SLICE_LIMIT, 1, ARTIFACT_MAX_SLICE_LIMIT);

  if (Array.isArray(value)) {
    return value.slice(offset, offset + limit);
  }
  if (typeof value === 'string') {
    return value
      .split('\n')
      .slice(offset, offset + limit)
      .join('\n');
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).slice(offset, offset + limit));
  }
  return value;
}

function selectArtifactPath(value: unknown, path: string): unknown {
  let current = value;
  const parts = parsePath(path);
  for (const part of parts) {
    if (typeof part === 'number') {
      current = Array.isArray(current) ? current[part] : undefined;
    } else {
      current = isRecord(current) ? current[part] : undefined;
    }
  }
  return current;
}

function parsePath(path: string): Array<string | number> {
  const trimmed = path.trim();
  if (!trimmed || trimmed === '$') {
    return [];
  }

  const normalized = trimmed.replace(/^\$\.?/, '').replace(/^\./, '');
  const parts: Array<string | number> = [];
  const pattern = /([^.[\]]+)|\[(\d+|"[^"]+"|'[^']+')\]/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(normalized))) {
    const bare = match[1];
    const bracket = match[2];
    if (bare !== undefined) {
      parts.push(/^\d+$/.test(bare) ? Number(bare) : bare);
      continue;
    }
    if (bracket === undefined) {
      continue;
    }
    if (/^\d+$/.test(bracket)) {
      parts.push(Number(bracket));
    } else {
      parts.push(bracket.slice(1, -1));
    }
  }

  return parts;
}

function formatArtifactValue(value: unknown) {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function getSingleTextContent(content: AgentToolResult<any>['content'] | undefined): string | undefined {
  if (!Array.isArray(content) || content.length !== 1) {
    return undefined;
  }

  const block = content[0];
  return block.type === 'text' && typeof block.text === 'string' ? block.text : undefined;
}

function firstImageBlock(content: AgentToolResult<any>['content'] | undefined): ToolImageBlock | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  return content.find(isToolImageBlock);
}

function isToolImageBlock(block: AgentToolResult<any>['content'][number]): block is ToolImageBlock {
  return (
    isRecord(block) && block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string'
  );
}

function hasArtifactRef(details: unknown) {
  return isRecord(details) && isRecord(details.artifactRef) && typeof details.artifactRef.id === 'string';
}

function toJqInput(value: unknown): string | object {
  if (typeof value === 'string') {
    return value;
  }
  if (value === null || value === undefined) {
    return {};
  }
  if (typeof value === 'object') {
    return value;
  }
  return String(value);
}

async function loadJq() {
  jqModulePromise ??= import('jq-wasm');
  return jqModulePromise;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new Error('Tool call aborted');
  }
}

function clampInteger(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function truncateText(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}\n... (truncated)` : value;
}

function utf8ByteLength(value: string) {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(value).byteLength;
  }

  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x7f) {
      bytes += 1;
    } else if (codePoint <= 0x7ff) {
      bytes += 2;
    } else if (codePoint <= 0xffff) {
      bytes += 3;
    } else {
      bytes += 4;
    }
  }
  return bytes;
}

function recordField(record: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  return record && isRecord(record[key]) ? record[key] : undefined;
}

function recordsField(record: Record<string, unknown> | undefined, key: string): Array<Record<string, unknown>> {
  const value = record?.[key];
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function arrayField(record: Record<string, unknown>, key: string): unknown[] | undefined {
  const value = record[key];
  return Array.isArray(value) ? value : undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
}

function booleanField(record: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const value = record?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function compactObject(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
