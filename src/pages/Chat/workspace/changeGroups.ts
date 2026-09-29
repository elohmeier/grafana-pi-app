import { diffArrays, structuredPatch } from 'diff';
import type { WorkspaceChangeGroup } from './broker';

const MAX_FRAGMENT_LENGTH = 200;

export type ChangeGroupInput = { path: string; before: string; after: string };

/**
 * Groups the changes of a change set by textual replacement. A removed line and
 * the added line at the same position of a hunk form a pair; a token diff of the
 * pair yields its replacements, for example `5m` → `$__rate_interval` inside
 * `rate(...[5m])` (twice for a line with two such ranges). Equal replacements
 * across all dashboards form one group.
 */
export function groupChanges(inputs: readonly ChangeGroupInput[]): {
  groups: WorkspaceChangeGroup[];
  ungroupedChanges: number;
} {
  const byKey = new Map<string, WorkspaceChangeGroup & { pathSet: Set<string> }>();
  let unpaired = 0;
  for (const input of inputs) {
    const patch = structuredPatch(input.path, input.path, input.before, input.after, undefined, undefined, {
      context: 0,
    });
    for (const hunk of patch.hunks) {
      const removed = hunk.lines.filter((line) => line.startsWith('-')).map((line) => line.slice(1));
      const added = hunk.lines.filter((line) => line.startsWith('+')).map((line) => line.slice(1));
      const pairs = Math.min(removed.length, added.length);
      unpaired += removed.length + added.length - 2 * pairs;
      for (let index = 0; index < pairs; index++) {
        for (const [before, after] of replacements(removed[index], added[index])) {
          const key = JSON.stringify([before, after]);
          let group = byKey.get(key);
          if (!group) {
            group = {
              before,
              after,
              count: 0,
              paths: [],
              pathSet: new Set(),
              example: { path: input.path, before: removed[index].trim(), after: added[index].trim() },
            };
            byKey.set(key, group);
          }
          group.count++;
          if (!group.pathSet.has(input.path)) {
            group.pathSet.add(input.path);
            group.paths.push(input.path);
          }
        }
      }
    }
  }
  const groups: WorkspaceChangeGroup[] = [];
  let ungroupedChanges = unpaired;
  for (const { pathSet: _pathSet, ...group } of byKey.values()) {
    if (group.count >= 2) {
      groups.push(group);
    } else {
      ungroupedChanges += group.count;
    }
  }
  groups.sort((left, right) => right.count - left.count || left.before.localeCompare(right.before));
  return { groups, ungroupedChanges };
}

const TOKEN = /[A-Za-z0-9_$]+|\s+|[^A-Za-z0-9_$\s]/g;

/**
 * The replacements that turn one line into the other, on word tokens so
 * `5m`→`1m` does not read as `5`→`1`. Adjacent changed tokens form one
 * replacement; a line whose tokens mostly changed is one whole-line replacement.
 */
export function replacements(before: string, after: string): Array<[string, string]> {
  const left = before.match(TOKEN) ?? [];
  const right = after.match(TOKEN) ?? [];
  const changes = diffArrays(left, right);
  const spans: Array<[string, string]> = [];
  let removed: string[] = [];
  let added: string[] = [];
  let unchanged = 0;
  const flush = () => {
    if (removed.length || added.length) {
      spans.push([clip(removed.join('')), clip(added.join(''))]);
    }
    removed = [];
    added = [];
  };
  for (const change of changes) {
    if (change.removed) {
      removed.push(...change.value);
    } else if (change.added) {
      added.push(...change.value);
    } else if (change.value.every((token) => /^\s+$/.test(token)) && (removed.length || added.length)) {
      // Whitespace between two changed tokens belongs to one replacement.
      removed.push(...change.value);
      added.push(...change.value);
    } else {
      unchanged += change.value.join('').length;
      flush();
    }
  }
  flush();
  if (spans.length > 3 && unchanged < Math.min(before.length, after.length) / 2) {
    return [replacement(before, after)];
  }
  return spans.filter(([from, to]) => from !== to);
}

/** The differing middle of two lines, widened to word boundaries so `5m`→`1m` does not read as `5`→`1`. */
export function replacement(before: string, after: string): [string, string] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) {
    start++;
  }
  let end = 0;
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  ) {
    end++;
  }
  while (start > 0 && isWordChar(before[start - 1])) {
    start--;
  }
  while (end > 0 && isWordChar(before[before.length - end])) {
    end--;
  }
  return [clip(before.slice(start, before.length - end)), clip(after.slice(start, after.length - end))];
}

function isWordChar(char: string | undefined) {
  return char !== undefined && /[A-Za-z0-9_$]/.test(char);
}

function clip(text: string) {
  const trimmed = text.trim();
  return trimmed.length > MAX_FRAGMENT_LENGTH ? `${trimmed.slice(0, MAX_FRAGMENT_LENGTH - 1)}…` : trimmed;
}
