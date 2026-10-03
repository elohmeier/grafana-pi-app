/** Counters and gauges of the assistant host in the Prometheus text format (`GET /metrics`). */
export class Metrics {
  private counters = new Map<string, { help: string; values: Map<string, number> }>();
  private gauges: Array<{ name: string; help: string; value: () => number }> = [];

  inc(name: string, help: string, labels: Record<string, string> = {}) {
    const counter = this.counters.get(name) ?? { help, values: new Map<string, number>() };
    this.counters.set(name, counter);
    const key = Object.entries(labels)
      .map(([label, value]) => `${label}="${value.replace(/["\\\n]/g, '_')}"`)
      .join(',');
    counter.values.set(key, (counter.values.get(key) ?? 0) + 1);
  }

  gauge(name: string, help: string, value: () => number) {
    this.gauges.push({ name, help, value });
  }

  render() {
    const lines: string[] = [];
    for (const [name, counter] of this.counters) {
      lines.push(`# HELP ${name} ${counter.help}`, `# TYPE ${name} counter`);
      for (const [labels, value] of counter.values) {
        lines.push(`${name}${labels ? `{${labels}}` : ''} ${value}`);
      }
    }
    for (const gauge of this.gauges) {
      lines.push(`# HELP ${gauge.name} ${gauge.help}`, `# TYPE ${gauge.name} gauge`, `${gauge.name} ${gauge.value()}`);
    }
    return `${lines.join('\n')}\n`;
  }
}
