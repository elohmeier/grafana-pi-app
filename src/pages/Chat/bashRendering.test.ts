import { highlightBash } from './bashRendering';

describe('Bash highlighting', () => {
  it.each([
    '',
    "grafana-prom query 'sum(rate(http_requests_total[5m]))' | jq '.data.result' > /session/result.json\n",
    'for x in a b; do echo "${x:-default} $(date)"; done',
    "cat <<'EOF' > /session/dashboard.jsonnet\n{ title: 'Demo', panels: [] }\nEOF\n",
    'cat <<-EOF\n\t$x\n\tEOF\n',
    "grafana-prom query 'unfinished",
    'echo "$(jq ',
    '# comment\r\nprintf "🦊 <script>alert(1)</script>"\r\n',
    "grafana-prom query 'sum(\n  rate(requests[5m])\n)' \\\n  | jq '.data'",
  ])('preserves the exact source: %j', (command) => {
    expect(
      highlightBash(command)
        ?.map((token) => token.text)
        .join('')
    ).toBe(command);
  });

  it('colors workspace commands, strings, and pipeline operators', () => {
    const tokens = highlightBash("grafana-prom query 'up' | jq '.data' > result.json");
    expect(tokens).toEqual(
      expect.arrayContaining([
        { text: 'grafana-prom', kind: 'builtin' },
        { text: "'up'", kind: 'string' },
        { text: '|', kind: 'operator' },
        { text: 'jq', kind: 'builtin' },
      ])
    );
  });

  it('keeps quoted heredocs literal and colors nested substitutions', () => {
    const literal = "cat <<'EOF'\n$HOME $(grafana search)\nEOF";
    const body = highlightBash(literal)?.find((token) => token.text.includes('$HOME'));
    expect(body?.kind).toBe('string');
    expect(highlightBash('echo "${x} $(date)"')).toEqual(
      expect.arrayContaining([
        { text: '${x}', kind: 'key' },
        { text: 'date', kind: 'builtin' },
      ])
    );
  });

  it('falls back to plain text for large scripts', () => {
    expect(highlightBash('x'.repeat(20001))).toBeUndefined();
    expect(highlightBash('echo x\n'.repeat(501))).toBeUndefined();
  });
});
