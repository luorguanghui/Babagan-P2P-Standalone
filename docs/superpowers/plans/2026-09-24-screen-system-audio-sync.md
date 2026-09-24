# Screen and System Audio Synchronization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep shared system sound aligned with shared video across capture, WebRTC transport and Android/Windows playback while leaving microphone audio independent.

**Architecture:** Native WASAPI loopback audio uses the same monotonic QPC time origin as native screen frames. Video and system sound share one `MediaStream`/WebRTC stream association and one remote `<video>` playback element; microphone stays on its own audio element. Sync stats and a flash/beep fixture gate the release.

**Tech Stack:** WASAPI / QPC, Electron 42 `AudioData` and `MediaStreamTrackGenerator`, WebRTC `RTCRtpSender.setStreams`, WebRTC stats, Node tests, Playwright, Android WebView.

**Spec:** `docs/superpowers/specs/2026-09-24-native-capture-p2p-budget-av-sync-design.md`

## Global Constraints

- Synchronize shared screen video with shared system audio. Microphone is independent and must remain available when sharing stops.
- Video and system audio timestamps use a single monotonic origin; no backwards timestamps after resize, audio-device change or reconnect.
- Prefer WebRTC's stream/jitter-buffer synchronization; do not add unbounded application buffers.
- Healthy local-network stable segment target: absolute A/V offset ≤150 ms, verified on Windows and Android; show a diagnostic warning if sustained offset exceeds the threshold.
- Native audio is optional when the user did not select system sound. OBS capture mode continues video-only unless separately designed.

## Review Focus

1. Local preview must be muted to prevent captured system sound feeding back into the loopback device; Task 1 tests this.
2. Replacing the share track must not stop or duplicate a participant's microphone; Task 1 tests it.
3. Audio output device change must restart loopback and keep timestamps increasing; Task 2 tests it.
4. A late system-audio track after share stop must be released, not attached to a later share; Task 2 tests it.
5. Missing WebRTC playout timestamp must show “无法测量同步” rather than a false 0 ms claim; Task 3 tests it.

---

## File map

- `apps/standalone/native/capture-helper/wasapi-loopback.cpp` and `.h`: default render endpoint, loopback packet read and device-change restart.
- `apps/standalone/native/capture-helper/frame-protocol.h`: add type `audio` with sample rate, channels, frame count, QPC microseconds and interleaved PCM payload.
- `apps/standalone/client/native-capture-audio.mjs`: export `decodeNativeAudioRecord(record)` and construct timestamped `AudioData` / audio `MediaStreamTrackGenerator` from native records.
- `apps/standalone/client/mesh.mjs`: `setShareStream(stream)` groups video/system-audio senders and keeps microphone separate.
- `apps/standalone/client/app.mjs`: receive and play shared A/V in `#screen` while remote microphone remains in `#audio-elements`.
- `apps/standalone/client/av-sync.mjs`: pure playout-offset calculation and sustained warning state.
- `apps/standalone/test/av-sync.test.mjs`, `mesh.test.mjs`, `media-smoke.mjs`: track grouping, no double audio, offset and device lifecycle.

### Task 1: Group existing screen and system-audio tracks

**Interfaces:** `Mesh.setShareStream(streamOrNull)` replaces fixed slots `1` (video) and `2` (system audio), calls `sender.setStreams(stream)` for both when supported, and leaves slot `0` (microphone) untouched. Receiver state is `{ micAudio, screenVideo, systemAudio }`; `#screen.srcObject` contains screen video and optional system audio, and `#screen.muted` is `true` only for local preview.

- [ ] **Step 1:** Add a failing `mesh.test.mjs`: create a `MediaStream` with one video and one system-audio track, call `setShareStream`, assert both senders receive the **same** stream via `setStreams` while microphone sender's track remains unchanged. Add an `app` integration test asserting the remote `<video>` has one video and one audio track, remote `<audio>` has only the microphone, and local `<video>` is muted.

```js
await mesh.setShareStream(screenStream);
assert.equal(videoSender.streams[0], screenStream);
assert.equal(systemAudioSender.streams[0], screenStream);
assert.equal(microphoneSender.track, originalMicrophone);
assert.deepEqual(await guest.locator('#screen').evaluate(video =>
  [video.srcObject.getVideoTracks().length, video.srcObject.getAudioTracks().length]), [1, 1]);
```
- [ ] **Step 2:** Run `node --test apps/standalone/test/mesh.test.mjs` and `node apps/standalone/test/media-smoke.mjs`; expect missing-method and remote-track grouping failures.
- [ ] **Step 3:** Implement `setShareStream` in `mesh.mjs` without changing the fixed transceiver order. In `app.mjs`, call it when the share lock is granted; store incoming index `1` as `screenVideo`, index `2` as `systemAudio`, and index `0` as microphone. On any screen-track update, rebuild the receiver `MediaStream` with `[screenVideo, systemAudio].filter(Boolean)` and attach it to `#screen`; set `video.muted = sharer === session?.id`. Never add index `2` to the microphone audio element. `setStreams` may fire negotiation-needed; reuse the existing perfect-negotiation queue and assert the post-renegotiation track stays live.
- [ ] **Step 4:** Run the new tests and existing two-peer/three-peer screen share smokes. Check no audio loop is heard locally, and that mute/unmute only affects microphone.
- [ ] **Step 5:** Commit explicit files with message `fix: play shared screen and system sound as one stream`.

### Task 2: Capture system sound with the native helper time origin

**Interfaces:** `NativeCaptureController.start(selection, { includeSystemAudio })` returns `{ stream, sourceId, stop }` as defined in the native capture plan; `stream` contains video and optional system-audio tracks. IPC record type `5` is audio: the frame header's width field means `sampleRate`, height means `channels`, and the payload begins with a little-endian `sampleFrames` uint32 followed by interleaved Float32 PCM (`4 + sampleFrames * channels * 4` bytes). The header QPC-derived `timestampUs` applies to the first sample. WASAPI's `pu64QPCPosition` is in 100 ns units; the helper divides by 10 and rebases both A/V tracks against a shared first-capture origin.

- [ ] **Step 1:** Add failing parser/audio tests. A record with 480 stereo frames at 48 kHz must become an `AudioData` chunk with `format:'f32'`, `sampleRate:48000`, `numberOfFrames:480`, `numberOfChannels:2`, a strictly increasing microsecond timestamp, and 10 ms duration. A simulated device-change event must preserve later timestamps and stop the old loopback client. A delayed audio record arriving after `stop()` must be discarded and its buffer released.

```js
const audio = decodeNativeAudioRecord({ sampleRate: 48_000, channels: 2, sampleFrames: 480,
  timestampUs: 1_000_000, pcm: new Float32Array(960) });
assert.equal(audio.format, 'f32');
assert.equal(audio.sampleRate, 48_000);
assert.equal(audio.numberOfFrames, 480);
assert.equal(audio.numberOfChannels, 2);
assert.equal(audio.timestamp, 1_000_000);
audio.close();
```
- [ ] **Step 2:** Run `node --test apps/standalone/test/native-capture.test.mjs apps/standalone/test/av-sync.test.mjs`; expect missing audio record/track implementation.
- [ ] **Step 3:** In the native helper, activate the default render endpoint with `AUDCLNT_STREAMFLAGS_LOOPBACK`, read all `IAudioCaptureClient::GetBuffer` packets, handle SILENT/DATA_DISCONTINUITY/TIMESTAMP_ERROR flags, convert endpoint PCM to 48 kHz stereo Float32, and emit records with normalized QPC microseconds. Reinitialize on default render-device change; signal an error rather than silently attaching a different audio source if reopening fails. In `native-capture-audio.mjs`, feed records to `MediaStreamTrackGenerator({kind:'audio'})`, close each `AudioData` after the writer consumes it, and bound the queue to 200 ms.
- [ ] **Step 4:** Run synthetic audio-track tests, native helper device-change smoke and paired video+audio loopback tests. Verify monotonic timestamps across a simulated 2560×1440→1920×1080 video resize and an audio endpoint switch.
- [ ] **Step 5:** Commit helper and JS bridge using explicit paths with message `feat: timestamp native system sound with screen capture`.

### Task 3: Observe and recover sustained A/V drift

**Interfaces:** `measureAvOffset(stats)` returns `{ offsetMs, measurable }`, using inbound screen-audio and screen-video `estimatedPlayoutTimestamp` values for the same peer; null or missing values produce `measurable:false`. `observeAvSync(previous, measurement)` produces `{ consecutiveBad, warning }`; `warning` is true after three samples over 150 ms absolute offset.

- [ ] **Step 1:** Add failing `av-sync.test.mjs` cases for +80 ms, -170 ms, missing timestamp, unrelated microphone-audio stats, and three consecutive bad samples. Add a browser flash/beep fixture whose video flashes on the same 1-second marks as 1 kHz, 30 ms audio pulses.

```js
assert.deepEqual(measureAvOffset({ screenAudio: { estimatedPlayoutTimestamp: 1080 },
  screenVideo: { estimatedPlayoutTimestamp: 1000 } }), { offsetMs: 80, measurable: true });
assert.deepEqual(measureAvOffset({ screenAudio: {}, screenVideo: {} }),
  { offsetMs: null, measurable: false });
let state = { consecutiveBad: 0, warning: false };
for (let i = 0; i < 3; i++) state = observeAvSync(state, { offsetMs: -170, measurable: true });
assert.equal(state.warning, true);
```
- [ ] **Step 2:** Run the unit and browser tests; expect missing-measurement implementation.
- [ ] **Step 3:** Implement measurement using the screen audio/video stats' shared stream identity, show measured offset (or “无法测量”) in diagnostics, and expose a bounded `reattachSharedPlayback()` action when offset >150 ms for three samples. Reattach once with a cooldown of at least 30 seconds; do not build an ever-growing delay buffer. Preserve the microphone element and volume controls.
- [ ] **Step 4:** Measure flash/beep alignment for 10 minutes in local P2P and forced TURN, then on an Android device. Record p50/p95 absolute offset, source/encoded/decoded FPS, audio concealment and each reattach. Pass the healthy local-network target only if stable-segment p95 ≤150 ms; if device playback exceeds it, keep warning visible and do not claim synchronized delivery.
- [ ] **Step 5:** Run standalone tests, targeted ESLint, packaged EXE and APK checks; write acceptance results and commit explicit paths with message `feat: monitor and recover shared audio video sync`.
