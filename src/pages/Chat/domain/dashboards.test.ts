import { renderTime } from './dashboards';

describe('renderTime', () => {
  it('keeps date math and epoch milliseconds and converts ISO timestamps (UTC without a zone)', () => {
    expect(renderTime('now-6h')).toBe('now-6h');
    expect(renderTime('1791018000000')).toBe('1791018000000');
    expect(renderTime('2026-10-03T09:00:00Z')).toBe(String(Date.UTC(2026, 9, 3, 9)));
    expect(renderTime('2026-10-03T09:00')).toBe(String(Date.UTC(2026, 9, 3, 9)));
    expect(renderTime('2026-10-03T11:00:00+02:00')).toBe(String(Date.UTC(2026, 9, 3, 9)));
  });
});
