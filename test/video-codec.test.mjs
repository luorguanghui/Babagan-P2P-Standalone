import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preferH264, preferredVideoCodecs, describeEncoder, tuneVideoSdp } from '../client/video-codec.mjs';

test('H.264 is preferred while VP8 and retransmission remain available', () => {
  const vp8 = { mimeType: 'video/VP8' }, rtx = { mimeType: 'video/rtx' };
  const h264 = { mimeType: 'video/H264', sdpFmtpLine: 'packetization-mode=1;profile-level-id=42001f' };
  const codecs = [vp8, rtx, h264];
  let selected;
  assert.equal(preferH264({ setCodecPreferences(value) { selected = value; } }, codecs), true);
  assert.deepEqual(selected, [h264, vp8, rtx]);
  assert.deepEqual(codecs, [vp8, rtx, h264]);
});

test('unsupported H.264 leaves browser negotiation unchanged', () => {
  let called = false;
  assert.equal(preferH264({ setCodecPreferences() { called = true; } }, [{ mimeType: 'video/VP8' }]), false);
  assert.equal(called, false);
});

test('a browser rejecting H.264 preferences keeps its default negotiation', () => {
  assert.equal(preferH264({ setCodecPreferences() { throw new Error('unsupported profile'); } }, [{ mimeType: 'video/H264' }]), false);
});

test('receiver capabilities are used when available', () => {
  const original = { receiver: globalThis.RTCRtpReceiver, sender: globalThis.RTCRtpSender };
  globalThis.RTCRtpReceiver = { getCapabilities: () => ({ codecs: [{ mimeType: 'video/H264' }] }) };
  globalThis.RTCRtpSender = { getCapabilities: () => ({ codecs: [{ mimeType: 'video/VP8' }] }) };
  try { assert.deepEqual(preferredVideoCodecs(), [{ mimeType: 'video/H264' }]); }
  finally { globalThis.RTCRtpReceiver = original.receiver; globalThis.RTCRtpSender = original.sender; }
});

test('the actual encoder, rather than the codec name, determines the software or hardware label', () => {
  assert.match(describeEncoder('libvpx', false), /^软件编码/);
  assert.match(describeEncoder('MediaFoundationVideoEncodeAccelerator (NVIDIA H.264 Encoder MFT)', true), /^硬件编码/);
  assert.equal(describeEncoder(null, null), '编码器未报告');
});

test('preferH264 sorts High Profile before Baseline Profile', () => {
  const baseline = { mimeType: 'video/H264', sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f' };
  const high = { mimeType: 'video/H264', sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640c1f' };
  const vp8 = { mimeType: 'video/VP8' };
  let selected;
  preferH264({ setCodecPreferences(value) { selected = value; } }, [baseline, vp8, high]);
  assert.deepEqual(selected, [high, baseline, vp8]);
});

test('hardware H.264 publishing prefers ordinary Main with Baseline and RTX fallback', () => {
  const high = { mimeType: 'video/H264', sdpFmtpLine: 'packetization-mode=1;profile-level-id=64001f' };
  const constrained = { mimeType: 'video/H264', sdpFmtpLine: 'packetization-mode=1;profile-level-id=42e01f' };
  const baseline = { mimeType: 'video/H264', sdpFmtpLine: 'packetization-mode=1;profile-level-id=42001f' };
  const main = { mimeType: 'video/H264', sdpFmtpLine: 'packetization-mode=1;profile-level-id=4d001f' };
  const vp8 = { mimeType: 'video/VP8' }, rtx = { mimeType: 'video/rtx' };
  let selected;
  assert.equal(preferH264({ setCodecPreferences(value) { selected = value; } },
    [constrained, vp8, high, baseline, main, rtx], { hardware: true }), true);
  assert.deepEqual(selected, [main, baseline, rtx]);
});

test('hardware H.264 publishing retains interoperable codecs when ordinary Baseline is unavailable', () => {
  const constrained = { mimeType: 'video/H264', sdpFmtpLine: 'packetization-mode=1;profile-level-id=42e01f' };
  const vp8 = { mimeType: 'video/VP8' };
  let selected;
  assert.equal(preferH264({ setCodecPreferences(value) { selected = value; } },
    [vp8, constrained], { hardware: true }), true);
  assert.deepEqual(selected, [constrained, vp8]);
});

test('tuneVideoSdp adds min, start, max bitrate and b=AS bandwidth', () => {
  const sdp = [
    'v=0',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'a=rtpmap:111 opus/48000/2',
    'm=video 9 UDP/TLS/RTP/SAVPF 96',
    'c=IN IP4 0.0.0.0',
    'a=rtpmap:96 H264/90000',
    'a=fmtp:96 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f'
  ].join('\r\n');

  const tuned = tuneVideoSdp(sdp);
  assert.ok(tuned.includes('x-google-min-bitrate=2500'));
  assert.ok(tuned.includes('x-google-start-bitrate=6000'));
  assert.ok(tuned.includes('x-google-max-bitrate=30000'));
  assert.ok(tuned.includes('b=AS:30000'));
  assert.equal(tuneVideoSdp(tuned), tuned);
});

test('tuneVideoSdp ignores non-video SDP safely', () => {
  const sdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
  assert.equal(tuneVideoSdp(sdp), sdp);
  assert.equal(tuneVideoSdp(''), '');
  assert.equal(tuneVideoSdp(null), null);
});
