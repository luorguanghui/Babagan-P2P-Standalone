// Isolated, offline Electron test. A UDP proxy drops actual WebRTC datagrams;
// HTTP network emulation does not exercise RTP. No captured images are saved.
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import dgram from 'node:dgram';
import assert from 'node:assert/strict';
const require = createRequire(new URL('../package.json', import.meta.url));
const { _electron } = require('playwright');
const profile = await mkdtemp(path.join(tmpdir(), 'babagan-flicker-'));
const env = { ...process.env, BABAGAN_SMOKE: '1' }; delete env.ELECTRON_RUN_AS_NODE;
const sockets = [dgram.createSocket('udp4'), dgram.createSocket('udp4')];
await Promise.all(sockets.map(socket => new Promise(resolve => socket.bind(0, '0.0.0.0', resolve))));
const targets = [], counters = { forwarded: 0, dropped: 0 };
let mode = 'normal', packet = 0;
for (let index = 0; index < 2; index++) sockets[index].on('message', bytes => {
  const target = targets[index];
  if (!target) return;
  // Preserve STUN consent/ICE and DTLS, impair SRTP/SRTCP only.
  const media = bytes[0] >= 128 && bytes[0] < 192;
  if (media && (mode === 'outage' || (mode === 'loss' && ++packet % 10 === 0))) {
    counters.dropped++; return;
  }
  counters.forwarded++;
  sockets[1 - index].send(bytes, target.port, target.address);
});
const app = await _electron.launch({ executablePath: process.env.BABAGAN_EXE || require('electron'),
  args: [...(process.env.BABAGAN_EXE ? [] : [process.cwd()]), `--user-data-dir=${profile}`,
    '--autoplay-policy=no-user-gesture-required'], env, timeout: 30000 });
const result = {};
async function waitProgress(page, frames, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const sample = await page.evaluate(() => window.__flicker.snapshot());
    if (sample.framesDecoded > frames + 10) return sample;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('RTP decoding did not resume after the outage');
}
try {
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('flickerSignal', async (id, message) => {
    if (message.candidate) {
      const fields = message.candidate.candidate.split(' ');
      if (fields[2].toLowerCase() !== 'udp' || fields[7] !== 'host' || !/^\d+\.\d+\.\d+\.\d+$/.test(fields[4])) return;
      const index = id === 'a' ? 0 : 1;
      if (targets[index]) return;
      targets[index] = { address: fields[4], port: Number(fields[5]) };
      fields[5] = String(sockets[index].address().port);
      message.candidate.candidate = fields.join(' ');
    }
    await page.evaluate(({ id, message }) => window.__flicker.mesh[id === 'a' ? 'z' : 'a'].signal({ ...message, from: id }), { id, message });
  });
  await page.evaluate(async () => {
    const { Mesh } = await import('./mesh.mjs');
    const { createShareStageContinuity } = await import('./share-stage-continuity.mjs');
    const { reconcileSharePlayback } = await import('./share-playback.mjs');
    const { createNativeVideoTrack } = await import('./native-capture-track.mjs');
    const probe = window.__flicker = { errors: [], events: [], mesh: {}, whiteFrames: 0, presented: 0 };
    const video = document.createElement('video'); video.muted = true; video.autoplay = true;
    const hold = document.createElement('canvas'); hold.hidden = true;
    const surface = document.createElement('div');
    surface.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#000';
    video.style.cssText = 'width:100%;height:100%;object-fit:contain';
    hold.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000';
    surface.append(video, hold); document.body.append(surface);
    const stage = createShareStageContinuity({ video, hold, empty: { hidden: true } });
    Object.assign(probe, { video, hold, stage, reconcileSharePlayback });
    for (const type of ['waiting', 'resize', 'emptied', 'pause', 'playing']) video.addEventListener(type, () => {
      probe.events.push({ type, readyState: video.readyState, holdVisible: !hold.hidden });
    });
    for (const id of ['a', 'z']) probe.mesh[id] = new Mesh({ id, iceServers: [], relayOnly: false,
      send: message => { void window.flickerSignal(id, message).catch(error => probe.errors.push(error.message)); },
      onTrack: (_id, index, track) => {
        if (id !== 'z' || index !== 1) return;
        probe.receivedTrack = track;
        reconcileSharePlayback(video, track, null, false, MediaStream, () => stage.hold());
        video.muted = true; stage.show(); void video.play().catch(error => probe.errors.push(error.message));
      }, onStatus() {}, onError: error => probe.errors.push(error.message), refreshIce: async () => [] });
    const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
    const context = canvas.getContext('2d');
    probe.sourceColor = '#fff';
    let motion = 0;
    probe.timer = setInterval(() => {
      context.fillStyle = probe.sourceColor; context.fillRect(0, 0, 1280, 720);
      if (probe.sourceColor !== '#fff') {
        // Dark moving texture: no source pixels should be white even with
        // partial decoding or a stale-overlay flash during packet loss.
        for (let y = 0; y < 720; y += 40) for (let x = 0; x < 1280; x += 40) {
          const level = 24 + (x / 40 * 17 + y / 40 * 31 + motion * 13) % 48;
          context.fillStyle = `rgb(${level},${level},${level})`; context.fillRect(x, y, 40, 40);
        }
      }
      motion++;
    }, 33);
    context.fillStyle = '#fff'; context.fillRect(0, 0, 1280, 720);
    probe.sourceTrack = canvas.captureStream(30).getVideoTracks()[0];
    await probe.mesh.a.configureVideo({ height: 720, fps: 30 });
    await probe.mesh.a.setTrack(1, probe.sourceTrack);
    probe.mesh.z.ensure('a', 'probe'); probe.mesh.a.ensure('z', 'probe');
    const sampleCanvas = document.createElement('canvas'); sampleCanvas.width = 8; sampleCanvas.height = 8;
    const sampling = sampleCanvas.getContext('2d', { willReadFrequently: true });
    probe.samplePixel = source => {
      sampling.drawImage(source, 0, 0, 8, 8);
      return [...sampling.getImageData(4, 4, 1, 1).data].slice(0, 3);
    };
    const sampleDisplay = () => {
      if (probe.checkWhite) {
        if (!hold.hidden || video.readyState >= 2) {
          const pixel = probe.samplePixel(hold.hidden ? video : hold);
          probe.presented++;
          if (pixel.every(value => value > 235)) probe.whiteFrames++;
        }
      }
      probe.frameRequest = window.requestAnimationFrame(sampleDisplay);
    };
    probe.frameRequest = window.requestAnimationFrame(sampleDisplay);
    probe.native = createNativeVideoTrack();
    probe.unsubscribe = window.babaganDesktop.onNativeRecord(record => {
      probe.native.push(record);
      if (record.type === 'frame') window.babaganDesktop.nativeReady();
    });
    probe.snapshot = async () => {
      const reports = await probe.mesh.z.peers.get('a').pc.getStats();
      const inbound = [...reports.values()].find(item => item.type === 'inbound-rtp' && item.kind === 'video');
      const outboundReports = await probe.mesh.a.peers.get('z').pc.getStats();
      const outbound = [...outboundReports.values()].find(item => item.type === 'outbound-rtp' && item.kind === 'video');
      const pair = [...reports.values()].find(item => item.type === 'candidate-pair' && item.state === 'succeeded' && item.nominated);
      return { framesDecoded: inbound?.framesDecoded, packetsLost: inbound?.packetsLost,
        nackCount: inbound?.nackCount, pliCount: inbound?.pliCount, freezeCount: inbound?.freezeCount,
        width: inbound?.frameWidth, height: inbound?.frameHeight,
        framesEncoded: outbound?.framesEncoded, bytesSent: outbound?.bytesSent,
        encoder: outbound?.encoderImplementation, decoder: inbound?.decoderImplementation,
        pairPorts: pair && [reports.get(pair.localCandidateId)?.port, reports.get(pair.remoteCandidateId)?.port],
        presented: probe.presented, whiteFrames: probe.whiteFrames, errors: probe.errors };
    };
  });
  await page.waitForFunction(() => window.__flicker.video.videoWidth === 1280 && window.__flicker.video.readyState >= 2, null, { timeout: 15000 });
  await page.waitForFunction(() => window.__flicker.hold.width > 0 && window.__flicker.samplePixel(window.__flicker.hold).every(value => value > 235));
  await page.evaluate(() => { window.__flicker.sourceColor = '#181818'; });
  await page.waitForFunction(() => window.__flicker.samplePixel(window.__flicker.video).every(value => value < 100));
  result.baseline = await page.evaluate(() => window.__flicker.snapshot());
  assert.ok(result.baseline.pairPorts.some(port => sockets.some(socket => socket.address().port === port)), 'ICE must actually select the UDP proxy');
  await page.evaluate(() => { window.__flicker.checkWhite = true; });
  mode = 'loss';
  await new Promise(resolve => setTimeout(resolve, 4000));
  result.loss = await page.evaluate(() => window.__flicker.snapshot());
  mode = 'outage';
  await new Promise(resolve => setTimeout(resolve, 1500));
  result.outage = await page.evaluate(() => window.__flicker.snapshot());
  mode = 'normal';
  result.recovered = await waitProgress(page, result.outage.framesDecoded);
  assert.ok(counters.dropped > 0);
  assert.ok(result.recovered.presented > 50, 'must sample visible output throughout the decoder outage');
  assert.equal(result.recovered.whiteFrames, 0);
  // Deterministic real-player reproduction of the stale-white snapshot path.
  result.reload = await page.evaluate(async () => {
    const p = window.__flicker;
    p.video.srcObject = null;
    await new Promise(resolve => setTimeout(resolve, 100));
    p.video.dispatchEvent(new globalThis.Event('waiting'));
    const state = { holdVisible: !p.hold.hidden, holdPixel: p.samplePixel(p.hold) };
    p.reconcileSharePlayback(p.video, p.receivedTrack, null, false, MediaStream, () => p.stage.hold());
    p.video.muted = true; await p.video.play();
    return state;
  });
  console.log('Reload probe:', JSON.stringify(result.reload));
  assert.equal(result.reload.holdVisible, false, 'cannot replay the initial white frame after the video is no longer drawable');
  await page.waitForFunction(() => window.__flicker.video.readyState >= 2);
  result.audio = await page.evaluate(() => {
    const p = window.__flicker, stream = p.video.srcObject;
    const resetsBefore = p.events.filter(event => event.type === 'emptied' || event.type === 'waiting').length;
    const context = new globalThis.AudioContext(), oscillator = context.createOscillator(), destination = context.createMediaStreamDestination();
    oscillator.connect(destination); oscillator.start();
    p.reconcileSharePlayback(p.video, p.receivedTrack, destination.stream.getAudioTracks()[0], false);
    const stable = stream === p.video.srcObject;
    const replacement = context.createMediaStreamDestination();
    p.reconcileSharePlayback(p.video, p.receivedTrack, replacement.stream.getAudioTracks()[0], false);
    p.reconcileSharePlayback(p.video, p.receivedTrack, null, false);
    p.video.muted = true;
    oscillator.stop(); void context.close();
    const resetsAfter = p.events.filter(event => event.type === 'emptied' || event.type === 'waiting').length;
    return { stable: stable && p.video.srcObject === stream, resetsBefore, resetsAfter };
  });
  assert.equal(result.audio.stable, true);
  assert.equal(result.audio.resetsAfter, result.audio.resetsBefore);
  // Exercise the real OBS helper -> IPC -> I420 -> H.264 -> UDP -> PC decoder.
  await page.evaluate(() => { window.__flicker.checkWhite = false; });
  await app.evaluate(({ app, BrowserWindow, ipcMain }) => {
    const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
    const { NativeCaptureService } = require('./desktop/native-capture-service.cjs');
    const { NativeFrameGate } = require('./desktop/native-frame-gate.cjs');
    const win = BrowserWindow.getAllWindows()[0];
    app.flickerGate = new NativeFrameGate(record => win.webContents.send('babagan:native-record', record), { maxInFlight: 2 });
    app.flickerReady = () => app.flickerGate.ready(); ipcMain.on('babagan:native-ready', app.flickerReady);
    const root = app.isPackaged ? process.resourcesPath + '/native-capture' : app.getAppPath() + '/native/runtime';
    app.flickerCapture = new NativeCaptureService({ helperPath: root + '/bin/64bit/babagan-capture.exe', sendEvent: record => app.flickerGate.push(record) });
    app.flickerCapture.start({ id: 'screen:0:0', kind: 'screen' }, { fps: 30, height: 1080 });
  });
  await page.waitForFunction(() => window.__flicker.native.metrics.written > 10);
  await page.evaluate(() => window.__flicker.mesh.a.setTrack(1, window.__flicker.native.track));
  await new Promise(resolve => setTimeout(resolve, 1500));
  result.nativeBefore = await page.evaluate(() => window.__flicker.snapshot());
  mode = 'loss'; await new Promise(resolve => setTimeout(resolve, 3000));
  mode = 'outage'; await new Promise(resolve => setTimeout(resolve, 1500));
  result.nativeOutage = await page.evaluate(() => window.__flicker.snapshot());
  mode = 'normal';
  result.nativeRecovered = await waitProgress(page, result.nativeOutage.framesDecoded);
  result.events = await page.evaluate(() => window.__flicker.events);
  result.proxy = { ...counters, ports: sockets.map(socket => socket.address().port) };
  assert.deepEqual(errors, []); assert.deepEqual(result.nativeRecovered.errors, []);
  const output = path.resolve('releases/p2p-flicker-fix-2026-10-03');
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, process.env.BABAGAN_EXE ? 'packaged-probe.json' : 'source-probe.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (error) {
  const output = path.resolve('releases/p2p-flicker-fix-2026-10-03');
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'failed-probe.json'), JSON.stringify({ error: error.message, ...result, proxy: counters }, null, 2));
  throw error;
} finally {
  await app.evaluate(({ app, ipcMain }) => {
    app.flickerCapture?.stop(); app.flickerGate?.stop();
    if (app.flickerReady) ipcMain.removeListener('babagan:native-ready', app.flickerReady);
  }).catch(() => {});
  await app.close(); for (const socket of sockets) socket.close();
}
