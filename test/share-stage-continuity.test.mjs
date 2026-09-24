import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShareStageContinuity } from '../client/share-stage-continuity.mjs';

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
