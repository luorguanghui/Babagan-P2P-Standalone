import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workerUrl, parseInvitation } from '../client/config.mjs';
test('legacy endpoint and invitations migrate only the owned Worker origin', () => {
  const legacy = 'https://babagan-p2p.1312479965.workers.dev';
  const room = 'a'.repeat(32);
  assert.equal(workerUrl(legacy + '/'), 'https://p2p.babagan.cloud');
  assert.deepEqual(parseInvitation(`${legacy}/room/${room}`, ''), { worker: 'https://p2p.babagan.cloud', room });
  assert.equal(workerUrl('https://custom.example'), 'https://custom.example');
  assert.equal(workerUrl('https://babagan-p2p.1312479965.workers.dev.example.com'), 'https://babagan-p2p.1312479965.workers.dev.example.com');
});
test('worker endpoints require HTTPS and prohibit embedded credentials', () => {
  assert.equal(workerUrl('https://example.workers.dev/'), 'https://example.workers.dev');
  assert.throws(() => workerUrl('http://example.com'));
  assert.throws(() => workerUrl('https://secret@example.com'));
  assert.throws(() => workerUrl('https://example.com/path'));
});
test('invitation selects endpoint and exact room; malformed invitations rejected', () => {
  const room = 'f'.repeat(32);
  assert.deepEqual(parseInvitation(`https://example.workers.dev/room/${room}`, ''), { worker: 'https://example.workers.dev', room });
  assert.throws(() => parseInvitation('https://example.com/room/short', ''));
});
