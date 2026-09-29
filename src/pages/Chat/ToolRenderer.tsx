import { EvidenceView, evidencePresentations } from './session/EvidenceView';
import React, { useEffect, useMemo, useState } from 'react';
import { css, cx, keyframes } from '@emotion/css';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { ToolResultMessage } from '@earendil-works/pi-ai';
import { renderMarkdown, type GrafanaTheme2 } from '@grafana/data';
import { Spinner, useStyles2 } from '@grafana/ui';
import { structuredPatch } from 'diff';
import { highlightBash } from './bashRendering';
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
  /** When execution started; absent in runs restored from older snapshots. */
  startedAt?: number;
  updatedAt: number;
};

/** Tool results and in-flight runs, keyed by tool call ID, so calls render with their output in place. */
export type ToolTranscript = {
  results: ReadonlyMap<string, ToolResultMessage>;
  runs: Readonly<Record<string, ToolRunView>>;
};

export const ToolTranscriptContext = React.createContext<ToolTranscript | undefined>(undefined);

type ToolEntryResult = {
  content: unknown;
  details: unknown;
  isError?: boolean;
};

type ToolEntryState = 'preparing' | 'running' | 'done' | 'pending';

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

  // Consecutive tool calls share one terminal surface.
  const groups: Array<{ index: number; blocks: unknown[] }> = [];
  content.forEach((block, index) => {
    const previous = groups[groups.length - 1];
    if (isToolCallBlock(block) && previous && isToolCallBlock(previous.blocks[0])) {
      previous.blocks.push(block);
    } else {
      groups.push({ index, blocks: [block] });
    }
  });

  return (
    <>
      {groups.map(({ index, blocks }) => {
        const block = blocks[0];
        if (isToolCallBlock(block)) {
          return (
            <Terminal key={index}>
              {(blocks as Array<Record<string, any>>).map((call, offset) => (
                <ToolCallEntry
                  key={offset}
                  id={typeof call.id === 'string' ? call.id : undefined}
                  name={call.name}
                  args={call.arguments}
                  partialJson={typeof call.partialJson === 'string' ? call.partialJson : undefined}
                  isStreaming={isStreaming}
                />
              ))}
            </Terminal>
          );
        }
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

function isToolCallBlock(block: unknown): block is Record<string, any> {
  return isRecord(block) && block.type === 'toolCall' && typeof block.name === 'string';
}

export function ToolResultMessageBody({
  toolName = 'tool',
  content,
  details,
  isError,
}: {
  toolName?: string;
  content: unknown;
  details: unknown;
  isError?: boolean;
}) {
  const result = { content, details, isError };
  // Session filesystem results carry their call's command or path, so they render as a terminal entry of their own.
  return (
    <Terminal>
      {WORKSPACE_TOOL_NAMES.has(toolName) && isRecord(details) ? (
        <ToolEntry name={toolName} args={details} state="done" result={result} />
      ) : (
        <LegacyToolEntry name={toolName} args={undefined} state="done" result={result} />
      )}
    </Terminal>
  );
}

/** A user `!command`: the same terminal entry as an agent bash call, with the user's prompt. */
export function UserShellEntry({ result }: { result: unknown }) {
  return (
    <Terminal>
      <ToolEntry name="bash" args={result} state="done" result={{ content: [], details: result }} prompt="!" />
    </Terminal>
  );
}

function Terminal({ children }: { children: React.ReactNode }) {
  const styles = useStyles2(getToolStyles);
  return <div className={styles.terminal}>{children}</div>;
}

function ToolCallEntry({
  id,
  name,
  args,
  partialJson,
  isStreaming,
}: {
  id?: string;
  name: string;
  args: unknown;
  partialJson?: string;
  isStreaming: boolean;
}) {
  const transcript = React.useContext(ToolTranscriptContext);
  const message = id ? transcript?.results.get(id) : undefined;
  const run = id ? transcript?.runs[id] : undefined;
  const result: ToolEntryResult | undefined = message
    ? { content: message.content, details: message.details, isError: message.isError }
    : run?.result
      ? { content: run.result.content, details: run.result.details, isError: run.isError }
      : undefined;
  const state: ToolEntryState = result
    ? 'done'
    : run?.status === 'running'
      ? 'running'
      : isStreaming
        ? 'preparing'
        : 'pending';

  if (!WORKSPACE_TOOL_NAMES.has(name)) {
    return <LegacyToolEntry name={name} args={args} partialJson={partialJson} state={state} result={result} />;
  }
  return (
    <ToolEntry
      name={name}
      args={isRecord(args) ? args : {}}
      state={state}
      result={result}
      progress={state === 'running' ? run : undefined}
    />
  );
}

function ToolEntry({
  name,
  args,
  state,
  result,
  progress,
  prompt = '$',
}: {
  name: string;
  args: unknown;
  state: ToolEntryState;
  result?: ToolEntryResult;
  /** The in-flight run of this call, for its start time and progress updates. */
  progress?: ToolRunView;
  prompt?: string;
}) {
  const record = isRecord(args) ? args : {};
  const details = isRecord(result?.details) ? result.details : undefined;
  const error = result?.isError ? extractToolError(name, result.details, result.content).message : undefined;

  switch (name) {
    case 'bash':
      return (
        <BashEntry
          args={record}
          details={details}
          error={error}
          progress={progress}
          prompt={prompt}
          result={result}
          state={state}
        />
      );
    case 'read':
      return <ReadEntry args={record} details={details} error={error} result={result} state={state} />;
    case 'write':
    case 'edit':
      return <MutationEntry args={record} details={details} error={error} name={name} state={state} />;
    default:
      return null;
  }
}

function BashEntry({
  args,
  details,
  error,
  progress,
  prompt,
  result,
  state,
}: {
  args: Record<string, unknown>;
  details?: Record<string, unknown>;
  error?: string;
  progress?: ToolRunView;
  prompt: string;
  result?: ToolEntryResult;
  state: ToolEntryState;
}) {
  const styles = useStyles2(getToolStyles);
  const bash = details && !error ? workspaceBashResultFromRecord(details) : undefined;
  const command = bash?.command || stringField(args, 'command') || '';
  const cwd = bash?.cwd ?? stringField(args, 'cwd');
  const failed = Boolean(error || bash?.timedOut || (bash?.exitCode !== undefined && bash.exitCode !== 0));
  const status = bash?.timedOut ? 'timed out' : bash?.exitCode ? `exit ${bash.exitCode}` : error ? 'error' : undefined;
  // Commands such as `grafana-dashboard screenshot` attach images after the text block.
  const images = imageBlocks(result?.content);

  return (
    <div className={styles.terminalEntry}>
      <PromptLine
        cwd={cwd}
        failed={failed}
        meta={[status, formatDurationMs(bash?.durationMs)].filter(Boolean).join(' · ') || undefined}
        prompt={prompt}
        startedAt={progress?.startedAt}
        state={state}
      >
        <BashCommand command={command} />
      </PromptLine>
      {state === 'running' && runningCommand(progress) && (
        <div className={styles.terminalMuted}>↳ {runningCommand(progress)}</div>
      )}
      {error && <TerminalOutput error text={error} />}
      {bash?.stdout && <TerminalOutput text={bash.stdout} truncated={bash.stdoutTruncated} />}
      {bash?.stderr && <TerminalOutput error text={bash.stderr} truncated={bash.stderrTruncated} />}
      {bash?.discardedChanges && (
        <div className={styles.terminalError}>discarded uncommitted changes: {bash.discardedChanges}</div>
      )}
      {bash && bash.changes.length > 0 && <TerminalFileChanges changes={bash.changes} />}
      {(evidencePresentations(details?.presentations).length > 0 || images.length > 0) && (
        <div className={styles.terminalRich}>
          {evidencePresentations(details?.presentations).map((evidence, i) => (
            <EvidenceView key={i} evidence={evidence} />
          ))}
          {images.length > 0 && <ContentBlocks content={images} />}
        </div>
      )}
    </div>
  );
}

function ReadEntry({
  args,
  details,
  error,
  result,
  state,
}: {
  args: Record<string, unknown>;
  details?: Record<string, unknown>;
  error?: string;
  result?: ToolEntryResult;
  state: ToolEntryState;
}) {
  const styles = useStyles2(getToolStyles);
  const path = stringField(details, 'path') ?? stringField(args, 'path') ?? '';
  const text = extractToolText(result?.content) ?? '';
  const isDirectory = stringField(details, 'type') === 'directory';
  const directory = details && isDirectory ? workspaceDirectoryResultFromRecord(details, text) : undefined;
  const file = details && !isDirectory && !error ? workspaceReadResultFromRecord(details, text) : undefined;
  const meta = directory
    ? formatLabeledCount(directory.entries.length, 'entry', 'entries')
    : file
      ? workspaceReadLineSummary(file)
      : undefined;
  const line = (
    <PromptLine failed={Boolean(error)} meta={meta} state={state}>
      <span className={styles.terminalVerb}>read</span> {directory ? `${directory.path}/` : path}
    </PromptLine>
  );

  // File contents are context for the model; keep them one click away.
  const body = directory ? (
    <pre className={styles.terminalOutput}>{directory.entries.join('\n') || '(empty directory)'}</pre>
  ) : file && file.lines.length > 0 ? (
    <>
      <CodeViewer lines={file.lines} language={/\.(jsonnet|libsonnet)$/.test(file.path) ? 'jsonnet' : 'plain'} />
      {file.notes.map((note) => (
        <div className={styles.terminalMuted} key={note}>
          {note}
        </div>
      ))}
    </>
  ) : undefined;

  return (
    <div className={styles.terminalEntry}>
      {body ? (
        <details className={styles.terminalDisclosure}>
          <summary>{line}</summary>
          {body}
        </details>
      ) : (
        line
      )}
      {error && <TerminalOutput error text={error} />}
    </div>
  );
}

function MutationEntry({
  name,
  args,
  details,
  error,
  state,
}: {
  name: 'write' | 'edit';
  args: Record<string, unknown>;
  details?: Record<string, unknown>;
  error?: string;
  state: ToolEntryState;
}) {
  const styles = useStyles2(getToolStyles);
  const path = stringField(details, 'path') ?? stringField(args, 'path') ?? '';
  const content = stringField(args, 'content');
  const edits = recordsField(args, 'edits').length;
  const diff = stringField(details, 'diff');
  const hasDiff = Boolean(diff && /^@@/m.test(diff));
  const meta =
    name === 'write'
      ? formatBytes(numberField(details, 'bytes') ?? (content !== undefined ? utf8ByteLength(content) : undefined))
      : edits > 0
        ? formatLabeledCount(edits, 'edit', 'edits')
        : undefined;

  return (
    <div className={styles.terminalEntry}>
      <PromptLine failed={Boolean(error)} meta={meta} state={state}>
        <span className={styles.terminalVerb}>{name}</span> {path}
      </PromptLine>
      {error && <TerminalOutput error text={error} />}
      {!error && hasDiff && diff && <TerminalDiff diff={diff} />}
      {!error && details && isWorkspaceStagedPath(path) && (
        <div className={styles.terminalMuted}>staged locally; Grafana is unchanged until workspace apply</div>
      )}
    </div>
  );
}

/** Tools retired before the read/write/edit/bash redesign, still present in older sessions. */
function LegacyToolEntry({
  name,
  args,
  partialJson,
  state,
  result,
}: {
  name: string;
  args: unknown;
  partialJson?: string;
  state: ToolEntryState;
  result?: ToolEntryResult;
}) {
  const styles = useStyles2(getToolStyles);
  const output = result?.isError
    ? extractToolError(name, result.details, result.content).message
    : extractToolText(result?.content);
  const images = imageBlocks(result?.content);
  const argsText = partialJson && state === 'preparing' ? partialJson : hasDetails(args) ? formatJson(args) : undefined;
  const line = (
    <PromptLine failed={Boolean(result?.isError)} state={state}>
      <span className={styles.terminalVerb}>{name}</span>
    </PromptLine>
  );

  return (
    <div className={styles.terminalEntry}>
      {argsText ? (
        <details className={styles.terminalDisclosure}>
          <summary>{line}</summary>
          <pre className={styles.terminalOutput}>{argsText}</pre>
        </details>
      ) : (
        line
      )}
      {output && <TerminalOutput error={result?.isError} text={output} />}
      {images.length > 0 && (
        <div className={styles.terminalRich}>
          <ContentBlocks content={images} />
        </div>
      )}
    </div>
  );
}

function imageBlocks(content: unknown) {
  return Array.isArray(content) ? content.filter((block) => isRecord(block) && block.type === 'image') : [];
}

function PromptLine({
  children,
  cwd,
  failed,
  meta,
  prompt = '›',
  startedAt,
  state,
}: {
  children: React.ReactNode;
  cwd?: string;
  failed?: boolean;
  meta?: string;
  prompt?: string;
  startedAt?: number;
  state: ToolEntryState;
}) {
  const styles = useStyles2(getToolStyles);
  return (
    <div className={styles.terminalPromptLine}>
      <span className={cx(styles.terminalPrompt, failed && styles.terminalPromptFailed)}>
        {cwd && cwd !== DEFAULT_CWD && <span className={styles.terminalMuted}>{cwd} </span>}
        {prompt}
      </span>
      <span className={styles.terminalCommand}>
        {children}
        {state === 'preparing' && <span className={styles.streamingCursor} aria-hidden="true" />}
      </span>
      {state === 'running' ? (
        <span className={styles.terminalMeta}>
          {startedAt !== undefined && <RunningElapsed startedAt={startedAt} />} <Spinner inline size="xs" />
        </span>
      ) : (
        meta && <span className={cx(styles.terminalMeta, failed && styles.terminalError)}>{meta}</span>
      )}
    </div>
  );
}

const DEFAULT_CWD = '/workspace';

function runningCommand(run: ToolRunView | undefined) {
  const details = run?.partialResult?.details;
  return isRecord(details) ? stringField(details, 'running') : undefined;
}

function RunningElapsed({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.floor((now - startedAt) / 1000);
  return seconds >= 1 ? <>{seconds} s</> : null;
}

function BashCommand({ command }: { command: string }) {
  const tokens = useMemo(() => highlightBash(command), [command]);
  return (
    <code className="language-bash">{tokens?.length ? <CodeLineText text={command} tokens={tokens} /> : command}</code>
  );
}

const OUTPUT_PREVIEW_LINES = 10;

function TerminalOutput({ text, error, truncated }: { text: string; error?: boolean; truncated?: boolean }) {
  const styles = useStyles2(getToolStyles);
  const [expanded, setExpanded] = useState(false);
  const lines = text.replace(/\n$/, '').split('\n');
  // Hiding only a line or two saves nothing; show them instead of an expander.
  const clamp = !expanded && lines.length > OUTPUT_PREVIEW_LINES + 2;
  return (
    <>
      <pre className={cx(styles.terminalOutput, error && styles.terminalError)}>
        {clamp ? lines.slice(0, OUTPUT_PREVIEW_LINES).join('\n') : lines.join('\n')}
      </pre>
      {clamp && (
        <button className={styles.terminalExpand} type="button" onClick={() => setExpanded(true)}>
          … {formatLabeledCount(lines.length - OUTPUT_PREVIEW_LINES, 'more line', 'more lines')}
        </button>
      )}
      {truncated && <div className={styles.terminalMuted}>[output truncated]</div>}
    </>
  );
}

function TerminalDiff({ diff }: { diff: string }) {
  const styles = useStyles2(getToolStyles);
  const [expanded, setExpanded] = useState(false);
  const { lines, metadataFlags } = useMemo(() => {
    // The entry already names the file; keep hunks and drop file headers and end-of-file markers.
    const allLines = optimizedUnifiedDiffLines(diff);
    const allFlags = diffMetadataFlags(allLines);
    const firstHunk = allLines.findIndex((line) => line.startsWith('@@'));
    const kept = allLines
      .map((line, index) => ({ line, isMeta: allFlags[index] }))
      .filter(({ line }, index) => index >= Math.max(firstHunk, 0) && line !== '' && !line.startsWith('\\'));
    return { lines: kept.map(({ line }) => line), metadataFlags: kept.map(({ isMeta }) => isMeta) };
  }, [diff]);
  const clamp = !expanded && lines.length > OUTPUT_PREVIEW_LINES + 2;
  const visible = clamp ? lines.slice(0, OUTPUT_PREVIEW_LINES) : lines;
  return (
    <>
      <pre className={styles.terminalOutput}>
        {visible.map((line, index) => {
          const isMeta = metadataFlags[index];
          return (
            <div
              className={cx(
                isMeta && styles.terminalMuted,
                !isMeta && line.startsWith('+') && styles.terminalDiffAdd,
                !isMeta && line.startsWith('-') && styles.terminalDiffDelete
              )}
              key={`${index}:${line}`}
            >
              {line || ' '}
            </div>
          );
        })}
      </pre>
      {clamp && (
        <button className={styles.terminalExpand} type="button" onClick={() => setExpanded(true)}>
          … {formatLabeledCount(lines.length - OUTPUT_PREVIEW_LINES, 'more line', 'more lines')}
        </button>
      )}
    </>
  );
}

const FILE_CHANGE_MARKERS: Record<string, string> = { created: 'A', modified: 'M', deleted: 'D' };

function TerminalFileChanges({ changes }: { changes: WorkspaceFileChange[] }) {
  const styles = useStyles2(getToolStyles);
  return (
    <pre className={styles.terminalOutput}>
      {changes.map((change) => (
        <div key={change.path}>
          <span className={styles.terminalVerb}>{FILE_CHANGE_MARKERS[change.change] ?? '?'}</span> {change.path}
          <span className={styles.terminalMuted}>
            {[formatBytes(change.bytes), isWorkspaceStagedPath(change.path) ? 'staged' : undefined]
              .filter(Boolean)
              .map((part) => `  ${part}`)
              .join('')}
          </span>
        </div>
      ))}
    </pre>
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

type ToolErrorViewModel = {
  toolName?: string;
  message: string;
};

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

// Renderers for the session filesystem tools (read/write/edit/bash) in src/pages/Chat/workspace/tools.ts.
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

function recordsField(record: Record<string, unknown>, key: string): Array<Record<string, unknown>> {
  const value = record[key];
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanField(record: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const value = record?.[key];
  return typeof value === 'boolean' ? value : undefined;
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
  toolCallJson: css({
    margin: 0,
    overflow: 'auto',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
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
  collapsible: css({
    minWidth: 0,
    maxWidth: '100%',
    '& summary': {
      cursor: 'pointer',
      color: theme.colors.text.secondary,
      fontSize: theme.typography.bodySmall.fontSize,
    },
  }),
  terminal: css({
    display: 'grid',
    gap: theme.spacing(0.75),
    minWidth: 0,
    maxWidth: '100%',
    margin: theme.spacing(0.5, 0),
    padding: theme.spacing(1, 1.5),
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.canvas,
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: theme.typography.bodySmall.fontSize,
    lineHeight: 1.5,
    whiteSpace: 'normal',
    overflowWrap: 'normal',
  }),
  terminalEntry: css({
    display: 'grid',
    minWidth: 0,
  }),
  terminalPromptLine: css({
    display: 'grid',
    gridTemplateColumns: 'auto minmax(0, 1fr) auto',
    alignItems: 'baseline',
    columnGap: theme.spacing(1),
    minWidth: 0,
  }),
  terminalPrompt: css({
    color: theme.colors.success.text,
    fontWeight: theme.typography.fontWeightMedium,
    whiteSpace: 'nowrap',
    userSelect: 'none',
  }),
  terminalPromptFailed: css({
    color: theme.colors.error.text,
  }),
  terminalCommand: css({
    minWidth: 0,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word',
    color: theme.colors.text.primary,
    // Grafana styles every `code` element as an inline box.
    '& code': {
      padding: 0,
      border: 'none',
      background: 'none',
      color: 'inherit',
      fontSize: 'inherit',
      whiteSpace: 'inherit',
      overflowWrap: 'inherit',
    },
  }),
  terminalVerb: css({
    color: theme.colors.text.link,
  }),
  terminalMeta: css({
    color: theme.colors.text.secondary,
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
  }),
  terminalOutput: css({
    // Beats the message container's `pre` rule; terminal output keeps its columns and scrolls sideways.
    '&&': {
      margin: 0,
      padding: 0,
      minWidth: 0,
      maxWidth: '100%',
      overflowX: 'auto',
      whiteSpace: 'pre',
      overflowWrap: 'normal',
      border: 'none',
      background: 'transparent',
      color: theme.colors.text.secondary,
      fontFamily: 'inherit',
      fontSize: 'inherit',
    },
  }),
  terminalError: css({
    '&&': {
      color: theme.colors.error.text,
    },
  }),
  terminalMuted: css({
    color: theme.colors.text.secondary,
    opacity: 0.8,
  }),
  terminalDiffAdd: css({
    color: theme.colors.success.text,
  }),
  terminalDiffDelete: css({
    color: theme.colors.error.text,
  }),
  terminalExpand: css({
    justifySelf: 'start',
    padding: 0,
    border: 'none',
    background: 'none',
    color: theme.colors.text.link,
    font: 'inherit',
    cursor: 'pointer',
    '&:hover': {
      textDecoration: 'underline',
    },
  }),
  terminalDisclosure: css({
    minWidth: 0,
    '& > summary': {
      display: 'block',
      listStyle: 'none',
      cursor: 'pointer',
    },
    '& > summary::-webkit-details-marker': {
      display: 'none',
    },
    '&[open] > summary': {
      marginBottom: theme.spacing(0.5),
    },
  }),
  terminalRich: css({
    display: 'grid',
    gap: theme.spacing(1),
    minWidth: 0,
    marginTop: theme.spacing(0.5),
    fontFamily: theme.typography.fontFamily,
    fontSize: theme.typography.body.fontSize,
  }),
});
