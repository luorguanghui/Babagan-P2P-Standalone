// Offline hardware encoder comparison using the same synthetic high-motion
// I420 source and selected 1080p60 ceiling. Prints counters, never pixels.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
const require = createRequire(new URL('../package.json', import.meta.url));
const { _electron } = require('playwright');
const env = { ...process.env, BABAGAN_SMOKE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const app = await _electron.launch({ executablePath: require('electron'), args: [process.cwd()], env, timeout: 30000 });
try {
  const page = await app.firstWindow();
  for (const [profile, bitrate, tune] of [['4200', 15e6, false], ['6400', 15e6, false],
    ['4200', 30e6, false], ['6400', 30e6, false], ['4200', 15e6, true]]) {
    const gpuSamples = [];
    const sampler = setInterval(() => {
      try { gpuSamples.push(execFileSync('nvidia-smi', ['--query-gpu=encoder.stats.sessionCount,utilization.encoder',
        '--format=csv,noheader'], { encoding: 'utf8' }).trim()); } catch { /* no NVIDIA counters */ }
    }, 500);
    let result;
    try {
      result = await page.evaluate(async ({ profile, bitrate, tune }) => {
        const { tuneVideoSdp } = await import('./video-codec.mjs');
        const codecs = globalThis.RTCRtpReceiver.getCapabilities('video').codecs;
        const h264 = codecs.filter(codec => codec.mimeType.toLowerCase() === 'video/h264' &&
          codec.sdpFmtpLine?.includes(`profile-level-id=${profile}`) && /packetization-mode=1/.test(codec.sdpFmtpLine));
        if (!h264.length) return { profile, unsupported: true };
        const width = 1920, height = 1080, size = width * height;
        // Precompute motion so source pixel generation cannot bottleneck FPS.
        const frames = [];
        for (let index = 0; index < 4; index++) {
          const data = new Uint8Array(size * 3 / 2);
          let seed = 100 + index;
          for (let pixel = 0; pixel < size; pixel++) {
            seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
            data[pixel] = 48 + ((seed >>> 0) % 160);
          }
          data.fill(128, size); frames.push(data);
        }
        const track = new globalThis.MediaStreamTrackGenerator({ kind: 'video' });
        track.contentHint = 'motion';
        const writer = track.writable.getWriter();
        const sender = new RTCPeerConnection({ iceServers: [] });
        const receiver = new RTCPeerConnection({ iceServers: [] });
        sender.onicecandidate = event => { if (event.candidate) void receiver.addIceCandidate(event.candidate).catch(() => {}); };
        receiver.onicecandidate = event => { if (event.candidate) void sender.addIceCandidate(event.candidate).catch(() => {}); };
        let running = true, generated = 0;
        void (async () => {
          const started = globalThis.performance.now();
          while (running) {
            const frame = new globalThis.VideoFrame(frames[generated++ % frames.length], {
              format: 'I420', codedWidth: width, codedHeight: height, timestamp: Math.round(globalThis.performance.now() * 1000)
            });
            try { await writer.write(frame); } catch { break; } finally { frame.close(); }
            await new Promise(resolve => setTimeout(resolve, Math.max(1, started + generated * 1000 / 60 - globalThis.performance.now())));
          }
        })();
        const snapshot = async () => {
          const outReports = await sender.getStats(), inReports = await receiver.getStats();
          const out = [...outReports.values()].find(report => report.type === 'outbound-rtp' && report.kind === 'video');
          const inbound = [...inReports.values()].find(report => report.type === 'inbound-rtp' && report.kind === 'video');
          const source = out?.mediaSourceId && outReports.get(out.mediaSourceId);
          const pair = [...outReports.values()].find(report => report.type === 'candidate-pair' && report.state === 'succeeded');
          return { out, inbound, source, codec: out?.codecId && outReports.get(out.codecId), pair, generated };
        };
        try {
          const transceiver = sender.addTransceiver(track, { direction: 'sendonly',
            sendEncodings: [{ maxFramerate: 60, maxBitrate: bitrate, scaleResolutionDownBy: 1 }] });
          transceiver.setCodecPreferences([...h264, ...codecs.filter(codec => codec.mimeType.toLowerCase() === 'video/rtx')]);
          const offer = await sender.createOffer();
          if (tune) offer.sdp = tuneVideoSdp(offer.sdp, { minBitrate: 0, startBitrate: 6000, maxBitrate: bitrate / 1000 });
          await sender.setLocalDescription(offer);
          await receiver.setRemoteDescription(sender.localDescription);
          await receiver.setLocalDescription(await receiver.createAnswer());
          await sender.setRemoteDescription(receiver.localDescription);
          const parameters = transceiver.sender.getParameters();
          parameters.degradationPreference = 'maintain-resolution';
          await transceiver.sender.setParameters(parameters);
          await new Promise(resolve => setTimeout(resolve, 2500));
          const before = await snapshot();
          await new Promise(resolve => setTimeout(resolve, 3500));
          const after = await snapshot();
          const seconds = (after.out.timestamp - before.out.timestamp) / 1000;
          const encoded = after.out.framesEncoded - before.out.framesEncoded;
          const decoded = after.inbound.framesDecoded - before.inbound.framesDecoded;
          return { profile, capMbps: bitrate / 1e6, tune,
            sourceFps: (after.generated - before.generated) / seconds,
            sentFps: (after.out.framesSent - before.out.framesSent) / seconds, encodedFps: encoded / seconds,
            receivedFps: (after.inbound.framesReceived - before.inbound.framesReceived) / seconds,
            decodedFps: decoded / seconds,
            encodeMs: encoded ? (after.out.totalEncodeTime - before.out.totalEncodeTime) * 1000 / encoded : null,
            actualMbps: (after.out.bytesSent - before.out.bytesSent) * 8 / seconds / 1e6,
            avgQp: encoded ? (after.out.qpSum - before.out.qpSum) / encoded : null,
            availableMbps: after.pair?.availableOutgoingBitrate / 1e6,
            width: after.out.frameWidth, height: after.out.frameHeight,
            limitation: after.out.qualityLimitationReason, implementation: after.out.encoderImplementation,
            fmtp: after.codec?.sdpFmtpLine,
            videoSdp: sender.remoteDescription.sdp.split('\r\n').filter(line => /^a=framerate:|^b=(AS|TIAS):/.test(line)) };
        } finally {
          running = false; track.stop(); sender.close(); receiver.close();
          await writer.close().catch(() => {});
        }
      }, { profile, bitrate, tune });
    } finally { clearInterval(sampler); }
    console.log(JSON.stringify({ ...result, nvencSessionSeen: gpuSamples.some(value => Number.parseInt(value, 10) > 0) }));
  }
} finally { await app.close(); }
