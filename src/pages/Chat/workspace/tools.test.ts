jest.mock('typebox', () => ({
  Type: {
    Array: jest.fn((items, config) => ({ ...config, items })),
    Boolean: jest.fn((config) => config ?? {}),
    Number: jest.fn((config) => config ?? {}),
    Object: jest.fn((properties) => ({ properties })),
    Optional: jest.fn((schema) => schema),
    String: jest.fn((config) => config ?? {}),
  },
}));

import type { AgentTool } from '@earendil-works/pi-agent-core';
import { createFakeDashboardBroker } from './testUtils';
import { applyTextEdits, createWorkspaceTools } from './tools';
import { SessionWorkspace } from './workspace';

function setup() {
  const fake = createFakeDashboardBroker([{ uid: 'checkout', title: 'Checkout' }]);
  const workspace = new SessionWorkspace();
  workspace.setHydrator((_kind, uid, signal) => fake.broker.dashboards!.get(uid, signal));
  const tools = Object.fromEntries(
    createWorkspaceTools({ workspace, broker: fake.broker }).map((tool) => [tool.name, tool])
  ) as Record<'read' | 'write' | 'edit' | 'bash', AgentTool>;
  const call = async (name: 'read' | 'write' | 'edit' | 'bash', params: Record<string, unknown>) => {
    const result = await tools[name].execute('call-1', params as never, undefined, undefined);
    return {
      text: result.content.map((block) => (block.type === 'text' ? block.text : '')).join(''),
      details: result.details as Record<string, any>,
    };
  };
  return { workspace, call, fake };
}

describe('workspace file tools', () => {
  it('exposes exactly read, write, edit, and bash', () => {
    const { workspace } = setup();
    expect(createWorkspaceTools({ workspace, broker: {} }).map((tool) => tool.name)).toEqual([
      'read',
      'write',
      'edit',
      'bash',
    ]);
  });

  it('writes, reads with line numbers and windows, and lists directories', async () => {
    const { call } = setup();
    const content = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join('\n');
    await call('write', { path: 'notes/a.txt', content });

    const window = await call('read', { path: '/workspace/notes/a.txt', offset: 3, limit: 2 });
    expect(window.text).toContain('\n3\tline 3\n4\tline 4\n');
    expect(window.text).toContain('continue with offset=5');
    expect(window.details.totalLines).toBe(10);

    const listing = await call('read', { path: '/workspace' });
    expect(listing.text).toBe('/workspace/\nnotes/');
  });

  it('shares state with bash', async () => {
    const { call } = setup();
    await call('bash', { command: `echo '{"a":1}' > data.json` });
    const read = await call('read', { path: 'data.json' });
    expect(read.text).toContain('1\t{"a":1}');
    await call('edit', { path: 'data.json', edits: [{ oldText: '"a":1', newText: '"a":2' }] });
    const jq = await call('bash', { command: 'jq .a data.json' });
    expect(jq.text).toBe('2\n[exit 0]');
  });

  it('guards writes and edits with revisions', async () => {
    const { call } = setup();
    const created = await call('write', { path: '/session/plan.md', content: 'one' });
    const revision = created.details.revision;
    await call('write', { path: '/session/plan.md', content: 'two', revision });
    await expect(call('write', { path: '/session/plan.md', content: 'three', revision })).rejects.toThrow(/changed/);
    await expect(
      call('edit', { path: '/session/plan.md', revision, edits: [{ oldText: 'two', newText: '2' }] })
    ).rejects.toThrow(/changed/);
  });

  it('reports ambiguous and missing edits without changing the file', async () => {
    const { call, workspace } = setup();
    await call('write', { path: 'x.txt', content: 'foo\nbar\nfoo\n' });
    await expect(call('edit', { path: 'x.txt', edits: [{ oldText: 'foo', newText: 'baz' }] })).rejects.toThrow(
      /matches 2 times .*lines 1, 3/
    );
    await expect(
      call('edit', {
        path: 'x.txt',
        edits: [
          { oldText: 'bar', newText: 'BAR' },
          { oldText: 'missing', newText: 'x' },
        ],
      })
    ).rejects.toThrow(/edit 2: oldText not found/);
    expect(workspace.getScratchFile('/workspace/x.txt')?.content).toBe('foo\nbar\nfoo\n');

    await call('edit', { path: 'x.txt', edits: [{ oldText: 'foo', newText: 'baz', replaceAll: true }] });
    expect(workspace.getScratchFile('/workspace/x.txt')?.content).toBe('baz\nbar\nbaz\n');
  });

  it('lazily fetches dashboards on read and stages edits locally', async () => {
    const { call, workspace, fake } = setup();
    const read = await call('read', { path: '/grafana/dashboards/checkout/dashboard.json' });
    expect(read.text).toContain('"title": "Checkout"');
    const edit = await call('edit', {
      path: '/grafana/dashboards/checkout/dashboard.json',
      edits: [{ oldText: '"title": "Checkout"', newText: '"title": "Checkout SLOs"' }],
    });
    expect(edit.text).toContain('Staged locally only');
    expect(edit.text).toContain('+    "title": "Checkout SLOs"');
    expect(workspace.status()).toEqual([expect.objectContaining({ uid: 'checkout', change: 'modified' })]);
    expect(fake.store.get('checkout')?.resource.spec.title).toBe('Checkout');
  });

  it('rejects traversal and read-only targets', async () => {
    const { call } = setup();
    await expect(call('read', { path: '/../etc/passwd' })).rejects.toThrow(/escapes/);
    await expect(call('write', { path: '/.agents/skills/x.md', content: 'x' })).rejects.toThrow(/read-only/);
    await expect(call('write', { path: '/grafana/catalog/x', content: 'x' })).rejects.toThrow(/read-only/);
  });
});

describe('applyTextEdits', () => {
  it('treats $ in replacement text literally', () => {
    expect(applyTextEdits('f', 'rate(x[5m])', [{ oldText: '5m', newText: '$__rate_interval' }])).toBe(
      'rate(x[$__rate_interval])'
    );
  });
});
