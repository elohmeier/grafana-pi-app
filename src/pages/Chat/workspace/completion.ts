import { WORKSPACE_COMMANDS } from './commands/commands';
import type { WorkspaceCommandSpec } from './commands/registry';
import { WORKSPACE_BUILTIN_COMMANDS } from './execution/engine';
import { normalizeWorkspacePath } from './paths';
import type { SessionWorkspace } from './workspace';

export type CompletionKind = 'command' | 'subcommand' | 'option' | 'directory' | 'file';

export type CompletionCandidate = {
  /** Text that replaces the word being completed. */
  value: string;
  /** Shown in the candidate list (the last path segment for paths). */
  label: string;
  kind: CompletionKind;
  description?: string;
};

export type CompletionResult = {
  /** Range of the word being completed in the input. */
  start: number;
  end: number;
  candidates: CompletionCandidate[];
  /** Replacement for the word: the longest common prefix, plus a space when it is complete. */
  replacement: string;
};

export type CompletionSources = {
  commands: readonly WorkspaceCommandSpec[];
  /** Other command names: just-bash builtins, jq, python3. */
  builtins: readonly string[];
  /** Every path of the session filesystem, directories included. */
  paths: readonly string[];
  /** Directories that may be empty (mount roots, created directories); others are inferred from paths. */
  directories?: ReadonlySet<string>;
  cwd: string;
};

/** Characters that end a word and start a new simple command. */
const COMMAND_SEPARATORS = new Set(['|', ';', '&', '(', ')']);
const REDIRECTS = new Set(['<', '>']);

/**
 * Tab completion of a shell line at the caret: command names in command
 * position, subcommands and `--options` of workspace commands from their
 * registry specs, and paths of the session filesystem everywhere else.
 */
export function completeShellLine(
  line: string,
  caret: number,
  sources: CompletionSources
): CompletionResult | undefined {
  const { words, word, start, redirectTarget } = wordsBeforeCaret(line.slice(0, caret));
  let candidates: CompletionCandidate[];
  const spec = sources.commands.find((command) => command.name === words[0]);
  if (redirectTarget) {
    candidates = pathCandidates(word, sources);
  } else if (words.length === 0) {
    candidates = commandCandidates(word, sources);
  } else if (spec && word.startsWith('-')) {
    candidates = optionCandidates(spec, words[1], word);
  } else if (spec && words.length === 1) {
    candidates = [
      ...Object.entries(spec.subcommands)
        .filter(([name]) => name.startsWith(word))
        .map(([name, sub]) => ({ value: name, label: name, kind: 'subcommand' as const, description: sub.summary })),
      // `jsonnet FILE` runs its default subcommand, so paths complete too.
      ...(spec.defaultSubcommand ? pathCandidates(word, sources) : []),
    ];
  } else {
    candidates = pathCandidates(word, sources);
  }
  if (candidates.length === 0) {
    return undefined;
  }
  const prefix = commonPrefix(candidates.map((candidate) => candidate.value));
  const complete = candidates.length === 1 && !prefix.endsWith('/');
  return { start, end: caret, candidates, replacement: complete ? `${prefix} ` : prefix };
}

/** The words of the current simple command before the caret, and the partial word at the caret. */
function wordsBeforeCaret(text: string) {
  let words: string[] = [];
  let word = '';
  let start = 0;
  let quote: string | undefined;
  // Whether the word being built follows `>` or `<`: a redirect target, not an argument.
  let redirectTarget = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        word += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
    } else if (char === '\\' && index + 1 < text.length) {
      word += text[++index];
    } else if (/\s/.test(char) || COMMAND_SEPARATORS.has(char) || REDIRECTS.has(char)) {
      if (word) {
        if (!redirectTarget) {
          words.push(word);
        }
        redirectTarget = false;
      }
      if (REDIRECTS.has(char)) {
        redirectTarget = true;
      }
      if (COMMAND_SEPARATORS.has(char)) {
        words = [];
        redirectTarget = false;
      }
      word = '';
      start = index + 1;
    } else {
      word += char;
    }
  }
  return { words, word, start, redirectTarget };
}

function commandCandidates(word: string, sources: CompletionSources): CompletionCandidate[] {
  const seen = new Set<string>();
  const candidates: CompletionCandidate[] = [];
  for (const command of sources.commands) {
    if (command.name.startsWith(word) && !seen.has(command.name)) {
      seen.add(command.name);
      candidates.push({ value: command.name, label: command.name, kind: 'command', description: command.summary });
    }
  }
  for (const name of sources.builtins) {
    if (name.startsWith(word) && !seen.has(name)) {
      seen.add(name);
      candidates.push({ value: name, label: name, kind: 'command' });
    }
  }
  return candidates.sort((left, right) => left.value.localeCompare(right.value));
}

function optionCandidates(spec: WorkspaceCommandSpec, subcommand: string | undefined, word: string) {
  const sub =
    (subcommand && spec.subcommands[subcommand]) ||
    (spec.defaultSubcommand && spec.subcommands[spec.defaultSubcommand]);
  const options = Object.entries(sub ? (sub.options ?? {}) : {}).map(([name, option]) => ({
    value: `--${name}`,
    label: `--${name}`,
    kind: 'option' as const,
    description: option.description,
  }));
  options.push({ value: '--help', label: '--help', kind: 'option', description: 'Show usage and options.' });
  return options.filter((option) => option.value.startsWith(word));
}

function pathCandidates(word: string, sources: CompletionSources): CompletionCandidate[] {
  const slash = word.lastIndexOf('/');
  const dirPart = slash >= 0 ? word.slice(0, slash + 1) : '';
  const base = word.slice(slash + 1);
  let directory: string;
  try {
    directory = normalizeWorkspacePath(dirPart || '.', sources.cwd);
  } catch {
    return [];
  }
  const directories = new Set<string>(sources.directories);
  const children = new Map<string, boolean>();
  for (const path of sources.paths) {
    const parent = path.slice(0, path.lastIndexOf('/')) || '/';
    if (parent !== '/') {
      directories.add(parent);
    }
    if (parent === directory && path !== directory) {
      children.set(path.slice(parent === '/' ? 1 : parent.length + 1), false);
    }
  }
  const candidates: CompletionCandidate[] = [];
  for (const name of children.keys()) {
    if (!name.startsWith(base) || (name.startsWith('.') && !base.startsWith('.'))) {
      continue;
    }
    const absolute = directory === '/' ? `/${name}` : `${directory}/${name}`;
    const isDirectory = directories.has(absolute);
    candidates.push({
      value: `${dirPart}${name}${isDirectory ? '/' : ''}`,
      label: `${name}${isDirectory ? '/' : ''}`,
      kind: isDirectory ? 'directory' : 'file',
    });
  }
  return candidates.sort((left, right) => left.value.localeCompare(right.value));
}

function commonPrefix(values: string[]) {
  let prefix = values[0] ?? '';
  for (const value of values.slice(1)) {
    let length = 0;
    while (length < prefix.length && prefix[length] === value[length]) {
      length++;
    }
    prefix = prefix.slice(0, length);
  }
  return prefix;
}

/** Completion sources for the composer: the workspace commands and every current path of the session filesystem. */
export async function workspaceCompletionSources(workspace: SessionWorkspace, cwd: string): Promise<CompletionSources> {
  // Loads the dashboard listing and generated mount listings, as before a bash invocation.
  await workspace.prepareMounts();
  const tx = workspace.begin();
  try {
    const paths = tx.allPaths();
    const directories = new Set<string>([...workspace.mountRoots(), ...workspace.scratchDirs()]);
    return {
      commands: WORKSPACE_COMMANDS,
      builtins: [...WORKSPACE_BUILTIN_COMMANDS, 'jq', 'python3', 'python'],
      paths,
      directories,
      cwd,
    };
  } finally {
    tx.abort();
  }
}
