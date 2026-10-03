export const DEFAULT_VIDEO = { height: 'source', fps: 30, adaptive: true };
export function videoOptions(value = {}) {
  const fps = [15, 30, 45, 50, 60].includes(Number(value.fps)) ? Number(value.fps) : 30;
  return { height: [720,1080,1440,2160].includes(Number(value.height)) ? Number(value.height) : 'source',
    fps, adaptive: value.adaptive !== false,
    ...(value.degradationPreference ? { degradationPreference: value.degradationPreference } : {}) };
}
export function baseBitrate(options) { return Math.round(4_000_000 * ((Number(options.height) || 1080) / 1080) ** 1.5 * (options.fps / 30)); }
export function minBitrate(options = {}) {
  const height = Number(options.height) || 1080;
  const fps = Number(options.fps) || 30;
  const fpsFactor = 1.0 + (Math.max(30, fps) - 30) / 60;
  if (height <= 720) return Math.round(1_000_000 * fpsFactor);
  if (height <= 1080) return Math.round(1_800_000 * fpsFactor);
  if (height <= 1440) return Math.round(3_000_000 * fpsFactor);
  return Math.round(4_500_000 * fpsFactor);
}
export function qualityLimits(options) {
  const height = Number(options.height) || 1080;
  const tier = height <= 720 ? { maxHeight: 720, maxBitrate: 10_000_000 }
    : height <= 1080 ? { maxHeight: 1080, maxBitrate: 15_000_000 }
      : height <= 1440 ? { maxHeight: 1440, maxBitrate: 20_000_000 }
        : { maxHeight: 2160, maxBitrate: 30_000_000 };
  return { ...tier, maxHeight: height };
}
export function equalEstimatedBandwidthShare(availableBps) {
  if (!availableBps.length || availableBps.some(value => !Number.isFinite(value) || value <= 0)) return null;
  return Math.floor(availableBps.reduce((total, value) => total + value, 0) / availableBps.length);
}
// maxBitrate is a ceiling, not a requested sending rate. GCC controls the actual
// traffic and needs a stable ceiling to probe after idle periods or congestion.
export function newBudget(options) {
  return { bitrate: options.adaptive ? qualityLimits(options).maxBitrate
    : Math.min(baseBitrate(options), qualityLimits(options).maxBitrate),
    good: 0, scale: 1, framePressure: 0, reason: options.adaptive ? '浏览器自适应码率，保持分辨率' : '固定画质上限' };
}
// No artificial upscaling: a uniform sender scale preserves all source ratios.
export function resolutionScale(width, height, targetHeight) {
  if (!(width > 0 && height > 0)) return 1;
  return Math.max(1, height / targetHeight);
}
// Chromium rounds dimensions after applying scaleResolutionDownBy. Keep both
// dimensions even so a hardware H.264 encoder is not handed odd-sized frames.
export function evenResolutionScale(width, height, targetHeight) {
  const minimum = resolutionScale(width, height, targetHeight);
  if (!(width >= 2 && height >= 2 && targetHeight >= 2)) return minimum;
  const firstHeight = 2 * Math.floor((height / minimum) / 2);
  for (let evenHeight = firstHeight; evenHeight >= 2; evenHeight -= 2) {
    const heightScale = height / evenHeight;
    const widthAtHeightScale = width / heightScale;
    const nearbyWidth = 2 * Math.floor(widthAtHeightScale / 2);
    const candidates = [heightScale, ...[nearbyWidth - 2, nearbyWidth, nearbyWidth + 2]
      .filter(evenWidth => evenWidth >= 2)
      .map(evenWidth => width / evenWidth)];
    const valid = candidates.filter(candidate => {
      if (candidate < minimum) return false;
      const outputWidth = Math.round(width / candidate);
      const outputHeight = Math.round(height / candidate);
      return outputWidth >= 2 && outputHeight >= 2 && outputHeight <= targetHeight &&
        outputWidth % 2 === 0 && outputHeight % 2 === 0;
    });
    if (valid.length) return Math.min(...valid);
  }
  return minimum;
}
export function adaptBudget(previous, sample, options) {
  if (options.suspended || sample.suspended) {
    return { ...previous, good: 0, reason: '后台挂起，维持当前画质' };
  }
  // Do not feed availableOutgoingBitrate back into maxBitrate. It is GCC's
  // estimate, not an independent measurement of physical link capacity. A
  // second controller can trap GCC at its own low estimate and resize on every
  // sample. maintain-resolution lets GCC reduce bitrate/FPS under pressure.
  const next = newBudget(options);
  if (sample.limitation === 'cpu') next.reason = '编码负载较高，浏览器调整帧率';
  else if (sample.limitation === 'bandwidth') next.reason = '浏览器控制拥塞，保留带宽恢复空间';
  return next;
}
export function selectedCandidatePair(reports) {
  let videoTransportId;
  const transports = [], selected = [], succeeded = [];
  reports.forEach(report => {
    if (report.type === 'outbound-rtp' && (report.kind === 'video' || report.mediaType === 'video')) videoTransportId = report.transportId;
    if (report.type === 'transport' && report.selectedCandidatePairId) transports.push(report);
    if (report.type === 'candidate-pair' && report.state === 'succeeded') {
      succeeded.push(report);
      if (report.selected) selected.push(report);
    }
  });
  const activeTransport = transports.find(report => report.id === videoTransportId) || (transports.length === 1 ? transports[0] : null);
  const activePair = activeTransport && reports.get(activeTransport.selectedCandidatePairId);
  if (activePair?.type === 'candidate-pair') return activePair;
  if (selected.length === 1) return selected[0];
  if (selected.length > 1) return null;
  return succeeded.length === 1 ? succeeded[0] : null;
}
export function rate(current, previous, field) {
  if (!previous || current.timestamp <= previous.timestamp || current[field] == null || previous[field] == null || current[field] < previous[field]) return null;
  return (current[field] - previous[field]) * 1000 / (current.timestamp - previous.timestamp);
}
export function videoSample(reports, previous = new Map()) {
  const pair = selectedCandidatePair(reports);
  let outbound, inbound;
  const sources = [];
  reports.forEach(r => { if (r.kind === 'video' || r.mediaType === 'video') { if (r.type === 'outbound-rtp') outbound = r; if (r.type === 'inbound-rtp') inbound = r; if (r.type === 'media-source') sources.push(r); } });
  const source = (outbound?.mediaSourceId && reports.get(outbound.mediaSourceId)) || (sources.length === 1 ? sources[0] : null);
  const remote = outbound?.remoteId ? reports.get(outbound.remoteId) : null;
  const oldRemote = remote && previous.get(remote.id), oldOut = outbound && previous.get(outbound.id);
  const sent = outbound && oldOut ? outbound.packetsSent - oldOut.packetsSent : 0;
  const loss = remote && oldRemote && remote.timestamp > oldRemote.timestamp && sent > 0 ? Math.max(0, (remote.packetsLost - oldRemote.packetsLost) / sent) : null;
  const encoded = outbound && oldOut ? outbound.framesEncoded - oldOut.framesEncoded : 0;
  const result = { available: pair?.availableOutgoingBitrate ?? null, rtt: pair?.currentRoundTripTime ?? null, loss,
    fps: outbound ? rate(outbound, oldOut, 'framesEncoded') : null,
    outCodec: outbound?.codecId ? reports.get(outbound.codecId)?.mimeType || null : null,
    encoderImplementation: outbound?.encoderImplementation || null,
    powerEfficientEncoder: outbound?.powerEfficientEncoder ?? null,
    sourceFps: source ? (rate(source, previous.get(source.id), 'frames') ?? source.framesPerSecond ?? null) : null,
    encodeMs: encoded > 0 && oldOut.totalEncodeTime != null ? (outbound.totalEncodeTime - oldOut.totalEncodeTime) * 1000 / encoded : null,
    limitation: outbound?.qualityLimitationReason || null, outbound, inbound, pair,
    outgoing: 0, incoming: 0, outVideo: outbound ? rate(outbound, oldOut, 'bytesSent') : null,
    inVideo: inbound ? rate(inbound, previous.get(inbound.id), 'bytesReceived') : null,
    inFps: inbound ? rate(inbound, previous.get(inbound.id), 'framesDecoded') : null,
    inReceivedFps: inbound ? rate(inbound, previous.get(inbound.id), 'framesReceived') : null,
    inDroppedFps: inbound ? rate(inbound, previous.get(inbound.id), 'framesDropped') : null,
    inCodec: inbound?.codecId ? reports.get(inbound.codecId)?.mimeType || null : null };
  reports.forEach(r => { if (r.type === 'outbound-rtp') result.outgoing += (rate(r, previous.get(r.id), 'bytesSent') || 0) * 8; if (r.type === 'inbound-rtp') result.incoming += (rate(r, previous.get(r.id), 'bytesReceived') || 0) * 8; });
  return result;
}
