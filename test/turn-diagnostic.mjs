// Opt-in live TURN diagnostic. Creates a short-lived room and sends synthetic video.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const pwRequire = createRequire(new URL('../package.json', import.meta.url));
const { chromium } = pwRequire('playwright');
const endpoint = process.env.WORKER_URL || 'https://p2p.babagan.cloud';
const transport = process.env.TURN_TRANSPORT || 'auto';
const forceRelay = process.env.FORCE_RELAY !== '0';
const turnRealIp = process.env.TURN_REAL_IP;
const externalIce = process.env.TURN_ICE_SERVERS_FILE
  ? JSON.parse(await readFile(process.env.TURN_ICE_SERVERS_FILE, 'utf8'))
  : null;
if (externalIce && (!Array.isArray(externalIce) || !externalIce.some(server => server.urls && server.username && server.credential))) {
  throw new Error('TURN_ICE_SERVERS_FILE must contain at least one TURN server with credentials');
}
const root = new URL('../www/', import.meta.url);
const server = createServer(async (request, response) => {
  const name = request.url === '/' ? 'index.html' : request.url.slice(1);
  if (!/^[\w.-]+$/.test(name)) { response.writeHead(404).end(); return; }
  try {
    const bytes = await readFile(new URL(name, root));
    response.setHeader('Content-Type', name.endsWith('.html') ? 'text/html' : name.endsWith('.css') ? 'text/css' : 'text/javascript');
    response.end(bytes);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}),
  headless: true,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required']
});
const context = await browser.newContext({ permissions: ['microphone'] });
if (transport !== 'auto' || turnRealIp || externalIce) {
  const urlMatch = {
    udp: url => url.startsWith('turn:') && url.includes('transport=udp'),
    tcp: url => url.startsWith('turn:') && url.includes('transport=tcp'),
    tls: url => url.startsWith('turns:') && url.includes('transport=tcp')
  }[transport] || (transport === 'auto' ? () => true : null);
  if (!urlMatch) throw new Error(`Unknown TURN_TRANSPORT: ${transport}`);
  await context.route('**/rooms/*/ice', async route => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.iceServers = externalIce || payload.iceServers.map(server => ({ ...server, urls: server.urls.filter(urlMatch).map(url => turnRealIp ? url.replace('turn.cloudflare.com', turnRealIp) : url) })).filter(server => server.urls.length);
    await route.fulfill({ response, json: payload });
  });
}
await context.addInitScript(() => {
  window.__pcs = [];
  window.__iceErrors = [];
  const nativeFetch = window.fetch;
  window.fetch = async (...args) => {
    const response = await nativeFetch(...args);
    if (String(args[0]).endsWith('/ice') && response.ok) window.__iceServers = (await response.clone().json()).iceServers;
    return response;
  };
  const NativePeerConnection = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends NativePeerConnection {
    constructor(...args) {
      super(...args);
      window.__pcs.push(this);
      this.addEventListener('icecandidateerror', event => window.__iceErrors.push({ code: event.errorCode, text: event.errorText, url: event.url }));
    }
  };
});
const host = await context.newPage();
const guest = await context.newPage();

async function snapshot(page) {
  return page.evaluate(async () => {
    const pc = window.__pcs.at(-1);
    const reports = await pc.getStats();
    const values = [...reports.values()];
    const transport = values.find(item => item.type === 'transport' && item.selectedCandidatePairId);
    const pair = reports.get(transport?.selectedCandidatePairId) || values.find(item => item.type === 'candidate-pair' && item.selected);
    const local = reports.get(pair?.localCandidateId);
    const remote = reports.get(pair?.remoteCandidateId);
    const videoOut = values.find(item => item.type === 'outbound-rtp' && (item.kind || item.mediaType) === 'video');
    const videoIn = values.find(item => item.type === 'inbound-rtp' && (item.kind || item.mediaType) === 'video');
    return {
      time: Date.now(), state: pc.connectionState,
      localType: local?.candidateType, remoteType: remote?.candidateType,
      relayProtocol: local?.relayProtocol, turnUrl: local?.url,
      available: pair?.availableOutgoingBitrate, rtt: pair?.currentRoundTripTime,
      sent: videoOut?.bytesSent, received: videoIn?.bytesReceived,
      framesEncoded: videoOut?.framesEncoded, framesDecoded: videoIn?.framesDecoded,
      limitation: videoOut?.qualityLimitationReason,
      width: videoOut?.frameWidth || videoIn?.frameWidth,
      height: videoOut?.frameHeight || videoIn?.frameHeight,
      ui: document.querySelector('#metrics-peers')?.textContent
    };
  });
}

async function connectionState(page) {
  return page.evaluate(async () => {
    const pc = window.__pcs.at(-1);
    const reports = pc ? [...(await pc.getStats()).values()] : [];
    return {
      state: pc?.connectionState,
      ice: pc?.iceConnectionState,
      signaling: pc?.signalingState,
      gathering: pc?.iceGatheringState,
      pcCount: window.__pcs.length,
      transceivers: pc?.getTransceivers().length,
      hasLocalDescription: !!pc?.localDescription,
      hasRemoteDescription: !!pc?.remoteDescription,
      localRelayCandidates: reports.filter(report => report.type === 'local-candidate' && report.candidateType === 'relay').length,
      remoteRelayCandidates: reports.filter(report => report.type === 'remote-candidate' && report.candidateType === 'relay').length,
      pairs: reports.filter(report => report.type === 'candidate-pair').map(report => report.state),
      status: document.querySelector('#status')?.textContent,
      iceErrors: window.__iceErrors,
      peers: document.querySelector('#peers')?.textContent
    };
  });
}

try {
  for (const page of [host, guest]) {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    if (!await page.locator('#worker').isVisible()) await page.locator('#settings summary').click();
    await page.locator('#worker').fill(endpoint);
    if (forceRelay) await page.locator('#relay-only').check();
  }
  await host.locator('#name').fill('TURN sender');
  await host.locator('#create').click();
  await host.locator('#room:not([hidden])').waitFor({ timeout: 25000 });
  const invitation = await host.locator('#invite-text').textContent();
  await guest.locator('#name').fill('TURN receiver');
  await guest.locator('#tab-join').click();
  await guest.locator('#invitation').fill(invitation);
  await guest.locator('#join').click();
  await guest.locator('#room:not([hidden])').waitFor({ timeout: 25000 });
  const path = forceRelay ? 'Cloudflare TURN' : /Cloudflare TURN|P2P 直连/;
  try {
    await host.locator('#peers small').filter({ hasText: path }).waitFor({ timeout: 25000 });
    await guest.locator('#peers small').filter({ hasText: path }).waitFor({ timeout: 25000 });
  } catch (error) {
    console.error(JSON.stringify({ host: await connectionState(host), guest: await connectionState(guest) }));
    throw error;
  }
  await host.evaluate(() => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
      const graphics = canvas.getContext('2d'); let tick = 0;
      const timer = setInterval(() => {
        graphics.fillStyle = `hsl(${tick++ % 360} 70% 30%)`;
        graphics.fillRect(0, 0, canvas.width, canvas.height);
        for (let index = 0; index < 180; index++) {
          graphics.fillStyle = `hsl(${(index * 17 + tick * 3) % 360} 80% 60%)`;
          graphics.fillRect((index * 127 + tick * 19) % 1280, (index * 59 + tick * 11) % 720, 20, 20);
        }
      }, 33);
      const stream = canvas.captureStream(30);
      stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer));
      return stream;
    };
  });
  await host.locator('#share').click();
  await guest.waitForFunction(() => document.querySelector('#screen').videoWidth > 0, null, { timeout: 20000 });
  let previousHost, previousGuest;
  for (let index = 0; index < Number(process.env.DIAG_SAMPLES || 8); index++) {
    await new Promise(resolve => setTimeout(resolve, 3000));
    const [sender, receiver] = await Promise.all([snapshot(host), snapshot(guest)]);
    const seconds = previousHost ? (sender.time - previousHost.time) / 1000 : null;
    const mbps = (current, prior, field) => prior && seconds > 0 ? Number(((current[field] - prior[field]) * 8 / seconds / 1e6).toFixed(3)) : null;
    console.log(JSON.stringify({
      sample: index + 1,
      sender: { type: sender.localType, remoteType: sender.remoteType, protocol: sender.relayProtocol, url: sender.turnUrl, availableMbps: sender.available && Number((sender.available / 1e6).toFixed(3)), rttMs: sender.rtt && Math.round(sender.rtt * 1000), actualMbps: mbps(sender, previousHost, 'sent'), fps: previousHost && seconds > 0 ? Number(((sender.framesEncoded - previousHost.framesEncoded) / seconds).toFixed(1)) : null, limitation: sender.limitation, size: `${sender.width}x${sender.height}`, ui: sender.ui },
      receiver: { type: receiver.localType, protocol: receiver.relayProtocol, actualMbps: mbps(receiver, previousGuest, 'received'), fps: previousGuest && seconds > 0 ? Number(((receiver.framesDecoded - previousGuest.framesDecoded) / seconds).toFixed(1)) : null }
    }));
    previousHost = sender; previousGuest = receiver;
  }
  if (process.env.RAW_PROBE === '1') {
    const rawProbe = await host.evaluate(async () => {
      const configuration = { iceServers: window.__iceServers, iceTransportPolicy: 'relay' };
      const left = new RTCPeerConnection(configuration), right = new RTCPeerConnection(configuration);
      const leftPending = [], rightPending = [];
      left.onicecandidate = ({ candidate }) => {
        if (!candidate) return;
        if (right.remoteDescription) void right.addIceCandidate(candidate);
        else leftPending.push(candidate);
      };
      right.onicecandidate = ({ candidate }) => {
        if (!candidate) return;
        if (left.remoteDescription) void left.addIceCandidate(candidate);
        else rightPending.push(candidate);
      };
      let received = 0;
      right.ondatachannel = ({ channel }) => { channel.onmessage = event => { received += event.data.byteLength; }; };
      const channel = left.createDataChannel('raw-probe', { ordered: false, maxRetransmits: 0 });
      channel.binaryType = 'arraybuffer';
      try {
        await left.setLocalDescription(await left.createOffer());
        await right.setRemoteDescription(left.localDescription);
        for (const candidate of leftPending) await right.addIceCandidate(candidate);
        await right.setLocalDescription(await right.createAnswer());
        await left.setRemoteDescription(right.localDescription);
        for (const candidate of rightPending) await left.addIceCandidate(candidate);
        await Promise.race([
          new Promise(resolve => { if (channel.readyState === 'open') resolve(); else channel.onopen = resolve; }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('raw probe channel timeout')), 30000))
        ]);
        const samples = [];
        for (const offeredMbps of [0.25, 1, 2]) {
          const bytes = Math.round(offeredMbps * 1e6 / 8 / 40);
          const payload = new Uint8Array(bytes);
          crypto.getRandomValues(payload);
          const begin = window.performance.now(), startReceived = received;
          let sent = 0;
          while (window.performance.now() - begin < 5000) {
            if (channel.bufferedAmount < 256_000) { channel.send(payload); sent += bytes; }
            await new Promise(resolve => setTimeout(resolve, 25));
          }
          await new Promise(resolve => setTimeout(resolve, 1500));
          samples.push({ offeredMbps, sentMbps: Number((sent * 8 / 5e6).toFixed(3)), receivedMbps: Number(((received - startReceived) * 8 / 6.5e6).toFixed(3)), pendingBytes: channel.bufferedAmount });
        }
        const stats = await left.getStats();
        const transport = [...stats.values()].find(item => item.type === 'transport' && item.selectedCandidatePairId);
        const pair = stats.get(transport?.selectedCandidatePairId);
        const local = stats.get(pair?.localCandidateId);
        return { state: left.connectionState, protocol: local?.relayProtocol, samples };
      } finally { channel.close(); left.close(); right.close(); }
    });
    console.log(JSON.stringify({ rawProbe }));
  }
} finally {
  await host.locator('#end:visible').click({ timeout: 1000 }).catch(() => {});
  await browser.close(); server.close();
}
