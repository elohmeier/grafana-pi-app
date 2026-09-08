import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { prepareFixtureEnvironment, inspectPreparedStack } from './prepare.mjs';

// Both runners prepare the same locked stack; callers supply their full wall-time budget.
export async function prepareStack({
  prepare,
  values,
  config,
  grafanaUrl,
  run,
  cases,
  env,
  abort,
  directory,
  id,
  command,
  save,
  log = console.log,
}) {
  if (prepare) {
    const grafana = new URL(grafanaUrl);
    if (!['localhost', '127.0.0.1'].includes(grafana.hostname) || grafana.port !== '3001') {
      throw new Error(
        'Automatic stack preparation targets localhost:3001. Use --reuse-stack for another Grafana installation.'
      );
    }
    const statePath = path.resolve('artifacts/benchmark-stack.json');
    let state;
    try {
      state = JSON.parse(await readFile(statePath, 'utf8'));
    } catch {
      /* First prepared run. */
    }
    const reuse = values.prepare
      ? { reusable: false, reason: 'Fresh preparation explicitly requested' }
      : await inspectPreparedStack(
          state,
          config.model,
          run.environment.sourceSha256,
          grafanaUrl,
          cases,
          env,
          abort.signal
        );
    if (reuse.reusable) {
      log('[benchmark-setup] Reusing verified Grafana configuration and valid fixture history.');
      run.environment.fixtures = { ...state.fixtures, reused: true };
      if (reuse.seedSamples) {
        log('[benchmark-setup] Restoring missing Grafana sample dashboards/alerts.');
        const code = await command(
          process.execPath,
          ['scripts/seed-dev-samples.mjs'],
          env,
          path.join(directory, 'prepare.log')
        );
        if (code !== 0) {
          throw new Error('Grafana sample seeding failed; see prepare.log');
        }
      }
    } else {
      const prepared = await prepareFixtureEnvironment(directory, id, cases, env);
      Object.assign(env, prepared.env);
      run.environment.fixtures = { ...prepared.fixtures, reused: false };
      await save();
      log(
        `[benchmark-setup] ${reuse.reason}. Building and seeding fresh isolated fixtures; progress is in prepare.log.`
      );
      const code = await command('mise', ['run', 'dev:reload:variant:seed'], env, path.join(directory, 'prepare.log'));
      if (code !== 0) {
        throw new Error('Stack preparation failed; see prepare.log');
      }
      run.environment.prepared = true;
    }
  }
  const health = await fetch(`${grafanaUrl}/api/health`, { signal: AbortSignal.timeout(10_000) });
  if (!health.ok) {
    throw new Error(`Grafana health check failed: HTTP ${health.status}`);
  }
  const { version, commit } = await health.json();
  run.environment.grafana = { version, commit };
  if (prepare) {
    const query = 'max(count_over_time(http_requests_total[6h]))';
    const response = await fetch(`http://127.0.0.1:9090/api/v1/query?query=${encodeURIComponent(query)}`, {
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]),
    });
    const data = await response.json();
    const samples = Number(data.data?.result?.[0]?.value?.[1] ?? 0);
    if (!response.ok || data.status !== 'success' || samples < 300) {
      throw new Error(
        'Prepared Prometheus history is incomplete; expected at least 300 samples per HTTP series over six hours.'
      );
    }
    run.environment.fixtures.validation = { query, samples, checkedAt: new Date().toISOString() };
    const state = { grafanaUrl, sourceSha256: run.environment.sourceSha256, fixtures: run.environment.fixtures };
    await writeFile(path.resolve('artifacts/benchmark-stack.json.tmp'), JSON.stringify(state, null, 2));
    await rename(path.resolve('artifacts/benchmark-stack.json.tmp'), path.resolve('artifacts/benchmark-stack.json'));
  }
}

export function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}
export async function sourceHash() {
  const files = (git(['ls-files', '--cached', '--others', '--exclude-standard']) ?? '')
    .split('\n')
    .filter((file) =>
      /^(src\/|pkg\/|tests\/|scripts\/|provisioning\/|dev\/|\.agents\/skills\/|docker|playwright|package|mise)/.test(
        file
      )
    );
  const hash = createHash('sha256');
  for (const file of [...new Set(files)].sort()) {
    hash.update(file);
    try {
      hash.update(await readFile(file));
    } catch {
      hash.update('<missing>');
    }
  }
  return hash.digest('hex');
}
