import type {
  BufferEncoding,
  CpOptions,
  FileContent,
  FsStat,
  IFileSystem,
  MkdirOptions,
  RmOptions,
} from 'just-bash/browser';
import { normalizeWorkspacePath } from './paths';
import { WorkspaceError, type WorkspaceTransaction } from './workspace';

type DirentEntry = { name: string; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean };

const FILE_MODE = 0o644;
const DIR_MODE = 0o755;
const EPOCH = new Date(0);
/** Discards writes and reads as empty, so `cmd > /dev/null 2>&1` works as in any shell. */
const DEV_NULL = '/dev/null';

/**
 * just-bash filesystem backed by a workspace transaction. Every shell
 * mutation is staged in the transaction and validated at commit, so bash has
 * exactly the same path, read-only, and quota policy as the file tools.
 * Symlinks and hard links are rejected.
 */
export class WorkspaceBashFs implements IFileSystem {
  constructor(private readonly tx: WorkspaceTransaction) {}

  async readFile(path: string, options?: { encoding?: BufferEncoding | null } | BufferEncoding): Promise<string> {
    const normalized = this.normalize(path);
    const text = normalized === DEV_NULL ? '' : await this.tx.readFile(normalized);
    return isByteEncoding(options) ? latin1FromBytes(new TextEncoder().encode(text)) : text;
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    return new TextEncoder().encode(await this.readFile(path));
  }

  async writeFile(path: string, content: FileContent, options?: WriteOptions): Promise<void> {
    const normalized = this.normalize(path);
    if (normalized !== DEV_NULL) {
      await this.tx.writeFile(normalized, decodeContent(content, options));
    }
  }

  async appendFile(path: string, content: FileContent, options?: WriteOptions): Promise<void> {
    const normalized = this.normalize(path);
    if (normalized !== DEV_NULL) {
      await this.tx.appendFile(normalized, decodeContent(content, options));
    }
  }

  async exists(path: string): Promise<boolean> {
    if (this.normalize(path) === DEV_NULL) {
      return true;
    }
    try {
      return await this.tx.exists(this.normalize(path));
    } catch {
      return false;
    }
  }

  async stat(path: string): Promise<FsStat> {
    const normalized = this.normalize(path);
    if (normalized === DEV_NULL) {
      return { isFile: true, isDirectory: false, isSymbolicLink: false, mode: 0o666, size: 0, mtime: EPOCH };
    }
    const type = await this.tx.entryType(normalized);
    if (!type) {
      throw new WorkspaceError('ENOENT', `no such file or directory, stat '${normalized}'`);
    }
    return {
      isFile: type === 'file',
      isDirectory: type === 'dir',
      isSymbolicLink: false,
      mode: type === 'dir' ? DIR_MODE : FILE_MODE,
      size: type === 'file' ? await this.tx.size(normalized) : 0,
      mtime: EPOCH,
    };
  }

  lstat(path: string): Promise<FsStat> {
    return this.stat(path);
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    await this.tx.mkdir(this.normalize(path), options);
  }

  async readdir(path: string): Promise<string[]> {
    return (await this.tx.readdir(this.normalize(path))).map((entry) => entry.name);
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    return (await this.tx.readdir(this.normalize(path))).map((entry) => ({
      name: entry.name,
      isFile: entry.type === 'file',
      isDirectory: entry.type === 'dir',
      isSymbolicLink: false,
    }));
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    await this.tx.rm(this.normalize(path), options);
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    await this.tx.cp(this.normalize(src), this.normalize(dest), options);
  }

  async mv(src: string, dest: string): Promise<void> {
    await this.tx.mv(this.normalize(src), this.normalize(dest));
  }

  resolvePath(base: string, path: string): string {
    return normalizeWorkspacePath(path, base || '/', { clampAtRoot: true });
  }

  getAllPaths(): string[] {
    return this.tx.allPaths();
  }

  async chmod(path: string, _mode: number): Promise<void> {
    await this.stat(path);
  }

  async symlink(_target: string, linkPath: string): Promise<void> {
    throw new WorkspaceError('EPERM', `operation not permitted, symlink '${linkPath}' (links are disabled)`);
  }

  async link(_existingPath: string, newPath: string): Promise<void> {
    throw new WorkspaceError('EPERM', `operation not permitted, link '${newPath}' (links are disabled)`);
  }

  async readlink(path: string): Promise<string> {
    throw new WorkspaceError('EPERM', `invalid argument, readlink '${path}' (not a symbolic link)`);
  }

  async realpath(path: string): Promise<string> {
    const normalized = this.normalize(path);
    if (!(await this.tx.exists(normalized))) {
      throw new WorkspaceError('ENOENT', `no such file or directory, realpath '${normalized}'`);
    }
    return normalized;
  }

  async utimes(path: string, _atime: Date, _mtime: Date): Promise<void> {
    await this.stat(path);
  }

  private normalize(path: string) {
    try {
      return normalizeWorkspacePath(path, '/', { clampAtRoot: true });
    } catch (error) {
      throw new WorkspaceError('ENOENT', `${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * just-bash passes byte output (`cat`, `cut`, `tee`, redirections of byte
 * commands) as a latin1 string with one char per byte and the encoding
 * `binary`. The session filesystem stores text, so those bytes are decoded
 * as UTF-8; treating them as text would store every multibyte character as
 * mojibake (`ä` as `Ã¤`).
 */
function decodeContent(content: FileContent, options?: WriteOptions) {
  const bytes =
    typeof content !== 'string'
      ? content
      : isByteEncoding(options)
        ? Uint8Array.from(content, (char) => char.charCodeAt(0) & 0xff)
        : undefined;
  const text = bytes ? new TextDecoder().decode(bytes) : (content as string);
  return text.replace(/\r\n/g, '\n');
}

type WriteOptions = { encoding?: BufferEncoding | null } | BufferEncoding | null;

function isByteEncoding(options: WriteOptions | undefined) {
  const encoding = typeof options === 'string' ? options : options?.encoding;
  return encoding === 'binary' || encoding === 'latin1';
}

function latin1FromBytes(bytes: Uint8Array) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return text;
}
