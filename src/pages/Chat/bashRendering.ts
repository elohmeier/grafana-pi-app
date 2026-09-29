import Prism from 'prismjs/components/prism-core';
import 'prismjs/components/prism-bash';
import type { CodeToken, CodeTokenKind } from './jsonnetRendering';

// Only use the token API: React owns the DOM and Grafana owns the theme.
Prism.manual = true;

const bashFunctions = Prism.languages.bash.function ?? [];
const bashGrammar = Prism.languages.extend('bash', {
  function: [
    {
      pattern:
        /(^|[\s;|&]|[<>]\()(?:grafana(?:-prom|-usage|-dashboard|-alert)?|workspace|live|jsonnet|jq|yq|rg)(?=$|[)\s;|&<>])/,
      lookbehind: true,
    },
    ...(Array.isArray(bashFunctions) ? bashFunctions : [bashFunctions]),
  ],
});

const tokenKinds: Record<string, CodeTokenKind> = {
  comment: 'comment',
  keyword: 'keyword',
  boolean: 'keyword',
  string: 'string',
  'heredoc-string': 'string',
  number: 'number',
  builtin: 'builtin',
  function: 'builtin',
  'function-name': 'builtin',
  variable: 'key',
  environment: 'key',
  'assign-left': 'key',
  'for-or-select': 'key',
  parameter: 'key',
  operator: 'operator',
  punctuation: 'punctuation',
};

export function highlightBash(command: string): CodeToken[] | undefined {
  // Bound synchronous regex work and the number of React spans in chat history.
  if (command.length > 20000 || command.split('\n').length > 500) {
    return undefined;
  }

  try {
    const result: CodeToken[] = [];
    const append = (value: string | Prism.Token | Array<string | Prism.Token>, inherited?: CodeTokenKind) => {
      if (typeof value === 'string') {
        const last = result[result.length - 1];
        if (last && last.kind === inherited) {
          last.text += value;
        } else if (value) {
          result.push({ text: value, kind: inherited });
        }
      } else if (Array.isArray(value)) {
        value.forEach((token) => append(token, inherited));
      } else {
        append(value.content, tokenKinds[value.type] ?? inherited);
      }
    };
    append(Prism.tokenize(command, bashGrammar));
    return result;
  } catch {
    // An incomplete streamed command or a tokenizer failure must not hide the source.
    return undefined;
  }
}
