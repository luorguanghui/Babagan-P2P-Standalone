import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleSfuVideoStats, formatSfuVideoStats, createSfuStatsSampler } from '../client/sfu-stats.mjs';

test('SFU metrics select the progressing RTP stream instead of a retained stale report', () => {
  const before = new Map([
    ['old', { id: 'old', type: 'inbound-rtp', kind: 'video', timestamp: 1000,
      framesDecoded: 1000, bytesReceived: 1000000, frameWidth: 1920, frameHeight: 1080 }],
    ['new', { id: 'new', type: 'inbound-rtp', kind: 'video', timestamp: 1000,
      framesDecoded: 0, bytesReceived: 0, frameWidth: 1280, frameHeight: 720 }]
  ]);
  const after = new Map([
    ['old', { ...before.get('old'), timestamp: 2000 }],
    ['new', { ...before.get('new'), timestamp: 2000, framesDecoded: 60, bytesReceived: 500000 }]
  ]);
  const stats = sampleSfuVideoStats(after, before);
  assert.equal(stats.fps, 60);
  assert.equal(stats.height, 720);
  assert.equal(stats.bitrate, 4e6);
});

test('SFU receiving stats separate network arrival, decoding and discarded frames', () => {
  const before = new Map([['video', { id: 'video', type: 'inbound-rtp', kind: 'video', timestamp: 1000,
    framesReceived: 100, framesDecoded: 90, framesDropped: 10, totalDecodeTime: 0.45 }]]);
  const after = new Map([['video', { id: 'video', type: 'inbound-rtp', kind: 'video', timestamp: 2000,
    framesReceived: 160, framesDecoded: 110, framesDropped: 50, totalDecodeTime: 1.15 }]]);
  const stats = sampleSfuVideoStats(after, before);
  assert.equal(stats.receivedFps, 60);
  assert.equal(stats.fps, 20);
  assert.equal(stats.droppedFps, 40);
  assert.equal(Math.round(stats.decodeMs), 35);
  const text = formatSfuVideoStats(stats);
  assert.match(text, /到达 60\.0 fps/);
  assert.match(text, /解码 20\.0 fps/);
  assert.match(text, /丢弃 40\.0 fps/);
});

test('SFU publisher reports video bitrate, encoded frames and loss to the SFU', () => {
  const before = new Map([
    ['out', { id: 'out', type: 'outbound-rtp', kind: 'video', timestamp: 1000, bytesSent: 1000, framesEncoded: 30,
      packetsSent: 100, frameWidth: 1920, frameHeight: 1080, remoteId: 'remote' }],
    ['remote', { id: 'remote', type: 'remote-inbound-rtp', timestamp: 1000, packetsLost: 2, packetsReceived: 98 }]
  ]);
  const after = new Map([
    ['out', { id: 'out', type: 'outbound-rtp', kind: 'video', timestamp: 2000, bytesSent: 501000, framesEncoded: 90,
      packetsSent: 200, frameWidth: 1920, frameHeight: 1080, remoteId: 'remote', codecId: 'codec' }],
    ['codec', { id: 'codec', type: 'codec', mimeType: 'video/H264' }],
    ['remote', { id: 'remote', type: 'remote-inbound-rtp', timestamp: 2000, packetsLost: 4, packetsReceived: 196,
      roundTripTime: 0.08 }],
    ['audio', { id: 'audio', type: 'outbound-rtp', kind: 'audio', timestamp: 2000, bytesSent: 10000000 }]
  ]);
  const stats = sampleSfuVideoStats(after, before);
  assert.deepEqual(stats, { direction: 'send', bitrate: 4000000, fps: 60, width: 1920, height: 1080, codec: 'video/H264',
    sourceFps: null, encodeMs: null, encoderImplementation: null, powerEfficientEncoder: null, limitation: null,
    receivedFps: null, droppedFps: null, decodeMs: null, available: null,
    codecParameters: null, decoderImplementation: null, powerEfficientDecoder: null,
    loss: 0.02, rtt: 0.08 });
  assert.match(formatSfuVideoStats(stats), /至 SFU 丢包 2\.0%/);
  assert.match(formatSfuVideoStats(stats), /4\.00 Mbps/);
  assert.match(formatSfuVideoStats(stats), /H264/);
});

test('SFU subscriber reports received video loss without counting audio packets', () => {
  const before = new Map([
    ['in', { id: 'in', type: 'inbound-rtp', kind: 'video', timestamp: 1000, bytesReceived: 1000,
      framesDecoded: 30, packetsReceived: 95, packetsLost: 5 }]
  ]);
  const after = new Map([
    ['in', { id: 'in', type: 'inbound-rtp', kind: 'video', timestamp: 2000, bytesReceived: 376000,
      framesDecoded: 60, packetsReceived: 190, packetsLost: 10, frameWidth: 1280, frameHeight: 720 }],
    ['audio', { id: 'audio', type: 'inbound-rtp', kind: 'audio', timestamp: 2000, bytesReceived: 10000000,
      packetsReceived: 0, packetsLost: 100 }],
    ['pair', { id: 'pair', type: 'candidate-pair', selected: true, state: 'succeeded', currentRoundTripTime: 0.12 }]
  ]);
  const stats = sampleSfuVideoStats(after, before);
  assert.deepEqual(stats, { direction: 'receive', bitrate: 3000000, fps: 30, width: 1280, height: 720, codec: null,
    sourceFps: null, encodeMs: null, encoderImplementation: null, powerEfficientEncoder: null, limitation: null,
    receivedFps: null, droppedFps: null, decodeMs: null, available: null,
    codecParameters: null, decoderImplementation: null, powerEfficientDecoder: null,
    loss: 0.05, rtt: 0.12 });
  assert.match(formatSfuVideoStats(stats), /SFU→本机丢包 5\.0%/);
});

test('SFU publisher identifies the actual encoder and capture-to-encode pressure', () => {
  const before = new Map([
    ['out', { id: 'out', type: 'outbound-rtp', kind: 'video', timestamp: 1000, framesEncoded: 10,
      totalEncodeTime: 0.1, mediaSourceId: 'source' }],
    ['source', { id: 'source', type: 'media-source', kind: 'video', timestamp: 1000, frames: 30 }]
  ]);
  const after = new Map([
    ['out', { id: 'out', type: 'outbound-rtp', kind: 'video', timestamp: 2000, framesEncoded: 70,
      totalEncodeTime: 0.7, mediaSourceId: 'source',
      encoderImplementation: 'MediaFoundationVideoEncodeAccelerator (NVIDIA H.264 Encoder MFT)',
      powerEfficientEncoder: true, qualityLimitationReason: 'none' }],
    ['source', { id: 'source', type: 'media-source', kind: 'video', timestamp: 2000, frames: 90 }]
  ]);
  const stats = sampleSfuVideoStats(after, before);
  assert.equal(stats.sourceFps, 60);
  assert.equal(Math.round(stats.encodeMs), 10);
  assert.match(stats.encoderImplementation, /NVIDIA H\.264/);
  assert.equal(stats.powerEfficientEncoder, true);
  assert.equal(stats.limitation, 'none');
  assert.match(formatSfuVideoStats(stats), /采集 60\.0 fps/);
  assert.match(formatSfuVideoStats(stats), /硬件编码/);
});

test('SFU stats show unavailable counters as unknown rather than zero loss', () => {
  const stats = sampleSfuVideoStats(new Map([['in', { id: 'in', type: 'inbound-rtp', kind: 'video', timestamp: 1000,
    bytesReceived: 1000, framesDecoded: 3, packetsReceived: 10, packetsLost: 0 }]]));
  assert.equal(stats.loss, null);
  assert.equal(stats.bitrate, null);
  assert.match(formatSfuVideoStats(stats), /丢包 —/);
});

test('SFU stats sampler resets its rate baseline when the connection changes', async () => {
  const sampler = createSfuStatsSampler();
  const report = (timestamp, bytesReceived) => new Map([['in', {
    id: 'in', type: 'inbound-rtp', kind: 'video', timestamp, bytesReceived,
    framesDecoded: timestamp / 100, packetsReceived: timestamp / 10, packetsLost: 0
  }]]);
  let calls = 0;
  const first = { getStats: async () => [report(1000, 1000), report(2000, 501000)][calls++] };
  const second = { getStats: async () => report(3000, 900000) };

  assert.equal((await sampler.sample(first)).bitrate, null);
  assert.equal((await sampler.sample(first)).bitrate, 4000000);
  assert.equal((await sampler.sample(second)).bitrate, null, 'a new subscriber needs a fresh baseline');
  assert.equal(await sampler.sample(null), null);
});
