import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Mesh } from '../client/mesh.mjs';
globalThis.MediaStream ??= class {};
test('a transient recovery does not suppress the next ICE restart timer', () => {
  const original = { pc: globalThis.RTCPeerConnection, set: globalThis.setTimeout, clear: globalThis.clearTimeout };
  const scheduled = [];
  globalThis.RTCPeerConnection = class {
    connectionState = 'new';
    addTransceiver() { return { sender: { replaceTrack: async () => {} } }; }
    close() {}
  };
  globalThis.setTimeout = fn => { const timer = { fn }; scheduled.push(timer); return timer; };
  globalThis.clearTimeout = () => {};
  try {
    const mesh = new Mesh({ id: 'a', iceServers: [], send() {}, onStatus() {}, onTrack() {}, onError() {}, refreshIce: async () => [] });
    const peer = mesh.ensure('b', 'epoch');
    peer.pc.connectionState = 'disconnected'; peer.pc.onconnectionstatechange();
    peer.pc.connectionState = 'connected'; peer.pc.onconnectionstatechange();
    peer.pc.connectionState = 'failed'; peer.pc.onconnectionstatechange();
    assert.equal(scheduled.length, 2);
    mesh.close();
  } finally { globalThis.RTCPeerConnection = original.pc; globalThis.setTimeout = original.set; globalThis.clearTimeout = original.clear; }
});

test('mesh applies a lower sender resolution after sustained capture-versus-encode frame loss', async () => {
  const original = globalThis.RTCPeerConnection;
  let sample = 0;
  const applied = [];
  globalThis.RTCPeerConnection = class {
    connectionState = 'connected';
    signalingState = 'stable';
    addTransceiver() {
      return { sender: {
        replaceTrack: async () => {},
        getParameters: () => ({ encodings: [{}] }),
        setParameters: async params => { applied.push(params.encodings[0]); }
      } };
    }
    close() {}
    async getStats() {
      const tick = sample++;
      return new Map([
        ['capture', { id: 'capture', type: 'media-source', kind: 'video', timestamp: tick * 1000, frames: tick * 60 }],
        ['out', { id: 'out', type: 'outbound-rtp', kind: 'video', mediaSourceId: 'capture', timestamp: tick * 1000, framesEncoded: tick * 30, packetsSent: tick * 30, bytesSent: tick * 100000, qualityLimitationReason: 'cpu' }]
      ]);
    }
  };
  try {
    const mesh = new Mesh({ id: 'a', iceServers: [], send() {}, onStatus() {}, onTrack() {}, onError() {}, refreshIce: async () => [] });
    mesh.ensure('b', 'epoch');
    await mesh.configureVideo({ height: 1080, fps: 60, adaptive: false });
    // A selected 1080p ceiling must still downscale a 720p source under pressure.
    await mesh.setTrack(1, { getSettings: () => ({ width: 1280, height: 720 }) });
    await mesh.stats();
    await mesh.stats();
    await mesh.stats();
    assert.ok(applied.at(-1).scaleResolutionDownBy > 1, `sender scale was ${applied.at(-1).scaleResolutionDownBy}`);
    assert.equal(applied.at(-1).maxFramerate, 60);
    mesh.close();
  } finally { globalThis.RTCPeerConnection = original; }
});

test('1080p from a 2560×1440 screen keeps exact scaling for hardware-friendly even dimensions', async () => {
  const original = globalThis.RTCPeerConnection;
  let scale;
  globalThis.RTCPeerConnection = class {
    signalingState = 'stable';
    addTransceiver() {
      return { sender: {
        replaceTrack: async () => {},
        getParameters: () => ({ encodings: [{}] }),
        setParameters: async params => { scale = params.encodings[0].scaleResolutionDownBy; }
      } };
    }
    close() {}
  };
  try {
    const mesh = new Mesh({ id: 'a', iceServers: [], send() {}, onStatus() {}, onTrack() {}, onError() {}, refreshIce: async () => [] });
    mesh.ensure('b', 'epoch');
    await mesh.configureVideo({ height: 1080, fps: 60, adaptive: false });
    await mesh.setTrack(1, { getSettings: () => ({ width: 2560, height: 1440 }) });
    assert.equal(scale, 4 / 3);
    assert.deepEqual([Math.round(2560 / scale), Math.round(1440 / scale)], [1920, 1080]);
    mesh.close();
  } finally { globalThis.RTCPeerConnection = original; }
});

test('answerer prefers H.264 before generating its SDP answer', async () => {
  const original = { pc: globalThis.RTCPeerConnection, receiver: globalThis.RTCRtpReceiver };
  const selected = [];
  globalThis.RTCRtpReceiver = { getCapabilities: () => ({ codecs: [{ mimeType: 'video/VP8' }, { mimeType: 'video/H264' }] }) };
  globalThis.RTCPeerConnection = class {
    signalingState = 'stable';
    localDescription = { type: 'answer', sdp: 'v=0\r\n' };
    getTransceivers() {
      return ['audio', 'video', 'audio'].map((kind, index) => ({
        mid: String(index), direction: 'recvonly',
        setCodecPreferences: kind === 'video' ? codecs => selected.push(codecs.map(codec => codec.mimeType)) : undefined,
        sender: { replaceTrack: async () => {} }
      }));
    }
    async setRemoteDescription() {}
    async setLocalDescription() {}
    close() {}
  };
  try {
    const mesh = new Mesh({ id: 'z', iceServers: [], send() {}, onStatus() {}, onTrack() {}, onError() {}, refreshIce: async () => [] });
    mesh.ensure('a', 'epoch');
    await mesh.signal({ from: 'a', description: { type: 'offer', sdp: 'v=0\r\n' } });
    assert.deepEqual(selected, [['video/H264', 'video/VP8']]);
    mesh.close();
  } finally { globalThis.RTCPeerConnection = original.pc; globalThis.RTCRtpReceiver = original.receiver; }
});

test('stats accurately detects Cloudflare TURN on receiver side with selected candidate pair', async () => {
  const original = { pc: globalThis.RTCPeerConnection };
  const statuses = [];
  globalThis.RTCPeerConnection = class {
    connectionState = 'connected';
    addTransceiver() { return { sender: { replaceTrack: async () => {} } }; }
    close() {}
    async getStats() {
      return new Map([
        ['trans', { type: 'transport', selectedCandidatePairId: 'pair-1' }],
        ['pair-1', { type: 'candidate-pair', state: 'succeeded', selected: true, nominated: false, localCandidateId: 'local-1', remoteCandidateId: 'remote-1' }],
        ['local-1', { type: 'local-candidate', candidateType: 'srflx' }],
        ['remote-1', { type: 'remote-candidate', candidateType: 'relay', url: 'turn:turn.cloudflare.com:3478?transport=udp' }]
      ]);
    }
  };
  try {
    const mesh = new Mesh({
      id: 'a', iceServers: [], send() {},
      onStatus(id, path) { statuses.push({ id, path }); },
      onTrack() {}, onError() {}, refreshIce: async () => []
    });
    mesh.ensure('b', 'epoch');
    await mesh.stats();
    assert.deepEqual(statuses, [{ id: 'b', path: 'Cloudflare TURN' }]);
    mesh.close();
  } finally { globalThis.RTCPeerConnection = original.pc; }
});


test('stats detects P2P direct when host/srflx candidates connect without relay', async () => {
  const original = { pc: globalThis.RTCPeerConnection };
  const statuses = [];
  globalThis.RTCPeerConnection = class {
    connectionState = 'connected';
    addTransceiver() { return { sender: { replaceTrack: async () => {} } }; }
    close() {}
    async getStats() {
      return new Map([
        ['pair-1', { type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'local-1', remoteCandidateId: 'remote-1' }],
        ['local-1', { type: 'local-candidate', candidateType: 'host' }],
        ['remote-1', { type: 'remote-candidate', candidateType: 'host' }]
      ]);
    }
  };
  try {
    const mesh = new Mesh({
      id: 'a', iceServers: [], send() {},
      onStatus(id, path) { statuses.push({ id, path }); },
      onTrack() {}, onError() {}, refreshIce: async () => []
    });
    mesh.ensure('b', 'epoch');
    await mesh.stats();
    assert.deepEqual(statuses, [{ id: 'b', path: 'P2P 直连' }]);
    mesh.close();
  } finally { globalThis.RTCPeerConnection = original.pc; }
});

test('stats uses the selected relay pair instead of an older nominated direct pair', async () => {
  const original = globalThis.RTCPeerConnection;
  const statuses = [];
  globalThis.RTCPeerConnection = class {
    connectionState = 'connected';
    addTransceiver() { return { sender: { replaceTrack: async () => {} } }; }
    close() {}
    async getStats() {
      return new Map([
        ['selected', { id: 'selected', type: 'candidate-pair', state: 'succeeded', selected: true, localCandidateId: 'relay-local', remoteCandidateId: 'relay-remote' }],
        ['old', { id: 'old', type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'direct-local', remoteCandidateId: 'direct-remote' }],
        ['direct-local', { id: 'direct-local', type: 'local-candidate', candidateType: 'host' }],
        ['direct-remote', { id: 'direct-remote', type: 'remote-candidate', candidateType: 'srflx' }],
        ['relay-local', { id: 'relay-local', type: 'local-candidate', candidateType: 'relay' }],
        ['relay-remote', { id: 'relay-remote', type: 'remote-candidate', candidateType: 'srflx' }]
      ]);
    }
  };
  try {
    const mesh = new Mesh({ id: 'a', iceServers: [], send() {}, onStatus(_id, path) { statuses.push(path); }, onTrack() {}, onError() {}, refreshIce: async () => [] });
    mesh.ensure('b', 'epoch');
    await mesh.stats();
    assert.deepEqual(statuses, ['Cloudflare TURN']);
    mesh.close();
  } finally { globalThis.RTCPeerConnection = original; }
});
