import { addPromqlLabelFilter } from './promqlLabelFilter';

describe('addPromqlLabelFilter', () => {
  it('adds a matcher to bare and existing selectors', () => {
    const result = addPromqlLabelFilter(
      'sum(rate(http_requests_total[5m])) / sum(rate(http_requests_total{status=~"2.."}[5m]))',
      'env',
      '=~',
      '$env'
    );

    expect(result).toEqual({
      expression:
        'sum(rate(http_requests_total{env=~"$env"}[5m])) / sum(rate(http_requests_total{status=~"2..", env=~"$env"}[5m]))',
      changed: true,
      selectorCount: 2,
      changedSelectorCount: 2,
    });
  });

  it('is idempotent when the matcher already has the requested value', () => {
    const expression = 'sum(rate(http_requests_total{env=~"$env"}[$__rate_interval]))';

    expect(addPromqlLabelFilter(expression, 'env', '=~', '$env')).toEqual({
      expression,
      changed: false,
      selectorCount: 1,
      changedSelectorCount: 0,
    });
  });

  it('replaces an existing matcher by default', () => {
    expect(addPromqlLabelFilter('up{env="prod", job="api"}', 'env', '=~', '$env').expression).toBe(
      'up{env=~"$env", job="api"}'
    );
  });

  it('can preserve or reject an existing matcher', () => {
    expect(addPromqlLabelFilter('up{env="prod"}', 'env', '=~', '$env', 'keep').expression).toBe('up{env="prod"}');
    expect(() => addPromqlLabelFilter('up{env="prod"}', 'env', '=~', '$env', 'error')).toThrow(
      'already contains matcher for label env'
    );
  });

  it('handles empty and trailing-comma matcher lists', () => {
    expect(addPromqlLabelFilter('up{}', 'env', '=~', '$env').expression).toBe('up{env=~"$env"}');
    expect(addPromqlLabelFilter('up{job="api",}', 'env', '=~', '$env').expression).toBe('up{job="api", env=~"$env"}');
  });

  it('rejects malformed PromQL and invalid label names', () => {
    expect(() => addPromqlLabelFilter('sum(rate(up{[5m]))', 'env', '=~', '$env')).toThrow('could not be parsed safely');
    expect(() => addPromqlLabelFilter('up', 'bad-label', '=~', '$env')).toThrow('Invalid Prometheus label name');
  });
});
