import React, { useMemo, useState } from 'react';
import { css, cx, keyframes } from '@emotion/css';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { renderMarkdown, type GrafanaTheme2, type IconName } from '@grafana/data';
import { Badge, Icon, LinkButton, Spinner, type BadgeColor, useStyles2 } from '@grafana/ui';
import { structuredPatch } from 'diff';
import type { ArtifactPreview, ArtifactRef } from './tools';
import {
  highlightJsonnetLines,
  shouldHighlightJsonnet,
  utf8ByteLength,
  type CodeToken,
  type CodeTokenKind,
} from './jsonnetRendering';

export type ToolRunView = {
  id: string;
  name: string;
  args: unknown;
  status: 'running' | 'completed' | 'failed';
  partialResult?: AgentToolResult<any>;
  result?: AgentToolResult<any>;
  isError?: boolean;
  updatedAt: number;
};

export type DashboardAction = {
  title: string;
  status?: string;
  uid?: string;
  url?: string;
};

export type DashboardOpenHandler = (action: DashboardAction) => void;

export function ContentBlocks({
  content,
  isStreaming = false,
  markdown = true,
}: {
  content: unknown;
  isStreaming?: boolean;
  markdown?: boolean;
}) {
  const styles = useStyles2(getToolStyles);

  if (typeof content === 'string') {
    return markdown ? <MarkdownText isStreaming={isStreaming} text={content} /> : <div>{content}</div>;
  }
  if (!Array.isArray(content)) {
    return <pre className={styles.toolCallJson}>{formatJson(content)}</pre>;
  }

  return (
    <>
      {content.map((block, index) => {
        if (!block || typeof block !== 'object') {
          return (
            <pre className={styles.toolCallJson} key={index}>
              {formatJson(block)}
            </pre>
          );
        }
        const typedBlock = block as Record<string, any>;
        if (typedBlock.type === 'text' && typeof typedBlock.text === 'string') {
          return markdown ? (
            <MarkdownText isStreaming={isStreaming} key={index} text={typedBlock.text} />
          ) : (
            <div key={index}>{typedBlock.text}</div>
          );
        }
        if (typedBlock.type === 'thinking' && typeof typedBlock.thinking === 'string') {
          return (
            <details className={styles.collapsible} key={index}>
              <summary>Thinking</summary>
              <pre>{typedBlock.thinking}</pre>
            </details>
          );
        }
        if (typedBlock.type === 'toolCall' && typeof typedBlock.name === 'string') {
          return (
            <ToolCallBlock
              key={index}
              name={typedBlock.name}
              args={typedBlock.arguments}
              partialJson={typeof typedBlock.partialJson === 'string' ? typedBlock.partialJson : undefined}
              isStreaming={isStreaming}
            />
          );
        }
        if (typedBlock.type === 'image') {
          return <img key={index} alt="Tool result" src={`data:${typedBlock.mimeType};base64,${typedBlock.data}`} />;
        }
        return (
          <pre className={styles.toolCallJson} key={index}>
            {formatJson(typedBlock)}
          </pre>
        );
      })}
    </>
  );
}

export function ToolResultMessageBody({
  toolName,
  content,
  details,
  isError,
}: {
  toolName?: string;
  content: unknown;
  details: unknown;
  isError?: boolean;
  /** Accepted for API compatibility; no remaining tool result renders a dashboard open action. */
  onOpenDashboard?: DashboardOpenHandler;
}) {
  const styles = useStyles2(getToolStyles);
  const artifactResult = isError ? undefined : asArtifactResult(details);
  const showArtifactCard = Boolean(artifactResult && !isArtifactReadResult(toolName, details));
  const structuredResult = isError ? undefined : renderStructuredToolResult(toolName, details, content);
  const error = isError ? extractToolError(toolName, details, content) : undefined;

  return (
    <div className={cx(styles.toolFrame, isError && styles.toolFrameError)}>
      <ToolHeader name={toolName ?? 'tool'} status={isError ? 'failed' : 'completed'} />
      {showArtifactCard && artifactResult && (
        <ArtifactResultView artifact={artifactResult.ref} preview={artifactResult.preview} />
      )}
      {error ? (
        <ToolErrorView content={content} details={details} error={error} />
      ) : (
        (structuredResult ?? (!showArtifactCard ? <ContentBlocks content={content} /> : null))
      )}
      {!error && !structuredResult && !showArtifactCard && hasDetails(details) && (
        <details className={styles.collapsible}>
          <summary>Details</summary>
          <pre>{formatJson(details)}</pre>
        </details>
      )}
    </div>
  );
}

export function ToolActivityPanel({ runs, elapsed }: { runs: ToolRunView[]; elapsed?: string }) {
  const styles = useStyles2(getToolStyles);
  if (runs.length === 0) {
    return null;
  }

  return (
    <section className={styles.activity} aria-label="Tool activity">
      <div className={styles.activityTitle}>
        <span className={styles.activityTitleLabel}>
          <Spinner size="sm" />
          <span>Tool activity</span>
        </span>
        {elapsed && <span className={styles.activityElapsed}>{elapsed}</span>}
      </div>
      <div className={styles.activityList}>
        {runs.map((run) => (
          <div className={styles.activityItem} key={run.id}>
            <ToolHeader name={run.name} status={run.status} compact />
            {renderStructuredToolCall(run.name, run.args, undefined, run.status === 'running') ?? (
              <pre className={styles.toolCallJson}>{formatJson(run.args)}</pre>
            )}
            {run.partialResult && <ContentBlocks content={run.partialResult.content} isStreaming />}
          </div>
        ))}
      </div>
    </section>
  );
}

function MarkdownText({ text, isStreaming }: { text: string; isStreaming?: boolean }) {
  const styles = useStyles2(getToolStyles);
  const html = useMemo(
    () => hardenMarkdownHtml(renderMarkdown(completeOpenMarkdownFences(text), { breaks: true }).trim()),
    [text]
  );

  return (
    <div className={styles.markdown}>
      {html ? <div dangerouslySetInnerHTML={{ __html: html }} /> : isStreaming ? null : <span />}
      {isStreaming && <span className={styles.streamingCursor} aria-hidden="true" />}
    </div>
  );
}

// Grafana's markdown sanitizer blocks scripts but still allows remote images and
// sandboxed iframes, both zero-click exfiltration channels for prompt-injected
// model output. Keep only inline data-URI images.
function hardenMarkdownHtml(html: string): string {
  if (!html || typeof document === 'undefined') {
    return html;
  }

  const template = document.createElement('template');
  template.innerHTML = html;
  for (const iframe of Array.from(template.content.querySelectorAll('iframe'))) {
    iframe.remove();
  }
  for (const image of Array.from(template.content.querySelectorAll('img'))) {
    const src = image.getAttribute('src')?.trim().toLowerCase() ?? '';
    if (!src.startsWith('data:image/')) {
      image.remove();
    }
  }
  return template.innerHTML;
}

function ToolCallBlock({
  name,
  args,
  partialJson,
  isStreaming,
}: {
  name: string;
  args: unknown;
  partialJson?: string;
  isStreaming?: boolean;
}) {
  const styles = useStyles2(getToolStyles);
  const structuredToolCall = renderStructuredToolCall(name, args, partialJson, Boolean(isStreaming));
  const icon = toolIconName(name);
  const shouldCollapse = shouldCollapseToolCallBlock(name, Boolean(isStreaming));
  const collapsedSummary = toolCallCollapsedSummary(name, args, partialJson, Boolean(isStreaming));

  if (shouldCollapse) {
    return (
      <details className={styles.toolCallCollapsed}>
        <summary className={styles.toolCallCollapsedSummary}>
          <Badge text="tool call" color="blue" />
          {icon && <Icon aria-hidden className={styles.toolTypeIcon} name={icon} />}
          <strong>{name}</strong>
          {collapsedSummary && <span className={styles.toolCallSummaryText}>{collapsedSummary}</span>}
        </summary>
        <div className={styles.toolCallCollapsedBody}>
          {structuredToolCall ?? (
            <pre className={styles.toolCallJson}>{partialJson && isStreaming ? partialJson : formatJson(args)}</pre>
          )}
        </div>
      </details>
    );
  }

  return (
    <div className={styles.toolCall}>
      <div className={styles.toolCallHeader}>
        <Badge text={isStreaming ? 'preparing' : 'tool call'} color="blue" />
        {icon && <Icon aria-hidden className={styles.toolTypeIcon} name={icon} />}
        <strong>{name}</strong>
      </div>
      {structuredToolCall ?? (
        <pre className={styles.toolCallJson}>{partialJson && isStreaming ? partialJson : formatJson(args)}</pre>
      )}
    </div>
  );
}

function shouldCollapseToolCallBlock(name: string, isStreaming: boolean) {
  return !isStreaming && WORKSPACE_TOOL_NAMES.has(name);
}

function toolCallCollapsedSummary(name: string, args: unknown, partialJson: string | undefined, isStreaming: boolean) {
  const simpleCall = asSimpleToolCallSummary(name, args, partialJson, isStreaming);
  return simpleCall?.summary;
}

function renderStructuredToolCall(
  name: string,
  args: unknown,
  partialJson: string | undefined,
  isStreaming: boolean
): React.ReactNode | undefined {
  const simpleCall = asSimpleToolCallSummary(name, args, partialJson, isStreaming);
  if (simpleCall) {
    return <SimpleToolCallSummaryView call={simpleCall} />;
  }

  return undefined;
}

type SimpleToolCallSummary = {
  summary: string;
  items?: Array<{ label: string; value?: React.ReactNode }>;
  code?: string;
};

function SimpleToolCallSummaryView({ call }: { call: SimpleToolCallSummary }) {
  const styles = useStyles2(getToolStyles);
  return (
    <div className={styles.structuredResult}>
      <div className={styles.resultSummary}>{call.summary}</div>
      {call.items && <ResultMetaGrid items={call.items} />}
      {call.code && <pre className={styles.queryBlock}>{call.code}</pre>}
    </div>
  );
}

function asSimpleToolCallSummary(
  name: string,
  args: unknown,
  partialJson: string | undefined,
  isStreaming: boolean
): SimpleToolCallSummary | undefined {
  const record = toolCallArgsRecord(args, partialJson, isStreaming) ?? {};

  switch (name) {
    case 'navigate':
      return navigateToolCallSummary(record);
    case 'update_report':
      return updateReportToolCallSummary(record);
    case 'read_artifact':
      return readArtifactToolCallSummary(record);
    case 'read':
      return workspaceReadToolCallSummary(record);
    case 'write':
      return workspaceWriteToolCallSummary(record);
    case 'edit':
      return workspaceEditToolCallSummary(record);
    case 'bash':
      return workspaceBashToolCallSummary(record);
    case 'inspect_dashboard_metric_usage':
      return dashboardToolCallSummary('Inspect dashboard metric usage', record);
    case 'find_panel_alert_rules':
      return findPanelAlertRulesToolCallSummary(record);
    case 'get_alert_rule':
      return getAlertRuleToolCallSummary(record);
    case 'search_dashboard_metric_usage':
      return dashboardMetricSearchToolCallSummary(record);
    case 'get_metric_neighborhood':
      return metricNeighborhoodToolCallSummary(record);
    case 'list_live_dashboard_panels':
      return liveDashboardToolCallSummary('List live dashboard panels', record);
    case 'get_live_dashboard_layout':
      return liveDashboardToolCallSummary('Get live dashboard layout', record);
    case 'get_live_dashboard_info':
      return liveDashboardToolCallSummary('Get live dashboard info', record);
    case 'list_live_dashboard_variables':
      return liveDashboardToolCallSummary('List live dashboard variables', record);
    case 'get_live_dashboard_mutation_schema':
      return liveDashboardToolCallSummary('Get live dashboard mutation schema', record);
    case 'rename_live_dashboard_panel':
      return liveDashboardToolCallSummary('Rename live dashboard panel', record);
    case 'update_live_dashboard_panel_query':
      return liveDashboardToolCallSummary('Update live dashboard panel query', record);
    case 'update_live_dashboard_panel_queries':
      return liveDashboardToolCallSummary('Update live dashboard panel queries', record);
    case 'apply_live_dashboard_prometheus_label_filter':
      return liveDashboardToolCallSummary('Apply Prometheus dashboard label filter', record);
    case 'add_live_dashboard_panel':
      return liveDashboardToolCallSummary('Add live dashboard panel', record);
    case 'move_or_resize_live_dashboard_panel':
      return liveDashboardToolCallSummary('Move or resize live dashboard panel', record);
    case 'update_live_dashboard_settings':
      return liveDashboardToolCallSummary('Update live dashboard settings', record);
    case 'add_live_dashboard_variable':
      return liveDashboardToolCallSummary('Add live dashboard variable', record);
    case 'update_live_dashboard_variable':
      return liveDashboardToolCallSummary('Update live dashboard variable', record);
    case 'apply_live_dashboard_mutation':
      return liveDashboardToolCallSummary('Apply live dashboard mutation', record);
    case 'screenshot_dashboard':
    case 'grafana_screenshot':
      return screenshotDashboardToolCallSummary(record);
    default:
      return undefined;
  }
}

function navigateToolCallSummary(record: Record<string, unknown>): SimpleToolCallSummary {
  const type = stringField(record, 'type');
  const uid = stringField(record, 'uid');
  const path = stringField(record, 'path');
  const query = stringField(record, 'query');
  return {
    summary: summaryLine(['Navigate', type, uid ?? path ?? query]),
    items: [
      { label: 'Type', value: type },
      { label: 'Dashboard', value: uid ? <code>{uid}</code> : undefined },
      { label: 'Datasource', value: formatSummaryFieldValue(record, 'datasourceUid') },
      { label: 'Query', value: query ? <code>{query}</code> : undefined },
      { label: 'Path', value: path ? <code>{path}</code> : undefined },
    ],
  };
}

function updateReportToolCallSummary(record: Record<string, unknown>): SimpleToolCallSummary {
  const patchCount = recordsField(record, 'patch').length;
  return {
    summary: summaryLine(['Update investigation report', stringField(record, 'title'), formatPatchCount(patchCount)]),
    items: [
      { label: 'Title', value: stringField(record, 'title') },
      { label: 'Patch count', value: patchCount > 0 ? formatCount(patchCount) : undefined },
    ],
  };
}

function readArtifactToolCallSummary(record: Record<string, unknown>): SimpleToolCallSummary {
  const id = stringField(record, 'id');
  const path = stringField(record, 'path');
  const jq = stringField(record, 'jq');
  const mode = stringField(record, 'mode') ?? (jq ? 'jq' : path ? 'field' : 'preview');
  const offset = numberField(record, 'offset');
  const limit = numberField(record, 'limit');

  return {
    summary: summaryLine(['Read artifact', id, mode]),
    items: [
      { label: 'Artifact', value: id ? <code>{id}</code> : undefined },
      { label: 'Mode', value: mode },
      { label: 'Path', value: path ? <code>{path}</code> : undefined },
      {
        label: 'Slice',
        value: offset !== undefined || limit !== undefined ? `${offset ?? 0}:${limit ?? ''}` : undefined,
      },
      { label: 'jq', value: jq ? <code>{jq}</code> : undefined },
    ],
    code: jq,
  };
}

function workspaceReadToolCallSummary(record: Record<string, unknown>): SimpleToolCallSummary {
  const path = stringField(record, 'path');
  const offset = numberField(record, 'offset');
  const limit = numberField(record, 'limit');
  return {
    summary: 'Read file',
    items: [
      { label: 'Path', value: path ? <code>{path}</code> : undefined },
      { label: 'Offset', value: offset !== undefined ? String(offset) : undefined },
      { label: 'Limit', value: limit !== undefined ? formatLabeledCount(limit, 'line', 'lines') : undefined },
    ],
  };
}

function workspaceWriteToolCallSummary(record: Record<string, unknown>): SimpleToolCallSummary {
  const path = stringField(record, 'path');
  const content = stringField(record, 'content');
  const size = content !== undefined ? formatBytes(utf8ByteLength(content)) : undefined;
  return {
    summary: summaryLine(['Write file', size]),
    items: [
      { label: 'Path', value: path ? <code>{path}</code> : undefined },
      { label: 'Revision', value: formatSummaryFieldValue(record, 'revision') },
      { label: 'Content', value: size },
    ],
  };
}

function workspaceEditToolCallSummary(record: Record<string, unknown>): SimpleToolCallSummary {
  const path = stringField(record, 'path');
  const edits = recordsField(record, 'edits');
  return {
    summary: summaryLine(['Edit file', edits.length ? formatLabeledCount(edits.length, 'edit', 'edits') : undefined]),
    items: [
      { label: 'Path', value: path ? <code>{path}</code> : undefined },
      { label: 'Revision', value: formatSummaryFieldValue(record, 'revision') },
      { label: 'Replace all', value: edits.some((edit) => edit.replaceAll === true) ? 'yes' : undefined },
    ],
  };
}

function workspaceBashToolCallSummary(record: Record<string, unknown>): SimpleToolCallSummary {
  const cwd = stringField(record, 'cwd');
  return {
    summary: 'Run bash',
    items: [
      { label: 'CWD', value: cwd ? <code>{cwd}</code> : undefined },
      { label: 'Timeout', value: formatDurationMs(numberField(record, 'timeoutMs')) },
    ],
    code: stringField(record, 'command'),
  };
}

function formatSummaryFieldValue(record: Record<string, unknown>, key: string) {
  const value = stringOrNumberField(record, key);
  return value ? <code>{value}</code> : undefined;
}

function formatPatchCount(count: number) {
  return count > 0 ? `${formatCount(count)} ${count === 1 ? 'patch' : 'patches'}` : undefined;
}

function dashboardToolCallSummary(action: string, record: Record<string, unknown>): SimpleToolCallSummary {
  const dashboard = dashboardToolCallIdentifier(record);
  const path = stringField(record, 'path') ?? stringField(record, 'file');
  const folder =
    stringField(record, 'folderUid') ?? stringField(record, 'folder') ?? stringField(record, 'folderTitle');
  return {
    summary: summaryLine([action, dashboard]),
    items: [
      { label: 'Dashboard', value: dashboard ? <code>{dashboard}</code> : undefined },
      { label: 'Path', value: path ? <code>{path}</code> : undefined },
      { label: 'Folder', value: folder },
      { label: 'Panel', value: stringOrNumberField(record, 'panelId') },
      { label: 'Dry run', value: booleanLabel(record, 'dryRun') },
    ],
  };
}

function dashboardMetricSearchToolCallSummary(record: Record<string, unknown>): SimpleToolCallSummary {
  const query = stringField(record, 'query');
  const tag = stringField(record, 'tag');
  const seed = stringField(record, 'seedMetric');
  const seeds = stringArrayField(record, 'seedMetrics') ?? [];
  const seedCode = seeds.length > 0 ? seeds.join('\n') : seed;

  return {
    summary: summaryLine(['Search dashboard metric usage', query, tag ? `tag ${tag}` : undefined]),
    items: [
      { label: 'Query', value: query },
      { label: 'Tag', value: tag },
      { label: 'Datasource', value: formatDatasourceMetaValue(record) },
      {
        label: seeds.length > 0 ? 'Seed metrics' : 'Seed metric',
        value: seedCode ? <code>{seedCode}</code> : undefined,
      },
      { label: 'Max dashboards', value: stringOrNumberField(record, 'maxDashboards') },
    ],
    code: seedCode,
  };
}

function findPanelAlertRulesToolCallSummary(record: Record<string, unknown>): SimpleToolCallSummary {
  const dashboardUid = stringField(record, 'dashboardUid');
  const panelId = stringOrNumberField(record, 'panelId');
  const panelTitle = stringField(record, 'panelTitle');
  const ruleName = stringField(record, 'ruleName');
  const query = stringField(record, 'query');
  const namespace = stringField(record, 'namespace');

  return {
    summary: summaryLine([
      'Find panel alert rules',
      dashboardUid ? `dashboard ${dashboardUid}` : undefined,
      panelId ? `panel ${panelId}` : panelTitle,
      ruleName ? `rule ${ruleName}` : query,
    ]),
    items: [
      { label: 'Dashboard', value: dashboardUid ? <code>{dashboardUid}</code> : undefined },
      { label: 'Panel', value: panelId },
      { label: 'Panel title', value: panelTitle },
      { label: 'Rule', value: ruleName ? <code>{ruleName}</code> : undefined },
      { label: 'Query', value: query },
      { label: 'Namespace', value: namespace ? <code>{namespace}</code> : undefined },
      { label: 'Max rules', value: stringOrNumberField(record, 'maxRules') },
    ],
  };
}

function getAlertRuleToolCallSummary(record: Record<string, unknown>): SimpleToolCallSummary {
  const name = stringField(record, 'name');
  const namespace = stringField(record, 'namespace');
  return {
    summary: summaryLine(['Get alert rule', name, namespace ? `namespace ${namespace}` : undefined]),
    items: [
      { label: 'Rule', value: name ? <code>{name}</code> : undefined },
      { label: 'Namespace', value: namespace ? <code>{namespace}</code> : undefined },
    ],
  };
}

function metricNeighborhoodToolCallSummary(record: Record<string, unknown>): SimpleToolCallSummary {
  const metric = stringField(record, 'metric');
  const metrics = stringArrayField(record, 'metrics') ?? [];
  const seedCode = metrics.length > 0 ? metrics.join('\n') : metric;

  return {
    summary: summaryLine([
      'Get metric neighborhood',
      metric ?? (metrics.length > 0 ? `${metrics.length} seeds` : undefined),
    ]),
    items: [
      {
        label: metrics.length > 0 ? 'Seed metrics' : 'Seed metric',
        value: seedCode ? <code>{seedCode}</code> : undefined,
      },
      { label: 'Dashboard', value: formatSummaryFieldValue(record, 'dashboardUid') },
      { label: 'Query', value: stringField(record, 'query') },
      { label: 'Datasource', value: formatDatasourceMetaValue(record) },
      { label: 'Max results', value: stringOrNumberField(record, 'maxResults') },
    ],
    code: seedCode,
  };
}

function liveDashboardToolCallSummary(action: string, record: Record<string, unknown>): SimpleToolCallSummary {
  const query = stringField(record, 'queryExpression') ?? stringField(record, 'query');
  const command = stringField(record, 'type') ?? stringField(record, 'command');
  const element = stringField(record, 'elementName');
  const elements = liveDashboardElementsSummary(record);
  const title = stringField(record, 'title');
  const variable = stringField(record, 'name');
  const code = liveDashboardToolCallCode(record);
  return {
    summary: summaryLine([action, element ?? elements ?? title ?? variable ?? command]),
    items: [
      { label: 'Command', value: command },
      { label: 'Element', value: formatSummaryFieldValue(record, 'elementName') },
      { label: 'Elements', value: elements ? <code>{elements}</code> : undefined },
      { label: 'Title', value: title },
      { label: 'Description', value: stringField(record, 'description') },
      { label: 'Variable', value: variable ? <code>{variable}</code> : undefined },
      { label: 'New variable', value: formatSummaryFieldValue(record, 'newName') },
      { label: 'Visualization', value: stringField(record, 'visualizationType') },
      { label: 'Variable type', value: stringField(record, 'variableType') },
      { label: 'Parent path', value: formatSummaryFieldValue(record, 'parentPath') },
      { label: 'Datasource', value: liveDashboardDatasourceSummary(record) },
      { label: 'Ref ID', value: formatSummaryFieldValue(record, 'refId') },
      { label: 'Hidden', value: booleanLabel(record, 'hidden') },
      { label: 'Query', value: query ? <code>{query}</code> : undefined },
      { label: 'Unit', value: formatSummaryFieldValue(record, 'unit') },
      { label: 'Grid', value: liveDashboardGridSummary(record) },
      { label: 'Time range', value: liveDashboardTimeRangeSummary(record) },
      { label: 'Refresh', value: stringField(record, 'autoRefresh') },
      { label: 'Timezone', value: stringField(record, 'timezone') },
      { label: 'Cursor sync', value: stringField(record, 'cursorSync') },
      { label: 'Editable', value: booleanLabel(record, 'editable') },
      { label: 'Live now', value: booleanLabel(record, 'liveNow') },
      { label: 'Preload', value: booleanLabel(record, 'preload') },
      { label: 'Current', value: stringField(record, 'current') },
      { label: 'Position', value: stringOrNumberField(record, 'position') },
      { label: 'Multi', value: booleanLabel(record, 'multi') },
      { label: 'Include all', value: booleanLabel(record, 'includeAll') },
      { label: 'Tags', value: stringArraySummary(record, 'tags') },
      { label: 'Options', value: stringArraySummary(record, 'options') },
      { label: 'Evaluate variables', value: booleanLabel(record, 'evaluateVariables') },
      { label: 'Include status', value: booleanLabel(record, 'includeStatus') },
    ],
    code,
  };
}

function liveDashboardElementsSummary(record: Record<string, unknown>) {
  const elements = stringArrayField(record, 'elements');
  return elements?.length ? elements.join(', ') : undefined;
}

function liveDashboardDatasourceSummary(record: Record<string, unknown>) {
  const datasourceType = stringField(record, 'datasourceType');
  const datasourceName = stringField(record, 'datasourceName');
  if (datasourceType && datasourceName) {
    return `${datasourceType}/${datasourceName}`;
  }
  return datasourceName ?? datasourceType;
}

function liveDashboardGridSummary(record: Record<string, unknown>) {
  const fields = ['x', 'y', 'width', 'height']
    .map((key) => {
      const value = stringOrNumberField(record, key);
      return value ? `${key} ${value}` : undefined;
    })
    .filter(Boolean);
  return fields.length > 0 ? fields.join(', ') : undefined;
}

function liveDashboardTimeRangeSummary(record: Record<string, unknown>) {
  const from = stringField(record, 'from');
  const to = stringField(record, 'to');
  if (from && to) {
    return `${from} -> ${to}`;
  }
  return from ?? to;
}

function stringArraySummary(record: Record<string, unknown>, key: string) {
  const values = stringArrayField(record, key);
  return values?.length ? values.join(', ') : undefined;
}

function liveDashboardToolCallCode(record: Record<string, unknown>) {
  if (record.payload !== undefined) {
    return formatJson(record.payload);
  }
  if (record.querySpec !== undefined) {
    return formatJson(record.querySpec);
  }
  return undefined;
}

function screenshotDashboardToolCallSummary(record: Record<string, unknown>): SimpleToolCallSummary {
  const dashboard = dashboardToolCallIdentifier(record);
  const width = numberField(record, 'width');
  const height = numberField(record, 'height');
  return {
    summary: summaryLine(['Capture dashboard screenshot', dashboard]),
    items: [
      { label: 'Dashboard', value: dashboard ? <code>{dashboard}</code> : undefined },
      { label: 'Panel', value: stringOrNumberField(record, 'panelId') },
      { label: 'Size', value: width && height ? `${width} x ${height}` : undefined },
    ],
  };
}

function toolCallArgsRecord(
  args: unknown,
  partialJson: string | undefined,
  isStreaming: boolean
): Record<string, unknown> | undefined {
  if (isStreaming && partialJson) {
    try {
      const parsed = JSON.parse(partialJson);
      if (isRecord(parsed)) {
        return parsed;
      }
    } catch {
      return isRecord(args) ? args : undefined;
    }
  }

  return isRecord(args) ? args : undefined;
}

function formatDatasourceMetaValue(record: Record<string, unknown>) {
  return stringField(record, 'datasourceUid') ?? 'default';
}

function dashboardToolCallIdentifier(record: Record<string, unknown>) {
  return (
    stringField(record, 'uid') ??
    stringField(record, 'dashboardUid') ??
    stringField(record, 'name') ??
    stringField(record, 'title')
  );
}

function booleanLabel(record: Record<string, unknown>, key: string) {
  const value = booleanField(record, key);
  return value === undefined ? undefined : value ? 'yes' : 'no';
}

function summaryLine(parts: Array<string | undefined>) {
  return parts.filter(Boolean).join(' | ');
}

function ToolHeader({
  name,
  status,
  compact,
  label,
}: {
  name: string;
  status: 'running' | 'completed' | 'failed';
  compact?: boolean;
  label?: string;
}) {
  const styles = useStyles2(getToolStyles);
  const icon = toolIconName(name);
  const badge =
    status === 'running' ? (
      <Badge text="running" color="blue" />
    ) : status === 'failed' ? (
      <Badge text="failed" color="red" />
    ) : (
      <Badge text="done" color="green" />
    );

  return (
    <div className={cx(styles.toolHeader, compact && styles.toolHeaderCompact)}>
      {status === 'running' && !compact && <Spinner size="sm" />}
      {badge}
      {icon && <Icon aria-hidden className={styles.toolTypeIcon} name={icon} />}
      <strong>{label ?? name}</strong>
    </div>
  );
}

type ToolErrorViewModel = {
  toolName?: string;
  message: string;
};

function ToolErrorView({
  error,
  details,
  content,
}: {
  error: ToolErrorViewModel;
  details?: unknown;
  content?: unknown;
}) {
  const styles = useStyles2(getToolStyles);
  const showDetails = hasDetails(details);
  const showContent = hasUsefulErrorContent(content, error.message);

  return (
    <div className={styles.errorCard} data-testid="tool-error">
      <div className={styles.errorTitle}>{error.toolName ? `${error.toolName} failed` : 'Tool failed'}</div>
      <div className={styles.errorMessage}>{error.message}</div>
      {(showDetails || showContent) && (
        <details className={styles.collapsible}>
          <summary>Details</summary>
          {showDetails && <pre className={styles.queryBlock}>{formatJson(details)}</pre>}
          {showContent && <pre className={styles.queryBlock}>{formatJson(content)}</pre>}
        </details>
      )}
    </div>
  );
}

function extractToolError(toolName: string | undefined, details: unknown, content: unknown): ToolErrorViewModel {
  const message =
    extractExplicitErrorMessage(details) ??
    extractErrorMessageFromText(extractToolText(content)) ??
    extractErrorMessage(content) ??
    'Tool failed without a readable error message.';

  return {
    toolName,
    message,
  };
}

function extractToolText(content: unknown): string | undefined {
  if (typeof content === 'string') {
    return content.trim() || undefined;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }

  const text = content
    .map((block) => (isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();

  return text || undefined;
}

function extractExplicitErrorMessage(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  if (Array.isArray(value)) {
    return extractErrorMessageFromText(extractToolText(value));
  }

  const record = value as Record<string, unknown>;
  for (const key of ['error', 'message', 'reason', 'detail', 'details']) {
    const message = extractErrorMessage(record[key]);
    if (message) {
      return message;
    }
  }

  return undefined;
}

function extractErrorMessage(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return extractErrorMessageFromText(value);
  }
  if (!value || typeof value !== 'object') {
    // Non-string primitives like `false` or `0` are not readable error
    // messages; the raw details stay available in the Details section.
    return undefined;
  }
  if (Array.isArray(value)) {
    return extractErrorMessageFromText(extractToolText(value));
  }

  const record = value as Record<string, unknown>;
  for (const key of ['error', 'message', 'status', 'reason', 'detail', 'details']) {
    const nested = record[key];
    const message = extractErrorMessage(nested);
    if (message) {
      return message;
    }
  }

  return undefined;
}

function extractErrorMessageFromText(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed);
    const message = extractErrorMessage(parsed);
    return message || trimmed;
  } catch {
    return trimmed;
  }
}

function hasUsefulErrorContent(content: unknown, message: string) {
  if (content === undefined || content === null) {
    return false;
  }
  const contentText = extractToolText(content);
  return !contentText || contentText.trim() !== message.trim();
}

const TOOL_ICONS: Record<string, IconName> = {
  navigate: 'compass',
  read_artifact: 'file-alt',
  read: 'file-alt',
  edit: 'file-edit-alt',
  write: 'file-edit-alt',
  bash: 'brackets-curly',
  inspect_dashboard_metric_usage: 'dashboard',
  find_panel_alert_rules: 'bell',
  get_alert_rule: 'bell',
  search_dashboard_metric_usage: 'search',
  get_metric_neighborhood: 'search',
  list_live_dashboard_panels: 'list-ul',
  get_live_dashboard_layout: 'dashboard',
  get_live_dashboard_info: 'dashboard',
  list_live_dashboard_variables: 'list-ul',
  get_live_dashboard_mutation_schema: 'book',
  rename_live_dashboard_panel: 'edit',
  update_live_dashboard_panel_query: 'search',
  update_live_dashboard_panel_queries: 'search',
  apply_live_dashboard_prometheus_label_filter: 'filter',
  add_live_dashboard_panel: 'plus',
  move_or_resize_live_dashboard_panel: 'dashboard',
  update_live_dashboard_settings: 'cog',
  add_live_dashboard_variable: 'plus',
  update_live_dashboard_variable: 'edit',
  apply_live_dashboard_mutation: 'dashboard',
  screenshot_dashboard: 'camera',
  grafana_screenshot: 'camera',
};

function toolIconName(name: string): IconName | undefined {
  return TOOL_ICONS[name];
}

function renderStructuredToolResult(
  toolName: string | undefined,
  details: unknown,
  content: unknown
): React.ReactNode | undefined {
  const artifactResult = asArtifactResult(details);
  const workspaceResult = asWorkspaceToolResult(toolName, details, content);
  if (workspaceResult) {
    return workspaceResult;
  }

  const artifactRead = asArtifactReadResult(toolName, details, content);
  if (artifactRead) {
    return <ArtifactReadResultView result={artifactRead} />;
  }

  const alertRuleMatches = asAlertRuleMatchesResult(toolName, details, content);
  if (alertRuleMatches) {
    return <AlertRuleMatchesResultView result={alertRuleMatches} />;
  }

  const alertRule = asAlertRuleResult(toolName, details, content);
  if (alertRule) {
    return <AlertRuleResultView result={alertRule} />;
  }

  const screenshot = asScreenshotResult(toolName, details);
  if (screenshot) {
    return <ScreenshotResultView content={artifactResult ? undefined : content} result={screenshot} />;
  }

  const liveSchema = asLiveDashboardMutationSchemaResult(toolName, details, content);
  if (liveSchema) {
    return <LiveDashboardMutationSchemaResultView result={liveSchema} />;
  }

  const liveMutation = asLiveDashboardMutationResult(toolName, details);
  if (liveMutation) {
    return <LiveDashboardMutationResultView result={liveMutation} />;
  }

  return undefined;
}

type ArtifactReadResult = {
  artifact?: ArtifactRef;
  mode?: string;
  path?: string;
  jq?: string;
  exitCode?: number;
  truncated?: boolean;
  text?: string;
  emptyKind?: 'null' | 'undefined';
  json?: unknown;
};

function ArtifactReadResultView({ result }: { result: ArtifactReadResult }) {
  const styles = useStyles2(getToolStyles);
  const summary = summaryLine([
    'Artifact read',
    result.mode,
    result.artifact?.title,
    result.truncated ? 'truncated' : undefined,
  ]);

  return (
    <div className={styles.structuredResult}>
      <div className={styles.resultSummary}>{summary}</div>
      <ResultMetaGrid
        items={[
          { label: 'Artifact', value: result.artifact ? <code>{result.artifact.id}</code> : undefined },
          { label: 'Tool', value: result.artifact?.toolName },
          { label: 'Mode', value: result.mode },
          { label: 'Path', value: result.path ? <code>{result.path}</code> : undefined },
          { label: 'jq', value: result.jq ? <code>{result.jq}</code> : undefined },
          { label: 'Exit code', value: result.exitCode === undefined ? undefined : String(result.exitCode) },
          { label: 'Truncated', value: formatBoolean(result.truncated) },
        ]}
      />
      {result.emptyKind ? (
        <div className={styles.emptyState}>{artifactReadEmptyMessage(result)}</div>
      ) : result.json !== undefined ? (
        <ArtifactReadJsonView result={result} />
      ) : result.text ? (
        <ContentBlocks content={[{ type: 'text', text: result.text }]} />
      ) : (
        <div className={styles.emptyState}>Artifact read returned no output.</div>
      )}
    </div>
  );
}

function asArtifactReadResult(
  toolName: string | undefined,
  details: unknown,
  content: unknown
): ArtifactReadResult | undefined {
  if (!isArtifactReadResult(toolName, details) || !isRecord(details)) {
    return undefined;
  }

  const text = extractToolText(content);
  const trimmed = text?.trim();
  return {
    artifact: asArtifactRef(recordField(details, 'artifactRef')),
    mode: stringField(details, 'mode'),
    path: stringField(details, 'path'),
    jq: stringField(details, 'jq'),
    exitCode: numberField(details, 'exitCode'),
    truncated: booleanField(details, 'truncated'),
    text,
    emptyKind: trimmed === 'null' || trimmed === 'undefined' ? trimmed : undefined,
    json: parseArtifactReadJson(trimmed),
  };
}

function parseArtifactReadJson(text: string | undefined): unknown {
  if (!text || text === 'null' || text === 'undefined') {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function artifactReadEmptyMessage(result: ArtifactReadResult) {
  const selected = result.mode === 'jq' ? 'jq result' : 'Selected artifact field';
  return `${selected} is ${result.emptyKind}.`;
}

function ArtifactReadJsonView({ result }: { result: ArtifactReadResult }) {
  const styles = useStyles2(getToolStyles);
  const json = result.json;
  const isFullRead = result.mode === 'full';

  return (
    <div className={styles.jsonSummary}>
      {isRecord(json) && <ArtifactReadJsonSummary value={json} />}
      <details className={styles.collapsible} open={!isFullRead}>
        <summary>{isFullRead ? 'Full artifact JSON' : 'Artifact JSON'}</summary>
        <pre className={styles.queryBlock}>{formatJson(json)}</pre>
      </details>
    </div>
  );
}

function ArtifactReadJsonSummary({ value }: { value: Record<string, unknown> }) {
  const panels = liveDashboardPanelsFromArtifact(value);
  const command = stringField(value, 'command');
  const success = booleanField(value, 'success');
  const availableCommands = Array.isArray(value.availableCommands) ? value.availableCommands.length : undefined;

  return (
    <>
      <ResultMetaGrid
        items={[
          { label: 'Command', value: command },
          { label: 'Success', value: formatBoolean(success) },
          { label: 'Panels', value: panels ? formatCount(panels.length) : undefined },
          {
            label: 'Available commands',
            value: availableCommands === undefined ? undefined : formatCount(availableCommands),
          },
        ]}
      />
      {panels && panels.length > 0 && <ArtifactDashboardPanelsList panels={panels} />}
    </>
  );
}

type ArtifactDashboardPanelSummary = {
  title?: string;
  type?: string;
  grid?: string;
  queryCount?: number;
};

function ArtifactDashboardPanelsList({ panels }: { panels: ArtifactDashboardPanelSummary[] }) {
  const styles = useStyles2(getToolStyles);
  return (
    <div className={styles.queryResultList}>
      {panels.slice(0, 6).map((panel, index) => (
        <div className={styles.compactResult} key={`${panel.title ?? 'panel'}:${index}`}>
          <div className={styles.compactResultSummary}>
            <span className={styles.queryResultIndex}>{index + 1}</span>
            <span className={styles.compactResultText}>{panel.title ?? 'Untitled panel'}</span>
          </div>
          <div className={styles.compactResultBody}>
            <ResultMetaGrid
              items={[
                { label: 'Type', value: panel.type },
                { label: 'Grid', value: panel.grid },
                { label: 'Queries', value: panel.queryCount === undefined ? undefined : formatCount(panel.queryCount) },
              ]}
            />
          </div>
        </div>
      ))}
      {panels.length > 6 && (
        <div className={styles.emptyState}>{formatCount(panels.length - 6)} more panels hidden.</div>
      )}
    </div>
  );
}

function liveDashboardPanelsFromArtifact(value: Record<string, unknown>): ArtifactDashboardPanelSummary[] | undefined {
  const data = recordField(value, 'data');
  const elements = data ? recordsField(data, 'elements') : [];
  if (elements.length === 0) {
    return undefined;
  }

  return elements.map((entry) => {
    const element = recordField(entry, 'element');
    const spec = recordField(element, 'spec');
    const layoutItem = recordField(entry, 'layoutItem');
    const layoutSpec = recordField(layoutItem, 'spec');
    const queryGroup = recordField(recordField(spec, 'data'), 'spec');
    const queries = queryGroup ? recordsField(queryGroup, 'queries') : [];
    const vizConfig = recordField(spec, 'vizConfig');
    return {
      title: stringField(spec, 'title'),
      type: stringField(vizConfig, 'group'),
      grid: formatGridSummary(layoutSpec),
      queryCount: queries.length,
    };
  });
}

function formatGridSummary(layoutSpec: Record<string, unknown> | undefined) {
  if (!layoutSpec) {
    return undefined;
  }
  const width = numberField(layoutSpec, 'width');
  const height = numberField(layoutSpec, 'height');
  const x = numberField(layoutSpec, 'x');
  const y = numberField(layoutSpec, 'y');
  const size = width !== undefined && height !== undefined ? `${width}x${height}` : undefined;
  const position = x !== undefined && y !== undefined ? `at ${x},${y}` : undefined;
  if (size && position) {
    return `${size} ${position}`;
  }
  return size ?? position;
}

type AlertRuleMatchesResult = {
  namespace?: string;
  query?: AlertRuleSearchQuery;
  dashboardPanel?: AlertDashboardPanelSummary;
  ruleCount: number;
  matchCount: number;
  exactPanelMatchCount: number;
  matches: AlertRuleMatchView[];
  guidance: string[];
  contentAvailable: boolean;
};

type AlertRuleSearchQuery = {
  dashboardUid?: string;
  panelId?: string;
  panelTitle?: string;
  ruleName?: string;
  query?: string;
};

type AlertDashboardPanelSummary = {
  id?: string;
  title?: string;
  type?: string;
  datasourceUid?: string;
  datasourceType?: string;
  targets: AlertPanelTargetSummary[];
  thresholds?: unknown;
};

type AlertPanelTargetSummary = {
  refId?: string;
  datasourceUid?: string;
  datasourceType?: string;
  query?: string;
  legendFormat?: string;
  hidden?: boolean;
};

type AlertRuleMatchView = {
  score: number;
  reasons: string[];
  rule: AlertRuleView;
};

type AlertRuleResult = {
  namespace?: string;
  rule?: AlertRuleView;
  rawStatus?: unknown;
  guidance: string[];
  name?: string;
  title?: string;
  prometheusChecks?: number;
  contentAvailable: boolean;
};

type AlertRuleView = {
  name: string;
  title: string;
  viewUrl?: string;
  apiPath?: string;
  folderUid?: string;
  panelLink?: AlertRulePanelLinkView;
  for?: string;
  keepFiringFor?: string;
  noDataState?: string;
  execErrState?: string;
  paused?: boolean;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  conditionRef?: string;
  expressions: AlertExpressionView[];
  alertCondition?: AlertConditionView;
  prometheusChecks: AlertPrometheusCheckView[];
};

type AlertRulePanelLinkView = {
  dashboardUID: string;
  panelID: string;
  source?: string;
};

type AlertExpressionView = {
  refId: string;
  source?: boolean;
  queryType?: string;
  datasourceUid?: string;
  expressionType?: string;
  expression?: string;
  reducer?: string;
  evaluator?: AlertEvaluatorView;
  relativeTimeRange?: AlertRelativeTimeRangeView;
};

type AlertConditionView = {
  sourceRefId?: string;
  expression?: string;
  evaluator?: AlertEvaluatorView;
  reducer?: string;
};

type AlertEvaluatorView = {
  type?: string;
  params?: unknown[];
};

type AlertRelativeTimeRangeView = {
  from?: number;
  to?: number;
};

type AlertPrometheusCheckView = {
  refId: string;
  datasourceUid: string;
  query: string;
  type?: string;
  start?: string;
  end?: string;
  relativeTimeRange?: AlertRelativeTimeRangeView;
};

function AlertRuleMatchesResultView({ result }: { result: AlertRuleMatchesResult }) {
  const styles = useStyles2(getToolStyles);
  const summaryParts = [
    formatLabeledCount(result.matchCount, 'matched alert rule', 'matched alert rules'),
    formatLabeledCount(result.exactPanelMatchCount, 'exact panel link', 'exact panel links'),
    `${formatCount(result.ruleCount)} scanned`,
  ];

  return (
    <div className={styles.structuredResult}>
      <div className={styles.resultSummary}>{summaryParts.join(' | ')}</div>
      <ResultMetaGrid
        items={[
          { label: 'Namespace', value: result.namespace ? <code>{result.namespace}</code> : undefined },
          {
            label: 'Dashboard',
            value: result.query?.dashboardUid ? <code>{result.query.dashboardUid}</code> : undefined,
          },
          { label: 'Panel', value: result.query?.panelId },
          { label: 'Panel title', value: result.query?.panelTitle ?? result.dashboardPanel?.title },
          { label: 'Rules scanned', value: formatCount(result.ruleCount) },
          { label: 'Matches', value: formatCount(result.matchCount) },
          { label: 'Exact links', value: formatCount(result.exactPanelMatchCount) },
        ]}
      />
      {!result.contentAvailable && (
        <div className={styles.emptyState}>
          The alert rule search completed, but the detailed result text was unavailable.
        </div>
      )}
      {result.dashboardPanel && <AlertPanelEvidenceView panel={result.dashboardPanel} />}
      {result.matches.length > 0 ? (
        <AlertRuleMatchesList matches={result.matches} />
      ) : (
        result.contentAvailable && <div className={styles.emptyState}>No alert rules matched this panel context.</div>
      )}
    </div>
  );
}

function AlertPanelEvidenceView({ panel }: { panel: AlertDashboardPanelSummary }) {
  const styles = useStyles2(getToolStyles);
  return (
    <details className={styles.collapsible} open>
      <summary>Panel evidence</summary>
      <ResultMetaGrid
        items={[
          { label: 'Panel', value: panel.id },
          { label: 'Title', value: panel.title },
          { label: 'Type', value: panel.type },
          { label: 'Datasource', value: panel.datasourceUid ?? panel.datasourceType },
          { label: 'Targets', value: formatCount(panel.targets.length) },
        ]}
      />
      {panel.targets.length > 0 && <AlertPanelTargetsList targets={panel.targets} />}
      {panel.thresholds !== undefined && (
        <details className={styles.collapsible}>
          <summary>Panel thresholds</summary>
          <pre className={styles.queryBlock}>{formatJson(panel.thresholds)}</pre>
        </details>
      )}
    </details>
  );
}

function AlertPanelTargetsList({ targets }: { targets: AlertPanelTargetSummary[] }) {
  const styles = useStyles2(getToolStyles);
  return (
    <div className={styles.queryResultList}>
      {targets.map((target, index) => (
        <AlertPanelTargetItem
          defaultOpen={index === 0}
          index={index}
          key={`${target.refId ?? index}:${target.query ?? ''}`}
          target={target}
        />
      ))}
    </div>
  );
}

function AlertPanelTargetItem({
  defaultOpen,
  index,
  target,
}: {
  defaultOpen: boolean;
  index: number;
  target: AlertPanelTargetSummary;
}) {
  const styles = useStyles2(getToolStyles);
  const [open, setOpen] = useState(defaultOpen);
  const title = target.legendFormat ?? target.query ?? 'Panel query';
  const visibility = target.hidden ? 'hidden' : 'visible';

  return (
    <details className={styles.queryResultItem} onToggle={(event) => setOpen(event.currentTarget.open)} open={open}>
      <summary className={styles.queryResultSummary}>
        <Icon className={styles.queryResultChevron} name={open ? 'angle-down' : 'angle-right'} />
        <span className={styles.queryResultIndex}>{target.refId ?? index + 1}</span>
        <span className={target.query ? styles.queryResultExpression : styles.queryResultTitle} title={title}>
          {title}
        </span>
        <span className={styles.queryResultMeta}>{visibility}</span>
      </summary>
      <ResultMetaGrid
        items={[
          { label: 'Datasource', value: target.datasourceUid ?? target.datasourceType },
          { label: 'Legend', value: target.legendFormat },
          { label: 'Hidden', value: formatBoolean(target.hidden) },
        ]}
      />
      {target.query && <pre className={styles.queryBlock}>{target.query}</pre>}
    </details>
  );
}

function AlertRuleMatchesList({ matches }: { matches: AlertRuleMatchView[] }) {
  const styles = useStyles2(getToolStyles);
  return (
    <div className={styles.queryResultList}>
      {matches.map((match, index) => (
        <AlertRuleMatchItem defaultOpen={index === 0} index={index} key={`${match.rule.name}:${index}`} match={match} />
      ))}
    </div>
  );
}

function AlertRuleMatchItem({
  defaultOpen,
  index,
  match,
}: {
  defaultOpen: boolean;
  index: number;
  match: AlertRuleMatchView;
}) {
  const styles = useStyles2(getToolStyles);
  const [open, setOpen] = useState(defaultOpen);
  const rule = match.rule;
  const query = firstAlertPrometheusQuery(rule);
  const condition = formatAlertCondition(rule.alertCondition);

  return (
    <details className={styles.queryResultItem} onToggle={(event) => setOpen(event.currentTarget.open)} open={open}>
      <summary className={styles.queryResultSummary}>
        <Icon className={styles.queryResultChevron} name={open ? 'angle-down' : 'angle-right'} />
        <span className={styles.queryResultIndex}>{index + 1}</span>
        <span className={styles.queryResultTitle} title={rule.title}>
          {rule.title}
        </span>
        <span className={styles.queryResultMeta}>
          {match.score > 0 ? `score ${match.score}` : (condition ?? 'match')}
        </span>
      </summary>
      <ResultMetaGrid
        items={[
          { label: 'Rule', value: <code>{rule.name}</code> },
          { label: 'Score', value: match.score > 0 ? String(match.score) : undefined },
          { label: 'Link', value: <AlertPanelLinkHealth link={rule.panelLink} /> },
          { label: 'Condition', value: condition },
          { label: 'For', value: rule.for },
          { label: 'No data', value: rule.noDataState },
          { label: 'Exec error', value: rule.execErrState },
          { label: 'Folder', value: rule.folderUid ? <code>{rule.folderUid}</code> : undefined },
          {
            label: 'View',
            value: rule.viewUrl ? <ExternalLink href={rule.viewUrl}>Open rule</ExternalLink> : undefined,
          },
        ]}
      />
      {query && <pre className={styles.queryBlock}>{query}</pre>}
      {match.reasons.length > 0 && <StringChips values={match.reasons} />}
      {Object.keys(rule.labels).length > 0 && (
        <details className={styles.collapsible}>
          <summary>Labels</summary>
          <LabelPills labels={rule.labels} />
        </details>
      )}
      {Object.keys(rule.annotations).length > 0 && (
        <details className={styles.collapsible}>
          <summary>Annotations</summary>
          <LabelPills labels={rule.annotations} />
        </details>
      )}
    </details>
  );
}

function AlertRuleResultView({ result }: { result: AlertRuleResult }) {
  const styles = useStyles2(getToolStyles);
  const rule = result.rule;
  if (!rule) {
    return (
      <div className={styles.structuredResult}>
        <div className={styles.resultSummary}>Alert rule loaded</div>
        <ResultMetaGrid
          items={[
            { label: 'Namespace', value: result.namespace ? <code>{result.namespace}</code> : undefined },
            { label: 'Rule', value: result.name ? <code>{result.name}</code> : undefined },
            { label: 'Title', value: result.title },
            { label: 'Prometheus checks', value: result.prometheusChecks },
          ]}
        />
        <div className={styles.emptyState}>The alert rule completed, but the detailed result text was unavailable.</div>
      </div>
    );
  }

  return (
    <div className={styles.structuredResult}>
      <div className={styles.resultSummary}>{summaryLine(['Alert rule', rule.title, rule.name])}</div>
      <ResultMetaGrid
        items={[
          { label: 'Namespace', value: result.namespace ? <code>{result.namespace}</code> : undefined },
          { label: 'Rule', value: <code>{rule.name}</code> },
          { label: 'Folder', value: rule.folderUid ? <code>{rule.folderUid}</code> : undefined },
          { label: 'Condition', value: formatAlertCondition(rule.alertCondition) },
          { label: 'For', value: rule.for },
          { label: 'Keep firing', value: rule.keepFiringFor },
          { label: 'No data', value: rule.noDataState },
          { label: 'Exec error', value: rule.execErrState },
          { label: 'Paused', value: formatBoolean(rule.paused) },
          { label: 'Panel link', value: <AlertPanelLinkHealth link={rule.panelLink} /> },
        ]}
      />
      {rule.viewUrl && (
        <div>
          <LinkButton href={rule.viewUrl} icon="bell" rel="noreferrer" size="sm" target="_blank" variant="secondary">
            View alert rule
          </LinkButton>
        </div>
      )}
      {(Object.keys(rule.labels).length > 0 || Object.keys(rule.annotations).length > 0) && (
        <details className={styles.collapsible}>
          <summary>Labels and annotations</summary>
          {Object.keys(rule.labels).length > 0 && (
            <>
              <div className={styles.resultSummary}>Labels</div>
              <LabelPills labels={rule.labels} />
            </>
          )}
          {Object.keys(rule.annotations).length > 0 && (
            <>
              <div className={styles.resultSummary}>Annotations</div>
              <LabelPills labels={rule.annotations} />
            </>
          )}
        </details>
      )}
      <AlertExpressionChainView expressions={rule.expressions} />
      <AlertPrometheusChecksView checks={rule.prometheusChecks} />
      {result.rawStatus !== undefined && (
        <details className={styles.collapsible}>
          <summary>Raw status</summary>
          <pre className={styles.queryBlock}>{formatJson(result.rawStatus)}</pre>
        </details>
      )}
    </div>
  );
}

function AlertExpressionChainView({ expressions }: { expressions: AlertExpressionView[] }) {
  const styles = useStyles2(getToolStyles);
  if (expressions.length === 0) {
    return <div className={styles.emptyState}>No alert expressions were returned for this rule.</div>;
  }

  return (
    <details className={styles.collapsible} open>
      <summary>Expression chain</summary>
      <div className={styles.tableWrap}>
        <table className={cx(styles.dataTable, styles.wideTable)}>
          <thead>
            <tr>
              <th>Ref</th>
              <th>Kind</th>
              <th>Datasource</th>
              <th>Reducer</th>
              <th>Evaluator</th>
              <th>Window</th>
              <th>Expression</th>
            </tr>
          </thead>
          <tbody>
            {expressions.map((expression) => (
              <tr key={expression.refId}>
                <td>
                  <strong>{expression.refId}</strong>
                  {expression.source && <div className={styles.muted}>condition</div>}
                </td>
                <td>{expression.expressionType ?? expression.queryType ?? <span className={styles.muted}>-</span>}</td>
                <td>{expression.datasourceUid ?? <span className={styles.muted}>-</span>}</td>
                <td>{expression.reducer ?? <span className={styles.muted}>-</span>}</td>
                <td>{formatAlertEvaluator(expression.evaluator) ?? <span className={styles.muted}>-</span>}</td>
                <td>
                  {formatAlertRelativeTimeRange(expression.relativeTimeRange) ?? (
                    <span className={styles.muted}>-</span>
                  )}
                </td>
                <td className={styles.codeTextCell}>
                  {expression.expression ? (
                    truncateInline(expression.expression, 180)
                  ) : (
                    <span className={styles.muted}>-</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function AlertPrometheusChecksView({ checks }: { checks: AlertPrometheusCheckView[] }) {
  const styles = useStyles2(getToolStyles);
  if (checks.length === 0) {
    return <div className={styles.emptyState}>No Prometheus checks are available for this alert rule.</div>;
  }

  return (
    <details className={styles.collapsible} open>
      <summary>Prometheus checks</summary>
      <div className={styles.prometheusQueryPlanList}>
        {checks.map((check, index) => (
          <div className={styles.prometheusQueryPlanRow} key={`${check.refId}:${check.query}`}>
            <span className={styles.prometheusQueryPlanIndex}>{check.refId || `Query ${index + 1}`}</span>
            <span className={styles.prometheusQueryPlanMeta}>
              {[check.type ?? 'range', check.datasourceUid, formatAlertCheckRange(check)].filter(Boolean).join(' | ')}
            </span>
            <code className={styles.prometheusQueryPlanExpression} title={check.query}>
              {check.query}
            </code>
          </div>
        ))}
      </div>
    </details>
  );
}

function AlertPanelLinkHealth({ link }: { link?: AlertRulePanelLinkView }) {
  const styles = useStyles2(getToolStyles);
  const health = alertPanelLinkHealth(link);
  return (
    <div className={styles.chipList}>
      <Badge text={health.text} color={health.color} />
      {link && (
        <span className={styles.muted}>
          {link.dashboardUID}/{link.panelID}
        </span>
      )}
      {health.hint && <span className={styles.muted}>{health.hint}</span>}
    </div>
  );
}

function asAlertRuleMatchesResult(
  toolName: string | undefined,
  details: unknown,
  content: unknown
): AlertRuleMatchesResult | undefined {
  if (toolName !== 'find_panel_alert_rules') {
    return undefined;
  }

  const detailRecord = isRecord(details) ? details : {};
  const record = parseToolJsonRecord(content, details);
  if (record) {
    return alertRuleMatchesResultFromRecord(record, detailRecord, true);
  }

  const ruleCount = numberField(detailRecord, 'ruleCount');
  const matchCount = numberField(detailRecord, 'matchCount');
  if (ruleCount === undefined && matchCount === undefined) {
    return undefined;
  }

  return {
    namespace: stringField(detailRecord, 'namespace'),
    query: {
      dashboardUid: stringField(detailRecord, 'dashboardUid'),
      panelId: stringOrNumberField(detailRecord, 'panelId'),
    },
    ruleCount: ruleCount ?? 0,
    matchCount: matchCount ?? 0,
    exactPanelMatchCount: numberField(detailRecord, 'exactPanelMatchCount') ?? 0,
    matches: [],
    guidance: [],
    contentAvailable: false,
  };
}

function alertRuleMatchesResultFromRecord(
  record: Record<string, unknown>,
  details: Record<string, unknown>,
  contentAvailable: boolean
): AlertRuleMatchesResult {
  const matches = recordsField(record, 'matches')
    .map(alertRuleMatchFromRecord)
    .filter((match): match is AlertRuleMatchView => Boolean(match));

  return {
    namespace: stringField(record, 'namespace') ?? stringField(details, 'namespace'),
    query: alertRuleSearchQueryFromRecord(recordField(record, 'query')),
    dashboardPanel: alertDashboardPanelFromRecord(recordField(record, 'dashboardPanel')),
    ruleCount: numberField(record, 'ruleCount') ?? numberField(details, 'ruleCount') ?? 0,
    matchCount: numberField(record, 'matchCount') ?? numberField(details, 'matchCount') ?? matches.length,
    exactPanelMatchCount:
      numberField(record, 'exactPanelMatchCount') ?? numberField(details, 'exactPanelMatchCount') ?? 0,
    matches,
    guidance: stringArrayField(record, 'guidance') ?? [],
    contentAvailable,
  };
}

function asAlertRuleResult(
  toolName: string | undefined,
  details: unknown,
  content: unknown
): AlertRuleResult | undefined {
  if (toolName !== 'get_alert_rule') {
    return undefined;
  }

  const detailRecord = isRecord(details) ? details : {};
  const record = parseToolJsonRecord(content, details);
  if (record) {
    const rule = alertRuleFromRecord(recordField(record, 'rule'));
    return {
      namespace: stringField(record, 'namespace') ?? stringField(detailRecord, 'namespace'),
      rule,
      rawStatus: record.rawStatus,
      guidance: stringArrayField(record, 'guidance') ?? [],
      name: stringField(detailRecord, 'name'),
      title: stringField(detailRecord, 'title'),
      prometheusChecks: numberField(detailRecord, 'prometheusChecks'),
      contentAvailable: true,
    };
  }

  if (!booleanField(detailRecord, 'summarized')) {
    return undefined;
  }

  return {
    namespace: stringField(detailRecord, 'namespace'),
    name: stringField(detailRecord, 'name'),
    title: stringField(detailRecord, 'title'),
    prometheusChecks: numberField(detailRecord, 'prometheusChecks'),
    guidance: [],
    contentAvailable: false,
  };
}

function alertRuleSearchQueryFromRecord(record: Record<string, unknown> | undefined): AlertRuleSearchQuery | undefined {
  if (!record) {
    return undefined;
  }

  return {
    dashboardUid: stringField(record, 'dashboardUid'),
    panelId: stringOrNumberField(record, 'panelId'),
    panelTitle: stringField(record, 'panelTitle'),
    ruleName: stringField(record, 'ruleName'),
    query: stringField(record, 'query'),
  };
}

function alertDashboardPanelFromRecord(
  record: Record<string, unknown> | undefined
): AlertDashboardPanelSummary | undefined {
  if (!record) {
    return undefined;
  }

  return {
    id: stringOrNumberField(record, 'id'),
    title: stringField(record, 'title'),
    type: stringField(record, 'type'),
    datasourceUid: stringField(record, 'datasourceUid'),
    datasourceType: stringField(record, 'datasourceType'),
    targets: recordsField(record, 'targets').map(alertPanelTargetFromRecord),
    thresholds: record.thresholds,
  };
}

function alertPanelTargetFromRecord(record: Record<string, unknown>): AlertPanelTargetSummary {
  return {
    refId: stringField(record, 'refId'),
    datasourceUid: stringField(record, 'datasourceUid'),
    datasourceType: stringField(record, 'datasourceType'),
    query: stringField(record, 'query'),
    legendFormat: stringField(record, 'legendFormat'),
    hidden: booleanField(record, 'hidden'),
  };
}

function alertRuleMatchFromRecord(record: Record<string, unknown>): AlertRuleMatchView | undefined {
  const rule = alertRuleFromRecord(recordField(record, 'rule'));
  if (!rule) {
    return undefined;
  }

  return {
    score: numberField(record, 'score') ?? 0,
    reasons: stringArrayField(record, 'reasons') ?? [],
    rule,
  };
}

function alertRuleFromRecord(record: Record<string, unknown> | undefined): AlertRuleView | undefined {
  if (!record) {
    return undefined;
  }

  const name = stringField(record, 'name') ?? stringField(record, 'title');
  const title = stringField(record, 'title') ?? name;
  if (!name || !title) {
    return undefined;
  }

  return {
    name,
    title,
    viewUrl: stringField(record, 'viewUrl'),
    apiPath: stringField(record, 'apiPath'),
    folderUid: stringField(record, 'folderUid'),
    panelLink: alertPanelLinkFromRecord(recordField(record, 'panelLink')),
    for: stringField(record, 'for'),
    keepFiringFor: stringField(record, 'keepFiringFor'),
    noDataState: stringField(record, 'noDataState'),
    execErrState: stringField(record, 'execErrState'),
    paused: booleanField(record, 'paused'),
    labels: stringRecord(recordField(record, 'labels')),
    annotations: stringRecord(recordField(record, 'annotations')),
    conditionRef: stringField(record, 'conditionRef'),
    expressions: recordsField(record, 'expressions')
      .map(alertExpressionFromRecord)
      .filter((expression): expression is AlertExpressionView => Boolean(expression)),
    alertCondition: alertConditionFromRecord(recordField(record, 'alertCondition')),
    prometheusChecks: recordsField(record, 'prometheusChecks')
      .map(alertPrometheusCheckFromRecord)
      .filter((check): check is AlertPrometheusCheckView => Boolean(check)),
  };
}

function alertPanelLinkFromRecord(record: Record<string, unknown> | undefined): AlertRulePanelLinkView | undefined {
  const dashboardUID = stringField(record, 'dashboardUID');
  const panelID = record ? stringOrNumberField(record, 'panelID') : undefined;
  if (!dashboardUID || !panelID) {
    return undefined;
  }

  return {
    dashboardUID,
    panelID,
    source: stringField(record, 'source'),
  };
}

function alertExpressionFromRecord(record: Record<string, unknown>): AlertExpressionView | undefined {
  const refId = stringField(record, 'refId');
  if (!refId) {
    return undefined;
  }

  return {
    refId,
    source: booleanField(record, 'source'),
    queryType: stringField(record, 'queryType'),
    datasourceUid: stringField(record, 'datasourceUid'),
    expressionType: stringField(record, 'expressionType'),
    expression: stringField(record, 'expression'),
    reducer: stringField(record, 'reducer'),
    evaluator: alertEvaluatorFromRecord(recordField(record, 'evaluator')),
    relativeTimeRange: alertRelativeTimeRangeFromRecord(recordField(record, 'relativeTimeRange')),
  };
}

function alertConditionFromRecord(record: Record<string, unknown> | undefined): AlertConditionView | undefined {
  if (!record) {
    return undefined;
  }

  return {
    sourceRefId: stringField(record, 'sourceRefId'),
    expression: stringField(record, 'expression'),
    evaluator: alertEvaluatorFromRecord(recordField(record, 'evaluator')),
    reducer: stringField(record, 'reducer'),
  };
}

function alertEvaluatorFromRecord(record: Record<string, unknown> | undefined): AlertEvaluatorView | undefined {
  if (!record) {
    return undefined;
  }

  const params = record.params;
  return {
    type: stringField(record, 'type'),
    params: Array.isArray(params) ? params : undefined,
  };
}

function alertRelativeTimeRangeFromRecord(
  record: Record<string, unknown> | undefined
): AlertRelativeTimeRangeView | undefined {
  if (!record) {
    return undefined;
  }

  return {
    from: numberField(record, 'from'),
    to: numberField(record, 'to'),
  };
}

function alertPrometheusCheckFromRecord(record: Record<string, unknown>): AlertPrometheusCheckView | undefined {
  const refId = stringField(record, 'refId');
  const datasourceUid = stringField(record, 'datasourceUid');
  const query = stringField(record, 'query');
  if (!refId || !datasourceUid || !query) {
    return undefined;
  }

  return {
    refId,
    datasourceUid,
    query,
    type: stringField(record, 'type'),
    start: stringField(record, 'start'),
    end: stringField(record, 'end'),
    relativeTimeRange: alertRelativeTimeRangeFromRecord(recordField(record, 'relativeTimeRange')),
  };
}

function alertPanelLinkHealth(link: AlertRulePanelLinkView | undefined): {
  text: string;
  color: BadgeColor;
  hint?: string;
} {
  switch (link?.source) {
    case 'panelRef+annotations':
      return { text: 'properly linked', color: 'green', hint: 'panel indicator should appear' };
    case 'panelRef':
      return { text: 'panelRef only', color: 'orange', hint: 'panel indicator annotations missing' };
    case 'annotations':
      return { text: 'annotations only', color: 'blue', hint: 'panel indicator metadata present' };
    default:
      return { text: 'not linked', color: 'red' };
  }
}

function firstAlertPrometheusQuery(rule: AlertRuleView) {
  return rule.prometheusChecks[0]?.query ?? rule.expressions.find((expression) => expression.expression)?.expression;
}

function formatAlertCondition(condition: AlertConditionView | undefined) {
  if (!condition) {
    return undefined;
  }

  return [condition.sourceRefId, condition.reducer, formatAlertEvaluator(condition.evaluator)]
    .filter(Boolean)
    .join(' ');
}

function formatAlertEvaluator(evaluator: AlertEvaluatorView | undefined) {
  if (!evaluator?.type) {
    return undefined;
  }
  const params = evaluator.params?.map(formatShortValue).join(', ');
  return params ? `${evaluator.type} ${params}` : evaluator.type;
}

function formatAlertRelativeTimeRange(range: AlertRelativeTimeRangeView | undefined) {
  if (!range || (range.from === undefined && range.to === undefined)) {
    return undefined;
  }
  if (range.from !== undefined && range.to !== undefined) {
    return `${range.from}s to ${range.to}s`;
  }
  return range.from !== undefined ? `from ${range.from}s` : `to ${range.to}s`;
}

function formatAlertCheckRange(check: AlertPrometheusCheckView) {
  if (check.start && check.end) {
    return `${check.start} -> ${check.end}`;
  }
  if (check.start) {
    return `from ${check.start}`;
  }
  if (check.end) {
    return `to ${check.end}`;
  }
  return formatAlertRelativeTimeRange(check.relativeTimeRange);
}

type ScreenshotResult = {
  uid?: string;
  panelId?: number;
  width?: number;
  height?: number;
};

function ScreenshotResultView({ result, content }: { result: ScreenshotResult; content?: unknown }) {
  const styles = useStyles2(getToolStyles);
  return (
    <div className={styles.structuredResult}>
      <ResultMetaGrid
        items={[
          { label: 'Dashboard', value: result.uid ? <code>{result.uid}</code> : undefined },
          { label: 'Panel', value: result.panelId === undefined ? undefined : String(result.panelId) },
          { label: 'Size', value: result.width && result.height ? `${result.width} x ${result.height}` : undefined },
        ]}
      />
      {content !== undefined && <ContentBlocks content={content} />}
    </div>
  );
}

type LiveDashboardMutationSchemaResult = {
  command?: string;
  available?: boolean;
  readOnly?: boolean;
  availableCommands: string[];
  guidance?: unknown;
};

function LiveDashboardMutationSchemaResultView({ result }: { result: LiveDashboardMutationSchemaResult }) {
  const styles = useStyles2(getToolStyles);
  const summary = summaryLine(['Live dashboard mutation schema', result.command]);

  return (
    <div className={styles.structuredResult}>
      <div className={styles.resultSummary}>{summary}</div>
      <ResultMetaGrid
        items={[
          { label: 'Command', value: result.command ? <code>{result.command}</code> : undefined },
          { label: 'Available', value: formatBoolean(result.available) },
          { label: 'Read only', value: formatBoolean(result.readOnly) },
          { label: 'Commands', value: formatCount(result.availableCommands.length) },
        ]}
      />
      <StringChips values={result.availableCommands} />
      {result.guidance !== undefined && (
        <details className={styles.collapsible}>
          <summary>Guidance</summary>
          <pre className={styles.queryBlock}>{formatJson(result.guidance)}</pre>
        </details>
      )}
    </div>
  );
}

type LiveDashboardMutationResult = {
  command: string;
  success: boolean;
  error?: string;
  warnings: string[];
  changes: LiveDashboardMutationChange[];
  payload?: unknown;
  data?: unknown;
  availableCommands: string[];
  visualVerification?: {
    status?: string;
    error?: string;
    details?: unknown;
  };
};

type LiveDashboardMutationChange = {
  path?: string;
  previousValue?: unknown;
  newValue?: unknown;
};

const LIVE_DASHBOARD_READ_COMMANDS = new Set(['GET_DASHBOARD_INFO', 'GET_LAYOUT', 'LIST_PANELS', 'LIST_VARIABLES']);

function LiveDashboardMutationResultView({ result }: { result: LiveDashboardMutationResult }) {
  const styles = useStyles2(getToolStyles);
  const status = result.success ? 'succeeded' : 'failed';
  const resultKind = LIVE_DASHBOARD_READ_COMMANDS.has(result.command) ? 'command' : 'mutation';
  const summaryItems = liveDashboardResultSummaryItems(result);
  return (
    <div className={styles.structuredResult}>
      <div className={styles.resultSummary}>
        Live dashboard {resultKind} {status}
      </div>
      <ResultMetaGrid
        items={[
          { label: 'Command', value: <code>{result.command}</code> },
          { label: 'Status', value: status },
          ...summaryItems,
          { label: 'Changes', value: result.changes.length > 0 ? formatCount(result.changes.length) : undefined },
          { label: 'Warnings', value: result.warnings.length > 0 ? formatCount(result.warnings.length) : undefined },
          { label: 'Verification', value: result.visualVerification?.status },
          { label: 'Verification issue', value: result.visualVerification?.error },
        ]}
      />
      {!result.success && result.error && (
        <div className={styles.errorCard}>
          <div className={styles.errorTitle}>{result.command} failed</div>
          <div className={styles.errorMessage}>{result.error}</div>
        </div>
      )}
      {result.warnings.length > 0 && (
        <div className={styles.noticeList}>
          {result.warnings.map((warning, index) => (
            <div className={styles.notice} key={`${index}:${warning}`}>
              <strong>warning</strong>
              <span>{warning}</span>
            </div>
          ))}
        </div>
      )}
      {result.changes.length > 0 && <LiveDashboardMutationChangesTable changes={result.changes} />}
      {result.data !== undefined && (
        <details className={styles.collapsible}>
          <summary>Data</summary>
          <pre className={styles.queryBlock}>{formatJson(result.data)}</pre>
        </details>
      )}
      {result.visualVerification?.details !== undefined && (
        <details className={styles.collapsible}>
          <summary>Visual verification</summary>
          <pre className={styles.queryBlock}>{formatJson(result.visualVerification.details)}</pre>
        </details>
      )}
    </div>
  );
}

function liveDashboardResultSummaryItems(result: LiveDashboardMutationResult) {
  const payload = isRecord(result.payload) ? result.payload : undefined;
  const data = isRecord(result.data) ? result.data : undefined;
  const element = recordField(payload, 'element');
  const panel = recordField(payload, 'panel');
  const panelSpec = recordField(panel, 'spec');
  const variable = recordField(payload, 'variable');
  const variableSpec = recordField(variable, 'spec');
  const timeSettings = recordField(payload, 'timeSettings');
  const query = liveDashboardResultPanelQuery(panelSpec);
  const dataSummary = liveDashboardResultDataSummary(result.command, data);

  return [
    { label: 'Element', value: formatElementReference(element) },
    { label: 'Affected panels', value: liveDashboardAffectedPanelsSummary(payload) },
    { label: 'Panel title', value: stringField(panelSpec, 'title') },
    { label: 'Variable', value: formatSummaryRecordValue(payload, 'name') },
    { label: 'New variable', value: formatSummaryRecordValue(variableSpec, 'name') },
    {
      label: 'Parent path',
      value: formatSummaryRecordValue(payload, 'parentPath') ?? formatSummaryRecordValue(payload, 'toParent'),
    },
    { label: 'Datasource', value: query.datasource },
    { label: 'Query', value: query.expression ? <code>{query.expression}</code> : undefined },
    { label: 'Grid', value: liveDashboardResultGridSummary(payload) },
    { label: 'Dashboard title', value: stringField(payload, 'title') ?? stringField(data, 'title') },
    { label: 'Time range', value: liveDashboardTimeRangeSummary(timeSettings ?? payload ?? {}) },
    { label: 'Refresh', value: stringField(timeSettings, 'autoRefresh') },
    { label: 'Timezone', value: stringField(timeSettings, 'timezone') ?? stringField(payload, 'timezone') },
    { label: 'Tags', value: stringArraySummary(payload ?? {}, 'tags') },
    ...dataSummary,
  ];
}

function liveDashboardResultPanelQuery(panelSpec: Record<string, unknown> | undefined) {
  const data = recordField(panelSpec, 'data');
  const dataSpec = recordField(data, 'spec');
  const query = recordsField(dataSpec ?? {}, 'queries')[0];
  const querySpec = recordField(query, 'spec');
  const dataQuery = recordField(querySpec, 'query');
  const dataQuerySpec = recordField(dataQuery, 'spec');
  const datasource = recordField(dataQuery, 'datasource');
  const datasourceName = stringField(datasource, 'name');
  const datasourceGroup = stringField(dataQuery, 'group');
  const expression =
    stringField(dataQuerySpec, 'expr') ??
    stringField(dataQuerySpec, 'query') ??
    stringField(dataQuerySpec, '__legacyStringValue') ??
    stringField(dataQuerySpec, '__grafana_string_value');

  return {
    expression,
    datasource:
      datasourceGroup && datasourceName ? `${datasourceGroup}/${datasourceName}` : (datasourceName ?? datasourceGroup),
  };
}

function liveDashboardResultGridSummary(payload: Record<string, unknown> | undefined) {
  const layoutItem = recordField(payload, 'layoutItem');
  const layoutSpec = recordField(layoutItem, 'spec');
  return liveDashboardGridSummary(layoutSpec ?? payload ?? {});
}

function liveDashboardAffectedPanelsSummary(payload: Record<string, unknown> | undefined) {
  const names = recordsField(payload ?? {}, 'elements')
    .map((element) => stringField(element, 'name'))
    .filter((name): name is string => Boolean(name));
  return names.length > 0 ? names.join(', ') : undefined;
}

function liveDashboardResultDataSummary(command: string, data: Record<string, unknown> | undefined) {
  if (command === 'LIST_PANELS') {
    const panels = recordsField(data ?? {}, 'elements');
    return [{ label: 'Panels', value: formatCount(panels.length) }];
  }
  if (command === 'LIST_VARIABLES') {
    const variables = recordsField(data ?? {}, 'variables');
    return [
      { label: 'Variables', value: formatCount(variables.length) },
      { label: 'Scope', value: formatSummaryRecordValue(data, 'scopePath') },
    ];
  }
  if (command === 'GET_DASHBOARD_INFO') {
    return [{ label: 'Dashboard', value: formatSummaryRecordValue(data, 'uid') }];
  }
  return [];
}

function formatElementReference(record: Record<string, unknown> | undefined) {
  const name = stringField(record, 'name');
  return name ? <code>{name}</code> : undefined;
}

function formatSummaryRecordValue(record: Record<string, unknown> | undefined, key: string) {
  const value = record ? stringOrNumberField(record, key) : undefined;
  return value ? <code>{value}</code> : undefined;
}

function LiveDashboardMutationChangesTable({ changes }: { changes: LiveDashboardMutationChange[] }) {
  const styles = useStyles2(getToolStyles);
  return (
    <details className={styles.collapsible}>
      <summary>Changes</summary>
      <div className={styles.tableWrap}>
        <table className={styles.dataTable}>
          <thead>
            <tr>
              <th>Path</th>
              <th>Previous</th>
              <th>New</th>
            </tr>
          </thead>
          <tbody>
            {changes.slice(0, 20).map((change, index) => (
              <tr key={`${change.path ?? 'change'}:${index}`}>
                <td className={styles.monospace}>{change.path ?? '-'}</td>
                <td>{formatShortValue(change.previousValue)}</td>
                <td>{formatShortValue(change.newValue)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {changes.length > 20 && (
        <div className={styles.resultSummary}>{formatCount(changes.length - 20)} more changes</div>
      )}
    </details>
  );
}

// Renderers for the session filesystem tools (read/write/edit/bash) in src/pages/Chat/workspace/tools.ts.
function asWorkspaceToolResult(
  toolName: string | undefined,
  details: unknown,
  content: unknown
): React.ReactNode | undefined {
  if (!toolName || !WORKSPACE_TOOL_NAMES.has(toolName) || !isRecord(details)) {
    return undefined;
  }

  const text = extractToolText(content) ?? '';
  switch (toolName) {
    case 'read':
      return stringField(details, 'type') === 'directory' ? (
        <WorkspaceDirectoryResultView result={workspaceDirectoryResultFromRecord(details, text)} />
      ) : (
        <WorkspaceReadResultView result={workspaceReadResultFromRecord(details, text)} />
      );
    case 'write':
    case 'edit':
      return <WorkspaceMutationResultView result={workspaceMutationResultFromRecord(details, text)} />;
    case 'bash':
      return <WorkspaceBashResultView result={workspaceBashResultFromRecord(details)} />;
    default:
      return undefined;
  }
}

const WORKSPACE_TOOL_NAMES = new Set(['read', 'write', 'edit', 'bash']);

// Dashboard files under this prefix are local working copies until a plan is approved and applied.
const WORKSPACE_STAGED_RESOURCE_PREFIX = '/grafana/dashboards/';

function isWorkspaceStagedPath(path: string | undefined) {
  return Boolean(path?.startsWith(WORKSPACE_STAGED_RESOURCE_PREFIX));
}

type WorkspaceDirectoryResult = {
  path: string;
  entries: string[];
};

function WorkspaceDirectoryResultView({ result }: { result: WorkspaceDirectoryResult }) {
  const styles = useStyles2(getToolStyles);
  return (
    <details className={styles.compactResult}>
      <summary className={styles.compactResultSummary}>
        <Icon aria-hidden className={styles.toolTypeIcon} name="folder-open" />
        <span className={styles.compactResultText}>
          {summaryLine([`${result.path}/`, formatLabeledCount(result.entries.length, 'entry', 'entries')])}
        </span>
      </summary>
      <div className={styles.compactResultBody}>
        <div className={styles.scrollList}>
          {result.entries.length === 0 ? (
            <span className={styles.muted}>Empty directory</span>
          ) : (
            result.entries.map((entry) => (
              <div className={styles.listItem} key={entry}>
                {entry}
              </div>
            ))
          )}
        </div>
      </div>
    </details>
  );
}

function workspaceDirectoryResultFromRecord(record: Record<string, unknown>, text: string): WorkspaceDirectoryResult {
  // The text is "/path/" followed by one entry per line; empty directories render as "/path/ (empty directory)".
  const [, ...entries] = text.split('\n');
  return {
    path: (stringField(record, 'path') ?? '-').replace(/\/$/, ''),
    entries: entries.filter((entry) => entry.trim() !== ''),
  };
}

type WorkspaceReadResult = {
  path: string;
  revision?: string;
  totalLines?: number;
  startLine?: number;
  endLine?: number;
  lines: CodeLine[];
  notes: string[];
};

function WorkspaceReadResultView({ result }: { result: WorkspaceReadResult }) {
  const styles = useStyles2(getToolStyles);
  const summary = summaryLine([
    result.path,
    workspaceReadLineSummary(result),
    result.revision ? `rev ${result.revision}` : undefined,
  ]);
  return (
    <details className={styles.compactResult}>
      <summary className={styles.compactResultSummary}>
        <Icon aria-hidden className={styles.toolTypeIcon} name="file-alt" />
        <span className={styles.compactResultText}>{summary}</span>
      </summary>
      <div className={styles.compactResultBody}>
        {result.lines.length > 0 && (
          <CodeViewer
            lines={result.lines}
            language={/\.(jsonnet|libsonnet)$/.test(result.path) ? 'jsonnet' : 'plain'}
          />
        )}
        {result.notes.map((note) => (
          <div className={styles.muted} key={note}>
            {note}
          </div>
        ))}
      </div>
    </details>
  );
}

function workspaceReadLineSummary(result: WorkspaceReadResult) {
  if (result.totalLines === 0) {
    return 'empty file';
  }
  if (result.startLine !== undefined && result.endLine !== undefined && result.endLine >= result.startLine) {
    return `lines ${result.startLine}-${result.endLine} of ${result.totalLines ?? result.endLine}`;
  }
  return result.totalLines !== undefined ? formatLabeledCount(result.totalLines, 'line', 'lines') : undefined;
}

function workspaceReadResultFromRecord(record: Record<string, unknown>, text: string): WorkspaceReadResult {
  // Skip the header line, then split numbered "N\t<text>" lines from footer notes such as continuation hints.
  const [, ...body] = text.split('\n');
  const lines: CodeLine[] = [];
  const notes: string[] = [];
  for (const line of body) {
    const match = /^\s*(\d+)\t(.*)$/.exec(line);
    if (match) {
      lines.push({ line: Number(match[1]), text: match[2] });
    } else if (line.trim()) {
      notes.push(line.trim());
    }
  }
  return {
    path: stringField(record, 'path') ?? '-',
    revision: stringField(record, 'revision'),
    totalLines: numberField(record, 'totalLines'),
    startLine: numberField(record, 'startLine'),
    endLine: numberField(record, 'endLine'),
    lines,
    notes,
  };
}

type WorkspaceMutationResult = {
  path?: string;
  summary: string;
  diff?: string;
  staged: boolean;
};

function WorkspaceMutationResultView({ result }: { result: WorkspaceMutationResult }) {
  const styles = useStyles2(getToolStyles);
  return (
    <div className={styles.structuredResult}>
      {result.diff ? (
        <DiffViewer defaultOpen diff={result.diff} />
      ) : (
        <div className={styles.resultSummary}>{result.summary}</div>
      )}
      {result.staged && <WorkspaceStagedNotice />}
    </div>
  );
}

function workspaceMutationResultFromRecord(record: Record<string, unknown>, text: string): WorkspaceMutationResult {
  const path = stringField(record, 'path');
  const diff = stringField(record, 'diff');
  const fallback = summaryLine([stringField(record, 'change') ?? 'edited', path]);
  return {
    path,
    summary: text.split('\n')[0]?.trim() || fallback,
    // Writes that leave a file unchanged still produce an empty patch without hunks.
    diff: diff && /^@@/m.test(diff) ? diff : undefined,
    staged: isWorkspaceStagedPath(path),
  };
}

function WorkspaceStagedNotice() {
  const styles = useStyles2(getToolStyles);
  return (
    <div className={styles.notice}>
      <strong>staged</strong>
      <span>Local working copy only. Grafana is unchanged until the change is planned and applied.</span>
    </div>
  );
}

type WorkspaceBashResult = {
  command: string;
  cwd?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  timedOut?: boolean;
  durationMs?: number;
  changes: WorkspaceFileChange[];
  discardedChanges?: string;
};

type WorkspaceFileChange = {
  path: string;
  change: string;
  bytes?: number;
  revision?: string;
};

function WorkspaceBashResultView({ result }: { result: WorkspaceBashResult }) {
  const styles = useStyles2(getToolStyles);
  const status = result.timedOut ? 'timed out' : result.exitCode === 0 ? 'completed' : 'failed';
  return (
    <div className={styles.structuredResult}>
      <ResultMetaGrid
        items={[
          { label: 'Status', value: <WorkspaceStatusBadge status={status} /> },
          { label: 'Exit code', value: result.exitCode === undefined ? undefined : String(result.exitCode) },
          { label: 'Duration', value: formatDurationMs(result.durationMs) },
          { label: 'CWD', value: result.cwd ? <code>{result.cwd}</code> : undefined },
        ]}
      />
      <pre className={styles.queryBlock}>{result.command}</pre>
      {result.discardedChanges && (
        <div className={styles.notice}>
          <strong>discarded</strong>
          <span>File changes from this command were discarded: {result.discardedChanges}</span>
        </div>
      )}
      {result.stdout && (
        <details className={styles.collapsible} open>
          <summary>stdout{result.stdoutTruncated ? ' | truncated' : ''}</summary>
          <pre className={styles.queryBlock}>{result.stdout}</pre>
        </details>
      )}
      {result.stderr && (
        <details className={styles.collapsible} open={status !== 'completed'}>
          <summary>stderr{result.stderrTruncated ? ' | truncated' : ''}</summary>
          <pre className={styles.queryBlock}>{result.stderr}</pre>
        </details>
      )}
      {result.changes.length > 0 && <WorkspaceFileChangesTable changes={result.changes} />}
    </div>
  );
}

function workspaceBashResultFromRecord(record: Record<string, unknown>): WorkspaceBashResult {
  return {
    command: stringField(record, 'command') ?? '',
    cwd: stringField(record, 'cwd'),
    exitCode: numberField(record, 'exitCode'),
    stdout: stringField(record, 'stdout'),
    stderr: stringField(record, 'stderr'),
    stdoutTruncated: booleanField(record, 'stdoutTruncated'),
    stderrTruncated: booleanField(record, 'stderrTruncated'),
    timedOut: booleanField(record, 'timedOut'),
    durationMs: numberField(record, 'durationMs'),
    changes: recordsField(record, 'changes').map((change) => ({
      path: stringField(change, 'path') ?? '-',
      change: stringField(change, 'change') ?? 'modified',
      bytes: numberField(change, 'bytes'),
      revision: stringField(change, 'revision'),
    })),
    discardedChanges: stringField(record, 'discardedChanges'),
  };
}

function WorkspaceFileChangesTable({ changes }: { changes: WorkspaceFileChange[] }) {
  const styles = useStyles2(getToolStyles);
  return (
    <div className={styles.tableWrap}>
      <table className={cx(styles.dataTable, styles.wideTable)}>
        <thead>
          <tr>
            <th>File</th>
            <th>Change</th>
            <th>Size</th>
            <th>Revision</th>
          </tr>
        </thead>
        <tbody>
          {changes.map((change, index) => (
            <tr key={`${change.path}:${index}`}>
              <td className={styles.monospace}>{change.path}</td>
              <td>
                {change.change}
                {isWorkspaceStagedPath(change.path) && (
                  <>
                    {' '}
                    <Badge text="staged" color="blue" />
                  </>
                )}
              </td>
              <td>{formatBytes(change.bytes) ?? <span className={styles.muted}>-</span>}</td>
              <td className={styles.monospace}>{change.revision ?? <span className={styles.muted}>-</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WorkspaceStatusBadge({ status }: { status: string }) {
  const color: BadgeColor =
    status === 'completed' ? 'green' : status === 'failed' || status === 'timed out' ? 'red' : 'blue';
  return <Badge text={status} color={color} />;
}

function formatDurationMs(value: number | undefined) {
  if (value === undefined) {
    return undefined;
  }
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`;
}

type CodeLine = {
  line: number;
  text: string;
};

function ArtifactResultView({ artifact, preview }: { artifact: ArtifactRef; preview?: ArtifactPreview }) {
  const styles = useStyles2(getToolStyles);

  return (
    <div className={styles.artifactCard} data-testid="artifact-result">
      <div className={styles.artifactHeader}>
        <Icon aria-hidden className={styles.toolTypeIcon} name={artifactIcon(artifact.kind)} />
        <div className={styles.artifactTitleGroup}>
          <div className={styles.artifactTitle}>{artifact.title}</div>
          <div className={styles.resultSummary}>{artifact.summary}</div>
        </div>
        <Badge text={artifact.kind} color="blue" />
      </div>
      <ResultMetaGrid
        items={[
          { label: 'ID', value: <code>{artifact.id}</code> },
          { label: 'Tool', value: artifact.toolName },
          { label: 'Size', value: formatBytes(artifact.bytes) },
          { label: 'Read', value: <code>{`read_artifact {"id":"${artifact.id}"}`}</code> },
        ]}
      />
      {preview?.type === 'text' && <ArtifactTextPreview preview={preview} />}
      {preview?.type === 'image' && (
        <img
          alt={artifact.title}
          className={styles.artifactImagePreview}
          src={`data:${preview.mimeType};base64,${preview.data}`}
        />
      )}
    </div>
  );
}

function ArtifactTextPreview({ preview }: { preview: Extract<ArtifactPreview, { type: 'text' }> }) {
  const styles = useStyles2(getToolStyles);
  return (
    <details className={cx(styles.collapsible, styles.artifactTextPreview)} open>
      <summary>Preview{preview.truncated ? ' | truncated' : ''}</summary>
      <ContentBlocks content={[{ type: 'text', text: preview.text }]} />
    </details>
  );
}

function artifactIcon(kind: ArtifactRef['kind']): IconName {
  switch (kind) {
    case 'dashboard':
      return 'dashboard';
    case 'image':
      return 'camera';
    case 'table':
      return 'table';
    case 'text':
      return 'file-alt';
    case 'json':
      return 'brackets-curly';
  }
}

function ResultMetaGrid({ items }: { items: Array<{ label: string; value?: React.ReactNode }> }) {
  const styles = useStyles2(getToolStyles);
  const visible = items.filter((item) => item.value !== undefined && item.value !== '');
  if (visible.length === 0) {
    return null;
  }

  return (
    <div className={styles.metaGrid}>
      {visible.map((item) => (
        <div className={styles.metaItem} key={item.label}>
          <span className={styles.metaLabel}>{item.label}</span>
          <span className={styles.metaValue}>{item.value}</span>
        </div>
      ))}
    </div>
  );
}

function StringChips({ values }: { values: string[] }) {
  const styles = useStyles2(getToolStyles);
  if (values.length === 0) {
    return null;
  }

  return (
    <div className={styles.chipList}>
      {values.map((value) => (
        <span className={styles.chip} key={value}>
          {value}
        </span>
      ))}
    </div>
  );
}

function LabelPills({ labels, limit = 12 }: { labels: Record<string, string>; limit?: number }) {
  const styles = useStyles2(getToolStyles);
  const entries = Object.entries(labels).filter(([, value]) => value !== undefined && value !== '');
  if (entries.length === 0) {
    return <span className={styles.muted}>-</span>;
  }

  const visible = entries.slice(0, limit);
  return (
    <div className={styles.chipList}>
      {visible.map(([key, value]) => (
        <span className={styles.chip} key={`${key}:${value}`}>
          <span className={styles.labelKey}>{key}</span>={value}
        </span>
      ))}
      {entries.length > visible.length && <span className={styles.muted}>+{entries.length - visible.length}</span>}
    </div>
  );
}

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  const styles = useStyles2(getToolStyles);
  const safeHref = safeLinkHref(href);
  if (!safeHref) {
    return <>{children}</>;
  }
  return (
    <a className={styles.externalLink} href={safeHref} rel="noreferrer" target="_blank">
      {children}
    </a>
  );
}

// All current callers pass server-generated URLs, but nothing enforces that
// invariant for future tool results, so reject anything that is not http(s)
// or an in-app absolute path.
function safeLinkHref(href: string): string | undefined {
  const trimmed = href.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
    return trimmed;
  }
  return undefined;
}

function CodeViewer({ lines, language = 'jsonnet' }: { lines: CodeLine[]; language?: 'jsonnet' | 'plain' }) {
  const styles = useStyles2(getToolStyles);
  // Result views re-parse tool text on every render, so key highlighting on the line content rather than identity.
  const contentKey = lines.map((line) => line.text).join('\n');
  const highlighted = useMemo(
    () => (language === 'jsonnet' && shouldHighlightJsonnet(lines) ? highlightJsonnetLines(lines) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [language, contentKey]
  );
  return (
    <pre className={styles.codeViewer}>
      {lines.map((line, index) => (
        <div className={styles.codeLine} key={line.line}>
          <span className={styles.lineNumber}>{line.line}</span>
          <span className={styles.codeText}>
            <CodeLineText text={line.text} tokens={highlighted?.[index]} />
          </span>
        </div>
      ))}
    </pre>
  );
}

function CodeLineText({ text, tokens }: { text: string; tokens?: CodeToken[] }) {
  const styles = useStyles2(getToolStyles);
  if (!tokens) {
    return <>{text || ' '}</>;
  }

  return (
    <>
      {tokens.length > 0
        ? tokens.map((token, index) => (
            <span className={codeTokenClass(styles, token.kind)} key={`${index}:${token.text}`}>
              {token.text}
            </span>
          ))
        : ' '}
    </>
  );
}

function codeTokenClass(styles: ReturnType<typeof getToolStyles>, kind: CodeTokenKind | undefined) {
  switch (kind) {
    case 'comment':
      return styles.syntaxComment;
    case 'keyword':
      return styles.syntaxKeyword;
    case 'string':
      return styles.syntaxString;
    case 'number':
      return styles.syntaxNumber;
    case 'builtin':
      return styles.syntaxBuiltin;
    case 'key':
      return styles.syntaxKey;
    case 'operator':
      return styles.syntaxOperator;
    case 'punctuation':
      return styles.syntaxPunctuation;
    default:
      return undefined;
  }
}

function DiffViewer({ diff, defaultOpen }: { diff: string; defaultOpen?: boolean }) {
  const styles = useStyles2(getToolStyles);
  const { lines, metadataFlags, summary } = useMemo(() => {
    const optimizedLines = optimizedUnifiedDiffLines(diff);
    const flags = diffMetadataFlags(optimizedLines);
    return { lines: optimizedLines, metadataFlags: flags, summary: diffSummary(optimizedLines, flags) };
  }, [diff]);
  return (
    <details className={styles.compactResult} open={defaultOpen}>
      <summary className={styles.compactResultSummary}>
        <Icon aria-hidden className={styles.toolTypeIcon} name="file-alt" />
        <span className={styles.compactResultText}>{summary}</span>
      </summary>
      <div className={styles.compactResultBody}>
        <pre className={styles.diffViewer}>
          {lines.map((line, index) => {
            const isMeta = metadataFlags[index];
            return (
              <div
                className={cx(
                  styles.diffLine,
                  isMeta && styles.diffMeta,
                  !isMeta && line.startsWith('+') && styles.diffAdd,
                  !isMeta && line.startsWith('-') && styles.diffDelete
                )}
                key={`${index}:${line}`}
              >
                {line || ' '}
              </div>
            );
          })}
        </pre>
      </div>
    </details>
  );
}

function diffSummary(lines: string[], metadataFlags: boolean[]) {
  const added = lines.filter((line, index) => !metadataFlags[index] && line.startsWith('+')).length;
  const removed = lines.filter((line, index) => !metadataFlags[index] && line.startsWith('-')).length;
  const hunks = lines.filter((line) => line.startsWith('@@')).length;
  return summaryLine([
    'Diff',
    hunks > 0 ? formatLabeledCount(hunks, 'hunk', 'hunks') : undefined,
    added > 0 || removed > 0 ? `+${formatCount(added)} / -${formatCount(removed)}` : undefined,
  ]);
}

// `---`/`+++` are file headers only in the preamble before the first hunk;
// inside a hunk they are removed/added lines whose content starts with dashes
// or pluses and must be colored and counted as changes.
function diffMetadataFlags(lines: string[]): boolean[] {
  let preamble = true;
  return lines.map((line) => {
    if (line.startsWith('@@')) {
      preamble = false;
      return true;
    }
    if (line.startsWith('Index:') || line.startsWith('diff ')) {
      preamble = true;
      return true;
    }
    return preamble && (line.startsWith('---') || line.startsWith('+++'));
  });
}

function optimizedUnifiedDiffLines(diff: string) {
  const lines = diff.split('\n');
  const optimized: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.startsWith('@@')) {
      optimized.push(line);
      continue;
    }

    const hunkLines: string[] = [];
    let nextIndex = index + 1;
    while (nextIndex < lines.length && !isDiffBoundaryLine(lines[nextIndex])) {
      hunkLines.push(lines[nextIndex]);
      nextIndex += 1;
    }

    optimized.push(...optimizeFullReplacementHunk(line, hunkLines));
    index = nextIndex - 1;
  }

  return optimized;
}

function optimizeFullReplacementHunk(header: string, hunkLines: string[]) {
  const normalizedHunkLines = trimTrailingEmptyDiffLine(hunkLines);
  if (!shouldRediffHunk(normalizedHunkLines)) {
    return [header, ...hunkLines];
  }

  const oldLines = normalizedHunkLines.filter((line) => line.startsWith('-')).map((line) => line.slice(1));
  const newLines = normalizedHunkLines.filter((line) => line.startsWith('+')).map((line) => line.slice(1));
  const range = parseUnifiedDiffHunkHeader(header);
  const patch = structuredPatch('', '', diffLinesToText(oldLines), diffLinesToText(newLines), '', '', {
    context: 3,
  });
  // Without a parseable original header the true positions are unknown; keep
  // the original header instead of asserting fabricated line numbers.
  const optimizedHunkLines = patch.hunks.flatMap((hunk) => [
    range
      ? `@@ -${formatUnifiedDiffRange(range.oldStart + hunk.oldStart - 1, hunk.oldLines)} +${formatUnifiedDiffRange(
          range.newStart + hunk.newStart - 1,
          hunk.newLines
        )} @@`
      : header,
    ...hunk.lines,
  ]);

  return optimizedHunkLines.length > 0 && optimizedHunkLines.length < normalizedHunkLines.length + 1
    ? optimizedHunkLines
    : [header, ...hunkLines];
}

function trimTrailingEmptyDiffLine(lines: string[]) {
  return lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
}

function shouldRediffHunk(hunkLines: string[]) {
  if (hunkLines.length < 6) {
    return false;
  }

  const hasRemoved = hunkLines.some((line) => line.startsWith('-'));
  const hasAdded = hunkLines.some((line) => line.startsWith('+'));
  const hasContext = hunkLines.some((line) => line.startsWith(' '));
  const hasUnsupportedLine = hunkLines.some((line) => !line.startsWith('-') && !line.startsWith('+'));
  return hasRemoved && hasAdded && !hasContext && !hasUnsupportedLine;
}

function parseUnifiedDiffHunkHeader(header: string) {
  const match = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?/.exec(header);
  if (!match) {
    return undefined;
  }

  return {
    oldStart: Number(match[1]),
    newStart: Number(match[2]),
  };
}

function diffLinesToText(lines: string[]) {
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

function formatUnifiedDiffRange(start: number, lines: number) {
  return lines === 1 ? String(start) : `${start},${lines}`;
}

// `---`/`+++` are intentionally not boundaries: inside a hunk they are
// removed/added lines whose content starts with dashes or pluses.
function isDiffBoundaryLine(line: string) {
  return line.startsWith('@@') || line.startsWith('Index:') || line.startsWith('diff ');
}

function asArtifactResult(details: unknown): { ref: ArtifactRef; preview?: ArtifactPreview } | undefined {
  if (!isRecord(details)) {
    return undefined;
  }
  const ref = asArtifactRef(recordField(details, 'artifactRef'));
  if (!ref) {
    return undefined;
  }
  return {
    ref,
    preview: asArtifactPreview(recordField(details, 'artifactPreview')),
  };
}

function asArtifactRef(value: unknown): ArtifactRef | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = stringField(value, 'id');
  const kind = stringField(value, 'kind');
  const title = stringField(value, 'title');
  const toolName = stringField(value, 'toolName');
  const createdAt = stringField(value, 'createdAt');
  const summary = stringField(value, 'summary');
  const bytes = numberField(value, 'bytes');
  if (
    !id ||
    !title ||
    !toolName ||
    !createdAt ||
    !summary ||
    bytes === undefined ||
    (kind !== 'json' && kind !== 'table' && kind !== 'dashboard' && kind !== 'image' && kind !== 'text')
  ) {
    return undefined;
  }
  return {
    id,
    kind,
    title,
    toolName,
    createdAt,
    bytes,
    summary,
  };
}

function asArtifactPreview(value: unknown): ArtifactPreview | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value.type === 'text' && typeof value.text === 'string') {
    return {
      type: 'text',
      text: value.text,
      truncated: value.truncated === true,
    };
  }
  if (value.type === 'json') {
    return {
      type: 'json',
      data: value.data,
      truncated: value.truncated === true,
    };
  }
  if (value.type === 'image' && typeof value.mimeType === 'string' && typeof value.data === 'string') {
    return {
      type: 'image',
      mimeType: value.mimeType,
      data: value.data,
    };
  }
  return undefined;
}

function isArtifactReadResult(toolName: string | undefined, details: unknown) {
  return toolName === 'read_artifact' || (isRecord(details) && details.artifactRead === true);
}

function asScreenshotResult(toolName: string | undefined, details: unknown): ScreenshotResult | undefined {
  if (toolName !== 'screenshot_dashboard' && toolName !== 'grafana_screenshot') {
    return undefined;
  }
  if (!isRecord(details)) {
    return undefined;
  }

  return {
    uid: stringField(details, 'uid'),
    panelId: numberField(details, 'panelId'),
    width: numberField(details, 'width'),
    height: numberField(details, 'height'),
  };
}

const LIVE_DASHBOARD_TOOL_NAMES = new Set([
  'list_live_dashboard_panels',
  'get_live_dashboard_layout',
  'get_live_dashboard_info',
  'list_live_dashboard_variables',
  'get_live_dashboard_mutation_schema',
  'rename_live_dashboard_panel',
  'update_live_dashboard_panel_query',
  'update_live_dashboard_panel_queries',
  'apply_live_dashboard_prometheus_label_filter',
  'add_live_dashboard_panel',
  'move_or_resize_live_dashboard_panel',
  'update_live_dashboard_settings',
  'add_live_dashboard_variable',
  'update_live_dashboard_variable',
  'apply_live_dashboard_mutation',
]);

function asLiveDashboardMutationSchemaResult(
  toolName: string | undefined,
  details: unknown,
  content: unknown
): LiveDashboardMutationSchemaResult | undefined {
  if (toolName !== 'get_live_dashboard_mutation_schema') {
    return undefined;
  }

  const detailRecord = isRecord(details) ? details : {};
  const contentRecord = parseJsonRecord(content);
  const availableCommands =
    stringArrayField(detailRecord, 'availableCommands') ??
    stringArrayField(contentRecord ?? {}, 'availableCommands') ??
    [];

  return {
    command: stringField(detailRecord, 'command') ?? stringField(contentRecord, 'command'),
    available: booleanField(contentRecord, 'available'),
    readOnly: booleanField(contentRecord, 'readOnly'),
    availableCommands,
    guidance: contentRecord?.guidance,
  };
}

function asLiveDashboardMutationResult(
  toolName: string | undefined,
  details: unknown
): LiveDashboardMutationResult | undefined {
  if (!toolName || !LIVE_DASHBOARD_TOOL_NAMES.has(toolName) || toolName === 'get_live_dashboard_mutation_schema') {
    return undefined;
  }
  if (!isRecord(details)) {
    return undefined;
  }

  const command = stringField(details, 'command');
  const success = booleanField(details, 'success');
  if (!command || success === undefined) {
    return undefined;
  }

  const visualVerification = recordField(details, 'visualVerification');
  return {
    command,
    success,
    error: stringField(details, 'error'),
    warnings: stringArrayField(details, 'warnings') ?? [],
    changes: recordsField(details, 'changes').map((change) => ({
      path: stringField(change, 'path'),
      previousValue: change.previousValue,
      newValue: change.newValue,
    })),
    payload: details.payload,
    data: details.data,
    availableCommands: stringArrayField(details, 'availableCommands') ?? [],
    visualVerification: visualVerification
      ? {
          status: stringField(visualVerification, 'status'),
          error: stringField(visualVerification, 'error'),
          details: visualVerification.details,
        }
      : undefined,
  };
}

function getSingleTextContent(content: unknown) {
  if (!Array.isArray(content) || content.length !== 1) {
    return undefined;
  }

  const block = content[0];
  return isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : undefined;
}

function parseJsonRecord(content: unknown): Record<string, unknown> | undefined {
  const parsed = parseSingleJsonContent(content);
  return isRecord(parsed) ? parsed : undefined;
}

function parseToolJsonRecord(content: unknown, details: unknown): Record<string, unknown> | undefined {
  return parseJsonRecord(content) ?? artifactPreviewJsonRecord(details);
}

function artifactPreviewJsonRecord(details: unknown): Record<string, unknown> | undefined {
  const data = artifactPreviewData(details);
  return isRecord(data) ? data : undefined;
}

function artifactPreviewData(details: unknown): unknown {
  if (!isRecord(details)) {
    return undefined;
  }

  const preview = recordField(details, 'artifactPreview');
  return preview?.data;
}

function parseSingleJsonContent(content: unknown): unknown {
  const contentText = getSingleTextContent(content);
  if (!contentText) {
    return undefined;
  }

  try {
    return JSON.parse(contentText);
  } catch {
    return undefined;
  }
}

function recordField(record: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  return record && isRecord(record[key]) ? record[key] : undefined;
}

function recordsField(record: Record<string, unknown>, key: string): Array<Record<string, unknown>> {
  const value = record[key];
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
}

function stringOrNumberField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value === 'string') {
    return value;
  }
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined;
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanField(record: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const value = record?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

function stringArrayField(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : undefined;
}

function stringRecord(record: Record<string, unknown> | undefined): Record<string, string> {
  if (!record) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(record)
      .filter(([, value]) => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
      .map(([key, value]) => [key, String(value)])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function hasDetails(details: unknown) {
  return Boolean(details && typeof details === 'object' && Object.keys(details as Record<string, unknown>).length > 0);
}

function formatCount(value: number) {
  if (value < 1000) {
    return String(value);
  }
  if (value < 1000000) {
    return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)}k`;
  }
  return `${(value / 1000000).toFixed(1)}M`;
}

function formatLabeledCount(value: number, singular: string, plural: string) {
  return `${formatCount(value)} ${value === 1 ? singular : plural}`;
}

function formatBoolean(value: boolean | undefined) {
  return value === undefined ? undefined : value ? 'yes' : 'no';
}

function formatShortValue(value: unknown) {
  if (value === undefined || value === null) {
    return '-';
  }
  if (typeof value === 'string') {
    return truncateInline(value, 96);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `${formatCount(value.length)} items`;
  }
  if (isRecord(value)) {
    const kind = stringField(value, 'kind') ?? stringField(value, 'type');
    return kind ? truncateInline(kind, 96) : truncateInline(formatJson(value), 96);
  }
  return truncateInline(String(value), 96);
}

function truncateInline(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

function formatBytes(value: number | undefined) {
  if (value === undefined) {
    return undefined;
  }
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KiB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function completeOpenMarkdownFences(text: string) {
  const fenceCount = text.split('\n').filter((line) => line.trimStart().startsWith('```')).length;
  return fenceCount % 2 === 1 ? `${text}\n\`\`\`` : text;
}

const blink = keyframes({
  '0%, 45%': { opacity: 1 },
  '46%, 100%': { opacity: 0 },
});

const getToolStyles = (theme: GrafanaTheme2) => ({
  toolFrame: css({
    display: 'grid',
    gap: theme.spacing(1),
    minWidth: 0,
    maxWidth: '100%',
  }),
  toolFrameError: css({
    color: theme.colors.error.text,
  }),
  markdown: css({
    whiteSpace: 'normal',
    overflowWrap: 'anywhere',
    '& > div > :first-child': {
      marginTop: 0,
    },
    '& > div > :last-child': {
      marginBottom: 0,
    },
    '& p': {
      margin: `0 0 ${theme.spacing(1)}`,
    },
    '& ul, & ol': {
      margin: `0 0 ${theme.spacing(1)} ${theme.spacing(2)}`,
      paddingLeft: theme.spacing(2),
    },
    '& li': {
      margin: `${theme.spacing(0.25)} 0`,
    },
    '& code': {
      fontFamily: theme.typography.fontFamilyMonospace,
      fontSize: theme.typography.bodySmall.fontSize,
      whiteSpace: 'pre-wrap',
      overflowWrap: 'anywhere',
    },
    '& pre': {
      whiteSpace: 'pre-wrap',
      overflow: 'auto',
      overflowWrap: 'anywhere',
      padding: theme.spacing(1),
      border: `1px solid ${theme.colors.border.weak}`,
      borderRadius: theme.shape.radius.default,
      background: theme.colors.background.primary,
    },
    '& blockquote': {
      margin: `0 0 ${theme.spacing(1)}`,
      paddingLeft: theme.spacing(1),
      borderLeft: `3px solid ${theme.colors.border.medium}`,
      color: theme.colors.text.secondary,
    },
    '& table': {
      display: 'block',
      maxWidth: '100%',
      margin: `${theme.spacing(0.5)} 0 ${theme.spacing(1)}`,
      overflowX: 'auto',
      borderCollapse: 'collapse',
    },
    '& table + p, & table + ul, & table + ol': {
      marginTop: theme.spacing(1),
    },
    '& th, & td': {
      padding: theme.spacing(0.5, 1),
      border: `1px solid ${theme.colors.border.weak}`,
    },
  }),
  streamingCursor: css({
    display: 'inline-block',
    width: 8,
    height: '1em',
    marginLeft: 2,
    verticalAlign: '-0.15em',
    background: theme.colors.primary.text,
    animation: `${blink} 1s steps(1, end) infinite`,
  }),
  toolHeader: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    minWidth: 0,
    '& strong': {
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    },
  }),
  toolHeaderCompact: css({
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  toolTypeIcon: css({
    color: theme.colors.text.secondary,
    flex: '0 0 auto',
  }),
  toolCall: css({
    display: 'grid',
    gap: theme.spacing(1),
    padding: theme.spacing(1),
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.primary,
  }),
  toolCallCollapsed: css({
    display: 'grid',
    minWidth: 0,
    maxWidth: '100%',
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.primary,
    '&[open]': {
      gap: theme.spacing(1),
      paddingBottom: theme.spacing(1),
    },
  }),
  toolCallCollapsedSummary: css({
    display: 'grid',
    gridTemplateColumns: 'auto auto auto minmax(0, 1fr)',
    alignItems: 'center',
    gap: theme.spacing(1),
    minWidth: 0,
    padding: theme.spacing(0.75, 1),
    cursor: 'pointer',
    listStyle: 'none',
    '&::marker': {
      content: '""',
    },
    '&::-webkit-details-marker': {
      display: 'none',
    },
    '&:focus-visible': {
      outline: `2px solid ${theme.colors.primary.border}`,
      outlineOffset: theme.spacing(0.5),
      borderRadius: theme.shape.radius.default,
    },
    '& strong': {
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    },
  }),
  toolCallCollapsedBody: css({
    display: 'grid',
    gap: theme.spacing(1),
    minWidth: 0,
    padding: theme.spacing(0, 1),
  }),
  toolCallSummaryText: css({
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  toolCallHeader: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
  }),
  toolCallJson: css({
    margin: 0,
    overflow: 'auto',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  }),
  structuredResult: css({
    display: 'grid',
    gap: theme.spacing(1),
    minWidth: 0,
    maxWidth: '100%',
  }),
  artifactCard: css({
    display: 'grid',
    gap: theme.spacing(1),
    minWidth: 0,
    maxWidth: '100%',
    padding: theme.spacing(1),
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.secondary,
  }),
  artifactTextPreview: css({
    '& h1, & h2, & h3, & h4, & h5, & h6': {
      margin: `${theme.spacing(1)} 0 ${theme.spacing(0.5)}`,
      lineHeight: 1.35,
      fontWeight: theme.typography.fontWeightMedium,
    },
    '& h1': {
      fontSize: theme.typography.h4.fontSize,
    },
    '& h2': {
      fontSize: theme.typography.h5.fontSize,
    },
    '& h3, & h4, & h5, & h6': {
      fontSize: theme.typography.bodySmall.fontSize,
    },
  }),
  artifactHeader: css({
    display: 'grid',
    gridTemplateColumns: 'auto minmax(0, 1fr) auto',
    alignItems: 'center',
    gap: theme.spacing(1),
    minWidth: 0,
  }),
  artifactTitleGroup: css({
    display: 'grid',
    gap: theme.spacing(0.25),
    minWidth: 0,
  }),
  artifactTitle: css({
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontWeight: theme.typography.fontWeightMedium,
  }),
  artifactImagePreview: css({
    display: 'block',
    maxWidth: '100%',
    maxHeight: 420,
    objectFit: 'contain',
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.primary,
  }),
  errorCard: css({
    display: 'grid',
    gap: theme.spacing(0.75),
    padding: theme.spacing(1),
    border: `1px solid ${theme.colors.error.border}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.error.transparent,
  }),
  errorTitle: css({
    color: theme.colors.error.text,
    fontWeight: theme.typography.fontWeightMedium,
  }),
  errorMessage: css({
    color: theme.colors.text.primary,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  }),
  resultSummary: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  jsonSummary: css({
    display: 'grid',
    gap: theme.spacing(1),
    minWidth: 0,
  }),
  compactResult: css({
    display: 'grid',
    minWidth: 0,
    maxWidth: '100%',
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.primary,
    '&[open]': {
      gap: theme.spacing(1),
      paddingBottom: theme.spacing(1),
    },
  }),
  compactResultSummary: css({
    display: 'grid',
    gridTemplateColumns: 'auto minmax(0, 1fr)',
    alignItems: 'center',
    gap: theme.spacing(1),
    minWidth: 0,
    padding: theme.spacing(0.75, 1),
    cursor: 'pointer',
    listStyle: 'none',
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
    '&::marker': {
      content: '""',
    },
    '&::-webkit-details-marker': {
      display: 'none',
    },
    '&:focus-visible': {
      outline: `2px solid ${theme.colors.primary.border}`,
      outlineOffset: theme.spacing(0.5),
      borderRadius: theme.shape.radius.default,
    },
  }),
  compactResultText: css({
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  }),
  compactResultBody: css({
    display: 'grid',
    gap: theme.spacing(1),
    minWidth: 0,
    padding: theme.spacing(0, 1),
  }),
  prometheusQueryPlanList: css({
    display: 'grid',
    gap: theme.spacing(0.75),
    minWidth: 0,
  }),
  prometheusQueryPlanRow: css({
    display: 'grid',
    gridTemplateColumns: 'auto minmax(0, 1fr)',
    gridTemplateAreas: '"index meta" "index expression"',
    alignItems: 'center',
    columnGap: theme.spacing(1),
    rowGap: theme.spacing(0.25),
    minWidth: 0,
    padding: theme.spacing(0.75, 1),
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.primary,
  }),
  prometheusQueryPlanIndex: css({
    gridArea: 'index',
    color: theme.colors.text.primary,
    fontSize: theme.typography.bodySmall.fontSize,
    fontWeight: theme.typography.fontWeightMedium,
    whiteSpace: 'nowrap',
  }),
  prometheusQueryPlanMeta: css({
    gridArea: 'meta',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  prometheusQueryPlanExpression: css({
    gridArea: 'expression',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: theme.colors.text.primary,
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  emptyState: css({
    padding: theme.spacing(1),
    color: theme.colors.text.secondary,
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.primary,
  }),
  tableWrap: css({
    minWidth: 0,
    maxWidth: '100%',
    overflowX: 'auto',
  }),
  dataTable: css({
    width: '100%',
    minWidth: 520,
    borderCollapse: 'collapse',
    background: theme.colors.background.primary,
    border: `1px solid ${theme.colors.border.weak}`,
    '& th, & td': {
      padding: theme.spacing(0.75, 1),
      borderBottom: `1px solid ${theme.colors.border.weak}`,
      textAlign: 'left',
      verticalAlign: 'middle',
    },
    '& th': {
      color: theme.colors.text.secondary,
      fontSize: theme.typography.bodySmall.fontSize,
      fontWeight: theme.typography.fontWeightMedium,
      background: theme.colors.background.secondary,
    },
    '& tbody tr:last-child td': {
      borderBottom: 0,
    },
  }),
  wideTable: css({
    minWidth: 640,
    '@media (max-width: 700px)': {
      minWidth: 520,
    },
  }),
  metaGrid: css({
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(min(140px, 100%), 1fr))',
    gap: theme.spacing(1),
    minWidth: 0,
  }),
  metaItem: css({
    display: 'grid',
    gap: theme.spacing(0.25),
    minWidth: 0,
    padding: theme.spacing(0.75, 1),
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.primary,
  }),
  metaLabel: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  metaValue: css({
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    '& code': {
      fontFamily: theme.typography.fontFamilyMonospace,
      fontSize: theme.typography.bodySmall.fontSize,
    },
  }),
  queryBlock: css({
    margin: 0,
    minWidth: 0,
    maxWidth: '100%',
    padding: theme.spacing(1),
    overflow: 'auto',
    whiteSpace: 'pre-wrap',
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.primary,
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  queryResultList: css({
    display: 'grid',
    gap: theme.spacing(1),
  }),
  queryResultItem: css({
    display: 'grid',
    gap: theme.spacing(1),
    minWidth: 0,
    padding: theme.spacing(1),
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.primary,
    '&:hover': {
      borderColor: theme.colors.border.medium,
    },
    '&[open]': {
      borderColor: theme.colors.border.medium,
    },
    '&[open] summary': {
      marginBottom: theme.spacing(1),
    },
  }),
  queryResultSummary: css({
    display: 'grid',
    gridTemplateColumns: 'auto auto minmax(0, 1fr) auto',
    alignItems: 'center',
    gap: theme.spacing(1),
    minWidth: 0,
    cursor: 'pointer',
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
    listStyle: 'none',
    '&::marker': {
      content: '""',
    },
    '&::-webkit-details-marker': {
      display: 'none',
    },
    '&:focus-visible': {
      outline: `2px solid ${theme.colors.primary.border}`,
      outlineOffset: theme.spacing(0.5),
      borderRadius: theme.shape.radius.default,
    },
  }),
  queryResultChevron: css({
    color: theme.colors.text.secondary,
    flexShrink: 0,
  }),
  queryResultIndex: css({
    color: theme.colors.text.primary,
    fontWeight: theme.typography.fontWeightMedium,
    whiteSpace: 'nowrap',
  }),
  queryResultExpression: css({
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: theme.colors.text.primary,
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  queryResultTitle: css({
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: theme.colors.text.primary,
    fontWeight: theme.typography.fontWeightMedium,
  }),
  queryResultMeta: css({
    color: theme.colors.text.secondary,
    whiteSpace: 'nowrap',
  }),
  chipList: css({
    display: 'flex',
    flexWrap: 'wrap',
    gap: theme.spacing(0.5),
    minWidth: 0,
  }),
  chip: css({
    display: 'inline-flex',
    maxWidth: '100%',
    alignItems: 'center',
    padding: theme.spacing(0.25, 0.75),
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.primary,
    fontSize: theme.typography.bodySmall.fontSize,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  }),
  labelKey: css({
    color: theme.colors.text.secondary,
  }),
  scrollList: css({
    maxHeight: 280,
    overflow: 'auto',
    display: 'grid',
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.primary,
  }),
  listItem: css({
    padding: theme.spacing(0.35, 1),
    borderBottom: `1px solid ${theme.colors.border.weak}`,
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: theme.typography.bodySmall.fontSize,
    '&:last-child': {
      borderBottom: 0,
    },
  }),
  noticeList: css({
    display: 'grid',
    gap: theme.spacing(0.5),
  }),
  notice: css({
    display: 'flex',
    gap: theme.spacing(1),
    padding: theme.spacing(0.75, 1),
    borderLeft: `3px solid ${theme.colors.warning.border}`,
    background: theme.colors.background.primary,
    '& strong': {
      color: theme.colors.warning.text,
      textTransform: 'uppercase',
      fontSize: theme.typography.bodySmall.fontSize,
    },
  }),
  codeTextCell: css({
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: theme.typography.bodySmall.fontSize,
    whiteSpace: 'pre-wrap',
  }),
  externalLink: css({
    color: theme.colors.text.link,
  }),
  codeViewer: css({
    margin: 0,
    maxHeight: 520,
    overflow: 'auto',
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.primary,
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  codeLine: css({
    display: 'grid',
    gridTemplateColumns: '4.5em minmax(0, 1fr)',
    minWidth: 0,
  }),
  lineNumber: css({
    userSelect: 'none',
    padding: theme.spacing(0, 1),
    color: theme.colors.text.secondary,
    textAlign: 'right',
    borderRight: `1px solid ${theme.colors.border.weak}`,
    background: theme.colors.background.secondary,
  }),
  codeText: css({
    padding: theme.spacing(0, 1),
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  }),
  syntaxComment: css({
    color: theme.colors.text.secondary,
    fontStyle: 'italic',
  }),
  syntaxKeyword: css({
    color: theme.colors.primary.text,
    fontWeight: theme.typography.fontWeightMedium,
  }),
  syntaxString: css({
    color: theme.colors.success.text,
  }),
  syntaxNumber: css({
    color: theme.colors.warning.text,
  }),
  syntaxBuiltin: css({
    color: theme.colors.text.link,
  }),
  syntaxKey: css({
    color: theme.colors.text.link,
  }),
  syntaxOperator: css({
    color: theme.colors.text.secondary,
  }),
  syntaxPunctuation: css({
    color: theme.colors.text.secondary,
  }),
  diffViewer: css({
    margin: 0,
    maxHeight: 420,
    overflow: 'auto',
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.primary,
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  diffLine: css({
    padding: theme.spacing(0, 1),
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  }),
  diffAdd: css({
    background: theme.colors.success.transparent,
  }),
  diffDelete: css({
    background: theme.colors.error.transparent,
  }),
  diffMeta: css({
    color: theme.colors.text.secondary,
    background: theme.colors.background.secondary,
  }),
  monospace: css({
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  muted: css({
    color: theme.colors.text.secondary,
  }),
  collapsible: css({
    minWidth: 0,
    maxWidth: '100%',
    '& summary': {
      cursor: 'pointer',
      color: theme.colors.text.secondary,
      fontSize: theme.typography.bodySmall.fontSize,
    },
  }),
  activity: css({
    width: '100%',
    minWidth: 0,
    maxWidth: 980,
    display: 'grid',
    gap: theme.spacing(1),
    padding: theme.spacing(1.5),
    border: `1px dashed ${theme.colors.border.medium}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.secondary,
  }),
  activityTitle: css({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing(1),
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
    textTransform: 'uppercase',
  }),
  activityTitleLabel: css({
    display: 'flex',
    alignItems: 'center',
    minWidth: 0,
    gap: theme.spacing(1),
  }),
  activityElapsed: css({
    flex: '0 0 auto',
    color: theme.colors.text.secondary,
    fontVariantNumeric: 'tabular-nums',
    textTransform: 'none',
    whiteSpace: 'nowrap',
  }),
  activityList: css({
    display: 'grid',
    gap: theme.spacing(1),
    minWidth: 0,
  }),
  activityItem: css({
    display: 'grid',
    gap: theme.spacing(1),
    minWidth: 0,
  }),
});
