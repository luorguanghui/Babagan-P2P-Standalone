# P2P Shared Uplink Budget Implementation Plan

> Superseded for version 1.09 by the user's feedback: remove the room-level hard budget. Use equal division of observed per-connection WebRTC bandwidth estimates only as a soft probe target and enforce per-tier per-viewer bitrate ceilings. Keep this plan as historical context.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop simultaneous P2P viewers from independently claiming the sender's full uplink while retaining direct or Cloudflare TURN transport.

**Architecture:** A pure room-level budget controller estimates a conservative total video ceiling and distributes it by capped equal-share water filling. The existing per-peer adaptive bitrate/resolution remains in charge of each link; `Mesh` applies the minimum of per-peer and room allocations. A user override is a hard ceiling, not a promised throughput.

**Tech Stack:** JavaScript ESM, WebRTC `getStats`, existing `Mesh`, Node test runner and Playwright.

**Spec:** `docs/superpowers/specs/2026-09-24-native-capture-p2p-budget-av-sync-design.md`

## Global Constraints

- Maximum five room members: at most four screen-video receivers.
- Only existing P2P/Cloudflare TURN paths; no SFU or additional upload service.
- Sum of configured video `maxBitrate` values must stay at or below the room video budget. Reserve 128 kbps per active receiver for audio/protocol traffic when estimating total uplink.
- A slow or lossy receiver may receive lower quality but must not prevent healthy receivers from receiving their remaining fair share.
- Static screens and missing `getStats` fields are not evidence of spare bandwidth; no aggressive upward probing from them.

## Review Focus

1. Four viewers joining within seconds should not produce four full 8 Mbps caps; Task 2 asserts cap sum.
2. One viewer's low estimate should free unused budget for others, without starving the slow viewer; Task 1 covers asymmetric water filling.
3. A removed viewer should release its share promptly and without exceeding the total cap; Task 1 covers join/leave.
4. Missing stats should retain a conservative cap; Task 1 covers null RTT/loss/BWE.
5. Manual budget changes during a share must update all senders without renegotiating the meeting; Task 3 covers it.

---

## File map

- `apps/standalone/client/upload-budget.mjs`: pure total-budget state transition and capped equal-share allocator.
- `apps/standalone/test/upload-budget.test.mjs`: 1–4 receiver, congestion, missing stat and recovery tests.
- `apps/standalone/client/mesh.mjs`: aggregate per-peer samples, call controller once per stats interval, apply allocated bitrates.
- `apps/standalone/client/app.mjs` and `index.html`: total upload ceiling selection and diagnostics.
- `apps/standalone/test/mesh.test.mjs` and `media-smoke.mjs`: sender caps and multi-viewer behavior.

### Task 1: Pure budget allocator and congestion control

**Interfaces:** `createUploadBudget({ ceilingBps = null })` returns `{ totalBps: 8_000_000, healthyWindows: 0, ceilingBps }`. `updateUploadBudget(state, samples)` returns the next state. `allocateUploadBudget(totalBps, peers)` returns `Map<peerId, videoCapBps>`. Each peer is `{ id, capacityBps, requestedBps }`; absent capacity falls back to requested cap. `samples` is an array of per-peer `{ loss, rtt, fps, targetFps, qualityLimitationReason }`. `Mesh` separately sums observed `outgoing` stats for UI display.

- [ ] **Step 1: Write failing tests** in `test/upload-budget.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocateUploadBudget, createUploadBudget, updateUploadBudget } from '../client/upload-budget.mjs';
test('three viewers share 8 Mbps without starving a 0.7 Mbps path', () => {
  const caps = allocateUploadBudget(8_000_000, [
    { id: 'slow', capacityBps: 700_000, requestedBps: 8_000_000 },
    { id: 'fast-a', capacityBps: 12_000_000, requestedBps: 8_000_000 },
    { id: 'fast-b', capacityBps: 12_000_000, requestedBps: 8_000_000 }
  ]);
  assert.ok(caps.get('slow') >= 350_000 && caps.get('slow') <= 700_000);
  assert.ok(caps.get('fast-a') > caps.get('slow'));
  assert.ok([...caps.values()].reduce((a, b) => a + b, 0) <= 8_000_000);
});
test('room budget backs off on congestion and rises slowly after three healthy windows', () => {
  const initial = createUploadBudget({});
  const down = updateUploadBudget(initial, [{ loss: 0.06, rtt: 0.45, fps: 30, targetFps: 60 }]);
  assert.ok(down.totalBps <= initial.totalBps * 0.8);
  let up = down;
  for (let i = 0; i < 3; i++) up = updateUploadBudget(up, [{ loss: 0, rtt: 0.05, fps: 60, targetFps: 60 }]);
  assert.ok(up.totalBps > down.totalBps && up.totalBps <= down.totalBps * 1.08 + 1);
});
```

- [ ] **Step 2:** Run `node --test apps/standalone/test/upload-budget.test.mjs`; expect failure because module is missing.
- [ ] **Step 3:** Implement bounded AIMD: start at 8 Mbps, multiply by 0.8 on loss >3%, RTT >350 ms or bandwidth limitation with collapsed FPS; increase at most 8% after three consecutive healthy, active windows; clamp to `[1 Mbps, min(user ceiling or 40 Mbps, 40 Mbps)]`. Allocate a 350 kbps floor per peer if feasible, then repeatedly divide remaining budget equally among peers below `min(capacityBps, requestedBps)`. If total budget is below all floors, divide equally rather than exceeding it.

```js
const severe = samples.some(s => (s.loss ?? 0) > 0.03 || (s.rtt ?? 0) > 0.35 ||
  (s.qualityLimitationReason === 'bandwidth' && s.fps != null && s.fps < s.targetFps * 0.75));
const nextBps = severe ? Math.floor(state.totalBps * 0.8)
  : state.healthyWindows >= 2 && samples.every(s => s.fps != null && s.fps >= s.targetFps * 0.85)
    ? Math.floor(state.totalBps * 1.08) : state.totalBps;
return { ...state, totalBps: Math.max(1_000_000, Math.min(nextBps, state.ceilingBps ?? 40_000_000)) };
```
- [ ] **Step 4:** Run tests; add table-driven tests for 1–4 peers, missing capacity, join/leave, static fps and a ceiling lower than aggregate floors. Verify no allocation is negative or exceeds requested/capacity.
- [ ] **Step 5:** Commit allocator and test using exact paths with message `feat: allocate shared P2P upload budget`.

### Task 2: Apply room allocations to WebRTC senders

**Interfaces:** `Mesh.configureUploadCeiling(ceilingBpsOrNull)` updates the controller. Each `peer.allocatedBitrate` is set from `allocateUploadBudget`; `Mesh.applyVideo` uses `Math.min(peer.budget.bitrate, peer.allocatedBitrate)`. `onMetrics` reports `totalVideoBudgetBps`, `allocatedBitrate` per peer, and total actual outgoing bitrate.

- [ ] **Step 1:** Add a failing `mesh.test.mjs` with four connected fake peers whose `sender.setParameters` records `encodings[0].maxBitrate`; call `mesh.stats()` twice and assert the four caps sum to at most 8 Mbps, with no single cap at 8 Mbps. Give one peer a 700 kbps BWE and assert the other three receive higher allocations.

```js
const caps = [...mesh.peers.values()].map(peer => peer.lastVideoParameters.encodings[0].maxBitrate);
assert.equal(caps.length, 4);
assert.ok(caps.reduce((sum, cap) => sum + cap, 0) <= 8_000_000);
assert.ok(caps.every(cap => cap < 8_000_000));
```
- [ ] **Step 2:** Run `node --test apps/standalone/test/mesh.test.mjs`; expect cap-sum assertion failure because all peers currently use independent budgets.
- [ ] **Step 3:** Refactor `Mesh.stats()` into collect → update shared controller → allocate → apply phases. Only one controller update occurs per three-second stats tick. Preserve `adaptBudget` for each peer, but cap the final sender parameter by the room allocation. Do not change ICE, SDP or codec preferences.

```js
this.uploadBudget = updateUploadBudget(this.uploadBudget,
  samples.map(({ sample }) => ({ ...sample, targetFps: this.video.fps })));
const allocations = allocateUploadBudget(this.uploadBudget.totalBps, samples.map(({ id, sample, peer }) => ({
  id, capacityBps: sample.available, requestedBps: peer.budget.bitrate
})));
for (const { id, peer } of samples) {
  peer.allocatedBitrate = allocations.get(id);
  await this.applyVideo(peer);
}
```
- [ ] **Step 4:** Run `mesh.test.mjs` and all standalone Node tests. Add a browser smoke with three receive pages; assert the UI reports three allocations and a sum no greater than the room budget while all video tracks stay live.
- [ ] **Step 5:** Commit Mesh integration and tests with message `feat: enforce total P2P video ceiling`.

### Task 3: User override and transparent diagnostics

**Interfaces:** A Windows-only `#upload-ceiling` select has `auto`, `8`, `12`, `20`, `40` Mbps options. The saved preference key is `p2p-upload-ceiling`. UI shows `总视频上行预算 X Mbps / 实际上行 Y Mbps` and each peer's allocation. Selection changes call `mesh.configureUploadCeiling` without restarting a share.

- [ ] **Step 1:** Extend `media-smoke.mjs` with a failing assertion: choose 8 Mbps, read all sender cap values from diagnostics, then change to 12 Mbps during an active three-viewer share and observe reallocation with no `RTCPeerConnection` replacement.

```js
await host.locator('#upload-ceiling').selectOption('8');
await host.waitForFunction(() => document.querySelector('#metrics-total').textContent.includes('8.00 Mbps'));
await host.locator('#upload-ceiling').selectOption('12');
await host.waitForFunction(() => document.querySelector('#metrics-total').textContent.includes('12.00 Mbps'));
await guest.locator('#screen:not([hidden])').waitFor();
```
- [ ] **Step 2:** Run online or local three-viewer smoke; expect missing selector/diagnostics failure.
- [ ] **Step 3:** Add the selector and labels to `client/index.html` and `app.mjs`. Validate persisted values against the five permitted choices; invalid localStorage value falls back to `auto`. Ensure Android controls stay hidden and no remote peer can change another user's budget.
- [ ] **Step 4:** Run UI smoke at desktop and mobile sizes, Node suite, targeted ESLint, 1–4 receiver media smoke under P2P and forced TURN. Check that total outbound stats include audio separately from the video budget.
- [ ] **Step 5:** Commit UI/docs/tests with message `feat: expose total uplink ceiling and per-peer allocations`.
