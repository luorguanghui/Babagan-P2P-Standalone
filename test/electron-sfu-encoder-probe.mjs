import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const require = createRequire(new URL('../package.json', import.meta.url));
const { _electron, chromium } = require('playwright');
const server = createServer(async (request, response) => {
  const name = request.url === '/' ? 'index.html' : request.url.slice(1);
  if (!/^[\w.-]+$/.test(name)) { response.writeHead(404).end(); return; }
  try {
    const data = await readFile(new URL(`../www/${name}`, import.meta.url));
    response.setHeader('Content-Type', name.endsWith('.html') ? 'text/html' : name.endsWith('.css') ? 'text/css' : 'text/javascript');
    response.end(data);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const env = { ...process.env, BABAGAN_SMOKE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const profile = await mkdtemp(path.join(tmpdir(), 'babagan-sfu-probe-'));
const app = await _electron.launch({ executablePath: process.env.BABAGAN_EXE || require('electron'),
  args: [...(process.env.BABAGAN_EXE ? [] : [process.cwd()]), `--user-data-dir=${profile}`], env, timeout: 30000 });
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const host = await app.firstWindow();
const guest = await browser.newPage();
const hostLogs = [];
host.on('console', message => hostLogs.push(`${message.type()}: ${message.text()}`));
host.on('pageerror', error => hostLogs.push(`pageerror: ${error.message}`));
const gpuSamples = [];
let sampler;
try {
  await guest.goto(`http://127.0.0.1:${server.address().port}`);
  await host.locator('#listen-only').check();
  await guest.locator('#listen-only').check();
  await host.locator('#name').fill('Electron SFU encoder probe');
  await host.locator('#create').click();
  await host.locator('#room:not([hidden])').waitFor({ timeout: 30000 });
  const invitation = await host.locator('#invite-text').textContent();
  await guest.locator('#name').fill('Probe guest');
  await guest.locator('#tab-join').click();
  await guest.locator('#invitation').fill(invitation);
  await guest.locator('#join').click();
  await guest.locator('#room:not([hidden])').waitFor({ timeout: 30000 });
  await host.locator('#use-sfu').check();
  await host.locator('#quality').selectOption('1080');
  await host.locator('#fps').selectOption('60');
  if (process.env.H264_PROFILE) await host.locator('#sfu-compat').check();
  else await host.locator('#sfu-compat').uncheck();
  await host.evaluate(({ filterConstrained, h264Only, h264Profile }) => {
    if (filterConstrained || h264Only || h264Profile) {
      const setCodecPreferences = globalThis.RTCRtpTransceiver.prototype.setCodecPreferences;
      globalThis.RTCRtpTransceiver.prototype.setCodecPreferences = function (codecs) {
        return setCodecPreferences.call(this, codecs.filter(codec =>
          (!h264Only || codec.mimeType?.toLowerCase() === 'video/h264') &&
          (!h264Profile || codec.mimeType?.toLowerCase() === 'video/rtx' ||
            (codec.mimeType?.toLowerCase() === 'video/h264' &&
              codec.sdpFmtpLine?.toLowerCase().includes(`profile-level-id=${h264Profile}`))) &&
          (!filterConstrained || !(codec.mimeType?.toLowerCase() === 'video/h264' &&
            /profile-level-id=42e0/i.test(codec.sdpFmtpLine || '')))));
      };
    }
    const PeerConnection = window.RTCPeerConnection;
    window.__probePeerConnections = [];
    window.RTCPeerConnection = class extends PeerConnection {
      constructor(...args) { super(...args); window.__probePeerConnections.push(this); }
    };
    navigator.mediaDevices.getDisplayMedia = async () => {
      const track = new globalThis.MediaStreamTrackGenerator({ kind: 'video' });
      const writer = track.writable.getWriter();
      const size = 1920 * 1080;
      const dark = new Uint8Array(size * 3 / 2), bright = new Uint8Array(size * 3 / 2);
      dark.fill(80, 0, size); dark.fill(128, size);
      bright.fill(180, 0, size); bright.fill(128, size);
      let frame = 0;
      track.addEventListener('ended', () => { void writer.close().catch(() => {}); });
      void (async () => {
        while (track.readyState === 'live') {
          const image = new globalThis.VideoFrame(frame++ % 2 ? dark : bright, { format: 'I420',
            codedWidth: 1920, codedHeight: 1080, timestamp: frame * 16667 });
          try { await writer.write(image); }
          catch { break; }
          finally { image.close(); }
          await new Promise(resolve => setTimeout(resolve, 17));
        }
      })();
      return new MediaStream([track]);
    };
  }, { filterConstrained: process.env.FILTER_CONSTRAINED === '1', h264Only: process.env.H264_ONLY === '1',
    h264Profile: process.env.H264_PROFILE || null });
  sampler = setInterval(() => {
    try {
      gpuSamples.push(execFileSync('nvidia-smi', ['--query-gpu=encoder.stats.sessionCount,utilization.encoder', '--format=csv,noheader'], { encoding: 'utf8' }).trim());
    } catch { /* GPU counters can be temporarily unavailable */ }
  }, 300);
  await host.locator('#share').click();
  await host.waitForFunction(() => document.querySelector('#metrics-total').textContent.includes('Cloudflare SFU'), null, { timeout: 30000 });
  await guest.waitForFunction(() => document.querySelector('#screen').videoWidth > 0, null, { timeout: 30000 });
  await host.waitForFunction(() => document.querySelector('#metrics-peers').textContent.includes('编码'), null, { timeout: 10000 });
  if (process.env.PROBE_SECONDS) {
    const deadline = Date.now() + Math.min(60, Math.max(0, Number(process.env.PROBE_SECONDS))) * 1000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      console.log(JSON.stringify({ elapsedProbe: true,
        host: await host.locator('#metrics-peers').innerText(), guest: await guest.locator('#metrics-peers').innerText() }));
    }
  }
  const stats = await host.evaluate(async () => {
    const connections = [];
    for (const pc of window.__probePeerConnections) {
      const reports = await pc.getStats();
      const outbounds = [...reports.values()].filter(report => report.type === 'outbound-rtp' && report.kind === 'video');
      for (const outbound of outbounds) {
        const codec = reports.get(outbound.codecId);
        connections.push({ implementation: outbound.encoderImplementation ?? null, powerEfficient: outbound.powerEfficientEncoder ?? null,
          framesEncoded: outbound.framesEncoded ?? null, frameWidth: outbound.frameWidth ?? null,
          frameHeight: outbound.frameHeight ?? null, fmtp: codec?.sdpFmtpLine ?? null,
          state: pc.connectionState });
      }
    }
    return connections;
  });
  console.log(JSON.stringify({ stats, nvencSessionSeen: gpuSamples.some(value => Number.parseInt(value, 10) > 0),
    hostMetrics: await host.locator('#metrics-peers').innerText() }));
} catch (error) {
  console.error('Host metrics:', await host.locator('#metrics').innerText().catch(() => 'unavailable'));
  console.error('Guest metrics:', await guest.locator('#metrics').innerText().catch(() => 'unavailable'));
  console.error('Host status:', await host.locator('#status').textContent().catch(() => 'unavailable'));
  console.error('Host logs:', hostLogs.slice(-12));
  throw error;
} finally {
  if (sampler) clearInterval(sampler);
  await host.locator('#end:visible').click({ timeout: 1500 }).catch(() => {});
  await browser.close();
  await app.close();
  await new Promise(resolve => server.close(resolve));
}
