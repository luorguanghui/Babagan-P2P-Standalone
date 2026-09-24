import { createRequire } from 'node:module';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
const pwRequire = createRequire(new URL('../package.json', import.meta.url));
const { _electron } = pwRequire('playwright');
const require = createRequire(new URL('../package.json', import.meta.url));
const env = { ...process.env, BABAGAN_SMOKE: '1' }; delete env.ELECTRON_RUN_AS_NODE;
const profile = await mkdtemp(path.join(tmpdir(), 'babagan-smoke-'));
const packaged = process.env.BABAGAN_EXE;
const app = await _electron.launch({ timeout: 30000, executablePath: packaged || require('electron'), args: [...(packaged ? [] : [path.resolve(fileURLToPath(new URL('../', import.meta.url)))]), `--user-data-dir=${profile}`, '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'], env });
console.log('Electron launch connected.');
try {
  const page = await app.firstWindow();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const pickerWindow = app.waitForEvent('window');
  pickerWindow.catch(() => {});
  await app.evaluate(({ app, BrowserWindow, desktopCapturer, nativeImage }) => {
    const original = desktopCapturer.getSources;
    const thumbnail = nativeImage.createFromBitmap(process.getBuiltinModule('buffer').Buffer.alloc(400 * 225 * 4, 140), { width: 400, height: 225 });
    desktopCapturer.getSources = async () => [{ id: 'window:123:0', name: '测试应用窗口', thumbnail }, { id: 'screen:1:0', name: '测试显示器', thumbnail }];
    app.pickerResult = undefined;
    process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')('./desktop/source-picker.cjs').chooseSource(BrowserWindow.getAllWindows()[0], true).then(value => { app.pickerResult = value?.source.id || null; }).finally(() => { desktopCapturer.getSources = original; });
  });
  const picker = await pickerWindow;

  await picker.locator('#windows').click();
  await picker.getByRole('button', { name: '测试应用窗口预览 测试应用窗口' }).waitFor();
  assert.equal(await picker.locator('.preview img').count(), 1);
  assert.equal(await picker.locator('#confirm').isDisabled(), true);
  await picker.locator('.source').click();
  assert.equal(await picker.locator('#confirm').isEnabled(), true);
  await picker.locator('#screens').click();
  assert.equal(await picker.locator('#confirm').isDisabled(), true);
  await picker.locator('.source').click();
  await picker.locator('#confirm').click();
  assert.equal(await app.evaluate(({ app }) => app.pickerResult), 'screen:1:0');
  console.log('Thumbnail picker PASS: preview, tabs, explicit selection and IPC result.');
  await page.locator('#name').fill('Desktop smoke');
  const security = await page.evaluate(() => ({ secure: isSecureContext, require: typeof window.require, media: typeof navigator.mediaDevices?.getUserMedia, captureBridge: typeof window.babaganDesktop?.captureStarted }));
  assert.deepEqual(security, { secure: true, require: 'undefined', media: 'function', captureBridge: 'function' });
  const cameraTrackReady = await page.evaluate(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    const ready = stream.getVideoTracks()[0]?.readyState === 'live';
    stream.getTracks().forEach(track => track.stop());
    return ready;
  });
  assert.equal(cameraTrackReady, true);
  await app.evaluate(({ app, powerSaveBlocker }) => {
    app.capturePowerEvents = [];
    const start = powerSaveBlocker.start.bind(powerSaveBlocker);
    const stop = powerSaveBlocker.stop.bind(powerSaveBlocker);
    powerSaveBlocker.start = kind => { const id = start(kind); app.capturePowerEvents.push(['start', kind, id]); return id; };
    powerSaveBlocker.stop = id => { app.capturePowerEvents.push(['stop', id]); return stop(id); };
  });
  await page.evaluate(() => window.babaganDesktop.captureStarted());
  for (let attempt = 0; attempt < 20; attempt++) {
    if (await app.evaluate(({ app }) => app.capturePowerEvents.length) >= 1) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await page.evaluate(() => window.babaganDesktop.captureStopped());
  for (let attempt = 0; attempt < 20; attempt++) {
    if (await app.evaluate(({ app }) => app.capturePowerEvents.length) >= 2) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const powerEvents = await app.evaluate(({ app }) => app.capturePowerEvents);
  assert.deepEqual(powerEvents.map(event => event[0]), ['start', 'stop']);
  assert.equal(powerEvents[0][1], 'prevent-app-suspension');
  assert.equal(powerEvents[0][2], powerEvents[1][1]);
  await page.locator('#create').click();
  await page.locator('#room:not([hidden])').waitFor({ timeout: 30000 });
  await page.locator('#share-source').selectOption('obs');
  assert.equal(await page.locator('#system-audio').isDisabled(), true);
  assert.equal(await page.locator('#share').textContent(), '共享 OBS');
  await page.locator('#share-source').selectOption('screen');
  await page.locator('#peers').getByText('Desktop smoke（你） · 主持人', { exact: false }).waitFor();
  const micText = async () => (await page.locator('#mic').textContent()).trim();
  assert.equal(await micText(), '开启麦克风');
  await page.locator('#mic').click();
  assert.equal(await micText(), '静音');
  await page.locator('#mic').click();
  assert.equal(await micText(), '开启麦克风');
  await page.locator('#end').click();
  await page.locator('#lobby:not([hidden])').waitFor();
  assert.deepEqual(errors, []);
  console.log(`Desktop ${packaged ? 'packaged executable' : 'source'} smoke PASS: secure local protocol, isolated renderer, fake microphone, online create/join/end.`);
} finally { await app.close(); }
