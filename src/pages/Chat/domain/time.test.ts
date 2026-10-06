import { grafanaTime } from './time';

describe('grafanaTime', () => {
  it('keeps date math, reads epoch seconds and milliseconds, and converts ISO timestamps (UTC without an offset)', () => {
    const nine = String(Date.UTC(2026, 9, 3, 9));
    expect(grafanaTime('now-6h')).toBe('now-6h');
    expect(grafanaTime('1791018000000')).toBe('1791018000000');
    expect(grafanaTime('1791018000')).toBe('1791018000000');
    expect(grafanaTime('2026-10-03T09:00:00Z')).toBe(nine);
    expect(grafanaTime('2026-10-03T09:00')).toBe(nine);
    expect(grafanaTime('2026-10-03 09:00')).toBe(nine);
    expect(grafanaTime('2026-10-03T11:00:00+02:00')).toBe(nine);
    expect(grafanaTime('2026-10-03')).toBe(String(Date.UTC(2026, 9, 3)));
    expect(grafanaTime('yesterday')).toBeUndefined();
  });
});
