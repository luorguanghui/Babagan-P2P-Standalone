import { rate, selectedCandidatePair } from './video-quality.mjs';
import { describeEncoder } from './video-codec.mjs';

function videoReport(reports, type, previous) {
  const bytes = type === 'outbound-rtp' ? 'bytesSent' : 'bytesReceived';
  const frames = type === 'outbound-rtp' ? 'framesEncoded' : 'framesReceived';
  const activity = report => {
    if (report.active === false) return -1;
    const byteRate = rate(report, previous.get(report.id), bytes);
    const frameRate = rate(report, previous.get(report.id), frames);
    if (byteRate > 0 || frameRate > 0) return 2;
    if (byteRate != null || frameRate != null) return 0;
    return report[bytes] > 0 || report[frames] > 0 ? 1 : 0;
  };
  return [...reports.values()].filter(report => report.type === type &&
    (report.kind === 'video' || report.mediaType === 'video'))
    .sort((a, b) => activity(b) - activity(a))[0] || null;
}

function intervalLoss(current, previous) {
  if (!current || !previous || current.timestamp <= previous.timestamp) return null;
  const lost = current.packetsLost - previous.packetsLost;
  const received = current.packetsReceived - previous.packetsReceived;
  if (!Number.isFinite(lost) || !Number.isFinite(received) || lost < 0 || received < 0 || lost + received === 0) return null;
  return lost / (lost + received);
}

export function sampleSfuVideoStats(reports, previous = new Map()) {
  const outbound = videoReport(reports, 'outbound-rtp', previous);
  const inbound = videoReport(reports, 'inbound-rtp', previous);
  const video = outbound || inbound;
  const direction = outbound ? 'send' : 'receive';
  const remote = outbound && ((outbound.remoteId && reports.get(outbound.remoteId)) ||
    [...reports.values()].find(report => report.type === 'remote-inbound-rtp' && report.localId === outbound.id));
  const lossReport = outbound ? remote : inbound;
  const pair = selectedCandidatePair(reports);
  const bytesField = outbound ? 'bytesSent' : 'bytesReceived';
  const framesField = outbound ? 'framesEncoded' : 'framesDecoded';
  const bitrate = video ? rate(video, previous.get(video.id), bytesField) : null;
  const source = outbound && ((outbound.mediaSourceId && reports.get(outbound.mediaSourceId)) ||
    [...reports.values()].find(report => report.type === 'media-source' && report.kind === 'video'));
  const previousOutbound = outbound && previous.get(outbound.id);
  const encodedFrames = outbound && previousOutbound ? outbound.framesEncoded - previousOutbound.framesEncoded : 0;
  const encodeMs = encodedFrames > 0 && Number.isFinite(outbound.totalEncodeTime) &&
    Number.isFinite(previousOutbound.totalEncodeTime)
    ? (outbound.totalEncodeTime - previousOutbound.totalEncodeTime) * 1000 / encodedFrames : null;
  const previousInbound = inbound && previous.get(inbound.id);
  const decodedFrames = inbound && previousInbound ? inbound.framesDecoded - previousInbound.framesDecoded : 0;
  const decodeMs = decodedFrames > 0 && Number.isFinite(inbound.totalDecodeTime) &&
    Number.isFinite(previousInbound.totalDecodeTime)
    ? (inbound.totalDecodeTime - previousInbound.totalDecodeTime) * 1000 / decodedFrames : null;
  const codec = video?.codecId ? reports.get(video.codecId) : null;
  return {
    direction,
    bitrate: bitrate == null ? null : bitrate * 8,
    fps: video ? (rate(video, previous.get(video.id), framesField) ?? video.framesPerSecond ?? null) : null,
    receivedFps: inbound ? rate(inbound, previousInbound, 'framesReceived') : null,
    droppedFps: inbound ? rate(inbound, previousInbound, 'framesDropped') : null,
    decodeMs,
    available: pair?.availableOutgoingBitrate ?? null,
    width: video?.frameWidth ?? null,
    height: video?.frameHeight ?? null,
    codec: codec?.mimeType || null,
    codecParameters: codec?.sdpFmtpLine || null,
    decoderImplementation: inbound?.decoderImplementation || null,
    powerEfficientDecoder: inbound?.powerEfficientDecoder ?? null,
    sourceFps: source ? (rate(source, previous.get(source.id), 'frames') ?? source.framesPerSecond ?? null) : null,
    encodeMs,
    encoderImplementation: outbound?.encoderImplementation || null,
    powerEfficientEncoder: outbound?.powerEfficientEncoder ?? null,
    limitation: outbound?.qualityLimitationReason || null,
    loss: intervalLoss(lossReport, lossReport && previous.get(lossReport.id)) ??
      (outbound && Number.isFinite(remote?.fractionLost) ? remote.fractionLost : null),
    rtt: pair?.currentRoundTripTime ?? remote?.roundTripTime ?? null
  };
}

export function formatSfuVideoStats(stats) {
  const sending = stats?.direction === 'send';
  const resolution = stats?.width && stats?.height ? `${stats.width}×${stats.height}` : '—';
  const bitrate = stats?.bitrate == null ? '—' : `${(stats.bitrate / 1e6).toFixed(2)} Mbps`;
  const fps = stats?.fps == null ? '—' : `${stats.fps.toFixed(1)} fps`;
  const loss = stats?.loss == null ? '—' : `${(stats.loss * 100).toFixed(1)}%`;
  const rtt = stats?.rtt == null ? '—' : `${Math.round(stats.rtt * 1000)} ms`;
  const profileId = stats?.codecParameters?.match(/profile-level-id=([\da-f]{6})/i)?.[1].slice(0, 2).toLowerCase();
  const profile = stats?.codec?.toLowerCase() === 'video/h264' ? ({ '4d': 'Main', '42': 'Baseline', '64': 'High' }[profileId] || '') : '';
  const codec = stats?.codec ? ` · ${stats.codec.replace(/^video\//i, '')}${profile ? ` ${profile}` : ''}` : '';
  const source = sending && stats?.sourceFps != null ? ` · 采集 ${stats.sourceFps.toFixed(1)} fps` : '';
  const encoder = sending ? ` · ${describeEncoder(stats?.encoderImplementation, stats?.powerEfficientEncoder)}` : '';
  const encodeTime = sending && stats?.encodeMs != null ? ` · 编码 ${stats.encodeMs.toFixed(1)} ms/帧` : '';
  const limitation = sending && stats?.limitation && stats.limitation !== 'none' ? ` · 限制 ${stats.limitation}` : '';
  const arrival = !sending && stats?.receivedFps != null ? ` · 到达 ${stats.receivedFps.toFixed(1)} fps` : '';
  const discarded = !sending && stats?.droppedFps != null ? ` · 丢弃 ${stats.droppedFps.toFixed(1)} fps` : '';
  const decodeTime = !sending && stats?.decodeMs != null ? ` · 解码 ${stats.decodeMs.toFixed(1)} ms/帧` : '';
  const decoder = !sending && stats?.decoderImplementation ? ` · 解码器 ${stats.decoderImplementation}` : '';
  const available = sending && stats?.available != null ? ` · 可用带宽估计 ${(stats.available / 1e6).toFixed(2)} Mbps` : '';
  return `Cloudflare SFU · ${sending ? '发送' : '接收'} ${resolution} · 码率 ${bitrate} · ${sending ? '编码帧率' : '解码'} ${fps}${arrival}${discarded}${decodeTime}${source}${codec}${encoder}${decoder}${encodeTime}${limitation}${available} · ${sending ? '至 SFU 丢包' : 'SFU→本机丢包'} ${loss} · RTT ${rtt}`;
}

export function createSfuStatsSampler() {
  let activePc = null;
  let previous = new Map();
  return {
    async sample(pc) {
      if (pc !== activePc) { activePc = pc; previous = new Map(); }
      if (!pc) return null;
      const reports = await pc.getStats();
      if (pc !== activePc) return null;
      const stats = sampleSfuVideoStats(reports, previous);
      previous = reports;
      return stats;
    }
  };
}
