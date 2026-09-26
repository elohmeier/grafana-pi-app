import { PLUGIN_BASE_URL } from '../../../constants';

export type NavigateParams = {
  type: 'dashboard' | 'prometheus_explore' | 'app_chat' | 'relative';
  uid?: string;
  slug?: string;
  datasourceUid?: string;
  query?: string;
  start?: string;
  end?: string;
  path?: string;
};

export function buildNavigationPath(args: NavigateParams) {
  switch (args.type) {
    case 'dashboard':
      return dashboardPath(args);
    case 'prometheus_explore':
      return prometheusExplorePath(args);
    case 'app_chat':
      return `${PLUGIN_BASE_URL}/chat`;
    case 'relative':
      return safeRelativePath(args.path);
  }
}

function dashboardPath(args: NavigateParams) {
  const uid = requiredString(args.uid, 'uid');
  const slug = normalizeSlug(args.slug ?? uid) || uid;
  return `/d/${encodeURIComponent(uid)}/${encodeURIComponent(slug)}`;
}

function prometheusExplorePath(args: NavigateParams) {
  const datasourceUid = requiredString(args.datasourceUid, 'datasourceUid');
  const query = requiredString(args.query, 'query');
  const datasource = {
    type: 'prometheus',
    uid: datasourceUid,
  };
  const left = {
    datasource: datasourceUid,
    queries: [
      {
        refId: 'A',
        datasource,
        expr: query,
        range: true,
        instant: false,
        editorMode: 'code',
      },
    ],
    range: {
      from: args.start ?? 'now-1h',
      to: args.end ?? 'now',
    },
  };

  return `/explore?left=${encodeURIComponent(JSON.stringify(left))}`;
}

function safeRelativePath(path: string | undefined) {
  const value = requiredString(path, 'path');
  if (!value.startsWith('/') || value.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(value)) {
    throw new Error('path must be a Grafana-relative path starting with /.');
  }
  return value;
}

function requiredString(value: string | undefined, field: string) {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${field} is required for this destination`);
  }
  return trimmed;
}

function normalizeSlug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}
