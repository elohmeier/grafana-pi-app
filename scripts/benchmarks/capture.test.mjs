import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { installLLMCapture } from './capture.mjs';

function install(fetch) {
  const records = new Map();
  const window = {
    fetch,
    __PI_COMPARISON_REQUEST__: async (record) => records.set(record.id, structuredClone(record)),
  };
  const context = vm.createContext({
    window,
    location: { href: 'http://localhost:3001/' },
    URL,
    crypto,
    performance,
    TextDecoder,
    Date,
    Promise,
    Set,
  });
  vm.runInContext(`(${installLLMCapture.toString()})()`, context);
  return { window, records };
}
const request = {
  method: 'POST',
  body: JSON.stringify({ model: { id: 'test', api: 'openai-completions' }, options: { reasoning: 'high' } }),
};
const url = '/api/plugins/grafana-assistant-app/resources/llm/api/stream';

test('observes split SSE frames, counts specialist calls, and preserves the response', async () => {
  const body = [
    'data: {"type":"start"}\r\n\r\n',
    'data: {"type":"thinking_delta","delta":"h',
    'mm"}\n\ndata: {"type":"text_delta","delta":"hi"}\n\n',
    'data: {"type":"done","reason":"stop","usage":{"reported":true,"totalTokens":42,"reasoningTokens":2}}\n\n',
  ];
  const { window, records } = install(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            body.forEach((part) => controller.enqueue(new TextEncoder().encode(part)));
            controller.close();
          },
        })
      )
  );
  const responses = await Promise.all([window.fetch(url, request), window.fetch(url, request)]);
  assert.equal(await responses[0].text(), body.join(''));
  await window.__PI_COMPARISON_FLUSH__();
  assert.equal(records.size, 2);
  for (const record of records.values()) {
    assert.equal(record.state, 'completed');
    assert.equal(record.usage.totalTokens, 42);
    assert.equal(record.reasoning, 'high');
    assert.ok(record.firstTextMs >= record.firstContentMs);
    assert.ok(record.firstContentMs >= record.firstByteMs);
    assert.ok(record.durationMs >= record.firstTextMs);
  }
});

test('keeps missing usage unknown after an HTTP error or truncated stream', async () => {
  for (const response of [
    new Response('{"error":"bad key"}', { status: 401 }),
    new Response('data: {"type":"start"}\n\n'),
  ]) {
    const { window, records } = install(async () => response);
    await window.fetch(url, request);
    await window.__PI_COMPARISON_FLUSH__();
    const record = [...records.values()][0];
    assert.equal(record.state, 'failed');
    assert.equal(record.usage, undefined);
  }
});

test('passes unrelated requests through and records aborted fetches', async () => {
  const { window, records } = install(async () => {
    throw new DOMException('aborted', 'AbortError');
  });
  await assert.rejects(window.fetch('/api/health'));
  assert.equal(records.size, 0);
  await assert.rejects(window.fetch(url, request));
  assert.equal([...records.values()][0].state, 'failed');
  assert.equal([...records.values()][0].error, 'AbortError');
});
