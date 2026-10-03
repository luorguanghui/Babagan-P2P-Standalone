import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileSharePlayback, setSharePreviewVisibility } from '../client/share-playback.mjs';

test('background local preview stops rendering without stopping its capture track or remote audio', () => {
  let pauses = 0;
  const video = { hidden: false, pause: () => { pauses++; }, srcObject: { getTracks: () => [{ readyState: 'live' }] } };
  assert.equal(setSharePreviewVisibility(video, true, false), false);
  assert.equal(pauses, 1);
  assert.equal(video.hidden, true);
  assert.equal(video.srcObject.getTracks()[0].readyState, 'live');
  assert.equal(setSharePreviewVisibility(video, true, true), true);
  assert.equal(video.hidden, false);
  assert.equal(setSharePreviewVisibility(video, false, false), true);
  assert.equal(pauses, 1, 'remote playback carries audio and must keep playing');
});

class FakeStream {
  constructor(tracks) { this.tracks = tracks; }
  getTracks() { return this.tracks; }
  addTrack(track) { this.tracks.push(track); }
  removeTrack(track) { this.tracks = this.tracks.filter(item => item !== track); }
}

test('late system audio and audio replacement do not reload an already playing video', () => {
  const video = { kind: 'video' }, audio = { kind: 'audio' }, replacement = { kind: 'audio' };
  const element = { srcObject: null };
  reconcileSharePlayback(element, video, null, false, FakeStream);
  const stream = element.srcObject;
  let transitions = 0;
  const beforeChange = () => { transitions++; };
  assert.equal(reconcileSharePlayback(element, video, audio, false, FakeStream, beforeChange), false);
  assert.equal(element.srcObject, stream);
  assert.deepEqual(stream.getTracks(), [video, audio]);
  reconcileSharePlayback(element, video, replacement, false, FakeStream, beforeChange);
  assert.equal(element.srcObject, stream);
  assert.deepEqual(stream.getTracks(), [video, replacement]);
  reconcileSharePlayback(element, video, null, false, FakeStream, beforeChange);
  assert.deepEqual(stream.getTracks(), [video]);
  assert.equal(transitions, 0);
});

test('remote screen and system sound play through one media element while local preview stays muted', () => {
  const video = { kind: 'video' }, systemAudio = { kind: 'audio' };
  const element = { srcObject: null, muted: true };
  assert.equal(reconcileSharePlayback(element, video, systemAudio, false, FakeStream), true);
  assert.deepEqual(element.srcObject.getTracks(), [video, systemAudio]);
  assert.equal(element.muted, false);
  const stream = element.srcObject;
  assert.equal(reconcileSharePlayback(element, video, systemAudio, false, FakeStream), false);
  assert.equal(element.srcObject, stream);
  assert.equal(reconcileSharePlayback(element, video, systemAudio, true, FakeStream), false);
  assert.equal(element.srcObject, stream);
  assert.deepEqual(stream.getTracks(), [video]);
  assert.equal(element.muted, true);
});
