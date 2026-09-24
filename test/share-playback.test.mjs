import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileSharePlayback } from '../client/share-playback.mjs';

class FakeStream {
  constructor(tracks) { this.tracks = tracks; }
  getTracks() { return this.tracks; }
}

test('remote screen and system sound play through one media element while local preview stays muted', () => {
  const video = { kind: 'video' }, systemAudio = { kind: 'audio' };
  const element = { srcObject: null, muted: true };
  reconcileSharePlayback(element, video, systemAudio, false, FakeStream);
  assert.deepEqual(element.srcObject.getTracks(), [video, systemAudio]);
  assert.equal(element.muted, false);
  const stream = element.srcObject;
  reconcileSharePlayback(element, video, systemAudio, false, FakeStream);
  assert.equal(element.srcObject, stream);
  reconcileSharePlayback(element, video, systemAudio, true, FakeStream);
  assert.equal(element.muted, true);
});
