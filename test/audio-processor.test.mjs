import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUDIO_CONSTRAINTS, tuneOpusSdp, setupNoiseGate } from '../client/audio-processor.mjs';

test('AUDIO_CONSTRAINTS includes mandatory AEC, AGC and NS flags', () => {
  assert.equal(AUDIO_CONSTRAINTS.echoCancellation, true);
  assert.equal(AUDIO_CONSTRAINTS.noiseSuppression, true);
  assert.equal(AUDIO_CONSTRAINTS.autoGainControl, true);
  assert.equal(AUDIO_CONSTRAINTS.googHighpassFilter, true);
  assert.equal(AUDIO_CONSTRAINTS.googNoiseSuppression, true);
});

test('tuneOpusSdp adds usedtx=1 to existing Opus fmtp line', () => {
  const sdp = [
    'v=0',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'a=rtpmap:111 opus/48000/2',
    'a=fmtp:111 minptime=10;useinbandfec=1',
    'm=video 9 UDP/TLS/RTP/SAVPF 96'
  ].join('\r\n');

  const tuned = tuneOpusSdp(sdp);
  assert.ok(tuned.includes('a=fmtp:111 minptime=10;useinbandfec=1;usedtx=1'));
  // Calling it twice does not duplicate usedtx=1
  assert.equal(tuneOpusSdp(tuned), tuned);
});

test('tuneOpusSdp inserts fmtp line with usedtx=1 if fmtp was missing', () => {
  const sdp = [
    'v=0',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'a=rtpmap:111 opus/48000/2',
    'm=video 9 UDP/TLS/RTP/SAVPF 96'
  ].join('\r\n');

  const tuned = tuneOpusSdp(sdp);
  assert.ok(tuned.includes('a=fmtp:111 minptime=10;useinbandfec=1;usedtx=1'));
});

test('tuneOpusSdp leaves non-Opus SDP unchanged', () => {
  const sdp = 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n';
  assert.equal(tuneOpusSdp(sdp), sdp);
  assert.equal(tuneOpusSdp(''), '');
  assert.equal(tuneOpusSdp(null), null);
});

test('setupNoiseGate falls back gracefully when AudioContext is unavailable', () => {
  const fakeTrack = { kind: 'audio', stop() {} };
  const fakeStream = { getAudioTracks: () => [fakeTrack], getTracks: () => [fakeTrack] };
  const result = setupNoiseGate(fakeStream);
  assert.equal(result.track, fakeTrack);
  assert.equal(result.stream, fakeStream);
});
