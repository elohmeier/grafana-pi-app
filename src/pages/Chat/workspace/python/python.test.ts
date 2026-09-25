import { readFileSync } from 'fs';
import path from 'path';
import { runWorkspaceBash } from '../shell';
import { createFakeDashboardBroker } from '../testUtils';
import { SessionWorkspace } from '../workspace';
import { createPythonCommands, type PythonRunner } from './pythonCommand';
import { runPythonProgram, type CreatePythonModule } from './pythonCore';

const VENDOR = path.resolve(__dirname, '../../../../../node_modules/just-bash/vendor/cpython-emscripten');

// Runs the real vendored CPython in-process (the browser runs the same core in a Worker).
const nodeRunner: PythonRunner = {
  async run(input) {
    const createPythonModule = require(path.join(VENDOR, 'python.cjs')) as CreatePythonModule;
    return runPythonProgram(
      createPythonModule,
      {
        wasmBinary: new Uint8Array(readFileSync(path.join(VENDOR, 'python.wasm'))),
        stdlibZip: new Uint8Array(readFileSync(path.join(VENDOR, 'python313.zip'))),
      },
      input
    );
  },
};

function setup() {
  const fake = createFakeDashboardBroker([{ uid: 'checkout', title: 'Checkout' }]);
  const workspace = new SessionWorkspace();
  workspace.setHydrator((_kind, uid, signal) => fake.broker.dashboards!.get(uid, signal));
  const run = (command: string) =>
    runWorkspaceBash({ workspace, broker: fake.broker, extraCommands: createPythonCommands(nodeRunner) }, { command });
  return { workspace, run };
}

describe('python3 in the workspace shell', () => {
  jest.setTimeout(60_000);

  it('runs inline code with stdlib and pipes', async () => {
    const { run } = setup();
    const result = await run(`python3 -c 'import json,sys; print(json.dumps({"n": sum(range(10))}))' | jq .n`);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('45\n');
  });

  it('reads workspace files, stages new files, and edits dashboards through policy', async () => {
    const { run, workspace } = setup();
    await run('grafana fetch checkout && printf "a,1\\nb,2\\n" > data.csv');
    const script = [
      'import csv, json',
      'rows = list(csv.reader(open("data.csv")))',
      'open("/workspace/out.json", "w").write(json.dumps({"total": sum(int(r[1]) for r in rows)}))',
      'p = "/grafana/dashboards/checkout/dashboard.json"',
      'd = json.load(open(p))',
      'd["spec"]["title"] = "Checkout (py)"',
      'json.dump(d, open(p, "w"), indent=2)',
      'open("/grafana/dashboards/checkout/meta.json", "w").write("{}")',
      'print("ok")',
    ].join('\n');
    await run(`cat > /tmp/script.py <<'EOF'\n${script}\nEOF`);
    const result = await run('python3 /tmp/script.py');
    expect(result.stdout).toBe('ok\n');
    expect(result.exitCode).toBe(0);
    expect(workspace.getScratchFile('/workspace/out.json')?.content).toBe('{"total": 3}');
    expect(workspace.status()).toEqual([expect.objectContaining({ uid: 'checkout', change: 'modified' })]);
    // meta.json is provider-owned: the change stays inside the interpreter and is reported.
    expect(result.stderr).toContain('not staged: /grafana/dashboards/checkout/meta.json');
    expect(workspace.status()).toHaveLength(1);
  });

  it('reports Python exceptions with a non-zero exit code', async () => {
    const { run } = setup();
    const result = await run(`python3 -c 'raise SystemExit(3)'; echo "exit=$?"`);
    expect(result.stdout).toBe('exit=3\n');
    const error = await run(`python3 -c '1/0'`);
    expect(error.exitCode).toBe(1);
    expect(error.stderr).toContain('ZeroDivisionError: division by zero');
    expect(error.stderr).not.toContain('\u001b[');
  });

  it('has no network access', async () => {
    const { run } = setup();
    const result = await run(
      `python3 -c 'import urllib.request; urllib.request.urlopen("http://example.com", timeout=2)'`
    );
    expect(result.exitCode).not.toBe(0);
  });
});
