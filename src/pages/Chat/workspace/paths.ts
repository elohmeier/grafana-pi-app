export class WorkspacePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspacePathError';
  }
}

const MAX_PATH_BYTES = 1024;
const MAX_SEGMENT_BYTES = 255;

/**
 * Normalizes an absolute or cwd-relative workspace path. Rejects traversal above
 * the root, NUL bytes, backslashes, percent-encoded separators, and other
 * ambiguous encodings instead of silently rewriting them.
 */
export function normalizeWorkspacePath(path: string, cwd = '/', options: { clampAtRoot?: boolean } = {}): string {
  if (typeof path !== 'string') {
    throw new WorkspacePathError('path must be a string');
  }
  const raw = path.trim();
  if (!raw) {
    throw new WorkspacePathError('path is required');
  }
  if (raw.includes('\0')) {
    throw new WorkspacePathError(`path contains a NUL byte: ${JSON.stringify(path)}`);
  }
  if (raw.includes('\\')) {
    throw new WorkspacePathError(`path must use "/" separators: ${path}`);
  }
  if (/%2f|%5c|%00|%2e/i.test(raw)) {
    throw new WorkspacePathError(`path contains percent-encoded separators or dots: ${path}`);
  }
  if (raw !== raw.normalize('NFC')) {
    throw new WorkspacePathError(`path must be NFC-normalized Unicode: ${path}`);
  }

  const absolute = raw.startsWith('/') ? raw : `${cwd.replace(/\/+$/, '')}/${raw}`;
  const segments: string[] = [];
  for (const segment of absolute.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (segments.length === 0) {
        // POSIX resolves "/.." to "/"; shell tools (rg ignore-file lookup) rely on that.
        if (options.clampAtRoot) {
          continue;
        }
        throw new WorkspacePathError(`path escapes the workspace root: ${path}`);
      }
      segments.pop();
      continue;
    }
    if (utf8ByteLength(segment) > MAX_SEGMENT_BYTES) {
      throw new WorkspacePathError(`path segment is too long: ${segment.slice(0, 40)}...`);
    }
    segments.push(segment);
  }

  const normalized = `/${segments.join('/')}`;
  if (utf8ByteLength(normalized) > MAX_PATH_BYTES) {
    throw new WorkspacePathError(`path is too long (${MAX_PATH_BYTES} bytes max)`);
  }
  return normalized;
}

export function isWithin(path: string, root: string) {
  if (root === '/') {
    return true;
  }
  return path === root || path.startsWith(`${root}/`);
}

export function parentPath(path: string) {
  if (path === '/') {
    return '/';
  }
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
}

export function baseName(path: string) {
  const index = path.lastIndexOf('/');
  return path.slice(index + 1);
}

export function joinPath(dir: string, name: string) {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

/** Every ancestor directory of `path`, excluding `/` and the path itself. */
export function ancestorDirs(path: string) {
  const dirs: string[] = [];
  let current = parentPath(path);
  while (current !== '/') {
    dirs.unshift(current);
    current = parentPath(current);
  }
  return dirs;
}

export function utf8ByteLength(value: string) {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      bytes += 4;
      index++;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/** Truncates a string to at most `maxBytes` UTF-8 bytes without splitting a code point. */
export function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  if (utf8ByteLength(value) <= maxBytes) {
    return { text: value, truncated: false };
  }
  let bytes = 0;
  let end = 0;
  while (end < value.length) {
    const code = value.charCodeAt(end);
    const width = code < 0x80 ? 1 : code < 0x800 ? 2 : code >= 0xd800 && code <= 0xdbff ? 4 : 3;
    if (bytes + width > maxBytes) {
      break;
    }
    bytes += width;
    end += width === 4 ? 2 : 1;
  }
  return { text: value.slice(0, end), truncated: true };
}

/** The report the chat shows next to the messages; the agent maintains it like any other file. */
export const REPORT_PATH = '/session/report.md';
