import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.mjs';

test('unconfigured SFU never uses a fallback credential or contacts Cloudflare', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; return new Response('{}'); };
  try {
    for (const env of [{}, { CALLS_APP_ID: 'test-app' }, { CALLS_APP_TOKEN: 'test-token' }]) {
      const response = await worker.fetch(new Request('https://test/api/sfu/sessions/new', { method: 'POST' }), env);
      assert.equal(response.status, 503);
      assert.equal(requests, 0);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('configured SFU uses the environment credential only for its upstream request', async () => {
  const originalFetch = globalThis.fetch;
  let target, options;
  globalThis.fetch = async (url, init) => {
    target = url; options = init;
    return new Response(JSON.stringify({ sessionId: 'test-session' }));
  };
  try {
    const response = await worker.fetch(new Request('https://test/api/sfu/sessions/new', { method: 'POST' }),
      { CALLS_APP_ID: 'test-app', CALLS_APP_TOKEN: 'test-token' });
    assert.equal(target, 'https://rtc.live.cloudflare.com/v1/apps/test-app/sessions/new');
    assert.equal(options.headers.authorization, 'Bearer test-token');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { sessionId: 'test-session' });
  } finally { globalThis.fetch = originalFetch; }
});
