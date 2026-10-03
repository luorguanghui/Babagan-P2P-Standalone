import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const require = createRequire(new URL('../package.json', import.meta.url));
const { chromium } = require('playwright');
const root = new URL('../www/', import.meta.url);
const server = createServer(async (request, response) => {
  const name = request.url === '/' ? 'index.html' : request.url.slice(1);
  if (!/^[\w.-]+$/.test(name)) { response.writeHead(404).end(); return; }
  try {
    const body = await readFile(new URL(name, root));
    response.setHeader('Content-Type', name.endsWith('.html') ? 'text/html' : name.endsWith('.css') ? 'text/css' : 'text/javascript');
    response.end(body);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext();
const host = await context.newPage();
const guest = await context.newPage();
const hostErrors = [];
host.on('pageerror', error => hostErrors.push(error.message));
host.on('console', message => { if (['warning', 'error'].includes(message.type())) hostErrors.push(message.text()); });
try {
  await host.addInitScript(() => {
    const PeerConnection = window.RTCPeerConnection;
    window.__smokePeerConnections = [];
    window.RTCPeerConnection = class extends PeerConnection {
      constructor(...args) {
        super(...args);
        window.__smokePeerConnections.push(this);
      }
    };
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  for (const page of [host, guest]) {
    await page.goto(url);
    await page.locator('#listen-only').check();
  }
  await host.locator('#name').fill('SFU smoke host');
  await host.locator('#create').click();
  await host.locator('#room:not([hidden])').waitFor({ timeout: 30000 });
  const invitation = await host.locator('#invite-text').textContent();
  await guest.locator('#name').fill('SFU smoke guest');
  await guest.locator('#tab-join').click();
  await guest.locator('#invitation').fill(invitation);
  await guest.locator('#join').click();
  await guest.locator('#room:not([hidden])').waitFor({ timeout: 30000 });
  await host.locator('#use-sfu').check();
  await host.locator('#quality').selectOption('720');
  await host.evaluate(() => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 1280; canvas.height = 720;
      const context = canvas.getContext('2d');
      let frame = 0;
      const timer = setInterval(() => {
        context.fillStyle = frame++ % 2 ? '#2fa9ba' : '#075d72';
        context.fillRect(0, 0, canvas.width, canvas.height);
      }, 50);
      const stream = canvas.captureStream(20);
      window.__smokeCapture = stream.getVideoTracks()[0];
      const stop = window.__smokeCapture.stop.bind(window.__smokeCapture);
      window.__smokeCapture.stop = () => { window.__smokeStopStack = new Error('Capture stopped').stack; stop(); };
      stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer));
      return stream;
    };
  });
  await host.locator('#share').click();
  await host.waitForFunction(() => document.querySelector('#metrics-total').textContent.includes('Cloudflare SFU'), null, { timeout: 30000 });
  await guest.waitForFunction(() => document.querySelector('#screen').videoWidth > 0, null, { timeout: 30000 });
  await guest.waitForFunction(() => document.querySelector('#metrics-total').textContent.includes('Cloudflare SFU'), null, { timeout: 10000 });
  const publisherCodec = await host.evaluate(async () => {
    for (const pc of window.__smokePeerConnections) {
      const reports = await pc.getStats();
      const outbound = [...reports.values()].find(report => report.type === 'outbound-rtp' && report.kind === 'video');
      if (outbound) {
        const codec = reports.get(outbound.codecId);
        return { codec: codec?.mimeType, fmtp: codec?.sdpFmtpLine,
          implementation: outbound.encoderImplementation ?? null };
      }
    }
    return null;
  });
  console.log('SFU negotiated codec:', JSON.stringify(publisherCodec));
  console.log('SFU live smoke PASS: published and decoded a synthetic video frame.');
} catch (cause) {
  console.error('Host SFU:', await host.locator('#metrics').innerText().catch(() => 'unavailable'));
  console.error('Host status:', await host.locator('#status').textContent().catch(() => 'unavailable'));
  console.error('Host errors:', hostErrors.slice(-5));
  console.error('Capture state:', await host.evaluate(() => ({ state: window.__smokeCapture?.readyState,
    shareButton: document.querySelector('#share').textContent, stopStack: window.__smokeStopStack })));
  console.error('Guest SFU:', await guest.locator('#metrics').innerText().catch(() => 'unavailable'));
  console.error('Guest status:', await guest.locator('#status').textContent().catch(() => 'unavailable'));
  throw cause;
} finally {
  await host.locator('#end:visible').click({ timeout: 1500 }).catch(() => {});
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
