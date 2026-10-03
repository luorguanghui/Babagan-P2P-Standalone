import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShareStageContinuity } from '../client/share-stage-continuity.mjs';

test('buffering cannot flash a white startup snapshot over a later dark frame', () => {
  const video = new globalThis.EventTarget();
  Object.assign(video, { readyState: 2, videoWidth: 1280, videoHeight: 720, frame: 'white' });
  let callback, heldFrame;
  video.requestVideoFrameCallback = fn => { callback = fn; return 1; };
  const hold = { hidden: true, getContext: () => ({ drawImage: image => { heldFrame = image.frame; } }) };
  const stage = createShareStageContinuity({ video, hold, empty: {} });
  stage.show(); callback();
  assert.equal(heldFrame, 'white');
  video.frame = 'dark'; video.readyState = 1;
  video.dispatchEvent(new globalThis.Event('waiting'));
  assert.equal(hold.hidden, true, 'keep the native last frame; the white startup snapshot is stale');
  video.dispatchEvent(new globalThis.Event('resize'));
  assert.equal(hold.hidden, true);
  video.dispatchEvent(new globalThis.Event('emptied'));
  assert.equal(hold.hidden, true, 'an unprepared reset must not expose a stale snapshot');
});

test('a prepared track transition does not overwrite its held frame with a resize placeholder', () => {
  const video = new globalThis.EventTarget();
  Object.assign(video, { readyState: 2, videoWidth: 1280, videoHeight: 720, frame: 'dark' });
  let callback, heldFrame;
  video.requestVideoFrameCallback = fn => { callback = fn; return 1; };
  const hold = { hidden: true, getContext: () => ({ drawImage: image => { heldFrame = image.frame; } }) };
  const stage = createShareStageContinuity({ video, hold, empty: {} });
  stage.show(); callback(); stage.hold();
  video.frame = 'white-placeholder';
  video.dispatchEvent(new globalThis.Event('resize'));
  assert.equal(heldFrame, 'dark');
  assert.equal(hold.hidden, false);
  callback();
  assert.equal(hold.hidden, true);
});

test('failed drawing and failed empty capture cannot revive a stale snapshot', () => {
  const video = new globalThis.EventTarget();
  Object.assign(video, { readyState: 2, videoWidth: 1280, videoHeight: 720 });
  let callback, cannotDraw = false;
  video.requestVideoFrameCallback = fn => { callback = fn; return 1; };
  const hold = { hidden: true, getContext: () => ({ drawImage() { if (cannotDraw) throw new Error('frame unavailable'); } }) };
  const stage = createShareStageContinuity({ video, hold, empty: {}, schedule: () => 1, cancel() {} });
  stage.show(); callback(); cannotDraw = true;
  video.dispatchEvent(new globalThis.Event('waiting'));
  assert.equal(hold.hidden, true);
  stage.requestEmpty(() => {}); stage.show();
  assert.equal(hold.hidden, true, 'a failed capture must not survive immediate reconnect');
});

test('an ended share discards its snapshot before another share starts', () => {
  const video = new globalThis.EventTarget();
  Object.assign(video, { readyState: 2, videoWidth: 1280, videoHeight: 720 });
  let callback, timer;
  video.requestVideoFrameCallback = fn => { callback = fn; return 1; };
  const hold = { hidden: true, getContext: () => ({ drawImage() {} }) };
  const stage = createShareStageContinuity({ video, hold, empty: {},
    schedule: fn => { timer = fn; return 1; }, cancel() {} });
  stage.show(); callback(); stage.requestEmpty(() => {}); timer();
  video.readyState = 0; stage.show();
  assert.equal(hold.hidden, true, 'a new sharer must not expose the previous sharer snapshot');
});

test('timeupdate fallback preserves a prepared frame across resize until playback resumes', () => {
  const video = new globalThis.EventTarget();
  Object.assign(video, { readyState: 2, videoWidth: 1280, videoHeight: 720, frame: 'dark' });
  let heldFrame;
  const hold = { hidden: true, getContext: () => ({ drawImage: image => { heldFrame = image.frame; } }) };
  const stage = createShareStageContinuity({ video, hold, empty: {} });
  stage.show(); video.dispatchEvent(new globalThis.Event('timeupdate')); stage.hold();
  video.frame = 'placeholder'; video.dispatchEvent(new globalThis.Event('resize'));
  assert.equal(heldFrame, 'dark'); assert.equal(hold.hidden, false);
  video.paused = true; video.dispatchEvent(new globalThis.Event('timeupdate'));
  assert.equal(hold.hidden, false);
  video.paused = false; video.dispatchEvent(new globalThis.Event('timeupdate'));
  assert.equal(hold.hidden, true);
});

test('pausing captures the current frame rather than revealing an old startup snapshot', () => {
  const video = new globalThis.EventTarget();
  Object.assign(video, { readyState: 2, videoWidth: 1280, videoHeight: 720, frame: 'initial' });
  let callback, heldFrame;
  video.requestVideoFrameCallback = fn => { callback = fn; return 1; };
  const hold = { hidden: true, getContext: () => ({ drawImage: image => { heldFrame = image.frame; } }) };
  const stage = createShareStageContinuity({ video, hold, empty: {} });
  stage.show(); callback();
  video.frame = 'latest'; video.paused = true;
  video.dispatchEvent(new globalThis.Event('pause'));
  assert.equal(heldFrame, 'latest');
  assert.equal(hold.hidden, false);
  callback();
  assert.equal(hold.hidden, false, 'in-flight callbacks must not reveal a paused player');
});

test('steady playback takes no periodic canvas snapshots and stops callbacks when empty', () => {
  const video = new globalThis.EventTarget();
  Object.assign(video, { readyState: 2, videoWidth: 1920, videoHeight: 1080 });
  let callback, draws = 0, timer, cancelled = 0;
  video.requestVideoFrameCallback = fn => { callback = fn; return 1; };
  video.cancelVideoFrameCallback = () => { cancelled++; };
  const hold = { hidden: true, getContext: () => ({ drawImage: () => { draws++; } }) };
  const stage = createShareStageContinuity({ video, hold, empty: {},
    schedule: fn => { timer = fn; return 1; }, cancel() {} });
  stage.show();
  callback(1000);
  const initial = draws;
  for (let time = 1300; time < 10000; time += 300) callback(time);
  assert.equal(draws, initial, 'normal video rendering must not trigger GPU-to-canvas copies');
  video.dispatchEvent(new globalThis.Event('waiting'));
  stage.requestEmpty(() => {});
  timer();
  assert.ok(cancelled > 0, 'idle stage must cancel its frame callback');
});

test('adaptive resolution change keeps the previous frame until the next decoded frame', () => {
  const video = new globalThis.EventTarget();
  video.readyState = 2; video.videoWidth = 1920; video.videoHeight = 1080;
  video.hidden = true; video.srcObject = { getTracks: () => [] };
  let frameCallback, timer, draws = 0;
  video.requestVideoFrameCallback = callback => { frameCallback = callback; };
  const hold = { hidden: true, width: 0, height: 0, getContext: () => ({ drawImage: () => { draws++; } }) };
  const empty = { hidden: false }, topBar = { hidden: true };
  const stage = createShareStageContinuity({ video, hold, empty, topBar,
    schedule: callback => { timer = callback; return 1; }, cancel: () => { timer = null; } });
  stage.show();
  frameCallback(1000);
  assert.equal(draws, 1);
  assert.equal(empty.hidden, true);
  video.dispatchEvent(new globalThis.Event('waiting'));
  assert.equal(hold.hidden, false);
  video.videoWidth = 1280; video.videoHeight = 720;
  video.dispatchEvent(new globalThis.Event('resize'));
  assert.equal(hold.hidden, false);
  frameCallback(1300);
  assert.equal(hold.hidden, true);
  assert.equal(empty.hidden, true);
  stage.requestEmpty(() => { video.srcObject = null; });
  assert.equal(empty.hidden, true, 'a transient no-sharer state must not show the waiting card');
  stage.show();
  assert.equal(timer, null);
  stage.requestEmpty(() => { video.srcObject = null; });
  timer();
  assert.equal(empty.hidden, false, 'an actual stopped share eventually shows the waiting card');
});

test('stage continuity retains previous frame across stream reload and suppresses premature empty display', () => {
  const video = new globalThis.EventTarget();
  video.readyState = 2; video.videoWidth = 1920; video.videoHeight = 1080;
  video.hidden = true; video.srcObject = null;
  let frameCallback, timer, draws = 0;
  video.requestVideoFrameCallback = callback => { frameCallback = callback; };
  const hold = { hidden: true, width: 0, height: 0, getContext: () => ({ drawImage: () => { draws++; } }) };
  const empty = { hidden: false }, topBar = { hidden: true };
  const stage = createShareStageContinuity({ video, hold, empty, topBar,
    schedule: callback => { timer = callback; return 1; }, cancel: () => { timer = null; } });

  // Initial show with no snapshot
  stage.show();
  assert.equal(hold.hidden, true);
  frameCallback(1000);
  assert.equal(draws, 1);

  // Transient stream reload: srcObject becomes null, requestEmpty is called
  video.srcObject = null;
  stage.requestEmpty(() => {});
  // Empty card must NOT flash immediately even if srcObject is null
  assert.equal(empty.hidden, true, 'empty card must not show immediately when srcObject is temporarily null');
  assert.equal(hold.hidden, false, 'hold snapshot must remain visible');

  // Stream reconnects within delayMs: show() is called
  stage.show();
  assert.equal(timer, null, 'pending empty timer must be cancelled');
  assert.equal(empty.hidden, true);
  assert.equal(hold.hidden, false, 'hold snapshot must bridge the gap until first new frame renders');

  // First new frame arrives
  frameCallback(1200);
  assert.equal(hold.hidden, true, 'hold snapshot is hidden after fresh frame composited');
  assert.equal(empty.hidden, true);
});

test('updating a playing share does not flash the previous snapshot over live video', () => {
  const video = new globalThis.EventTarget();
  video.readyState = 2; video.videoWidth = 1920; video.videoHeight = 1080;
  video.hidden = true;
  let frameCallback;
  video.requestVideoFrameCallback = callback => { frameCallback = callback; };
  const hold = { hidden: true, width: 0, height: 0, getContext: () => ({ drawImage() {} }) };
  const stage = createShareStageContinuity({ video, hold, empty: { hidden: false }, topBar: { hidden: true } });

  stage.show();
  frameCallback(1000);
  assert.equal(hold.hidden, true);

  stage.show(); // A room roster or connection status update calls renderScreen again.
  assert.equal(hold.hidden, true, 'live video must not be covered by an old frame');

  video.dispatchEvent(new globalThis.Event('waiting'));
  assert.equal(hold.hidden, false, 'the snapshot still covers a real playback interruption');
});

test('a paused video keeps its last frame over the native play placeholder until playback resumes', () => {
  const video = new globalThis.EventTarget();
  video.readyState = 2; video.videoWidth = 1280; video.videoHeight = 720;
  let frameCallback;
  video.requestVideoFrameCallback = callback => { frameCallback = callback; };
  const hold = { hidden: true, width: 0, height: 0, getContext: () => ({ drawImage() {} }) };
  const stage = createShareStageContinuity({ video, hold, empty: { hidden: false } });
  stage.show();
  frameCallback(1000);
  assert.equal(hold.hidden, true);

  video.paused = true;
  video.dispatchEvent(new globalThis.Event('pause'));
  assert.equal(hold.hidden, false);
  frameCallback(1100);
  assert.equal(hold.hidden, false, 'an in-flight callback must not reveal a paused player');
  video.paused = false;
  frameCallback(1200);
  assert.equal(hold.hidden, true, 'a fresh rendered frame removes the snapshot');
});

test('an emptied media element retains the last frame instead of exposing its black background', () => {
  const video = new globalThis.EventTarget();
  video.readyState = 2; video.videoWidth = 1280; video.videoHeight = 720;
  let frameCallback;
  video.requestVideoFrameCallback = callback => { frameCallback = callback; };
  const hold = { hidden: true, width: 0, height: 0, getContext: () => ({ drawImage() {} }) };
  const stage = createShareStageContinuity({ video, hold, empty: { hidden: false } });
  stage.show();
  frameCallback(1000);
  video.dispatchEvent(new globalThis.Event('emptied'));
  assert.equal(hold.hidden, false);
});

test('changing the remote video track can cover the player before it paints a placeholder', () => {
  const video = new globalThis.EventTarget();
  video.readyState = 2; video.videoWidth = 1280; video.videoHeight = 720;
  let frameCallback;
  video.requestVideoFrameCallback = callback => { frameCallback = callback; };
  const hold = { hidden: true, width: 0, height: 0, getContext: () => ({ drawImage() {} }) };
  const stage = createShareStageContinuity({ video, hold, empty: { hidden: false } });
  stage.show();
  frameCallback(1000);
  stage.hold();
  assert.equal(hold.hidden, false);
});
