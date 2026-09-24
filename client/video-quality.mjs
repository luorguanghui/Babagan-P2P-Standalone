export const DEFAULT_VIDEO = { height: 'source', fps: 30, adaptive: true };
export function videoOptions(value = {}) {
  return { height: [720,1080,1440,2160].includes(Number(value.height)) ? Number(value.height) : 'source',
    fps: Number(value.fps) === 60 ? 60 : 30, adaptive: value.adaptive !== false,
    ...(value.degradationPreference ? { degradationPreference: value.degradationPreference } : {}) };
}
export function baseBitrate(options) { return Math.round(4_000_000 * ((Number(options.height) || 1080) / 1080) ** 1.5 * (options.fps / 30)); }
export function minBitrate(options = {}) {
  const height = Number(options.height) || 1080;
  const fpsFactor = options.fps === 60 ? 1.5 : 1.0;
  if (height <= 720) return Math.round(1_000_000 * fpsFactor);
  if (height <= 1080) return Math.round(1_800_000 * fpsFactor);
  if (height <= 1440) return Math.round(3_000_000 * fpsFactor);
  return Math.round(4_500_000 * fpsFactor);
}
export function qualityLimits(options) {
  const height = Number(options.height) || 1080;
  const tier = height <= 720 ? { maxHeight: 1080, maxBitrate: 10_000_000 }
    : height <= 1080 ? { maxHeight: 1440, maxBitrate: 15_000_000 }
      : height <= 1440 ? { maxHeight: 2160, maxBitrate: 20_000_000 }
        : { maxHeight: 2160, maxBitrate: 30_000_000 };
  return options.sourceMode ? { ...tier, maxHeight: height } : tier;
}
export function equalEstimatedBandwidthShare(availableBps) {
  if (!availableBps.length || availableBps.some(value => !Number.isFinite(value) || value <= 0)) return null;
  return Math.floor(availableBps.reduce((total, value) => total + value, 0) / availableBps.length);
}
export function newBudget(options) { return { bitrate: Math.min(baseBitrate(options), qualityLimits(options).maxBitrate), good: 0, scale: 1, framePressure: 0, reason: '基准画质' }; }
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
  const limits = qualityLimits(options);
  const base = Math.min(baseBitrate(options), limits.maxBitrate), cap = limits.maxBitrate;
  const selectedHeight = Number(options.height) || 1080;
  const maxScale = Math.max(1, limits.maxHeight / selectedHeight);
  const next = { ...previous };
  // A low encoded FPS is actionable only when the capture source is still
  // producing frames. An unchanged desktop can legitimately emit fewer frames.
  const activeSource = sample.sourceFps != null && sample.sourceFps >= options.fps * 0.8;
  const framePressure = activeSource && sample.fps != null &&
    sample.fps < Math.min(options.fps * 0.75, sample.sourceFps * 0.8);
  next.framePressure = framePressure ? (previous.framePressure || 0) + 1 : 0;
  if (!options.adaptive) {
    next.bitrate = base;
    next.good = 0;
    next.reason = '固定画质上限';
    if (next.framePressure >= 2) {
      next.scale = Math.max(0.5, Number((previous.scale / 1.2).toFixed(2)));
      next.framePressure = 0;
      next.reason = '编码帧率不足，降分辨率保流畅';
    } else if (activeSource && sample.fps >= options.fps * 0.9 && previous.scale < 1) {
      next.good = (previous.good || 0) + 1;
      if (next.good >= 6) {
        next.scale = Math.min(1, Number((previous.scale * 1.1).toFixed(2)));
        if (next.scale >= 0.95) next.scale = 1;
        next.good = 0;
        next.reason = '帧率稳定，恢复分辨率';
      }
    }
    next.scale = Math.min(1, next.scale);
    return next;
  }

  const available = Number.isFinite(sample.available) && sample.available > 0 ? sample.available : null;
  const lossCongested = sample.loss != null && sample.loss > 0.03;
  const rttCongested = sample.rtt != null && sample.rtt > 0.35;
  const bweLimited = sample.limitation === 'bandwidth' && available != null && available < previous.bitrate * 0.85;
  const wasSaturating = sample.outgoing == null || sample.outgoing > (available || previous.bitrate) * 0.6;
  const bweDropCongested = wasSaturating && available != null && available < previous.bitrate * 0.65;
  const congested = lossCongested || rttCongested || bweLimited || bweDropCongested;
  const cpu = sample.limitation === 'cpu' || (sample.encodeMs != null && sample.encodeMs > 1000 / options.fps * 0.8);

  if (congested || cpu) {
    next.good = 0;
    if (cpu || (sample.loss != null && sample.loss > 0.05) || (sample.rtt != null && sample.rtt > 0.4)) {
      next.scale = Math.max(0.5, Number((previous.scale / 1.2).toFixed(2)));
    }
    const targetDown = available ? Math.min(previous.bitrate * 0.8, available * 0.9) : previous.bitrate * 0.75;
    const baseFloor = minBitrate(options);
    const effectiveFloor = available != null ? Math.min(baseFloor, Math.max(500_000, Math.round(available * 0.85))) : baseFloor;
    next.bitrate = Math.max(effectiveFloor, Math.round(targetDown));
    next.reason = cpu ? '编码负载较高，优先保帧率' : '网络拥塞，降低码率保流畅';
  } else {
    const safe = sample.loss == null || sample.loss < 0.015;
    const lowRtt = sample.rtt == null || sample.rtt < 0.25;
    const notCpu = !cpu && sample.limitation !== 'cpu';
    const active = sample.fps != null && sample.fps >= options.fps * 0.85;
    const headroom = available == null || available >= previous.bitrate * 0.95;

    if (previous.bitrate < base && safe && lowRtt && notCpu) {
      const ceiling = available != null && available < base ? available : base;
      const step = available != null && available < base
        ? Math.min(ceiling, Math.max(previous.bitrate * 1.15, available * 0.9))
        : Math.min(base, Math.max(previous.bitrate * 1.25, previous.bitrate + 250_000));
      next.bitrate = Math.round(Math.min(ceiling, step));
      next.good = (previous.good || 0) + 1;
      next.reason = '网络平稳，恢复码率';
      if (next.good >= 3 && next.scale < 1) {
        next.scale = Math.min(1, Number((previous.scale * 1.15).toFixed(2)));
        if (next.scale >= 0.95) next.scale = 1;
        next.good = 0;
        next.reason = '网络平稳，恢复分辨率';
      }
    } else {
      const healthy = active && headroom && safe && lowRtt && notCpu;
      next.good = healthy ? previous.good + 1 : 0;
    }

    if (next.good >= 3) {
      next.good = 0;
      const fairProbe = Number.isFinite(sample.fairShare) && sample.fairShare > 0
        ? Math.min(sample.fairShare, previous.bitrate * 1.25) : 0;
      const probeBitrate = Math.round(Math.max(previous.bitrate * 1.15, fairProbe));
      const ceiling = available != null ? Math.max(available * 0.95, probeBitrate) : probeBitrate;
      next.bitrate = Math.min(cap, ceiling);
      next.reason = '稳定运行，逐步上探码率';

      if (active && next.bitrate >= base * 1.4 && (available == null || available > base * 1.6)) {
        next.scale = Math.min(1.5, Number((previous.scale * 1.1).toFixed(2)));
        next.reason = '帧率稳定，提升源像素细节';
      } else if (next.scale < 1) {
        next.scale = Math.min(1, Number((previous.scale * 1.15).toFixed(2)));
        if (next.scale >= 0.95) next.scale = 1;
        next.reason = '网络平稳，恢复分辨率';
      }
    } else if (next.reason !== '网络平稳，恢复码率') {
      next.reason = !active ? '观察帧率（静态画面可能低帧率）' : '观察网络';
    }
  }

  next.bitrate = Math.round(Math.min(cap, next.bitrate));
  if (next.framePressure >= 2 && !cpu && !(sample.loss != null && sample.loss > 0.05) && !(sample.rtt != null && sample.rtt > 0.4)) {
    next.scale = Math.max(0.5, Number((next.scale / 1.2).toFixed(2)));
    next.framePressure = 0;
    next.good = 0;
    next.reason = '编码帧率不足，降分辨率保流畅';
  }
  next.scale = Math.min(maxScale, next.scale);
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
