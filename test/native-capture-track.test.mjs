import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNativeVideoTrack } from '../client/native-capture-track.mjs';

test('incoming frame dimensions notify quality changes even without a helper resize record', async () => {
  const sizes = [];
  const bridge = createNativeVideoTrack({ factory: {
    createTrack: () => ({ stop() {} }), createFrame: () => ({ close() {} }), writeFrame: async () => {}
  }, onStatus: record => sizes.push([record.width, record.height]) });
  bridge.push({ type: 'frame', width: 1920, height: 1080, payload: new Uint8Array(12) });
  await bridge.flush();
  bridge.push({ type: 'frame', width: 1280, height: 720, payload: new Uint8Array(12) });
  await bridge.flush();
  bridge.push({ type: 'frame', width: 1280, height: 720, payload: new Uint8Array(12) });
  await bridge.flush();
  assert.deepEqual(sizes, [[1920, 1080], [1280, 720]]);
  assert.equal(bridge.track.getSettings().height, 720);
  bridge.stop();
});

test('native video hands off owned frame buffers instead of copying them again', async () => {
  const originals = { generator: globalThis.MediaStreamTrackGenerator, frame: globalThis.VideoFrame };
  let pixels;
  globalThis.MediaStreamTrackGenerator = class {
    writable = { getWriter: () => ({ write: async frame => { pixels = frame.pixels; }, close: async () => {} }) };
    stop() {}
  };
  globalThis.VideoFrame = class {
    constructor(data, options) {
      this.pixels = globalThis.structuredClone(data, { transfer: options.transfer || [] });
    }
    close() {}
  };
  try {
    const bridge = createNativeVideoTrack();
    const payload = new Uint8Array(12); payload.fill(128);
    bridge.push({ type: 'frame', width: 4, height: 2, timestampUs: 1000, payload });
    await bridge.flush();
    assert.equal(payload.buffer.byteLength, 0, 'frame ownership must be transferred');
    assert.equal(pixels[0], 128, 'transferring ownership preserves the video pixels');
    bridge.stop();
  } finally {
    globalThis.MediaStreamTrackGenerator = originals.generator;
    globalThis.VideoFrame = originals.frame;
  }
});

test('native track keeps only the newest two frames and releases old frame buffers', async () => {
  const written = [];
  const closed = [];
  let releaseWrite;
  const pendingWrite = new Promise(resolve => { releaseWrite = resolve; });
  const factory = {
    createTrack: () => ({ kind: 'video', stop() {} }),
    createFrame: record => ({ sequence: record.sequence, close() { closed.push(record.sequence); } }),
    writeFrame: async frame => { written.push(frame.sequence); if (frame.sequence === 1) await pendingWrite; }
  };
  const bridge = createNativeVideoTrack({ maxQueuedFrames: 2, factory });
  bridge.push({ type: 'frame', sequence: 1, width: 4, height: 2, timestampUs: 1000, payload: new Uint8Array(12) });
  for (let sequence = 2; sequence <= 10; sequence++) {
    bridge.push({ type: 'frame', sequence, width: 4, height: 2, timestampUs: sequence * 1000, payload: new Uint8Array(12) });
  }
  assert.equal(bridge.metrics.received, 10);
  assert.ok(bridge.metrics.queued <= 2);
  assert.ok(bridge.metrics.dropped >= 7);
  releaseWrite();
  await bridge.flush();
  assert.equal(written[0], 1);
  assert.equal(written.at(-1), 10);
  assert.deepEqual(written.sort((a, b) => a - b), closed.sort((a, b) => a - b));
  bridge.stop();
});

test('native track reports resize and discards late frames after stop', async () => {
  const events = [];
  const bridge = createNativeVideoTrack({ factory: {
    createTrack: () => ({ kind: 'video', stop() { events.push('stop'); } }),
    createFrame: () => ({ close() {} }),
    writeFrame: async () => {}
  }, onStatus: event => events.push(event) });
  bridge.push({ type: 'resize', sequence: 1, width: 1920, height: 1080, timestampUs: 1000, payload: new Uint8Array(0) });
  assert.deepEqual(events[0], { type: 'resized', width: 1920, height: 1080 });
  bridge.stop();
  bridge.push({ type: 'frame', sequence: 2, width: 1920, height: 1080, timestampUs: 2000, payload: new Uint8Array(1920 * 1080 * 3 / 2) });
  await bridge.flush();
  assert.equal(bridge.metrics.received, 0);
  assert.deepEqual(events.at(-1), 'stop');
});

test('video writer failure stops the capture with a visible error status', async () => {
  const events = [];
  const bridge = createNativeVideoTrack({ factory: {
    createTrack: () => ({ stop() { events.push('stop'); } }),
    createFrame: () => ({ close() {} }),
    writeFrame: async () => { throw new Error('writer failed'); }
  }, onStatus: event => events.push(event) });
  bridge.push({ type: 'frame', sequence: 1, width: 4, height: 2, timestampUs: 1000, payload: new Uint8Array(12) });
  await new Promise(resolve => setImmediate(resolve));
  const error = events.find(event => event.type === 'error');
  assert.match(error?.message, /writer failed/);
  assert.equal(events.at(-1), 'stop');
});

test('track.getSettings reflects the dimensions of the received native frames', () => {
  const bridge = createNativeVideoTrack({ factory: {
    createTrack: () => ({ kind: 'video', stop() {} }),
    createFrame: () => ({ close() {} }),
    writeFrame: async () => {}
  } });
  assert.equal(bridge.track.getSettings().width, undefined);
  assert.equal(bridge.track.getSettings().height, undefined);
  bridge.push({ type: 'frame', sequence: 1, width: 2560, height: 1440, timestampUs: 1000, payload: new Uint8Array(12) });
  assert.equal(bridge.track.getSettings().width, 2560);
  assert.equal(bridge.track.getSettings().height, 1440);
  bridge.stop();
});
