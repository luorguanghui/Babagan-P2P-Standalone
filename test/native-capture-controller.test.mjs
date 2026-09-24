import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureNativeScreen } from '../client/native-capture-controller.mjs';

test('native capture forwards frames, acknowledges bounded IPC and stops on room exit', async () => {
  let listener, stopped = 0, ready = 0, trackStops = 0;
  const desktop = {
    onNativeRecord: callback => { listener = callback; return () => { listener = null; }; },
    startNativeCapture: async () => ({ sourceId: 'screen:0:0' }),
    stopNativeCapture: () => { stopped++; },
    nativeReady: () => { ready++; }
  };
  const records = [];
  const capture = await captureNativeScreen(desktop, { fps: 60, height: 1080 }, {
    createTrack: () => ({ track: { stop: () => trackStops++ }, push: record => records.push(record), stop: () => trackStops++ }),
    Stream: class { constructor(tracks) { this.tracks = tracks; } getVideoTracks() { return this.tracks; } }
  });
  listener({ type: 'frame', sequence: 1 });
  assert.equal(records.length, 1);
  assert.equal(ready, 1);
  capture.stop();
  assert.equal(stopped, 1);
  assert.equal(trackStops, 1);
  assert.equal(listener, null);
});

test('system sound is exposed alongside video and uses the same native record timestamps', async () => {
  let listener;
  const desktop = {
    onNativeRecord: callback => { listener = callback; return () => {}; },
    startNativeCapture: async () => ({ sourceId: 'screen:0:0' }),
    stopNativeCapture: () => {}, nativeReady: () => {}
  };
  const received = [];
  const capture = await captureNativeScreen(desktop, { fps: 60, height: 1080, audio: true }, {
    createTrack: () => ({ track: { kind: 'video' }, push: record => received.push(['video', record.timestampUs]), stop() {} }),
    createAudioTrack: () => ({ track: { kind: 'audio' }, push: record => received.push(['audio', record.timestampUs]), stop() {} }),
    Stream: class { constructor(tracks) { this.tracks = tracks; } getAudioTracks() { return this.tracks.filter(track => track.kind === 'audio'); } }
  });
  listener({ type: 'audio', timestampUs: 1000 });
  listener({ type: 'frame', timestampUs: 2000 });
  assert.equal(capture.stream.getAudioTracks().length, 1);
  assert.deepEqual(received, [['audio', 1000], ['video', 2000]]);
  capture.stop();
});
