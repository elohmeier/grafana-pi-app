/**
 * A time argument as Grafana's query and render APIs take it: date math as it
 * is, epoch seconds or milliseconds as milliseconds, and ISO timestamps (UTC
 * unless they name an offset; a space may separate date and time) as epoch
 * milliseconds. Undefined when the value is none of these.
 */
export function grafanaTime(value: string): string | undefined {
  if (value.startsWith('now')) {
    return value;
  }
  if (/^\d{10}$/.test(value)) {
    return `${value}000`;
  }
  if (/^\d+$/.test(value)) {
    return value;
  }
  const iso = value.replace(' ', 'T');
  // Date-only values are UTC in JavaScript already; date-times without an offset would be local time.
  const zoned = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(iso) || !iso.includes('T') ? iso : `${iso}Z`;
  const time = Date.parse(zoned);
  return Number.isNaN(time) ? undefined : String(time);
}
