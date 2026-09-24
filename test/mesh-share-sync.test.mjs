import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Mesh } from '../client/mesh.mjs';

test('screen video and system sound are associated with one WebRTC stream; microphone is separate', () => {
  const oldPc = globalThis.RTCPeerConnection, oldStream = globalThis.MediaStream;
  const slots = [];
  globalThis.MediaStream = class {};
  globalThis.RTCPeerConnection = class {
    addTransceiver(kind, init) { slots.push({ kind, streams: init.streams }); return { sender: { replaceTrack: async () => {} }, setCodecPreferences() {} }; }
    close() {}
  };
  try {
    const mesh = new Mesh({ id: 'a', iceServers: [], relayOnly: false, send() {}, onTrack() {}, onStatus() {}, onError() {} });
    mesh.ensure('b', 1);
    assert.equal(slots.length, 3);
    assert.equal(slots[0].streams?.length || 0, 0);
    assert.equal(slots[1].streams?.length, 1);
    assert.equal(slots[2].streams?.[0], slots[1].streams?.[0]);
    mesh.close();
  } finally { globalThis.RTCPeerConnection = oldPc; globalThis.MediaStream = oldStream; }
});
