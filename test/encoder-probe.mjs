import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
const require = createRequire(new URL('../package.json', import.meta.url));
const { _electron } = require('playwright');
const env = { ...process.env, BABAGAN_SMOKE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const app = await _electron.launch({ executablePath: require('electron'), args: [process.cwd()], env, timeout: 30000 });
try {
  const page = await app.firstWindow();
  for (const [profile, source] of [['any', 'canvas'], ['42e0', 'canvas'], ['4d00', 'canvas'], ['64', 'canvas'],
    ['any', 'generator'], ['64', 'generator']]) {
    const sessions = [];
    const sampler = setInterval(() => {
      try {
        const value = execFileSync('nvidia-smi', ['--query-gpu=encoder.stats.sessionCount,utilization.encoder', '--format=csv,noheader'], { encoding: 'utf8' });
        sessions.push(value.trim());
      } catch { /* GPU counters can be temporarily unavailable */ }
    }, 250);
    const result = await page.evaluate(async ({ profile, source }) => {
    async function probe(profile, source) {
      const canvas = document.createElement('canvas');
      canvas.width = 1920; canvas.height = 1080;
      const context = canvas.getContext('2d');
      let frame = 0;
      let animate, running = true, writer;
      let track;
      if (source === 'generator') {
        const generator = new globalThis.MediaStreamTrackGenerator({ kind: 'video' });
        track = generator;
        writer = generator.writable.getWriter();
        const payload = new Uint8Array(1920 * 1080 * 3 / 2);
        payload.fill(128);
        void (async () => {
          while (running) {
            const videoFrame = new globalThis.VideoFrame(payload, { format: 'I420', codedWidth: 1920,
              codedHeight: 1080, timestamp: frame++ * 16667 });
            try { await writer.write(videoFrame); }
            catch { break; }
            finally { videoFrame.close(); }
            await new Promise(resolve => setTimeout(resolve, 17));
          }
        })();
      } else {
        animate = setInterval(() => {
          context.fillStyle = frame++ % 2 ? '#104d83' : '#ed8c2b';
          context.fillRect(0, 0, 1920, 1080);
        }, 17);
        track = canvas.captureStream(60).getVideoTracks()[0];
      }
      track.contentHint = 'motion';
      const sender = new RTCPeerConnection({ iceServers: [] });
      const receiver = new RTCPeerConnection({ iceServers: [] });
      sender.onicecandidate = event => { if (event.candidate) void receiver.addIceCandidate(event.candidate).catch(() => {}); };
      receiver.onicecandidate = event => { if (event.candidate) void sender.addIceCandidate(event.candidate).catch(() => {}); };
      try {
        const transceiver = sender.addTransceiver(track, { direction: 'sendonly',
          sendEncodings: [{ maxFramerate: 60, maxBitrate: 15_000_000, scaleResolutionDownBy: 1 }] });
        const codecs = globalThis.RTCRtpReceiver.getCapabilities('video').codecs;
        const preferred = codecs.filter(codec => codec.mimeType.toLowerCase() === 'video/h264' &&
          (profile === 'any' || codec.sdpFmtpLine?.toLowerCase().includes(`profile-level-id=${profile}`)));
        if (preferred.length) transceiver.setCodecPreferences([...preferred,
          ...codecs.filter(codec => codec.mimeType.toLowerCase() !== 'video/h264')]);
        await sender.setLocalDescription(await sender.createOffer());
        await receiver.setRemoteDescription(sender.localDescription);
        await receiver.setLocalDescription(await receiver.createAnswer());
        await sender.setRemoteDescription(receiver.localDescription);
        const deadline = Date.now() + 8000;
        let video, codec;
        while (Date.now() < deadline) {
          const reports = await sender.getStats();
          video = [...reports.values()].find(report => report.type === 'outbound-rtp' && report.kind === 'video');
          codec = video?.codecId ? reports.get(video.codecId) : null;
          if (video?.framesEncoded > 30) break;
          await new Promise(resolve => setTimeout(resolve, 250));
        }
        return { requestedProfile: profile, source, framesEncoded: video?.framesEncoded ?? 0,
          encoderImplementation: video?.encoderImplementation ?? null,
          powerEfficientEncoder: video?.powerEfficientEncoder ?? null,
          codec: codec?.mimeType ?? null, fmtp: codec?.sdpFmtpLine ?? null,
          qualityLimitationReason: video?.qualityLimitationReason ?? null };
      } finally {
        running = false;
        if (animate) clearInterval(animate);
        if (writer) await writer.close().catch(() => {});
        sender.close(); receiver.close(); track.stop();
      }
    }
      return probe(profile, source);
    }, { profile, source });
    clearInterval(sampler);
    console.log(JSON.stringify({ ...result, nvencSessionSeen: sessions.some(value => Number.parseInt(value, 10) > 0),
      encoderUtilizationSeen: sessions.some(value => /,[ ]*[1-9]/.test(value)) }));
  }
} finally { await app.close(); }
