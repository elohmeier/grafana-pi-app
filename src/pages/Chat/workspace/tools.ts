import { createTwoFilesPatch } from 'diff';
import { Type, type TSchema } from 'typebox';
import { textResult, throwIfAborted, type ToolResult } from '../domain/result';
import { contentRevision } from './hash';
import { LIVE_DASHBOARD_PATH } from './liveDashboard';
import { normalizeWorkspacePath, truncateUtf8, utf8ByteLength } from './paths';
import { formatBashResult, runWorkspaceBash, type WorkspaceShellDeps } from './shell';
import { WorkspaceError, type SessionWorkspace } from './workspace';

export { formatBashResult };

export const WORKSPACE_TOOL_NAMES = ['read', 'write', 'edit', 'bash'] as const;

const DEFAULT_READ_LINES = 400;
const MAX_READ_LINES = 2000;
const MAX_READ_BYTES = 48 * 1024;
const MAX_LINE_CHARS = 2000;
const MAX_EDIT_DIFF_BYTES = 12 * 1024;

type ReadParams = { path: string; offset?: number; limit?: number };
type WriteParams = { path: string; content: string; revision?: string };
type EditParams = {
  path: string;
  edits: Array<{ oldText: string; newText: string; replaceAll?: boolean }>;
  revision?: string;
};
type BashParams = { command: string; cwd?: string; timeoutMs?: number };

export type WorkspaceToolDeps = WorkspaceShellDeps;

/** What the model sees of a tool, and how the harness runs it. */
export type WorkspaceToolDefinition = {
  name: (typeof WORKSPACE_TOOL_NAMES)[number];
  label: string;
  description: string;
  parameters: TSchema;
  executionMode?: 'sequential' | 'parallel';
  /** Whether a call interrupted by a reload may run again; otherwise the model is told it was interrupted. */
  replay: 'safe' | 'unsafe';
};

export type WorkspaceTool = WorkspaceToolDefinition & {
  execute(
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: (partial: ToolResult) => void
  ): Promise<ToolResult>;
};

const READ_TOOL: WorkspaceToolDefinition = {
  name: 'read',
  label: 'Read',
  description:
    'Read a file from the session filesystem with line numbers, or list a directory. Large files are returned in windows: pass offset (1-based line) and limit to continue. Reading /grafana/dashboards/<uid>/dashboard.json or /grafana/alert-rules/<uid>/rule.json loads that resource on first access. The result includes a revision you can pass to write/edit to guard against concurrent changes.',
  parameters: Type.Object({
    path: Type.String({ description: 'Absolute path, or relative to /workspace.' }),
    offset: Type.Optional(Type.Number({ description: '1-based first line to return. Defaults to 1.' })),
    limit: Type.Optional(Type.Number({ description: `Maximum lines to return. Defaults to ${DEFAULT_READ_LINES}.` })),
  }),
  replay: 'safe',
};

const WRITE_TOOL: WorkspaceToolDefinition = {
  name: 'write',
  label: 'Write',
  description:
    'Create or overwrite one file in the session filesystem. Writable locations: /workspace, /session, /tmp, /grafana/dashboards/<uid>/dashboard.json, and /grafana/alert-rules/<uid>/rule.json (local working copies; nothing reaches Grafana until an approved `workspace apply`). Parent directories are created automatically. Prefer edit for small changes to existing files.',
  executionMode: 'sequential',
  parameters: Type.Object({
    path: Type.String({ description: 'Absolute path, or relative to /workspace.' }),
    content: Type.String({ description: 'Complete file content.' }),
    revision: Type.Optional(
      Type.String({ description: 'Expected current revision from read; the write fails if the file changed.' })
    ),
  }),
  replay: 'unsafe',
};

const EDIT_TOOL: WorkspaceToolDefinition = {
  name: 'edit',
  label: 'Edit',
  description:
    'Replace exact text in one file. Each oldText must match exactly once (including whitespace) unless replaceAll is true; edits apply in order and atomically - if any edit fails, nothing changes. Include enough surrounding context in oldText to make it unique.',
  executionMode: 'sequential',
  parameters: Type.Object({
    path: Type.String({ description: 'Absolute path, or relative to /workspace.' }),
    edits: Type.Array(
      Type.Object({
        oldText: Type.String({ description: 'Exact text to replace.' }),
        newText: Type.String({ description: 'Replacement text.' }),
        replaceAll: Type.Optional(Type.Boolean({ description: 'Replace every occurrence instead of exactly one.' })),
      }),
      { minItems: 1 }
    ),
    revision: Type.Optional(
      Type.String({ description: 'Expected current revision from read; the edit fails if the file changed.' })
    ),
  }),
  replay: 'unsafe',
};

const BASH_TOOL: WorkspaceToolDefinition = {
  name: 'bash',
  label: 'Bash',
  description:
    'Run a non-interactive bash script in the sandboxed session filesystem (no network, no host access). Includes coreutils, find, rg, grep, sed, awk, jq, yq, diff, plus Grafana commands: grafana, grafana-dashboard, grafana-prom, grafana-logs, workspace (run `<command> --help`). Variables and cwd reset per call; files persist. All file changes of one call are committed together, or discarded on timeout/cancel/quota errors.',
  executionMode: 'sequential',
  parameters: Type.Object({
    command: Type.String({ description: 'Bash script to run.' }),
    cwd: Type.Optional(Type.String({ description: 'Working directory. Defaults to /workspace.' })),
    timeoutMs: Type.Optional(Type.Number({ description: 'Timeout in milliseconds (default 30000, max 120000).' })),
  }),
  // A call may have applied changes to Grafana before it was interrupted.
  replay: 'unsafe',
};

/** The fixed tool list, in the order the model sees it. */
export const WORKSPACE_TOOL_DEFINITIONS: readonly WorkspaceToolDefinition[] = [
  READ_TOOL,
  WRITE_TOOL,
  EDIT_TOOL,
  BASH_TOOL,
];

export function createWorkspaceTools(deps: WorkspaceToolDeps): WorkspaceTool[] {
  return [
    makeReadTool(deps.workspace),
    makeWriteTool(deps.workspace),
    makeEditTool(deps.workspace),
    makeBashTool(deps),
  ];
}

function makeReadTool(workspace: SessionWorkspace): WorkspaceTool {
  return {
    ...READ_TOOL,
    async execute(_toolCallId, params, signal) {
      throwIfAborted(signal);
      const args = params as ReadParams;
      const path = resolveToolPath(args.path);
      await workspace.prepareMounts(signal);
      const tx = workspace.begin({ signal });
      try {
        const type = await tx.entryType(path).catch(() => undefined);
        if (type === 'dir') {
          const entries = await tx.readdir(path);
          const lines = entries.map((entry) => `${entry.name}${entry.type === 'dir' ? '/' : ''}`);
          const text = lines.length ? `${path}/\n${lines.join('\n')}` : `${path}/ (empty directory)`;
          return textResult(text, { path, type: 'directory', entries: entries.length });
        }
        const content = await tx.readFile(path);
        const window = readWindow(content, args.offset, args.limit);
        const header = `${path} (revision ${contentRevision(content)}, ${window.totalLines} lines, ${utf8ByteLength(content)} bytes)`;
        const footer = window.nextOffset
          ? `\n[showing lines ${window.startLine}-${window.endLine} of ${window.totalLines}; continue with offset=${window.nextOffset}]`
          : '';
        return textResult(`${header}\n${window.text}${footer}`, {
          path,
          type: 'file',
          revision: contentRevision(content),
          totalLines: window.totalLines,
          startLine: window.startLine,
          endLine: window.endLine,
          truncated: Boolean(window.nextOffset),
        });
      } finally {
        tx.abort();
      }
    },
  };
}

function makeWriteTool(workspace: SessionWorkspace): WorkspaceTool {
  return {
    ...WRITE_TOOL,
    async execute(_toolCallId, params, signal) {
      throwIfAborted(signal);
      const args = params as WriteParams;
      const path = resolveToolPath(args.path);
      if (typeof args.content !== 'string') {
        throw new Error('write requires string content');
      }
      await workspace.prepareMounts(signal);
      const tx = workspace.begin({ signal });
      try {
        const before = await readIfExists(tx, path);
        assertRevision(path, before, args.revision);
        await tx.writeFile(path, args.content);
        const [change] = tx.commit();
        const summary = change
          ? `${change.change === 'created' ? 'Created' : 'Updated'} ${path} (${change.bytes} bytes, revision ${change.revision})`
          : `${path} unchanged (revision ${contentRevision(args.content)})`;
        return textResult(`${summary}${stagingNote(workspace, path)}`, {
          path,
          change: change?.change ?? 'unchanged',
          bytes: utf8ByteLength(args.content),
          revision: contentRevision(args.content),
          diff: before !== undefined ? boundedDiff(path, before, args.content) : undefined,
        });
      } catch (error) {
        tx.abort();
        throw error;
      }
    },
  };
}

function makeEditTool(workspace: SessionWorkspace): WorkspaceTool {
  return {
    ...EDIT_TOOL,
    async execute(_toolCallId, params, signal) {
      throwIfAborted(signal);
      const args = params as EditParams;
      const path = resolveToolPath(args.path);
      if (!Array.isArray(args.edits) || args.edits.length === 0) {
        throw new Error('edit requires at least one {oldText, newText} edit');
      }
      await workspace.prepareMounts(signal);
      const tx = workspace.begin({ signal });
      try {
        const before = await tx.readFile(path);
        assertRevision(path, before, args.revision);
        const after = applyTextEdits(path, before, args.edits);
        if (after === before) {
          throw new Error(`edit produced no change in ${path}`);
        }
        await tx.writeFile(path, after);
        tx.commit();
        const diff = boundedDiff(path, before, after);
        return textResult(
          `Edited ${path} (revision ${contentRevision(after)})${stagingNote(workspace, path)}\n${diff}`,
          {
            path,
            revision: contentRevision(after),
            edits: args.edits.length,
            diff,
          }
        );
      } catch (error) {
        tx.abort();
        throw error;
      }
    },
  };
}

function makeBashTool(deps: WorkspaceShellDeps): WorkspaceTool {
  return {
    ...BASH_TOOL,
    async execute(_toolCallId, params, signal, onUpdate) {
      throwIfAborted(signal);
      const args = params as BashParams;
      // The interpreter returns output only at the end; report which host command is running meanwhile.
      const bash = await runWorkspaceBash(deps, args, signal, (running) =>
        onUpdate?.({ content: [], details: { running } })
      );
      const { images, ...result } = bash;
      const text = textResult(formatBashResult(bash), {
        ...result,
        ...(images ? { images: images.map(({ title, mimeType }) => ({ title, mimeType })) } : {}),
      });
      if (!images) {
        return text;
      }
      return {
        ...text,
        content: [
          ...text.content,
          ...images.map((image) => ({ type: 'image' as const, data: image.data, mimeType: image.mimeType })),
        ],
      };
    },
  };
}

export function applyTextEdits(path: string, content: string, edits: EditParams['edits']) {
  let next = content;
  edits.forEach((edit, index) => {
    const label = edits.length > 1 ? `edit ${index + 1}: ` : '';
    if (typeof edit.oldText !== 'string' || edit.oldText === '') {
      throw new Error(`${label}oldText must be a non-empty string`);
    }
    if (typeof edit.newText !== 'string') {
      throw new Error(`${label}newText must be a string`);
    }
    const positions = occurrences(next, edit.oldText);
    if (positions.length === 0) {
      const hint = whitespaceInsensitiveHint(next, edit.oldText);
      throw new Error(`${label}oldText not found in ${path}.${hint} Read the file again and copy the exact text.`);
    }
    if (positions.length > 1 && !edit.replaceAll) {
      const lines = positions.map((position) => lineNumberAt(next, position));
      throw new Error(
        `${label}oldText matches ${positions.length} times in ${path} (lines ${lines.join(', ')}); add surrounding context to make it unique or set replaceAll.`
      );
    }
    next = edit.replaceAll
      ? next.split(edit.oldText).join(edit.newText)
      : next.replace(edit.oldText, () => edit.newText);
  });
  return next;
}

function readWindow(content: string, offset?: number, limit?: number) {
  const lines = content.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  const totalLines = lines.length;
  const startLine = Math.max(1, Math.floor(offset ?? 1));
  const maxLines = Math.min(Math.max(1, Math.floor(limit ?? DEFAULT_READ_LINES)), MAX_READ_LINES);
  const width = String(Math.min(totalLines, startLine + maxLines)).length;
  const out: string[] = [];
  let bytes = 0;
  let endLine = startLine - 1;
  for (let index = startLine - 1; index < totalLines && out.length < maxLines; index++) {
    let line = lines[index];
    if (line.length > MAX_LINE_CHARS) {
      line = `${line.slice(0, MAX_LINE_CHARS)}... [line truncated, ${line.length} chars]`;
    }
    const formatted = `${String(index + 1).padStart(width)}\t${line}`;
    bytes += utf8ByteLength(formatted) + 1;
    if (bytes > MAX_READ_BYTES && out.length > 0) {
      break;
    }
    out.push(formatted);
    endLine = index + 1;
  }
  if (startLine > totalLines && totalLines > 0) {
    return { text: `[offset ${startLine} is past the end of the file]`, totalLines, startLine, endLine: totalLines };
  }
  return {
    text: out.join('\n'),
    totalLines,
    startLine,
    endLine,
    nextOffset: endLine < totalLines ? endLine + 1 : undefined,
  };
}

function resolveToolPath(path: string) {
  if (typeof path !== 'string') {
    throw new Error('path is required');
  }
  return normalizeWorkspacePath(path, '/workspace');
}

async function readIfExists(tx: ReturnType<SessionWorkspace['begin']>, path: string) {
  try {
    return await tx.readFile(path);
  } catch (error) {
    if (error instanceof WorkspaceError && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function assertRevision(path: string, content: string | undefined, revision: string | undefined) {
  if (!revision) {
    return;
  }
  const current = content === undefined ? 'missing' : contentRevision(content);
  if (current !== revision.trim()) {
    throw new Error(`${path} changed: expected revision ${revision}, current revision ${current}. Read it again.`);
  }
}

function stagingNote(workspace: SessionWorkspace, path: string) {
  if (path === LIVE_DASHBOARD_PATH) {
    return '\nStaged locally only. Run `live diff` to review and `live apply` to update the dashboard open in the browser.';
  }
  const target = workspace.classify(path);
  return target.type === 'resource'
    ? '\nStaged locally only. Validate with `grafana-dashboard validate`, then `workspace apply` to request approval.'
    : '';
}

function boundedDiff(path: string, before: string, after: string) {
  const patch = createTwoFilesPatch(path, path, before, after, undefined, undefined, { context: 2 })
    .split('\n')
    .slice(2)
    .join('\n');
  const limited = truncateUtf8(patch, MAX_EDIT_DIFF_BYTES);
  return limited.truncated ? `${limited.text}\n[diff truncated]` : limited.text;
}

function occurrences(haystack: string, needle: string) {
  const positions: number[] = [];
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    positions.push(index);
    index = haystack.indexOf(needle, index + needle.length);
  }
  return positions;
}

function lineNumberAt(content: string, position: number) {
  let line = 1;
  for (let index = 0; index < position; index++) {
    if (content.charCodeAt(index) === 10) {
      line++;
    }
  }
  return line;
}

function whitespaceInsensitiveHint(content: string, needle: string) {
  const squash = (value: string) => value.replace(/\s+/g, ' ').trim();
  const target = squash(needle);
  if (!target) {
    return '';
  }
  const lines = content.split('\n');
  const firstNeedleLine = squash(needle.split('\n').find((line) => line.trim()) ?? '');
  for (let index = 0; index < lines.length; index++) {
    if (firstNeedleLine && squash(lines[index]).includes(firstNeedleLine)) {
      return ` A similar line exists at line ${index + 1} with different whitespace or surrounding text.`;
    }
  }
  return '';
}
