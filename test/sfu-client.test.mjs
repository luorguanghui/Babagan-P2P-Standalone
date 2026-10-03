import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sfuRequest, createSfuPublisher, createSfuSubscriber } from '../client/sfu-client.mjs';

test('sfuRequest formats url and sends json body', async () => {
  let capturedUrl, capturedOptions;
  globalThis.fetch = async (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return {
      ok: true,
      json: async () => ({ sessionId: 'sess-123' })
    };
  };

  const res = await sfuRequest('https://p2p.babagan.cloud', 'sessions/new', { foo: 'bar' });
  assert.equal(capturedUrl, 'https://p2p.babagan.cloud/api/sfu/sessions/new');
  assert.equal(capturedOptions.method, 'POST');
  assert.equal(capturedOptions.headers['content-type'], 'application/json');
  assert.equal(capturedOptions.body, JSON.stringify({ foo: 'bar' }));
  assert.deepEqual(res, { sessionId: 'sess-123' });
});

test('sfuRequest sends empty body when body is undefined', async () => {
  let capturedOptions;
  globalThis.fetch = async (url, options) => {
    capturedOptions = options;
    return {
      ok: true,
      json: async () => ({ sessionId: 'sess-456' })
    };
  };

  const res = await sfuRequest('https://p2p.babagan.cloud', 'sessions/new');
  assert.equal(capturedOptions.body, undefined);
  assert.equal(capturedOptions.headers['content-type'], undefined);
  assert.deepEqual(res, { sessionId: 'sess-456' });
});

test('sfuRequest throws on SFU error code', async () => {
  globalThis.fetch = async () => ({
    ok: false,
    json: async () => ({ errorCode: 'invalid_session', errorDescription: 'Session expired' })
  });

  await assert.rejects(
    async () => sfuRequest('https://p2p.babagan.cloud', 'sessions/123/tracks/new', {}),
    /Session expired/
  );
});

test('createSfuPublisher creates session and tracks with SFU', async () => {
  const steps = [];
  let videoParameters;
  let videoCodecs;
  globalThis.fetch = async (url, options) => {
    if (url.includes('/sessions/new')) {
      steps.push('sessions/new');
      assert.equal(options.body, undefined);
      return { ok: true, json: async () => ({ sessionId: 'pub-sess-1' }) };
    }
    if (url.includes('/tracks/new')) {
      steps.push('tracks/new');
      const body = JSON.parse(options.body);
      assert.equal(body.sessionDescription.type, 'offer');
      assert.equal(body.tracks.length, 2);
      return { ok: true, json: async () => ({ sessionDescription: { type: 'answer', sdp: 'v=0' } }) };
    }
    return { ok: true, json: async () => ({}) };
  };

  class FakePeerConnection {
    constructor() {
      this.iceConnectionState = 'connected';
      this.iceGatheringState = 'complete';
      this.localDescription = { type: 'offer', sdp: 'v=0' };
    }
    addTransceiver(track) {
      return { mid: '0', sender: { track,
        getParameters: () => ({ encodings: [{}] }),
        setParameters: async parameters => { if (track.kind === 'video') videoParameters = parameters; }
      }, setCodecPreferences(codecs) { if (track.kind === 'video') videoCodecs = codecs; } };
    }
    async createOffer() { return { type: 'offer', sdp: 'v=0' }; }
    async setLocalDescription() {}
    async setRemoteDescription() {}
    addEventListener(evt, fn) {
      if (evt === 'iceconnectionstatechange' || evt === 'icegatheringstatechange') fn();
    }
    removeEventListener() {}
    close() { steps.push('closed'); }
  }

  const fakeStream = {
    getVideoTracks: () => [{ id: 'video-track-1', kind: 'video' }],
    getAudioTracks: () => [{ id: 'audio-track-1', kind: 'audio' }]
  };

  const pub = await createSfuPublisher({
    stream: fakeStream,
    workerUrl: 'https://test.worker',
    videoPreferences: { fps: 60 },
    videoCodecCapabilities: [{ mimeType: 'video/VP8' }, { mimeType: 'video/H264', sdpFmtpLine: 'packetization-mode=1' }],
    RTCPeerConnectionClass: FakePeerConnection
  });

  assert.equal(pub.sessionId, 'pub-sess-1');
  assert.equal(pub.sfuInfo.videoTrackName, 'video-track-1');
  assert.equal(pub.sfuInfo.audioTrackName, 'audio-track-1');
  assert.deepEqual(steps, ['sessions/new', 'tracks/new']);
  assert.equal(videoParameters?.degradationPreference, 'maintain-resolution');
  assert.equal(videoParameters?.encodings[0]?.scaleResolutionDownBy, 1);
  assert.equal(videoParameters?.encodings[0]?.maxFramerate, 60);
  assert.equal(videoCodecs?.[0]?.mimeType, 'video/H264');

  pub.stop();
  assert.equal(steps.at(-1), 'closed');
});

test('SFU publisher applies selected resolution and bitrate when starting and changing quality', async () => {
  const applied = [];
  let initialEncoding;
  let codecPreferences;
  const dimensions = { width: 2510, height: 1156 };
  const videoTrack = { id: 'video-track', kind: 'video', getSettings: () => dimensions };
  globalThis.fetch = async url => ({
    ok: true,
    json: async () => url.includes('/sessions/new')
      ? { sessionId: 'session' }
      : { sessionDescription: { type: 'answer', sdp: 'v=0' } }
  });
  class FakePeerConnection {
    constructor() {
      this.iceConnectionState = 'connected';
      this.iceGatheringState = 'complete';
      this.localDescription = { type: 'offer', sdp: 'v=0' };
    }
    addTransceiver(track, options) {
      if (track.kind === 'video') initialEncoding = options.sendEncodings?.[0];
      return { mid: '0', sender: {
        getParameters: () => ({ encodings: [{}] }),
        setParameters: async parameters => applied.push(JSON.parse(JSON.stringify(parameters)))
      }, setCodecPreferences: codecs => { codecPreferences = codecs; } };
    }
    async createOffer() { return this.localDescription; }
    async setLocalDescription() {}
    async setRemoteDescription() {}
    close() {}
  }

  const publisher = await createSfuPublisher({
    stream: { getVideoTracks: () => [videoTrack], getAudioTracks: () => [] },
    workerUrl: 'https://test.worker',
    videoPreferences: { height: 720, fps: 30, adaptive: false },
    videoCodecCapabilities: [
      { mimeType: 'video/H264', sdpFmtpLine: 'packetization-mode=1;profile-level-id=42e01f' },
      { mimeType: 'video/H264', sdpFmtpLine: 'packetization-mode=1;profile-level-id=42001f' },
      { mimeType: 'video/VP8' }, { mimeType: 'video/rtx' }
    ],
    RTCPeerConnectionClass: FakePeerConnection
  });
  assert.equal(codecPreferences?.[0]?.sdpFmtpLine, 'packetization-mode=1;profile-level-id=42001f');
  assert.equal(codecPreferences?.some(codec => codec.mimeType === 'video/VP8'), false);
  assert.equal(codecPreferences?.some(codec => /profile-level-id=42e0/i.test(codec.sdpFmtpLine || '')), false);
  assert.equal(Math.round(dimensions.height / initialEncoding?.scaleResolutionDownBy), 718);
  assert.equal(initialEncoding?.maxBitrate, 2_177_324);
  assert.equal(initialEncoding?.maxFramerate, 30);
  assert.equal(Math.round(dimensions.height / applied[0].encodings[0].scaleResolutionDownBy), 718);
  assert.equal(applied[0].encodings[0].maxBitrate, 2_177_324);
  assert.equal(applied[0].encodings[0].maxFramerate, 30);

  await publisher.configureVideo({ height: 1080, fps: 60, adaptive: false });
  assert.equal(Math.round(dimensions.height / applied[1].encodings[0].scaleResolutionDownBy), 1080);
  assert.equal(applied[1].encodings[0].maxBitrate, 8_000_000);
  assert.equal(applied[1].encodings[0].maxFramerate, 60);

  await publisher.configureVideo({ height: 'source', fps: 30, adaptive: false });
  assert.equal(applied[2].encodings[0].scaleResolutionDownBy, 1);
  assert.equal(applied[2].encodings[0].maxBitrate, 4_429_565);

  dimensions.width = 3840;
  dimensions.height = 2160;
  await publisher.configureVideo({ height: 1080, fps: 30, adaptive: true });
  assert.equal(applied[3].encodings[0].scaleResolutionDownBy, 2);
  assert.equal(applied[3].encodings[0].maxBitrate, 15_000_000);
  publisher.stop();
});

test('SFU publisher can retain alternate codecs in compatibility mode', async () => {
  let selectedCodecs;
  globalThis.fetch = async url => ({ ok: true, json: async () => url.includes('/sessions/new')
    ? { sessionId: 'session' } : { sessionDescription: { type: 'answer', sdp: 'v=0' } } });
  class FakePeerConnection {
    constructor() { this.iceConnectionState = 'connected'; this.iceGatheringState = 'complete';
      this.localDescription = { type: 'offer', sdp: 'v=0' }; }
    addTransceiver() { return { mid: '0', sender: { getParameters: () => ({ encodings: [{}] }),
      setParameters: async () => {} }, setCodecPreferences: codecs => { selectedCodecs = codecs; } }; }
    async createOffer() { return this.localDescription; }
    async setLocalDescription() {}
    async setRemoteDescription() {}
    close() {}
  }
  const publisher = await createSfuPublisher({
    stream: { getVideoTracks: () => [{ id: 'video', kind: 'video' }], getAudioTracks: () => [] },
    workerUrl: 'https://test.worker',
    preferHardwareEncoding: false,
    videoCodecCapabilities: [
      { mimeType: 'video/H264', sdpFmtpLine: 'packetization-mode=1;profile-level-id=42001f' },
      { mimeType: 'video/VP8' }
    ],
    RTCPeerConnectionClass: FakePeerConnection
  });
  assert.equal(selectedCodecs?.some(codec => codec.mimeType === 'video/VP8'), true);
  publisher.stop();
});

test('createSfuSubscriber pulls tracks and renegotiates with SFU', async () => {
  const steps = [];
  let receiveCodecs;
  globalThis.fetch = async (url, options) => {
    if (url.includes('/sessions/new')) {
      steps.push('sub-sessions/new');
      assert.equal(options.body, undefined);
      return { ok: true, json: async () => ({ sessionId: 'sub-sess-1' }) };
    }
    if (url.includes('/tracks/new')) {
      steps.push('sub-tracks/new');
      const body = JSON.parse(options.body);
      assert.equal(body.tracks.length, 2);
      return {
        ok: true,
        json: async () => ({
          tracks: [{ trackName: 'video-track-1', mid: '0' }, { trackName: 'audio-track-1', mid: '1' }],
          sessionDescription: { type: 'offer', sdp: 'v=0' },
          requiresImmediateRenegotiation: true
        })
      };
    }
    if (url.includes('/renegotiate')) {
      steps.push('sub-renegotiate');
      assert.equal(options.method, 'PUT');
      const body = JSON.parse(options.body);
      assert.equal(body.sessionDescription.type, 'answer');
      return { ok: true, json: async () => ({}) };
    }
    return { ok: true, json: async () => ({}) };
  };

  class FakeSubPeerConnection {
    constructor() {
      this.iceConnectionState = 'connected';
      this.iceGatheringState = 'complete';
      this.localDescription = { type: 'answer', sdp: 'v=0' };
    }
    getTransceivers() { return [{ receiver: { track: { kind: 'video' } },
      setCodecPreferences: codecs => { receiveCodecs = codecs; } }]; }
    async createAnswer() {
      assert.match(receiveCodecs?.[0]?.sdpFmtpLine || '', /profile-level-id=4d00/);
      assert.ok(receiveCodecs.some(codec => codec.mimeType === 'video/VP8'), 'receive preferences preserve compatibility fallback');
      return { type: 'answer', sdp: 'v=0' };
    }
    async setLocalDescription() {}
    async setRemoteDescription() { this.ontrack?.({ track: { kind: 'video' } }); }
    async getStats() {
      assert.equal(tracksReceived.length, 1, 'the video track must be attached before waiting for decoding');
      return new Map([['video', { type: 'inbound-rtp', kind: 'video', framesDecoded: 1 }]]);
    }
    addEventListener(evt, fn) {
      if (evt === 'iceconnectionstatechange' || evt === 'icegatheringstatechange') fn();
    }
    removeEventListener() {}
    close() { steps.push('sub-closed'); }
  }

  const tracksReceived = [];
  const sub = await createSfuSubscriber({
    sfuInfo: { sessionId: 'pub-sess-1', videoTrackName: 'video-track-1', audioTrackName: 'audio-track-1' },
    workerUrl: 'https://test.worker',
    onTrack: (track, kind) => tracksReceived.push({ track, kind }),
    videoCodecCapabilities: [
      { mimeType: 'video/VP8' },
      { mimeType: 'video/H264', sdpFmtpLine: 'packetization-mode=1;profile-level-id=42001f' },
      { mimeType: 'video/H264', sdpFmtpLine: 'packetization-mode=1;profile-level-id=4d001f' }
    ],
    RTCPeerConnectionClass: FakeSubPeerConnection
  });

  assert.equal(sub.sessionId, 'sub-sess-1');
  assert.deepEqual(steps, ['sub-sessions/new', 'sub-tracks/new', 'sub-renegotiate']);

  assert.equal(tracksReceived.length, 1);
  assert.equal(tracksReceived[0].kind, 'video');

  sub.stop();
  assert.equal(steps.at(-1), 'sub-closed');
});

test('SFU subscriber rejects a video track error inside a successful HTTP response', async () => {
  globalThis.fetch = async url => ({
    ok: true,
    json: async () => url.includes('/sessions/new') ? { sessionId: 'sub-session' } : {
      tracks: [{ trackName: 'video-track', errorCode: 'empty_track_error', errorDescription: 'Source media unavailable' }],
      sessionDescription: { type: 'offer', sdp: 'v=0' }
    }
  });
  class FakePeerConnection {
    constructor() { this.iceConnectionState = 'connected'; this.iceGatheringState = 'complete'; }
    async setRemoteDescription() {}
    async createAnswer() { return { type: 'answer', sdp: 'v=0' }; }
    async setLocalDescription() { this.localDescription = { type: 'answer', sdp: 'v=0' }; }
    close() {}
  }
  await assert.rejects(createSfuSubscriber({
    sfuInfo: { sessionId: 'pub-session', videoTrackName: 'video-track' },
    workerUrl: 'https://test.worker',
    RTCPeerConnectionClass: FakePeerConnection
  }), /Source media unavailable/);
});

test('SFU subscriber rejects a connected transport that never decodes a video frame', async () => {
  globalThis.fetch = async url => ({
    ok: true,
    json: async () => url.includes('/sessions/new') ? { sessionId: 'sub-session' } : url.includes('/tracks/new') ? {
      tracks: [{ trackName: 'video-track', mid: '0' }],
      sessionDescription: { type: 'offer', sdp: 'v=0' }
    } : {}
  });
  class FakePeerConnection {
    constructor() { this.iceConnectionState = 'connected'; this.iceGatheringState = 'complete'; }
    async setRemoteDescription() {}
    async createAnswer() { return { type: 'answer', sdp: 'v=0' }; }
    async setLocalDescription() { this.localDescription = { type: 'answer', sdp: 'v=0' }; }
    async getStats() { return new Map([['video', { type: 'inbound-rtp', kind: 'video', framesDecoded: 0 }]]); }
    close() {}
  }
  await assert.rejects(createSfuSubscriber({
    sfuInfo: { sessionId: 'pub-session', videoTrackName: 'video-track' },
    workerUrl: 'https://test.worker',
    firstFrameTimeoutMs: 0,
    RTCPeerConnectionClass: FakePeerConnection
  }), /未收到可解码视频帧/);
});
