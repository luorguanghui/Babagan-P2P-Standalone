# Native Windows Capture Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a bundled Windows screen/window capture source that maintains high frame rate when the meeting window is minimized, without requiring OBS.

**Architecture (implementation ruling):** A Windows x64 helper embeds only libobs and its Windows capture/WASAPI plugins. It emits I420 video and stereo PCM through a bounded local IPC bridge, which creates Electron video/audio generator tracks for the existing WebRTC mesh. It does not package OBS Studio UI, recording, streaming, or a virtual camera driver. Existing OBS and Chromium sources remain available. The first release targets entire-screen capture; Chromium remains the window source until native window capture is verified.

**Tech Stack:** C++20 / OBS Studio libobs 32.1.2 / Windows Graphics Capture / WASAPI; Electron 42, Node 24, WebCodecs, WebRTC, Playwright.

**Execution note:** The original DXGI/WGC implementation details in Tasks 2–4 below have been superseded by the approved minimal libobs implementation ruling. The empirical gate must count content-bearing frames: a prior 60 fps black-frame probe was invalidated by pixel sampling. Keep the remaining lifecycle, performance, resize, packaging and licensing gates.

**Spec:** `docs/superpowers/specs/2026-09-24-native-capture-p2p-budget-av-sync-design.md`

## Global Constraints

- Windows 10/11 x64 portable EXE; Android remains viewer/voice client.
- Media remains P2P or Cloudflare TURN. The helper opens no network listener.
- OBS is not required; OBS and Chromium capture remain user-selectable fallback sources.
- The helper emits source dimensions and QPC timestamps; no UI preset may stand in for actual dimensions.
- The product release gate is a 10-minute minimized 1080p60 dynamic-content run with capture and encoded 10-second-window median ≥57 fps, no sustained 10-second interval below 50 fps, and ≤80 ms added latency relative to OBS input.
- Do not modify user-owned files outside the standalone client and its docs; commit only explicit files when commits are made.
- The current `apps/standalone/` is untracked in the shared checkout; a fresh Git worktree from HEAD would omit it. Execute in the current checkout unless a reviewed commit or explicit file copy first makes the standalone source available in the worktree.

## Review Focus

1. A display mode change while sharing must restart native capture and preserve a live WebRTC track within two seconds; Task 4 tests this with an isolated virtual display.
2. Closing a captured window must end its track with a visible reason and free D3D resources; Task 4 covers it.
3. Capture output faster than renderer consumption must drop old frames with bounded memory, not grow latency; Task 2 covers it.
4. A helper crash must stop the share and leave OBS/Chromium fallback selectable; Task 5 covers it.
5. Protected/HDR content may be unavailable or tone-mapped; Task 4 checks explicit user feedback rather than a silent black image.

---

## File map

- `apps/standalone/native/capture-helper/main.cpp`: helper command protocol, process lifecycle, QPC time origin.
- `apps/standalone/native/capture-helper/dxgi-screen.cpp` and `.h`: monitor selection, D3D11 duplication, frame acquisition, mode-change restart.
- `apps/standalone/native/capture-helper/wgc-window.cpp` and `.h`: window selection, WGC frame pool and resize handling.
- `apps/standalone/native/capture-helper/frame-protocol.h`: fixed binary header and status records for local IPC.
- `apps/standalone/native/capture-helper/build.ps1`: build with the installed Visual Studio C++ toolset and Windows SDK.
- `apps/standalone/desktop/native-capture.cjs`: spawn helper, validate bounded IPC messages, restart/stop; no network binding.
- `apps/standalone/client/native-capture-track.mjs`: decode or copy frames into `MediaStreamTrackGenerator`, drop stale frames.
- `apps/standalone/client/native-capture-controller.mjs`: renderer-side controller returning a `MediaStream` and coordinating helper status with the frame bridge.
- `apps/standalone/client/app.mjs`, `client/index.html`, `desktop/main.cjs`, `package.json`: source selection, secure preload bridge, packaging and fallback.
- `apps/standalone/test/native-capture.test.mjs`, `native-capture-smoke.mjs`: protocol, backpressure, lifecycle and minimized media checks.

### Task 1: Define and validate helper frame protocol

**Interfaces:** A 36-byte little-endian header with magic `BGCF`, version `1`, record type, sequence, width, height, `qpcMicroseconds`, and payload length; record types `frame`, `resize`, `ended`, `error`. The parser returns `{ type, sequence, width, height, timestampUs, payload }` and rejects a frame payload over 64 MiB (enough for one 3840×2160 BGRA frame).

- [ ] **Step 1: Write a failing parser test** in `test/native-capture.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import capture from '../desktop/native-capture.cjs';
const { NativeFrameParser } = capture;
test('parser rejects oversize frames and reconstructs split records', () => {
  const parser = new NativeFrameParser({ maxPayloadBytes: 64 * 1024 * 1024 });
  const record = Buffer.alloc(40); record.write('BGCF'); record.writeUInt32LE(1, 4);
  record.writeUInt32LE(1, 8); record.writeUInt32LE(7, 12);
  record.writeUInt32LE(4, 16); record.writeUInt32LE(2, 20);
  record.writeBigUInt64LE(1000n, 24); record.writeUInt32LE(4, 32);
  assert.deepEqual(parser.push(record.subarray(0, 9)), []);
  assert.equal(parser.push(record.subarray(9)).length, 1);
  record.writeUInt32LE(65 * 1024 * 1024, 32);
  assert.throws(() => new NativeFrameParser().push(record), /payload/);
});
```

- [ ] **Step 2:** Run `node --test apps/standalone/test/native-capture.test.mjs`; expect failure because `NativeFrameParser` does not exist.
- [ ] **Step 3:** Implement the streaming parser and record encoder in `desktop/native-capture.cjs`; reject malformed magic/version, integer overflow, out-of-order sequence, and payload above the limit before allocating a body buffer. C++ `frame-protocol.h` uses the same field offsets and emits an `ended` record before normal exit. Use this decode boundary:

```js
if (header.subarray(0, 4).toString('ascii') !== 'BGCF') throw new Error('bad magic');
if (header.readUInt32LE(4) !== 1) throw new Error('unsupported frame version');
const length = header.readUInt32LE(32);
if (length > 64 * 1024 * 1024) throw new Error('payload too large');
```
- [ ] **Step 4:** Run the test; expect pass. Add a second split-at-every-byte test and a malformed-header test, then run again.
- [ ] **Step 5:** Commit only the parser, protocol header and test with `git add` on their explicit paths and message `test: define native capture frame protocol`.

### Task 2: Prove the Electron track bridge and bounded backpressure

**Interfaces:** `createNativeVideoTrack(frameSource, { maxQueuedFrames: 2 })` returns `{ track, stop, metrics }`. `frameSource` is an async iterator of Task 1 records. `metrics` exposes `received`, `written`, `dropped`, and latest source dimensions. `stop()` closes the writer and track.

- [ ] **Step 1:** Add a failing browser-backed test to `test/native-capture-smoke.mjs`: feed 180 synthetic 640×360 BGRA frames at 60 Hz to `createNativeVideoTrack`, add `track` to a local `RTCPeerConnection`, and assert `framesEncoded` rises by at least 150 in three seconds. Then feed 200 frames without waiting and assert `metrics.dropped > 0` and queued frames never exceed 2.
- [ ] **Step 2:** Run `node apps/standalone/test/native-capture-smoke.mjs`; expect failure because the track bridge is absent.
- [ ] **Step 3:** Implement the bridge in `client/native-capture-track.mjs` using the available `MediaStreamTrackGenerator({ kind: 'video' })`, `VideoFrame` timestamps in microseconds, and a two-frame queue. On frame size change, create a `VideoFrame` with the new `codedWidth`/`codedHeight` and update metrics. Ensure each frame is closed after `writer.write` settles; drop and close stale frames before creating further JS copies. The write boundary is:

```js
const generator = new MediaStreamTrackGenerator({ kind: 'video' });
const writer = generator.writable.getWriter();
const frame = new VideoFrame(record.payload, {
  format: 'BGRA', codedWidth: record.width, codedHeight: record.height,
  timestamp: record.timestampUs
});
try { await writer.write(frame); } finally { frame.close(); }
```
- [ ] **Step 4:** Run the browser-backed test in both visible and minimized Electron windows; record source, generated-track and encoded fps plus CPU, memory and latency. If the 10-minute performance gate fails, do not ship this raw path: add a second isolated test for helper NVENC H.264 packets → `VideoDecoder` → the same generator interface, using Annex B keyframe metadata and the same QPC time origin. Choose the first path that passes the gate; record the result in `docs/acceptance/native-capture-bridge-2026-09-24.md`.
- [ ] **Step 5:** Commit the bridge, benchmark test and acceptance measurement with explicit paths and message `feat: bridge native capture frames into WebRTC track` only after a path passes the gate.

### Task 3: Implement the bundled Windows capture helper

**Interfaces:** `capture-helper.exe --source monitor:<index>|window:<hwnd> --fps 60 --pipe stdout`; stdout carries only Task 1 records, stderr carries diagnostics. Exit code `0` is user stop, `2` is source loss, `3` is device loss, `4` is permission/protected content.

- [ ] **Step 1:** Extend `native-capture.test.mjs` to spawn the helper on a test monitor for five seconds; require at least 285 timestamped frames, strictly increasing `sequence` and QPC times, and no unexpected stdout text. Add a window-source test using a local moving test window.
- [ ] **Step 2:** Run the tests; expect executable-not-found failure.
- [ ] **Step 3:** Build `main.cpp`, `dxgi-screen.cpp`, and `wgc-window.cpp` with the installed MSVC toolset/Windows SDK. For monitors use `IDXGIOutput1::DuplicateOutput`, `AcquireNextFrame(17, ...)`, `ReleaseFrame()` in a `finally`-equivalent guard, and re-create duplication after `DXGI_ERROR_ACCESS_LOST`. Pace output to the requested target and repeat the latest frame when the desktop is unchanged, with a new presentation timestamp. For windows use `IGraphicsCaptureItemInterop::CreateForWindow`, `Direct3D11CaptureFramePool::FrameArrived`, `ContentSize`, `SystemRelativeTime`, and `Recreate` on size changes. Downscale on GPU only when the selected source exceeds the requested maximum; report actual post-scale dimensions. Validate source handles against the user-selected picker result passed from Electron. The acquisition boundary is:

Define `enum class CaptureResult { Frame, RepeatLatest, RestartDevice, Error };` in `dxgi-screen.h` before using it in the acquisition loop.

```cpp
DXGI_OUTDUPL_FRAME_INFO info{};
winrt::com_ptr<IDXGIResource> resource;
HRESULT hr = duplication->AcquireNextFrame(17, &info, resource.put());
if (hr == DXGI_ERROR_ACCESS_LOST) return CaptureResult::RestartDevice;
if (hr == DXGI_ERROR_WAIT_TIMEOUT) return CaptureResult::RepeatLatest;
if (FAILED(hr)) return CaptureResult::Error;
// Copy the acquired D3D11 texture before releasing the duplication frame.
duplication->ReleaseFrame();
```
- [ ] **Step 4:** Run helper tests at 30 and 60 fps; run the 10-minute minimized benchmark and a 2560×1440→1920×1080→2560×1440 isolated display-mode test. If it misses the Task 2 gate, stop before product integration and report measured bottleneck.
- [ ] **Step 5:** Commit helper code, build script and tests with message `feat: capture Windows displays and windows natively`.

### Task 4: Integrate source lifecycle and dynamic resolution

**Interfaces:** `NativeCaptureController.start(selection, options)` returns `{ stream, sourceId, stop }`; `stream` contains the generated video track. It exposes `onStatus({type:'resized'|'ended'|'error', width?, height?, reason?})` and guarantees no late track survives stop or room exit.

- [ ] **Step 1:** Extend `test/media-smoke.mjs` with a native-capture fixture that emits two sizes while three peers are connected. Assert each receiver sees live frames at the new dimensions within two seconds without meeting reconnect, and that closed windows stop the track and report a reason.
- [ ] **Step 2:** Run the fixture; expect failure because native source selection is missing.
- [ ] **Step 3:** Add a `native` option to `client/index.html`; in `client/app.mjs`, reuse the existing in-flight capture token so leave/retry cancels a pending native start. Spawn helper only from `desktop/main.cjs`, passing an allowlisted source selected by the existing native picker. On `resize`, reconfigure each `Mesh` sender's scale with `evenResolutionScale` and request a fresh keyframe if the browser supports it; on helper crash stop sharing and show a fallback choice. Keep OBS and Chromium modes unchanged.
- [ ] **Step 4:** Run unit tests, online three-peer media smoke, source and packaged EXE smoke; inspect 10-minute minimized stats and memory. Require no black interval over two seconds after resize and no raw frame/pipe leaks on stop/restart. In isolated fixtures, close a captured window and simulate unavailable/protected or HDR content: assert `ended` or a visible unsupported-content message, never a silently persistent black share.
- [ ] **Step 5:** Package the helper via `electron-builder` extra resources, verify it runs after portable EXE extraction without an OBS installation, and commit changed files with message `feat: add bundled native capture source`.

### Task 5: Release gate and rollback

- [ ] **Step 1:** Run `pnpm --filter @meeting/standalone test` and targeted ESLint; run local P2P, forced Cloudflare TURN, four-viewer, display resize, helper-crash and system sleep/wake acceptance. Record actual source/encoded/decoded fps, resolution and latency; compare against the OBS baseline.
- [ ] **Step 2:** If the spec's minimized fps/latency gate fails, leave native mode behind an experimental flag, preserve OBS as the recommended source, and do not label the build a replacement for OBS. If it passes, make native mode the Windows default and retain manual OBS/Chromium fallback.
- [ ] **Step 3:** Increment EXE/APK versions, build both, run packaged EXE smoke and APK signature validation, write SHA-256 sums and `docs/acceptance/native-capture-2026-09-24.md`. Commit release metadata with explicit paths.
