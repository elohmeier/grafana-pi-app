// Jest setup provided by Grafana scaffolding. It patches DOM classes, so it applies to jsdom tests only;
// tests of the Node assistant host (src/host) run with `@jest-environment node`.
if (typeof window !== 'undefined') {
  require('./.config/jest-setup');
}

// jsdom does not expose structuredClone, which Pi Durable uses to detach records. The clone must be
// created in this realm: Chord rejects objects whose prototype is another realm's Object.prototype.
if (typeof globalThis.structuredClone !== 'function') {
  const clone = (value, seen) => {
    if (value === null || typeof value !== 'object') {
      return value;
    }
    if (seen.has(value)) {
      return seen.get(value);
    }
    if (value instanceof Date) {
      return new Date(value.getTime());
    }
    if (ArrayBuffer.isView(value)) {
      return value.slice();
    }
    if (value instanceof Map) {
      const copy = new Map();
      seen.set(value, copy);
      value.forEach((item, key) => copy.set(clone(key, seen), clone(item, seen)));
      return copy;
    }
    if (value instanceof Set) {
      const copy = new Set();
      seen.set(value, copy);
      value.forEach((item) => copy.add(clone(item, seen)));
      return copy;
    }
    const copy = Array.isArray(value) ? [] : {};
    seen.set(value, copy);
    for (const key of Object.keys(value)) {
      copy[key] = clone(value[key], seen);
    }
    return copy;
  };
  globalThis.structuredClone = (value) => clone(value, new Map());
}
