// Prefer H.264 for screen sharing: Chromium can use the Windows video encoder
// accelerator for it, while retaining every other codec for interoperability.
export function preferH264(transceiver, codecs) {
  if (typeof transceiver?.setCodecPreferences !== 'function' || !Array.isArray(codecs)) return false;
  const h264 = codecs.filter(codec => codec.mimeType?.toLowerCase() === 'video/h264');
  if (!h264.length) return false;
  const sortedH264 = [...h264].sort((a, b) => {
    const score = codec => {
      const fmtp = codec.sdpFmtpLine || '';
      let s = 0;
      if (/packetization-mode=1/i.test(fmtp)) s += 10;
      if (/profile-level-id=64/i.test(fmtp)) s += 20;
      else if (/profile-level-id=4d/i.test(fmtp)) s += 10;
      return s;
    };
    return score(b) - score(a);
  });
  try {
    transceiver.setCodecPreferences([
      ...sortedH264,
      ...codecs.filter(codec => codec.mimeType?.toLowerCase() !== 'video/h264')
    ]);
    return true;
  } catch {
    // A platform may expose a decoder profile that it cannot send. Its normal
    // codec negotiation remains usable in that case.
    return false;
  }
}

export function tuneVideoSdp(sdp, { minBitrate = 2500, startBitrate = 6000, maxBitrate = 30000 } = {}) {
  if (!sdp || typeof sdp !== 'string') return sdp;
  const lines = sdp.split(/\r\n|\n/);
  const result = [];
  let inVideo = false;
  let videoPayloads = new Set();
  let hasBandwidth = false;
  let videoMediaIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('m=video ')) {
      inVideo = true;
      videoPayloads = new Set(line.split(' ').slice(3));
      hasBandwidth = false;
      videoMediaIndex = result.length;
      result.push(line);
      continue;
    } else if (line.startsWith('m=audio ') || line.startsWith('m=application ')) {
      inVideo = false;
    }

    if (inVideo) {
      if (line.startsWith('b=AS:') || line.startsWith('b=TIAS:')) {
        hasBandwidth = true;
      }
      const fmtpMatch = line.match(/^a=fmtp:(\d+)\s*(.*)$/);
      if (fmtpMatch && videoPayloads.has(fmtpMatch[1])) {
        const pt = fmtpMatch[1];
        let params = fmtpMatch[2] || '';
        const updates = [];
        if (!/x-google-min-bitrate=/i.test(params)) updates.push(`x-google-min-bitrate=${minBitrate}`);
        if (!/x-google-start-bitrate=/i.test(params)) updates.push(`x-google-start-bitrate=${startBitrate}`);
        if (!/x-google-max-bitrate=/i.test(params)) updates.push(`x-google-max-bitrate=${maxBitrate}`);
        if (updates.length) {
          const sep = params ? (params.endsWith(';') ? '' : ';') : '';
          result.push(`a=fmtp:${pt} ${params}${sep}${updates.join(';')}`);
          continue;
        }
      }
    }
    result.push(line);
  }

  if (videoMediaIndex >= 0 && !hasBandwidth) {
    result.splice(videoMediaIndex + 1, 0, `b=AS:${maxBitrate}`);
  }

  return result.join('\r\n');
}

export function preferredVideoCodecs() {
  return globalThis.RTCRtpReceiver?.getCapabilities?.('video')?.codecs ||
    globalThis.RTCRtpSender?.getCapabilities?.('video')?.codecs || [];
}

export function describeEncoder(implementation, powerEfficient) {
  if (!implementation) return '编码器未报告';
  if (/accelerator|nvenc|quick\s*sync|qsv|amf/i.test(implementation)) return `硬件编码 · ${implementation}`;
  if (/libvpx|openh264|libaom|libx264|software/i.test(implementation)) return `软件编码 · ${implementation}`;
  return `${powerEfficient === true ? '高效编码' : '编码方式未确认'} · ${implementation}`;
}
