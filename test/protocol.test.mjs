import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateMessage, validRoomId, cleanName, allowedIceServers } from '../worker/protocol.mjs';

test('room invitation has 128 bits and rejects path traversal', () => {
  assert.equal(validRoomId('0123456789abcdef0123456789abcdef'), true);
  for (const value of ['', '../ice', 'abc', 'a'.repeat(33)]) assert.equal(validRoomId(value), false);
});
test('display names have a bounded nonempty value', () => {
  assert.equal(cleanName('  Alice  '), 'Alice');
  assert.throws(() => cleanName('  '));
  assert.throws(() => cleanName('x'.repeat(41)));
});
test('signals cannot spoof the source or relay arbitrary data', () => {
  assert.deepEqual(validateMessage({ type: 'signal', to: 'peer', description: { type: 'offer', sdp: 'v=0' }, from: 'host' }), { type: 'signal', to: 'peer', description: { type: 'offer', sdp: 'v=0' } });
  assert.throws(() => validateMessage({ type: 'signal', to: 'peer', description: { type: 'bogus', sdp: 'x' } }));
  assert.throws(() => validateMessage({ type: 'signal', to: 'peer', candidate: { candidate: 'x'.repeat(5000) } }));
  assert.throws(() => validateMessage({ type: 'admin' }));
});
test('ICE configuration excludes non Cloudflare relays and browser-blocked port', () => {
  const ice = allowedIceServers([{ urls: ['stun:stun.cloudflare.com:3478', 'turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53', 'turn:evil.example:3478'], username: 'u', credential: 'p' }]);
  assert.equal(ice[0].urls.length, 2);
  assert.throws(() => allowedIceServers([{ urls: ['turn:evil.example:3478'] }]));
});

test('grant-share message validates target and permission boolean', () => {
  assert.deepEqual(validateMessage({ type: 'grant-share', target: 'user123', canShare: true }), { type: 'grant-share', target: 'user123', canShare: true });
  assert.deepEqual(validateMessage({ type: 'grant-share', target: 'user123', canShare: false }), { type: 'grant-share', target: 'user123', canShare: false });
  assert.throws(() => validateMessage({ type: 'grant-share', target: 'x'.repeat(65), canShare: true }));
  assert.throws(() => validateMessage({ type: 'grant-share', target: 'user123', canShare: 'yes' }));
  assert.throws(() => validateMessage({ type: 'grant-share', canShare: true }));
});
