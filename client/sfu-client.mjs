// Cloudflare Calls Serverless SFU client for single-encoder screen sharing.
import { preferH264, preferredVideoCodecs } from './video-codec.mjs';
import { baseBitrate, evenResolutionScale, qualityLimits, videoOptions } from './video-quality.mjs';

export async function sfuRequest(workerUrl, subPath, body, method = 'POST') {
  const url = `${workerUrl.replace(/\/+$/, '')}/api/sfu/${subPath.replace(/^\/+/, '')}`;
  const options = {
    method,
    headers: {}
  };
  if (body !== undefined) {
    options.headers['content-type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const response = await fetch(url, options);
  let data;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) {
    const errorMsg = data?.errorDescription || data?.errorCode || `SFU 请求失败 (HTTP ${response.status})`;
    throw new Error(errorMsg);
  }
  if (data?.errorCode) {
    throw new Error(data.errorDescription || data.errorCode || 'SFU 服务错误');
  }
  return data;
}

function isPcConnected(pc) {
  return (
    pc.iceConnectionState === 'connected' ||
    pc.iceConnectionState === 'completed' ||
    pc.connectionState === 'connected'
  );
}

function waitForIceGathering(pc, timeoutMs = 2500) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise(resolve => {
    const onGather = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener?.('icegatheringstatechange', onGather);
        resolve();
      }
    };
    pc.addEventListener?.('icegatheringstatechange', onGather);
    setTimeout(() => {
      pc.removeEventListener?.('icegatheringstatechange', onGather);
      resolve();
    }, timeoutMs);
  });
}

function waitForIceConnected(pc, timeoutMs = 8000) {
  if (isPcConnected(pc)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onStateChange = () => {
      if (isPcConnected(pc)) {
        pc.removeEventListener?.('iceconnectionstatechange', onStateChange);
        pc.removeEventListener?.('connectionstatechange', onStateChange);
        resolve();
      }
    };
    pc.addEventListener?.('iceconnectionstatechange', onStateChange);
    pc.addEventListener?.('connectionstatechange', onStateChange);
    setTimeout(() => {
      pc.removeEventListener?.('iceconnectionstatechange', onStateChange);
      pc.removeEventListener?.('connectionstatechange', onStateChange);
      if (isPcConnected(pc)) {
        resolve();
      } else {
        reject(new Error('Cloudflare SFU 边缘节点连接超时'));
      }
    }, timeoutMs);
  });
}

async function waitForFirstDecodedVideoFrame(pc, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const reports = await pc.getStats();
    const decoded = [...reports.values()].some(report => report.type === 'inbound-rtp' &&
      (report.kind === 'video' || report.mediaType === 'video') && report.framesDecoded > 0);
    if (decoded) return;
    if (Date.now() >= deadline) throw new Error('SFU 已连接，但未收到可解码视频帧');
    await new Promise(resolve => setTimeout(resolve, Math.min(400, deadline - Date.now())));
  }
}

function videoEncoding(settings, preferences) {
  const options = videoOptions(preferences);
  const selectedHeight = options.height === 'source' ? (settings.height || 1080) : options.height;
  const effective = { ...options, height: selectedHeight, sourceMode: options.height === 'source' };
  const limits = qualityLimits(effective);
  return {
    scaleResolutionDownBy: evenResolutionScale(settings.width, settings.height,
      Math.min(selectedHeight, settings.height || selectedHeight, limits.maxHeight)),
    maxBitrate: options.adaptive ? limits.maxBitrate : Math.min(baseBitrate(effective), limits.maxBitrate),
    maxFramerate: options.fps
  };
}

async function waitForCaptureDimensions(track, timeoutMs = 1500) {
  if (typeof track.getSettings !== 'function') return {};
  const deadline = Date.now() + timeoutMs;
  let settings = track.getSettings() || {};
  while ((!settings.width || !settings.height) && Date.now() < deadline && track.readyState !== 'ended') {
    await new Promise(resolve => setTimeout(resolve, 50));
    settings = track.getSettings() || {};
  }
  return settings;
}

export async function createSfuPublisher({
  stream,
  workerUrl,
  videoPreferences,
  preferHardwareEncoding = true,
  videoCodecCapabilities = preferredVideoCodecs(),
  onStatus,
  onError,
  RTCPeerConnectionClass = typeof RTCPeerConnection !== 'undefined' ? RTCPeerConnection : null
}) {
  if (!RTCPeerConnectionClass) throw new Error('当前环境不支持 WebRTC');
  const pc = new RTCPeerConnectionClass({
    iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
    bundlePolicy: 'max-bundle'
  });

  const videoTrack = stream.getVideoTracks()[0];
  if (!videoTrack) throw new Error('未检测到视频轨道');
  const audioTrack = stream.getAudioTracks()[0] || null;

  const initialSettings = await waitForCaptureDimensions(videoTrack);
  const videoTransceiver = pc.addTransceiver(videoTrack, {
    direction: 'sendonly', sendEncodings: [videoEncoding(initialSettings, videoPreferences)]
  });
  preferH264(videoTransceiver, videoCodecCapabilities, { hardware: preferHardwareEncoding });
  const audioTransceiver = audioTrack ? pc.addTransceiver(audioTrack, { direction: 'sendonly' }) : null;
  let configuration = Promise.resolve();
  let stopped = false;
  function configureVideo(preferences) {
    configuration = configuration.catch(() => {}).then(async () => {
      if (stopped) return;
      const settings = videoTrack.getSettings?.() || {};
      const params = videoTransceiver.sender.getParameters();
      if (!params.encodings?.length) return;
      params.degradationPreference = 'maintain-resolution';
      Object.assign(params.encodings[0], videoEncoding(settings, preferences));
      await videoTransceiver.sender.setParameters(params);
    });
    return configuration;
  }

  try {
    onStatus?.('正在连接 Cloudflare SFU…');
    await pc.setLocalDescription(await pc.createOffer());
    await waitForIceGathering(pc, 2500);

    const sessionRes = await sfuRequest(workerUrl, 'sessions/new');
    const sessionId = sessionRes?.sessionId;
    if (!sessionId) throw new Error('SFU 未返回有效推流会话 ID');

    onStatus?.('正在向 Cloudflare SFU 推流…');
    const trackObjects = [{ location: 'local', mid: videoTransceiver.mid, trackName: videoTrack.id }];
    if (audioTransceiver && audioTrack) {
      trackObjects.push({ location: 'local', mid: audioTransceiver.mid, trackName: audioTrack.id });
    }

    const tracksRes = await sfuRequest(workerUrl, `sessions/${sessionId}/tracks/new`, {
      sessionDescription: { type: 'offer', sdp: pc.localDescription.sdp },
      tracks: trackObjects
    });

    if (!tracksRes.sessionDescription) throw new Error('SFU 协商推流轨道失败');
    await pc.setRemoteDescription(tracksRes.sessionDescription);

    await configureVideo(videoPreferences);

    await waitForIceConnected(pc, 8000);
    onStatus?.('Cloudflare SFU 云端分发中 (单路推流)');

    return {
      pc,
      sessionId,
      configureVideo,
      sfuInfo: {
        sessionId,
        videoTrackName: videoTrack.id,
        audioTrackName: audioTrack ? audioTrack.id : null
      },
      stop() {
        stopped = true;
        try { pc.close(); } catch { /* ignore */ }
      }
    };
  } catch (err) {
    try { pc.close(); } catch { /* ignore */ }
    onError?.(err);
    throw err;
  }
}

export async function createSfuSubscriber({
  sfuInfo,
  workerUrl,
  onTrack,
  onStatus,
  onError,
  firstFrameTimeoutMs = 10000,
  videoCodecCapabilities = preferredVideoCodecs(),
  RTCPeerConnectionClass = typeof RTCPeerConnection !== 'undefined' ? RTCPeerConnection : null
}) {
  if (!RTCPeerConnectionClass) throw new Error('当前环境不支持 WebRTC');
  const pc = new RTCPeerConnectionClass({
    iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
    bundlePolicy: 'max-bundle'
  });

  try {
    onStatus?.('正在连接 Cloudflare SFU 接收端…');
    pc.ontrack = event => {
      onTrack?.(event.track, event.track.kind);
    };

    const sessionRes = await sfuRequest(workerUrl, 'sessions/new');
    const subSessionId = sessionRes?.sessionId;
    if (!subSessionId) throw new Error('SFU 未返回有效接收会话 ID');

    onStatus?.('正在从 Cloudflare SFU 订阅共享流…');
    const trackObjects = [{ location: 'remote', sessionId: sfuInfo.sessionId, trackName: sfuInfo.videoTrackName }];
    if (sfuInfo.audioTrackName) {
      trackObjects.push({ location: 'remote', sessionId: sfuInfo.sessionId, trackName: sfuInfo.audioTrackName });
    }

    const tracksRes = await sfuRequest(workerUrl, `sessions/${subSessionId}/tracks/new`, {
      tracks: trackObjects
    });

    const videoResult = tracksRes.tracks?.find(track => track.trackName === sfuInfo.videoTrackName);
    if (!videoResult) throw new Error('SFU 未返回视频订阅轨道');
    if (videoResult.errorCode) throw new Error(videoResult.errorDescription || videoResult.errorCode);
    if (videoResult.mid == null) throw new Error('SFU 视频订阅缺少接收轨道 ID');
    if (tracksRes.sessionDescription?.type !== 'offer') throw new Error('SFU 未返回视频订阅协商请求');

    await pc.setRemoteDescription(tracksRes.sessionDescription);
    // Prefer Main to align with the efficient hardware publisher. Keep other
    // codecs available for old peers and compatibility-mode publications.
    for (const transceiver of pc.getTransceivers?.() || []) {
      if (transceiver.receiver?.track?.kind === 'video') {
        preferH264(transceiver, videoCodecCapabilities, { preferredProfile: 'main' });
      }
    }
    await pc.setLocalDescription(await pc.createAnswer());
    await waitForIceGathering(pc, 2500);
    await sfuRequest(workerUrl, `sessions/${subSessionId}/renegotiate`, {
      sessionDescription: { type: 'answer', sdp: pc.localDescription.sdp }
    }, 'PUT');

    await waitForIceConnected(pc, 8000);
    await waitForFirstDecodedVideoFrame(pc, firstFrameTimeoutMs);
    onStatus?.('Cloudflare SFU 云分发接收中');

    return {
      sessionId: subSessionId,
      pc,
      stop() {
        try { pc.close(); } catch { /* ignore */ }
      }
    };
  } catch (err) {
    try { pc.close(); } catch { /* ignore */ }
    onError?.(err);
    throw err;
  }
}
