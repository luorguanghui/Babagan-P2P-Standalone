/**
 * Audio processing module for Babagan P2P Meeting.
 * Provides high-pass filtering (cuts rumble/fan hum), high-shelf shaping,
 * dynamics compression, an adaptive noise gate to eliminate background hiss,
 * and WebRTC Opus SDP tuning (usedtx=1) for discontinuous transmission.
 */

export const AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  googEchoCancellation: true,
  googAutoGainControl: true,
  googNoiseSuppression: true,
  googHighpassFilter: true,
  googTypingNoiseDetection: true,
  channelCount: { ideal: 1 },
  sampleRate: { ideal: 48000 }
};

/**
 * Wraps a raw MediaStream with a Web Audio processing pipeline:
 * 1. High-Pass Filter (85 Hz, Q=0.7) - filters mechanical desk rumble and fan hum
 * 2. High-Shelf Filter (7500 Hz, -4 dB) - tames high-frequency electrical hiss
 * 3. Dynamics Compressor - evens out loud vocal spikes
 * 4. Adaptive Noise Gate - attenuates signal to absolute silence when below speech threshold
 *
 * @param {MediaStream} rawStream
 * @returns {{ stream: MediaStream, track: MediaStreamTrack, rawStream: MediaStream, ctx?: AudioContext }}
 */
export function setupNoiseGate(rawStream) {
  if (!rawStream || !rawStream.getAudioTracks().length) {
    return { stream: rawStream, track: rawStream?.getAudioTracks()[0] || null, rawStream };
  }

  const AudioContextClass = typeof window !== 'undefined'
    ? (window.AudioContext || window.webkitAudioContext)
    : null;

  if (!AudioContextClass) {
    return { stream: rawStream, track: rawStream.getAudioTracks()[0], rawStream };
  }

  try {
    const ctx = new AudioContextClass();
    const source = ctx.createMediaStreamSource(rawStream);

    // 1. Highpass Filter (85Hz)
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.setValueAtTime(85, ctx.currentTime);
    hp.Q.setValueAtTime(0.7, ctx.currentTime);

    // 2. Highshelf Filter (7500Hz)
    const hs = ctx.createBiquadFilter();
    hs.type = 'highshelf';
    hs.frequency.setValueAtTime(7500, ctx.currentTime);
    hs.gain.setValueAtTime(-4, ctx.currentTime);

    // 3. Dynamics Compressor
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.setValueAtTime(-24, ctx.currentTime);
    comp.knee.setValueAtTime(12, ctx.currentTime);
    comp.ratio.setValueAtTime(3.5, ctx.currentTime);
    comp.attack.setValueAtTime(0.003, ctx.currentTime);
    comp.release.setValueAtTime(0.2, ctx.currentTime);

    // 4. Noise Gate Gain Node (starts muted until voice detected)
    const gateGain = ctx.createGain();
    gateGain.gain.setValueAtTime(0, ctx.currentTime);

    // 5. Analyser for speech envelope detection
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.15;

    // Connect audio processing chain
    source.connect(hp);
    hp.connect(hs);
    hs.connect(comp);
    comp.connect(gateGain);

    const dest = ctx.createMediaStreamDestination();
    gateGain.connect(dest);

    // Sidechain to speech detector analyser
    hs.connect(analyser);

    const buf = new Float32Array(analyser.fftSize);
    let isOpen = false;
    let holdCount = 0;
    const THRESHOLD = 0.012; // Approx -38 dBFS speech presence threshold
    const HOLD_INTERVALS = 12; // ~240ms hold time after speech pause

    const timer = setInterval(() => {
      if (ctx.state === 'closed') {
        clearInterval(timer);
        return;
      }
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        sum += buf[i] * buf[i];
      }
      const rms = Math.sqrt(sum / buf.length);

      if (rms >= THRESHOLD) {
        holdCount = HOLD_INTERVALS;
        if (!isOpen) {
          isOpen = true;
          gateGain.gain.setTargetAtTime(1, ctx.currentTime, 0.01); // 10ms fast attack
        }
      } else if (holdCount > 0) {
        holdCount--;
      } else if (isOpen) {
        isOpen = false;
        gateGain.gain.setTargetAtTime(0, ctx.currentTime, 0.05); // 50ms smooth decay to absolute silence
      }
    }, 20);

    const processedTrack = dest.stream.getAudioTracks()[0];
    const origStop = processedTrack.stop.bind(processedTrack);
    processedTrack.stop = () => {
      clearInterval(timer);
      try { ctx.close(); } catch { /* already closed */ }
      rawStream.getTracks().forEach(t => t.stop());
      origStop();
    };

    return { stream: dest.stream, track: processedTrack, rawStream, ctx };
  } catch (e) {
    console.warn('Web Audio noise gate unavailable, using raw microphone stream:', e);
    return { stream: rawStream, track: rawStream.getAudioTracks()[0], rawStream };
  }
}

/**
 * Modifies WebRTC SDP description to enable Opus Discontinuous Transmission (DTX).
 * With usedtx=1, Opus halts packet transmission during silence, eliminating background noise.
 *
 * @param {string} sdp
 * @returns {string}
 */
export function tuneOpusSdp(sdp) {
  if (!sdp || typeof sdp !== 'string') return sdp;

  // Find Opus payload type from rtpmap
  const opusMatch = sdp.match(/a=rtpmap:(\d+)\s+opus\/48000/i);
  if (!opusMatch) return sdp;

  const pt = opusMatch[1];
  const fmtpRegex = new RegExp(`(a=fmtp:${pt}\\s+[^\\r\\n]*)`, 'i');

  if (fmtpRegex.test(sdp)) {
    return sdp.replace(fmtpRegex, (line) => {
      if (line.includes('usedtx=')) return line;
      return `${line};usedtx=1`;
    });
  }

  // If no fmtp line exists for this Opus payload, insert one after rtpmap
  const rtpmapRegex = new RegExp(`(a=rtpmap:${pt}\\s+opus/48000[^\\r\\n]*)`, 'i');
  return sdp.replace(rtpmapRegex, `$1\r\na=fmtp:${pt} minptime=10;useinbandfec=1;usedtx=1`);
}
