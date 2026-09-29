import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

// The session must run outside a Grafana page (a later server host), so its
// import graph may not reach UI or Grafana runtime packages. Type-only imports are erased.
const FORBIDDEN = [/^react(-dom)?(\/|$)/, /^@grafana\/(runtime|scenes|ui)(\/|$)/, /^@emotion\//];
const ENTRY = path.join(__dirname, 'AssistantSession.ts');

function resolveLocal(from: string, specifier: string) {
  const base = path.resolve(path.dirname(from), specifier);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), base]) {
    if (existsSync(candidate) && /\.tsx?$/.test(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function valueImports(file: string) {
  const source = readFileSync(file, 'utf8');
  const specifiers: string[] = [];
  const pattern = /^(?:import|export)\s+(type\s+)?(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;
  for (const match of source.matchAll(pattern)) {
    if (!match[1]) {
      specifiers.push(match[2]);
    }
  }
  return specifiers;
}

it('keeps the session core free of React, Scenes, and @grafana/runtime', () => {
  const seen = new Set<string>();
  const violations: string[] = [];
  const visit = (file: string) => {
    if (seen.has(file)) {
      return;
    }
    seen.add(file);
    for (const specifier of valueImports(file)) {
      if (specifier.startsWith('.')) {
        const resolved = resolveLocal(file, specifier);
        if (resolved) {
          visit(resolved);
        }
      } else if (FORBIDDEN.some((pattern) => pattern.test(specifier))) {
        violations.push(`${path.relative(__dirname, file)} imports ${specifier}`);
      }
    }
  };
  visit(ENTRY);
  expect(seen.size).toBeGreaterThan(10);
  expect(violations).toEqual([]);
});
