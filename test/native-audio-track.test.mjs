import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNativeAudioTrack } from '../client/native-audio-track.mjs';

test('system audio uses helper timestamps and bounded PCM queue', async () => {
  const written = [];
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const track = createNativeAudioTrack({ maxQueuedBlocks: 2, factory: {
    createTrack: () => ({ stop() {} }),
    createAudio: record => ({ timestamp: record.timestampUs, close() {} }),
    writeAudio: async block => { written.push(block.timestamp); if (written.length === 1) await held; },
    close() {}
  } });
  for (let sequence = 1; sequence <= 5; sequence++) track.push({ type: 'audio', sequence,
    width: 48000, height: 2, timestampUs: sequence * 10_000, payload: new Uint8Array(1920) });
  release();
  await track.flush();
  assert.deepEqual(written, [10_000, 40_000, 50_000]);
  assert.equal(track.metrics.dropped, 2);
  track.stop();
});
