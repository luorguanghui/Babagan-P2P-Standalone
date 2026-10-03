// Local capture probe. Records frame counters only; no screen images are saved.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import serviceModule from '../desktop/native-capture-service.cjs';

const { NativeCaptureService } = serviceModule;
let frames = [], errors = [], lastTimestamp = -1;
const service = new NativeCaptureService({
  helperPath: fileURLToPath(new URL('../native/runtime/bin/64bit/babagan-capture.exe', import.meta.url)),
  sendEvent(record) {
    if (record.type === 'error' || record.type === 'ended') errors.push(record);
    if (record.type !== 'frame') return;
    assert.ok(record.timestampUs > lastTimestamp, 'restart must preserve a monotonic video clock');
    lastTimestamp = record.timestampUs;
    frames.push({ time: performance.now(), height: record.height, bytes: record.payload.byteLength });
  }
});

async function sample(fps, height) {
  await new Promise(resolve => setTimeout(resolve, 1500));
  frames = [];
  await new Promise(resolve => setTimeout(resolve, 3000));
  assert.deepEqual(errors, []);
  assert.ok(frames.length >= fps * 2.4, `capture at ${fps} fps delivered ${frames.length} frames in 3s`);
  assert.ok(frames.every(frame => frame.height <= height));
  const measuredFps = (frames.length - 1) * 1000 / (frames.at(-1).time - frames[0].time);
  assert.ok(measuredFps < fps * 1.15, `old capture FPS still active: ${measuredFps}`);
  return { fps, height, measuredFps: Math.round(measuredFps * 10) / 10,
    rawMiBPerSecond: Math.round(frames.reduce((sum, frame) => sum + frame.bytes, 0) / 3 / 1048576) };
}

try {
  service.start({ id: 'screen:0:0', kind: 'screen' }, { fps: 60, height: 1080 });
  const before = await sample(60, 1080);
  service.configure({ fps: 30, height: 720 });
  const after = await sample(30, 720);
  assert.ok(after.rawMiBPerSecond < before.rawMiBPerSecond * 0.4);
  console.log(JSON.stringify({ before, after, rawTrafficReductionPercent:
    Math.round((1 - after.rawMiBPerSecond / before.rawMiBPerSecond) * 100) }));
} finally { service.stop(); }
