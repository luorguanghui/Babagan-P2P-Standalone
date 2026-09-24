// Automated developer test; does not use the user's browser profile or accounts.
// Local mode substitutes ICE only, to test actual local WebRTC without TURN credentials.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const pwRequire = createRequire(new URL('../package.json', import.meta.url));
const { chromium } = pwRequire('playwright');
const root = new URL('../www/', import.meta.url);
const endpoint = process.env.WORKER_URL || 'http://127.0.0.1:8787';
const online = Boolean(process.env.WORKER_URL);
const server = createServer(async (req, res) => {
  const name = req.url === '/' ? 'index.html' : req.url.slice(1);
  if (!/^[\w.-]+$/.test(name)) { res.writeHead(404).end(); return; }
  try { const data = await readFile(new URL(name, root)); res.setHeader('Content-Type', name.endsWith('.html') ? 'text/html' : name.endsWith('.css') ? 'text/css' : 'text/javascript'); res.end(data); } catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}), headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1200, height: 800 } });
if (!online) await context.route('**/rooms/*/ice', route => route.fulfill({ json: { iceServers: [], expiresAt: Date.now() + 86400000 }, headers: { 'access-control-allow-origin': '*' } }));
const errors = [];
const a = await context.newPage(), b = await context.newPage();
for (const page of [a,b]) {
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  if (!await page.locator('#worker').isVisible()) await page.locator('#settings summary').click();
  await page.locator('#worker').fill(endpoint);
  if (process.env.RELAY_ONLY === '1' || (page === b && process.env.MIXED_RELAY === '1')) await page.locator('#relay-only').check();
}
try {
  await a.locator('#name').fill('Host'); await a.locator('#create').click();
  await a.locator('#room:not([hidden])').waitFor({ timeout: 25000 });
  const invitation = await a.locator('#invite-text').textContent();
  await a.locator('#copy').click();
  await a.locator('#status').waitFor({ state: 'visible' });
  await a.waitForFunction(() => !document.querySelector('#status').textContent, null, { timeout: 7000 });
  await b.locator('#name').fill('Guest'); await b.locator('#tab-join').click(); await b.locator('#invitation').fill(invitation); await b.locator('button[type=submit]').click();
  await b.locator('#room:not([hidden])').waitFor({ timeout: 25000 });
  const path = process.env.RELAY_ONLY === '1' || process.env.MIXED_RELAY === '1' ? 'Cloudflare TURN' : /P2P 直连|Cloudflare TURN/;
  await a.locator('#peers small').filter({ hasText: path }).waitFor({ timeout: 45000 });
  await b.locator('#peers small').filter({ hasText: path }).waitFor({ timeout: 45000 });
  assert.equal(await a.locator('#peers small').filter({ hasText: path }).textContent(), await b.locator('#peers small').filter({ hasText: path }).textContent());
  for (const page of [a,b]) assert.ok(await page.locator('audio').evaluate(el => el.srcObject.getAudioTracks().some(t => t.readyState === 'live')));
  await b.locator('#peers').getByText('Host · 主持人 · 静音', { exact: false }).waitFor();
  await a.locator('#mic').click();
  await b.locator('#peers').getByText('Host · 主持人', { exact: true }).waitFor();
  await a.locator('#mic').click();
  await b.locator('#peers').getByText('Host · 主持人 · 静音', { exact: false }).waitFor();
  // Supply a synthetic screen track through the same application capture flow.
  await a.evaluate(() => {
    navigator.mediaDevices.getDisplayMedia = async (constraints) => {
      if (constraints.video.width || constraints.video.height || constraints.video.aspectRatio) throw new Error("Capture must not force source dimensions or ratio");
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480;
      const ctx = canvas.getContext('2d'); let frame = 0;
      const timer = setInterval(() => { ctx.fillStyle = frame++ % 2 ? '#075d72' : '#2fa9ba'; ctx.fillRect(0,0,640,480); }, 100);
      const stream = canvas.captureStream(10); stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer)); return stream;
    };
  });
  assert.equal(await a.locator('#quality').inputValue(), 'source');
  await a.locator('#fps').selectOption('60');
  await a.locator('#share').click();
  await b.locator('#screen:not([hidden])').waitFor();
  await b.waitForFunction(() => document.querySelector('#screen').videoWidth > 0, { timeout: 15000 });
  const h264Available = await b.evaluate(() => window.RTCRtpReceiver.getCapabilities('video')?.codecs.some(codec => codec.mimeType.toLowerCase() === 'video/h264'));
  if (h264Available) await b.waitForFunction(() => document.querySelector('#metrics-peers').textContent.includes('H264'), null, { timeout: 15000 });
  assert.equal(await b.locator('#share').isDisabled(), true);
  assert.deepEqual(await b.locator('#screen').evaluate(v => [v.videoWidth, v.videoHeight]), [640,480]);
  await a.waitForFunction(() => document.querySelector('#metrics-peers').textContent.includes('发送'));
  await a.locator('#fps').selectOption('30');
  await a.locator('#quality').selectOption('720');
  await a.locator('#adaptive').uncheck();
  await a.waitForFunction(() => document.querySelector('#metrics-total').textContent.includes('720p / 30 fps'));
  await a.locator('#share').click();
  await b.locator('#empty:not([hidden])').waitFor();
  await a.locator('#share-source').selectOption('obs');
  assert.equal(await a.locator('#system-audio').isDisabled(), true);
  await a.evaluate(() => {
    const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.enumerateDevices = async () => [{ kind: 'videoinput', label: 'OBS Virtual Camera', deviceId: 'test-obs' }];
    navigator.mediaDevices.getUserMedia = async constraints => {
      if (!constraints.video) return originalGetUserMedia(constraints);
      if (constraints.video.deviceId?.exact !== 'test-obs') throw new Error('OBS device ID was not requested');
      const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 450;
      const context = canvas.getContext('2d'); let frame = 0;
      const timer = setInterval(() => { context.fillStyle = frame++ % 2 ? '#38bdf8' : '#1e293b'; context.fillRect(0, 0, 800, 450); }, 100);
      const stream = canvas.captureStream(10);
      stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer));
      return stream;
    };
  });
  await a.locator('#share').click();
  await b.locator('#screen:not([hidden])').waitFor();
  await b.waitForFunction(() => document.querySelector('#screen').videoWidth === 800, null, { timeout: 15000 });
  await a.locator('#share').click();
  await b.locator('#empty:not([hidden])').waitFor();
  await b.locator('#retry').click();
  await b.locator('#peers small').filter({ hasText: path }).waitFor({ timeout: 45000 });
  await a.locator('#peers small').filter({ hasText: path }).waitFor({ timeout: 45000 });
  await mkdir(new URL('../releases/', import.meta.url), { recursive: true });
  await a.screenshot({ path: fileURLToPath(new URL('../releases/desktop-smoke.png', import.meta.url)) });
  await b.setViewportSize({ width: 390, height: 844 });
  assert.equal(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await b.screenshot({ path: fileURLToPath(new URL('../releases/mobile-smoke.png', import.meta.url)) });
  await a.evaluate(() => {
    window.obsRaceCalls = 0;
    window.obsRaceReleases = [];
    window.obsRaceStreams = [];
    navigator.mediaDevices.getUserMedia = async constraints => {
      if (!constraints.video) throw new Error('unexpected audio capture during OBS race test');
      window.obsRaceCalls += 1;
      await new Promise(resolve => window.obsRaceReleases.push(resolve));
      const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 450;
      const context = canvas.getContext('2d'); context.fillRect(0, 0, 800, 450);
      const stream = canvas.captureStream(10);
      window.obsRaceStreams.push(stream);
      return stream;
    };
  });
  await a.locator('#share').click();
  await a.waitForFunction(() => window.obsRaceCalls === 1);
  await a.evaluate(() => document.querySelector('#share').click());
  await a.waitForTimeout(100);
  assert.equal(await a.evaluate(() => window.obsRaceCalls), 1, 'a pending OBS capture must not start twice');
  await a.locator('#end').click();
  await b.locator('#lobby:not([hidden])').waitFor();
  await a.evaluate(() => window.obsRaceReleases.forEach(release => release()));
  await a.waitForFunction(() => window.obsRaceStreams.length === 1 && window.obsRaceStreams.every(stream => stream.getVideoTracks()[0].readyState === 'ended'));
  assert.deepEqual(errors, []);
  console.log(`Media smoke PASS (${online ? 'online Cloudflare' : 'local, ICE stub'}): two peers, live audio, mute, screen frames, share lock, stop, reconnect, end, mobile width.`);
} catch (e) { console.error('Host:', await a.locator('body').innerText()); console.error('Guest:', await b.locator('body').innerText()); throw e; }
finally { await a.locator('#end:visible').click({ timeout: 1000 }).catch(() => {}); await browser.close(); server.close(); }
