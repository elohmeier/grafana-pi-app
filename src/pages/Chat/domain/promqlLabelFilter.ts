import { parser as promqlParser } from '@prometheus-io/lezer-promql';

export type ExistingPromqlMatcherStrategy = 'replace' | 'keep' | 'error';

export type PromqlLabelFilterResult = {
  expression: string;
  changed: boolean;
  selectorCount: number;
  changedSelectorCount: number;
};

type TextEdit = {
  from: number;
  to: number;
  text: string;
};

const PROMETHEUS_LABEL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function addPromqlLabelFilter(
  expression: string,
  label: string,
  operator: '=~' | '=' | '!=' | '!~',
  value: string,
  existingMatcher: ExistingPromqlMatcherStrategy = 'replace'
): PromqlLabelFilterResult {
  if (!expression.trim()) {
    throw new Error('PromQL expression is required.');
  }
  if (!PROMETHEUS_LABEL_NAME.test(label)) {
    throw new Error(`Invalid Prometheus label name: ${label}`);
  }

  const tree = promqlParser.parse(maskGrafanaDurationMacros(expression));
  let parseError = false;
  tree.iterate({
    enter(node) {
      parseError ||= node.type.isError;
    },
  });
  if (parseError) {
    throw new Error('PromQL expression could not be parsed safely.');
  }

  const matcher = `${label}${operator}${JSON.stringify(value)}`;
  const edits: TextEdit[] = [];
  let selectorCount = 0;
  let changedSelectorCount = 0;

  tree.iterate({
    enter(node) {
      if (node.name !== 'VectorSelector') {
        return;
      }

      selectorCount += 1;
      const labelMatchers = node.node.getChild('LabelMatchers');
      if (!labelMatchers) {
        edits.push({ from: node.to, to: node.to, text: `{${matcher}}` });
        changedSelectorCount += 1;
        return;
      }

      const existing = labelMatchers
        .getChildren('UnquotedLabelMatcher')
        .concat(labelMatchers.getChildren('QuotedLabelMatcher'));
      const matching = existing.filter(
        (candidate) => matcherLabel(expression.slice(candidate.from, candidate.to)) === label
      );
      if (matching.length > 1) {
        throw new Error(`PromQL selector contains duplicate ${label} matchers.`);
      }

      const current = matching[0];
      if (current) {
        const currentText = expression.slice(current.from, current.to);
        if (normalizeMatcher(currentText) === normalizeMatcher(matcher) || existingMatcher === 'keep') {
          return;
        }
        if (existingMatcher === 'error') {
          throw new Error(`PromQL selector already contains matcher for label ${label}.`);
        }
        edits.push({ from: current.from, to: current.to, text: matcher });
        changedSelectorCount += 1;
        return;
      }

      const body = expression.slice(labelMatchers.from + 1, labelMatchers.to - 1);
      const prefix = body.trim() ? (body.trimEnd().endsWith(',') ? ' ' : ', ') : '';
      edits.push({ from: labelMatchers.to - 1, to: labelMatchers.to - 1, text: `${prefix}${matcher}` });
      changedSelectorCount += 1;
    },
  });

  const updated = edits
    .sort((left, right) => right.from - left.from)
    .reduce((value, edit) => `${value.slice(0, edit.from)}${edit.text}${value.slice(edit.to)}`, expression);

  return {
    expression: updated,
    changed: edits.length > 0,
    selectorCount,
    changedSelectorCount,
  };
}

function matcherLabel(matcher: string) {
  const match = matcher.match(/^\s*(?:"((?:\\.|[^"\\])*)"|([A-Za-z_][A-Za-z0-9_]*))\s*(?:=~|!~|!=|=)/);
  if (!match) {
    return undefined;
  }
  if (match[2]) {
    return match[2];
  }

  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return undefined;
  }
}

function normalizeMatcher(matcher: string) {
  return matcher.replace(/\s+/g, '');
}

function maskGrafanaDurationMacros(expression: string) {
  return expression.replace(
    /\$(?:__interval|__rate_interval|__range)(?:_ms|_s)?|\$\{(?:__interval|__rate_interval|__range)(?:_ms|_s)?\}/g,
    (macro) => '1m'.padEnd(macro.length, ' ')
  );
}
