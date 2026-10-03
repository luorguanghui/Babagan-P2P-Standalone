// Offline Electron + real native capture + local P2P probe. No screen images
// are saved or sent outside this machine. Uses an isolated app profile.
import { createRequire } from 'node:module';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(new URL('../package.json', import.meta.url));
const { _electron } = require('playwright');
const profile = await mkdtemp(path.join(tmpdir(), 'babagan-performance-'));
const env = { ...process.env, BABAGAN_SMOKE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const app = await _electron.launch({ executablePath: process.env.BABAGAN_EXE || require('electron'),
  args: [...(process.env.BABAGAN_EXE ? [] : [process.cwd()]), `--user-data-dir=${profile}`], env, timeout: 30000 });
let nativeStarted = false;
async function poll(page, predicate, argument, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await page.evaluate(predicate, argument);
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('Native WebRTC frame progress timed out');
}
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const ownership = await page.evaluate(async () => {
    const { createNativeVideoTrack } = await import('./native-capture-track.mjs');
    const { Mesh } = await import('./mesh.mjs');
    const { createShareStageContinuity } = await import('./share-stage-continuity.mjs');
    const { setSharePreviewVisibility } = await import('./share-playback.mjs');
    const probe = window.__nativeProbe = { errors: [] };
    probe.video = createNativeVideoTrack();
    probe.video.track.contentHint = 'motion';
    const payload = new Uint8Array(12); payload.fill(128);
    probe.video.push({ type: 'frame', width: 4, height: 2, timestampUs: 1, payload });
    await probe.video.flush();
    const transferredBytes = payload.byteLength;
    const settings = { height: 1080, fps: 60, adaptive: true };
    const makeMesh = id => new Mesh({ id, iceServers: [], relayOnly: false,
      send: message => { const other = id === 'a' ? probe.receiver : probe.sender;
        void other.signal({ ...message, from: id }).catch(error => probe.errors.push(error.message)); },
      onTrack() {}, onStatus() {}, onError: error => probe.errors.push(error.message), refreshIce: async () => [] });
    probe.sender = makeMesh('a'); probe.receiver = makeMesh('z');
    probe.sender.ensure('z', 'epoch'); probe.receiver.ensure('a', 'epoch');
    await probe.sender.configureVideo(settings);
    const video = document.createElement('video');
    video.muted = true; video.autoplay = true; video.width = 960;
    document.body.append(video);
    const hold = document.createElement('canvas');
    document.body.append(hold);
    let snapshots = 0;
    const context = hold.getContext('2d');
    const draw = context.drawImage.bind(context);
    context.drawImage = (...args) => { snapshots++; return draw(...args); };
    const stage = createShareStageContinuity({ video, hold, empty: { hidden: true } });
    probe.preview = video; probe.stage = stage; probe.snapshots = () => snapshots;
    probe.unsubscribePreview = window.babaganDesktop.onPreviewVisibility(visible => {
      stage.setSuspended(!visible);
      if (setSharePreviewVisibility(video, true, visible)) void video.play();
    });
    probe.unsubscribe = window.babaganDesktop.onNativeRecord(record => {
      probe.video.push(record);
      if (record.type === 'frame') window.babaganDesktop.nativeReady();
    });
    video.srcObject = new MediaStream([probe.video.track]);
    stage.show(); void video.play().catch(error => probe.errors.push(error.message));
    probe.ready = async () => {
      await probe.sender.setTrack(1, probe.video.track);
    };
    return transferredBytes;
  });
  assert.equal(ownership, 0, 'Electron must support owned-buffer VideoFrame transfer');
  await app.evaluate(({ app, BrowserWindow, ipcMain }) => {
    const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
    const { NativeCaptureService } = require('./desktop/native-capture-service.cjs');
    const { NativeFrameGate } = require('./desktop/native-frame-gate.cjs');
    const win = BrowserWindow.getAllWindows()[0];
    app.probeGate = new NativeFrameGate(record => win.webContents.send('babagan:native-record', record), { maxInFlight: 2 });
    app.probeReady = () => app.probeGate.ready();
    ipcMain.on('babagan:native-ready', app.probeReady);
    const root = app.isPackaged ? process.resourcesPath + '/native-capture' : app.getAppPath() + '/native/runtime';
    app.probeCapture = new NativeCaptureService({ helperPath: root + '/bin/64bit/babagan-capture.exe',
      sendEvent: record => app.probeGate.push(record) });
    app.probeCapture.start({ id: 'screen:0:0', kind: 'screen' }, { fps: 60, height: 1080 });
  });
  nativeStarted = true;
  await page.waitForFunction(() => window.__nativeProbe.video.metrics.width > 4, null, { timeout: 10000 });
  await page.evaluate(() => window.__nativeProbe.ready());
  const before = await poll(page, async () => {
    const probe = window.__nativeProbe;
    const reports = await probe.sender.peers.get('z').pc.getStats();
    const out = [...reports.values()].find(report => report.type === 'outbound-rtp' && report.kind === 'video' && report.framesEncoded > 30 && report.frameHeight > 4);
    return out ? { frames: out.framesEncoded, width: out.frameWidth, height: out.frameHeight, snapshots: probe.snapshots() } : false;
  });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].emit('blur'));
  await page.waitForFunction(() => window.__nativeProbe.preview.paused && window.__nativeProbe.preview.hidden);
  const after = await poll(page, async frames => {
    const probe = window.__nativeProbe;
    const reports = await probe.sender.peers.get('z').pc.getStats();
    const out = [...reports.values()].find(report => report.type === 'outbound-rtp' && report.kind === 'video' && report.framesEncoded > frames + 30 && report.frameHeight > 4);
    return out ? { frames: out.framesEncoded, width: out.frameWidth, height: out.frameHeight,
      snapshots: probe.snapshots(), captured: probe.video.metrics.received, errors: probe.errors,
      encoding: { degradationPreference: probe.sender.peers.get('z').slots[1].sender.getParameters().degradationPreference, encodings: probe.sender.peers.get('z').slots[1].sender.getParameters().encodings } } : false;
  }, before.frames);
  assert.ok(before.frames > 30); assert.ok(after.frames > before.frames + 30);
  assert.equal(before.height, 1080); assert.equal(after.width, before.width); assert.equal(after.height, before.height);
  assert.equal(after.snapshots, before.snapshots, 'background sharing must not snapshot video textures');
  assert.equal(after.encoding.degradationPreference, 'maintain-resolution');
  assert.deepEqual(after.errors, []); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ before, after, bufferTransferred: true, previewPausedWhileSending: true }));
} finally {
  if (nativeStarted) await app.evaluate(({ app, ipcMain }) => {
    app.probeCapture.stop(); app.probeGate.stop(); ipcMain.removeListener('babagan:native-ready', app.probeReady);
  }).catch(() => {});
  await app.close();
}
