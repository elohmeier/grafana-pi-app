import type { WorkspaceResourceKind } from './types';

/** Where each Grafana resource kind is mounted and what its editable document is called. */
export const RESOURCE_KINDS: Record<
  WorkspaceResourceKind,
  { root: string; document: string; noun: string; plural: string }
> = {
  dashboard: { root: '/grafana/dashboards', document: 'dashboard.json', noun: 'dashboard', plural: 'dashboards' },
  alertRule: { root: '/grafana/alert-rules', document: 'rule.json', noun: 'alert rule', plural: 'alert rules' },
};

export const RESOURCE_KIND_NAMES = Object.keys(RESOURCE_KINDS) as WorkspaceResourceKind[];
export const RESOURCE_META = 'meta.json';
export const RESOURCE_UID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

export function resourceDocumentPath(kind: WorkspaceResourceKind, uid: string) {
  return `${RESOURCE_KINDS[kind].root}/${uid}/${RESOURCE_KINDS[kind].document}`;
}

export function resourceMetaPath(kind: WorkspaceResourceKind, uid: string) {
  return `${RESOURCE_KINDS[kind].root}/${uid}/${RESOURCE_META}`;
}

/** Map key of a resource: UIDs are unique per kind only. */
export function resourceKey(kind: WorkspaceResourceKind, uid: string) {
  return `${kind}:${uid}`;
}

/** The resource document or directory a path names, for example `/grafana/alert-rules/<uid>`. */
export function resourceAtPath(path: string): { kind: WorkspaceResourceKind; uid: string } | undefined {
  for (const kind of RESOURCE_KIND_NAMES) {
    const { root, document } = RESOURCE_KINDS[kind];
    if (!path.startsWith(`${root}/`)) {
      continue;
    }
    const [uid, file, ...rest] = path.slice(root.length + 1).split('/');
    if (RESOURCE_UID_PATTERN.test(uid) && rest.length === 0 && (file === undefined || file === document)) {
      return { kind, uid };
    }
  }
  return undefined;
}

/** Counts per kind as "3 dashboards and 1 alert rule". */
export function describeResourceCounts(counts: Partial<Record<WorkspaceResourceKind, number>>) {
  const parts = RESOURCE_KIND_NAMES.filter((kind) => counts[kind]).map(
    (kind) => `${counts[kind]} ${counts[kind] === 1 ? RESOURCE_KINDS[kind].noun : RESOURCE_KINDS[kind].plural}`
  );
  return parts.length ? parts.join(' and ') : '0 resources';
}
