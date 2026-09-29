import { parser as lezerPromqlParser } from '@prometheus-io/lezer-promql';
import {
  collectPanels,
  collectVariables,
  datasourceType,
  prepareTargets,
  unresolvedVariables,
  unwrapDashboard,
  asText,
} from './dashboardPanels';

export type PromqlParseResult = { id: string; error?: string; start?: number; end?: number };

/** Parses expressions in one batch; results are returned in request order. */
export type PromqlParser = {
  name: 'prometheus' | 'lezer';
  parse: (queries: Array<{ id: string; expr: string }>, signal?: AbortSignal) => Promise<PromqlParseResult[]>;
};

export type PromqlQueryRecord = {
  id: string;
  panel: string;
  title: string;
  refId: string;
  /** Expression as stored in the dashboard. */
  expr: string;
  /** Interpolated expression sent to the parser. */
  probe: string;
  hidden?: boolean;
};

export type PromqlCheckDiagnostic = {
  panel: string;
  title: string;
  refId: string;
  expr: string;
  message: string;
};

export type PromqlCheckReport = {
  parser: PromqlParser['name'];
  checked: number;
  errors: PromqlCheckDiagnostic[];
  /** Queries not parsed because they are not PromQL. */
  skipped: Array<{ panel: string; title: string; refId: string; reason: string }>;
};

// Placeholders for syntax probes only; the backend computes real macro values from the request range.
const MACRO_PLACEHOLDERS: Record<string, string> = {
  __rate_interval: '5m',
  __interval: '1m',
  __range: '30m',
  __rate_interval_ms: '300000',
  __interval_ms: '60000',
  __range_s: '1800',
  __range_ms: '1800000',
  __from: '1700000000000',
  __to: '1700001800000',
};
const MACRO_RE = /\$\{(__[a-z_]+)(?::[^}]*)?\}|\$(__[a-z_]+)/g;
const IGNORED_BUILTINS = /\$\{?__(?:dashboard|org|user|name|all)\b[^}\s]*\}?/g;

/** Replaces Grafana macros such as `$__rate_interval` with placeholder values for a syntax probe. */
export function promqlProbe(expr: string) {
  return expr
    .replace(MACRO_RE, (match, braced, bare) => MACRO_PLACEHOLDERS[braced || bare] ?? match)
    .replace(IGNORED_BUILTINS, 'builtin');
}

/**
 * Collects PromQL targets from every panel, including collapsed rows, hidden
 * targets, and inactive tabs, interpolated with the saved variable values.
 */
export function collectPromqlQueries(resource: unknown): {
  queries: PromqlQueryRecord[];
  unresolved: PromqlCheckDiagnostic[];
  skipped: PromqlCheckReport['skipped'];
} {
  const [shape, dashboard] = unwrapDashboard(resource);
  const variables = collectVariables(shape, dashboard);
  const panels = collectPanels(shape, dashboard, { includeCollapsed: true, includeHiddenTargets: true });
  const queries: PromqlQueryRecord[] = [];
  const unresolved: PromqlCheckDiagnostic[] = [];
  const skipped: PromqlCheckReport['skipped'] = [];
  for (const panel of panels) {
    const prepared = prepareTargets(panel, variables);
    panel.targets.forEach((original, index) => {
      const refId = asText(original.refId);
      const identity = { panel: panel.id, title: panel.title, refId };
      const type = datasourceType(original);
      const expr = typeof original.expr === 'string' ? original.expr : undefined;
      if (type === '__expr__' || expr === undefined) {
        return;
      }
      if (type && type !== 'prometheus') {
        skipped.push({ ...identity, reason: `no syntax parser for ${type}` });
        return;
      }
      if (!expr.trim()) {
        return;
      }
      const probe = promqlProbe(asText(prepared[index]?.expr));
      const missing = unresolvedVariables(probe);
      if (missing.length > 0) {
        unresolved.push({
          ...identity,
          expr,
          message: `undefined dashboard variable ${[...new Set(missing)].map((name) => `$${name}`).join(', ')}`,
        });
        return;
      }
      queries.push({
        id: `${panel.key}/${refId}/${index}`,
        ...identity,
        expr,
        probe,
        ...(original.hide ? { hidden: true } : {}),
      });
    });
  }
  return { queries, unresolved, skipped };
}

export async function checkDashboardPromql(
  resource: unknown,
  parser: PromqlParser = lezerParser,
  signal?: AbortSignal
): Promise<PromqlCheckReport> {
  const { queries, unresolved, skipped } = collectPromqlQueries(resource);
  const results = queries.length
    ? await parser.parse(
        queries.map(({ id, probe }) => ({ id, expr: probe })),
        signal
      )
    : [];
  const byId = new Map(results.map((result) => [result.id, result]));
  const errors = [...unresolved];
  for (const query of queries) {
    const result = byId.get(query.id);
    if (result?.error) {
      errors.push({
        panel: query.panel,
        title: query.title,
        refId: query.refId,
        expr: query.expr,
        message: query.probe !== query.expr ? `${result.error} (interpolated: ${query.probe})` : result.error,
      });
    }
  }
  return { parser: parser.name, checked: queries.length, errors, skipped };
}

/** Offline fallback when the backend parser is unavailable. Less strict than the upstream parser. */
export const lezerParser: PromqlParser = {
  name: 'lezer',
  async parse(queries) {
    return queries.map(({ id, expr }) => {
      let errorAt: number | undefined;
      lezerPromqlParser.parse(expr).iterate({
        enter(node) {
          if (errorAt === undefined && node.type.isError) {
            errorAt = node.from;
          }
        },
      });
      return errorAt === undefined ? { id } : { id, error: `syntax error near offset ${errorAt}`, start: errorAt };
    });
  },
};
