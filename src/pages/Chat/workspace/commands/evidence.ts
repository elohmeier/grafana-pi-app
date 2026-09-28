import { contentRevision } from '../hash';
import { normalizeWorkspacePath, utf8ByteLength } from '../paths';
import { json, stringOption, UsageError, type WorkspaceCommandSpec } from './registry';

/** A captured display value. Rendering this event never runs queries or follows mutable paths. */
export type EvidencePresentation = {
  version: 1;
  path: string;
  revision: string;
  title: string;
  view: 'json' | 'text' | 'table';
  data: unknown;
};

export const evidenceCommand: WorkspaceCommandSpec = {
  name: 'evidence',
  summary: 'Show selected captured evidence to the user without querying again.',
  subcommands: {
    show: {
      summary: 'Present a JSON, table, text, or captured image file in the conversation.',
      usage: 'evidence show PATH [--view json|table|text|image] [--title TITLE]',
      effect: 'local-read',
      options: {
        view: { type: 'string', description: 'Presentation format.', default: 'json' },
        title: { type: 'string', description: 'Human-readable evidence title.' },
      },
      async run(parsed, ctx) {
        if (parsed.positionals.length !== 1) {
          throw new UsageError('one PATH is required');
        }
        const path = normalizeWorkspacePath(parsed.positionals[0], ctx.cwd);
        const view = stringOption(parsed, 'view') ?? 'json';
        const title = stringOption(parsed, 'title') ?? path;
        if (view === 'image') {
          const id = /^\/artifacts\/([^/]+)\.json$/.exec(path)?.[1];
          const artifact = id && ctx.artifacts?.get(id);
          if (
            !artifact ||
            artifact.kind !== 'image' ||
            typeof artifact.data !== 'string' ||
            !/^image\/(png|jpeg|webp|gif)$/.test(artifact.mimeType ?? '')
          ) {
            throw new UsageError('image view requires a captured image artifact');
          }
          return {
            ...json({ schemaVersion: 1, shown: path }),
            images: [{ title, data: artifact.data, mimeType: artifact.mimeType! }],
          };
        }
        if (!['json', 'text', 'table'].includes(view)) {
          throw new UsageError('view must be json, text, table, or image');
        }
        const content = await ctx.tx.readFile(path);
        if (utf8ByteLength(content) > 64 * 1024) {
          throw new UsageError('evidence exceeds 64 KiB; use jq to select a smaller view into a file');
        }
        let data: unknown = view === 'text' ? content : JSON.parse(content);
        if (view !== 'text' && path.startsWith('/artifacts/') && data && typeof data === 'object' && 'data' in data) {
          data = data.data;
        }
        if (
          view === 'table' &&
          (!Array.isArray(data) ||
            data.length > 100 ||
            data.some((row) => !row || typeof row !== 'object' || Array.isArray(row)))
        ) {
          throw new UsageError('table view requires an array of at most 100 objects; use jq to select rows');
        }
        const event: EvidencePresentation = {
          version: 1,
          path,
          revision: contentRevision(content),
          title,
          view: view as EvidencePresentation['view'],
          data,
        };
        return { ...json({ schemaVersion: 1, shown: path, revision: event.revision }), presentations: [event] };
      },
    },
  },
};
