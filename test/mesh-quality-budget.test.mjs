import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Mesh } from '../client/mesh.mjs';

test('mesh configures every viewer independently without a room-wide upload cap', async () => {
  const mesh = Object.create(Mesh.prototype);
  mesh.video = { height: 1080, fps: 60, adaptive: true };
  mesh.tracks = [null, { getSettings: () => ({ width: 1920, height: 1080 }) }, null];
  mesh.peers = new Map(['a', 'b', 'c'].map(id => [id, { budget: { bitrate: 8_000_000, scale: 1 } }]));
  const applied = [];
  mesh.applyVideo = async peer => applied.push(peer.budget.bitrate);

  await mesh.configureVideo({ height: 1080, fps: 60, adaptive: true });

  assert.deepEqual(applied, [8_000_000, 8_000_000, 8_000_000]);
});

test('sender parameters enforce the selected tier maximum even across asynchronous quality changes', async () => {
  let encoding, degradation;
  const mesh = Object.create(Mesh.prototype);
  mesh.video = { height: 1080, fps: 60, adaptive: true };
  mesh.tracks = [null, { getSettings: () => ({ width: 3840, height: 2160 }) }, null];
  const peer = { budget: { bitrate: 30_000_000, scale: 1.5 }, pc: { signalingState: 'stable' },
    slots: [null, { sender: { getParameters: () => ({ encodings: [{}] }), setParameters: async params => { encoding = params.encodings[0]; degradation = params.degradationPreference; } } }] };
  await mesh.applyVideo(peer);
  assert.equal(encoding.maxBitrate, 15_000_000);
  assert.equal(Math.round(2160 / encoding.scaleResolutionDownBy), 1440);
  assert.equal(degradation, 'maintain-resolution');
});

test('mesh setSuspended controls suspended flag and clears peer stats baseline on resume', () => {
  const mesh = Object.create(Mesh.prototype);
  mesh.peers = new Map([
    ['p1', { previous: new Map([['rep1', {}]]) }],
    ['p2', { previous: new Map([['rep2', {}]]) }]
  ]);
  mesh.setSuspended(true);
  assert.equal(mesh.suspended, true);
  assert.equal(mesh.peers.get('p1').previous.size, 1);

  mesh.setSuspended(false);
  assert.equal(mesh.suspended, false);
  assert.equal(mesh.peers.get('p1').previous.size, 0, 'previous reports should be cleared on resume to re-baseline');
  assert.equal(mesh.peers.get('p2').previous.size, 0);
});
