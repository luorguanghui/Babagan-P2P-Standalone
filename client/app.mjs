import { DEFAULT_WORKER, workerUrl, parseInvitation } from './config.mjs';
import { Mesh } from './mesh.mjs';
import { videoOptions } from './video-quality.mjs';
import { describeEncoder } from './video-codec.mjs';
import { captureObsVirtualCamera } from './obs-capture.mjs';
import { AUDIO_CONSTRAINTS, setupNoiseGate } from './audio-processor.mjs';
import { createStatus } from './status-message.mjs';
import { reconcileSharePlayback, setSharePreviewVisibility } from './share-playback.mjs';
import { createShareStageContinuity } from './share-stage-continuity.mjs';
import { createSharePresence } from './share-presence.mjs';
import { captureNativeScreen } from './native-capture-controller.mjs';
import { createSfuPublisher, createSfuSubscriber } from './sfu-client.mjs';
import { createSfuSubscriptionManager } from './sfu-subscription.mjs';
import { createSfuStatsSampler, formatSfuVideoStats } from './sfu-stats.mjs';

const $ = id => document.getElementById(id);
const status = createStatus($('status'));
if ($('status')) $('status').title = '点击关闭提示';
const stageContinuity = createShareStageContinuity({ video: $('screen'), hold: $('screen-hold'),
  empty: $('empty'), topBar: $('stage-top-bar') });
const error = e => status(e?.message || String(e), 5000);
const isAndroid = /Android/i.test(navigator.userAgent);

let session, socket, mesh, microphone, audioProcessor, display, captureMode, nativeCapture, shareTimeout, capturePending = false, captureSequence = 0, roster = [], sharer, ice, closed = true, reconnectTimer, heartbeat, statsTimer, attempts = 0, generation = 0;
let muted = true, busy = false, sharingPending = false, resumedMuted = false;
let sfuPublisher = null, sfuSubscriber = null, sfuSubscriberTrack = null, sfuSubscriberAudioTrack = null;
let latestMeshMetrics = [], sfuVideoStats = null, sfuStatsPc = null;
const sfuStatsSampler = createSfuStatsSampler();
let previewVisible = true;
function updatePreviewVisibility(visible) {
  previewVisible = Boolean(visible);
  stageContinuity.setSuspended(!previewVisible);
  if (session) renderScreen();
}
window.babaganDesktop?.onPreviewVisibility?.(updatePreviewVisibility);
// Native visibility takes precedence because Electron keeps this page active
// for capture even when minimized. Browser clients use Page Visibility.
if (!window.babaganDesktop?.onPreviewVisibility) {
  document.addEventListener('visibilitychange', () => updatePreviewVisibility(!document.hidden));
}
const sharePresence = createSharePresence({ onExpire: lostId => {
  if (closed || sharer !== lostId) return;
  stageContinuity.hold();
  sharer = null;
  sfuSubscription.stop();
  renderRoster();
  renderScreen();
  renderMetrics();
} });
const sfuSubscription = createSfuSubscriptionManager({
  connect: ({ sfuInfo, onTrack }) => createSfuSubscriber({
    sfuInfo,
    workerUrl: $('worker').value,
    onTrack,
    onStatus: message => status(message, 3000)
  }),
  onTrack: (track, kind) => {
    if (kind === 'video') sfuSubscriberTrack = track;
    if (kind === 'audio') sfuSubscriberAudioTrack = track;
    renderScreen();
  },
  onSubscriber: subscriber => {
    sfuSubscriber = subscriber;
    if (!subscriber) {
      sfuSubscriberTrack = null;
      sfuSubscriberAudioTrack = null;
    }
    renderScreen();
    renderMetrics();
  },
  onError: cause => {
    console.warn('SFU subscription retry:', cause);
    status('SFU 视频暂未到达，正在重新订阅…', 5000);
  }
});
const remote = new Map(), paths = new Map();

// Local storage settings
const savedWorker = localStorage.getItem('p2p-worker');
try { $('worker').value = savedWorker ? workerUrl(savedWorker) : DEFAULT_WORKER; }
catch { $('worker').value = DEFAULT_WORKER; }
if (savedWorker && savedWorker !== $('worker').value) localStorage.setItem('p2p-worker', $('worker').value);

$('name').value = localStorage.getItem('p2p-name') || '';
if ($('settings')) $('settings').open = !$('worker').value;
if ($('share')) $('share').hidden = isAndroid;
if ($('system-audio-label')) $('system-audio-label').hidden = isAndroid;
if ($('mobile-note')) $('mobile-note').hidden = !isAndroid;
if ($('quality-controls')) $('quality-controls').hidden = isAndroid;
if ($('use-sfu')) {
  $('use-sfu').checked = localStorage.getItem('p2p-use-sfu') === 'true';
  $('use-sfu').onchange = () => {
    localStorage.setItem('p2p-use-sfu', $('use-sfu').checked);
    updateShareSource();
  };
}
if ($('sfu-compat')) {
  $('sfu-compat').checked = localStorage.getItem('p2p-sfu-compat') === 'true';
  $('sfu-compat').onchange = () => localStorage.setItem('p2p-sfu-compat', $('sfu-compat').checked);
}

let videoPreferences = videoOptions();
try {
  const saved = JSON.parse(localStorage.getItem('p2p-video') || '{}');
  const rawFps = Number(saved.fps);
  const fps = [15, 30, 45, 50, 60].includes(rawFps) ? rawFps : 30;
  videoPreferences = videoOptions({ ...saved, fps, degradationPreference: 'maintain-resolution' });
} catch { /* use defaults */ }
if ($('quality')) $('quality').value = String(videoPreferences.height);
if ($('fps')) $('fps').value = String(videoPreferences.fps);
if ($('adaptive')) $('adaptive').checked = videoPreferences.adaptive;

// Lobby Tab Switching
if ($('tab-create') && $('tab-join')) {
  $('tab-create').onclick = () => {
    $('tab-create').classList.add('active');
    $('tab-join').classList.remove('active');
    $('invitation-group').hidden = true;
    $('create').hidden = false;
    $('join').hidden = true;
  };
  $('tab-join').onclick = () => {
    $('tab-join').classList.add('active');
    $('tab-create').classList.remove('active');
    $('invitation-group').hidden = false;
    $('create').hidden = true;
    $('join').hidden = false;
    $('invitation').focus();
  };
}

function updateConnectionIndicator(text, mode = '') {
  $('connection').textContent = text;
  const dot = $('conn-dot');
  if (dot) dot.className = `conn-dot ${mode}`;
}

function renderMetrics(metrics = latestMeshMetrics) {
  latestMeshMetrics = metrics;
  const mbps = value => value == null ? '—' : `${(value / 1e6).toFixed(2)} Mbps`;
  const fps = value => value == null ? '—' : `${value.toFixed(1)} fps`;
  const activeSfuPc = sfuPublisher?.pc || sfuSubscriber?.pc;
  if (activeSfuPc) {
    const currentStats = sfuStatsPc === activeSfuPc ? sfuVideoStats : null;
    const direction = sfuPublisher ? 'send' : 'receive';
    $('metrics-total').textContent = `Cloudflare SFU · 视频${direction === 'send' ? '上行' : '下行'} ${mbps(currentStats?.bitrate)}`;
    const line = document.createElement('p');
    line.textContent = formatSfuVideoStats({ ...currentStats, direction });
    $('metrics-peers').replaceChildren(line);
    return;
  }
  $('metrics-total').textContent = session
    ? `总上行 ${mbps(metrics.reduce((n, m) => n + m.outgoing, 0))} · 总下行 ${mbps(metrics.reduce((n, m) => n + m.incoming, 0))} · ${isAndroid ? '接收帧率由共享端和设备决定' : `目标 ${videoPreferences.height === 'source' ? '原始分辨率' : videoPreferences.height + 'p'} / ${videoPreferences.fps} fps`}`
    : '未连接 · 上行 — · 下行 — · 帧率 —';
  $('metrics-peers').replaceChildren();
  for (const m of metrics) {
    const line = document.createElement('p');
    const out = display ? m.outbound : null, incoming = sharer === m.id ? m.inbound : null;
    const resolution = r => r?.frameWidth && r?.frameHeight ? `${r.frameWidth}×${r.frameHeight}` : '—';
    line.textContent = `${roster.find(p => p.id === m.id)?.name || '成员'} [${m.path || '直连'}] · 上行 ${mbps(m.outgoing)} / 下行 ${mbps(m.incoming)}` +
      (out ? ` · 发送 ${resolution(out)} / ${fps(m.fps)}${m.sourceFps == null ? '' : ` · 采集 ${fps(m.sourceFps)}`} · ${m.outCodec?.replace('video/', '') || '编码格式待确认'} · ${describeEncoder(m.encoderImplementation, m.powerEfficientEncoder)} · 码率上限 ${mbps(m.budget.bitrate)} · 可用带宽估计 ${mbps(m.available)} · ${m.budget.reason}` : '') +
      (incoming ? ` · 接收 ${resolution(incoming)} / 解码 ${fps(m.inFps)}${m.inReceivedFps == null ? '' : ` · 到达 ${fps(m.inReceivedFps)}`}${m.inCodec ? ` · ${m.inCodec.replace('video/', '')}` : ''}` : '');
    $('metrics-peers').append(line);
  }
}

async function changeQuality() {
  const rawFps = Number($('fps').value);
  const fps = [15, 30, 45, 50, 60].includes(rawFps) ? rawFps : 30;
  videoPreferences = videoOptions({ height: $('quality').value, fps, adaptive: $('adaptive').checked,
    degradationPreference: 'maintain-resolution' });
  localStorage.setItem('p2p-video', JSON.stringify(videoPreferences));
  if (display) {
    const videoTrack = display.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.contentHint = (videoPreferences.fps >= 60 || captureMode === 'native') ? 'motion' : 'detail';
      if (captureMode === 'screen') await videoTrack.applyConstraints({ frameRate: { ideal: videoPreferences.fps, max: videoPreferences.fps } });
      if (captureMode === 'obs') await videoTrack.applyConstraints({ frameRate: { ideal: videoPreferences.fps, max: videoPreferences.fps } });
      if (captureMode === 'native') await nativeCapture?.configure({ fps: videoPreferences.fps,
        height: videoPreferences.height === 'source' ? 2160 : videoPreferences.height });
    }
  }
  await mesh?.configureVideo(videoPreferences);
  await sfuPublisher?.configureVideo(videoPreferences);
}
for (const id of ['quality', 'fps', 'adaptive']) {
  if ($(id)) $(id).onchange = () => changeQuality().catch(error);
}

function updateShareSource() {
  const obs = $('share-source')?.value === 'obs';
  const native = $('share-source')?.value === 'native';
  if ($('share-source')) $('share-source').disabled = Boolean(display || capturePending);
  if ($('use-sfu')) $('use-sfu').disabled = Boolean(display || capturePending);
  if ($('sfu-compat')) $('sfu-compat').disabled = Boolean(display || capturePending || !$('use-sfu')?.checked);
  if ($('share')) $('share').disabled = capturePending || Boolean(sharer && sharer !== session?.id);
  if ($('system-audio')) {
    $('system-audio').disabled = obs;
    if (obs) $('system-audio').checked = false;
  }
  if ($('system-audio-label')) $('system-audio-label').hidden = isAndroid || obs;
  if ($('sfu-label')) $('sfu-label').hidden = isAndroid;
  if ($('sfu-compat-label')) $('sfu-compat-label').hidden = isAndroid || !$('use-sfu')?.checked;
  if ($('share-source-note')) $('share-source-note').textContent = obs
    ? '先在 OBS 启动虚拟摄像头；此来源仅传视频，麦克风仍使用会议设置。'
    : native ? '内置采集专为整屏高帧率优化（无需额外 OBS）；若需共享单个应用窗口请选择“屏幕 / 窗口”。'
    : '保持原始比例 · 优先帧率 · 共享中实时生效';
  if (!display && $('share')) $('share').textContent = capturePending ? '正在获取画面…' : (obs ? '共享 OBS' : '共享屏幕');
}
if ($('share-source')) $('share-source').onchange = updateShareSource;
updateShareSource();

async function api(path, body = {}, token = session?.token, endpoint = session?.worker) {
  const r = await fetch(`${endpoint}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(16000)
  });
  const value = await r.json();
  if (!r.ok) { const e = new Error(value.error || `请求失败 (${r.status})`); e.status = r.status; throw e; }
  return value;
}

const roomPath = action => `/rooms/${session.room}/${action}`;
async function refreshIce() { ice = await api(roomPath('ice')); return ice.iceServers; }
function send(message) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); }

async function start(create) {
  if (busy) return;
  busy = true;
  $('create').disabled = true;
  if ($('join')) $('join').disabled = true;
  status('正在准备音频和连接…');
  try {
    const name = $('name').value.trim();
    if (!name || name.length > 40) throw new Error('请填写你的名字');
    let endpoint, room;
    if (create) {
      endpoint = workerUrl($('worker').value);
    } else {
      ({ worker: endpoint, room } = parseInvitation($('invitation').value, $('worker').value));
    }
    if (!$('listen-only').checked) {
      const rawMic = await navigator.mediaDevices.getUserMedia({
        audio: AUDIO_CONSTRAINTS,
        video: false
      });
      audioProcessor = setupNoiseGate(rawMic);
      microphone = audioProcessor.stream;
      microphone.getAudioTracks().forEach(t => { t.enabled = false; });
    } else {
      audioProcessor = null;
      microphone = null;
    }
    const result = await api(create ? '/rooms' : `/rooms/${room}/join`, { name }, null, endpoint);
    session = { ...result, worker: endpoint, name, relayOnly: $('relay-only').checked };
    await refreshIce();
    localStorage.setItem('p2p-worker', endpoint);
    localStorage.setItem('p2p-name', name);
    $('worker').value = endpoint;
    muted = true;
    closed = false;
    attempts = 0;
    $('lobby').hidden = true;
    $('room').hidden = false;
    $('end').hidden = !session.host;
    $('invite-text').textContent = `${endpoint}/room/${session.room}`;
    updateMicButton();
    updateConnectionIndicator('正在建立连接…', 'connecting');
    connect();
    statsTimer = setInterval(() => {
      mesh?.stats().catch(() => {});
      const pc = sfuPublisher?.pc || sfuSubscriber?.pc || null;
      void sfuStatsSampler.sample(pc).then(stats => {
        if (pc !== (sfuPublisher?.pc || sfuSubscriber?.pc || null)) return;
        sfuStatsPc = pc;
        sfuVideoStats = stats;
        renderMetrics();
      }).catch(error => console.warn('SFU stats unavailable:', error));
    }, 3000);
  } catch (e) {
    if (session) await api(roomPath('leave')).catch(() => {});
    if (audioProcessor) {
      audioProcessor.track?.stop();
      audioProcessor = null;
    } else if (microphone) {
      microphone.getTracks().forEach(t => t.stop());
    }
    microphone = null;
    session = null;
    error(e.name === 'NotAllowedError' ? new Error('麦克风权限被拒绝。请允许麦克风，或选择“仅收听”。') : e);
  } finally {
    busy = false;
    $('create').disabled = false;
    if ($('join')) $('join').disabled = false;
  }
}

function connect() {
  if (closed) return;
  const current = ++generation;
  clearTimeout(reconnectTimer);
  clearInterval(heartbeat);
  socket?.close();
  mesh?.close();
  clearRemote();
  updateConnectionIndicator('正在连接 Cloudflare 信令…', 'connecting');

  const ws = new WebSocket(`${session.worker.replace(/^http/, 'ws')}${roomPath('ws')}?token=${encodeURIComponent(session.token)}`);
  socket = ws;
  const timeout = setTimeout(() => { if (ws.readyState !== WebSocket.OPEN) ws.close(); }, 15000);
  let lastRenew = Date.now(), lastPong = Date.now();

  ws.onopen = () => {
    clearTimeout(timeout);
    heartbeat = setInterval(() => {
      if (Date.now() - lastPong > 90000) ws.close();
      else {
        send({ type: 'ping' });
        if (Date.now() - lastRenew > 300000) {
          lastRenew = Date.now();
          send({ type: 'renew' });
        }
      }
    }, 25000);
  };

  ws.onmessage = async event => {
    if (generation !== current || closed) return;
    try {
      const message = JSON.parse(event.data);
      if (message.type === 'pong' || message.type === 'renewed') { lastPong = Date.now(); return; }
      if (message.type === 'welcome') {
        attempts = 0;
        mesh = new Mesh({
          id: session.id,
          iceServers: ice.iceServers,
          relayOnly: session.relayOnly,
          send,
          onTrack: receiveTrack,
          onStatus: (id, path) => {
            paths.set(id, path);
            renderRoster();
            renderScreen();
          },
          onError: error,
          refreshIce,
          onMetrics: renderMetrics
        });
        await mesh.configureVideo(videoPreferences);
        await mesh.setTrack(0, microphone?.getAudioTracks()[0] || null);
        send({ type: 'mute', muted });
        if (display && !closed) {
          sharingPending = true;
          send({ type: 'share-start', ...(sfuPublisher ? { sfu: sfuPublisher.sfuInfo } : {}) });
        }
        updateConnectionIndicator('已连接 · P2P / Cloudflare TURN', 'online');
        status('');
      }
      if (message.type === 'welcome' || message.type === 'roster') {
        roster = message.peers;
        const presence = sharePresence.update(message.sharer, roster);
        sharer = presence.sharer;
        if (presence.recovering && !sfuSubscriberTrack) stageContinuity.hold();
        const sfuInfo = message.sfu;
        if (mesh) {
          for (const peer of roster) if (peer.id !== session.id) mesh.ensure(peer.id, peer.epoch);
          for (const id of mesh.peers.keys()) if (!roster.some(p => p.id === id)) { mesh.remove(id); removeRemote(id); }
        }
        if (sharingPending && message.sharer === session.id && display) {
          sharingPending = false;
          clearTimeout(shareTimeout);
          shareTimeout = null;
          if (!sfuPublisher) {
            await mesh.setTrack(1, display.getVideoTracks()[0]);
            await mesh.setTrack(2, display.getAudioTracks()[0] || null);
          } else {
            await mesh.setTrack(1, null);
            await mesh.setTrack(2, null);
          }
        } else if (display && message.sharer !== session.id && !sharingPending && !presence.recovering) {
          const myMember = roster.find(p => p.id === session.id);
          const wasRevoked = myMember && !myMember.host && !myMember.canShare;
          await stopShare(false);
          if (wasRevoked) status('主持人已收回屏幕共享权限。', 4000);
        }

        // Subscriber handling for Cloudflare Calls SFU stream
        if (sharer && sharer !== session?.id) {
          if (sfuInfo) {
            sfuSubscription.update(sfuInfo);
          } else if (!presence.recovering) {
            sfuSubscription.stop();
          }
        } else if (!sharer) {
          sfuSubscription.stop();
        }

        renderRoster();
        renderScreen();
        renderMetrics();
      }
      if (message.type === 'signal') await mesh?.signal(message);
      if (message.type === 'error') {
        if (sharingPending) await stopShare(false);
        status(message.message, 5000);
      }
      if (message.type === 'ended') {
        await leave(false);
        status('主持人已结束会议。', 4000);
      }
    } catch (e) {
      error(e);
    }
  };

  ws.onclose = async event => {
    clearTimeout(timeout);
    if (generation !== current || closed) return;
    clearInterval(heartbeat);
    if (closed) await stopShare(false);
    updateConnectionIndicator('信令已断开', '');
    if (event.code === 1000 && event.reason === 'ended') { await leave(false); status('主持人已结束会议。', 5000); return; }
    if (event.code === 4000) { await leave(false); status('此入会身份已在另一连接打开。', 5000); return; }
    if (event.code === 4001) { await leave(false); status('连接已过期，请重新加入会议。', 5000); return; }
    status('连接中断，正在自动重连…');
    reconnectTimer = setTimeout(async () => {
      try {
        try {
          await refreshIce();
        } catch (e) {
          if ([401, 410].includes(e.status)) throw e;
          console.warn('ICE refresh during reconnect:', e);
        }
        connect();
      } catch (e) {
        if ([401, 410].includes(e.status)) { await leave(false); status(e.status === 410 ? '主持人已结束会议。' : '入会凭证已过期，请重新加入。', 5000); }
        else { error(e); connect(); }
      }
    }, Math.min(1000 * 2 ** Math.min(attempts++, 4), 6000));
  };

  ws.onerror = () => status('信令暂时不可达，请检查网络和 Worker 地址。', 5000);
}

function receiveTrack(id, index, track) {
  if (!remote.has(id)) {
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.setAttribute('playsinline', '');
    audio.srcObject = new MediaStream();
    $('audio-elements').append(audio);
    remote.set(id, { audio, video: null, systemAudio: null });
  }
  const entry = remote.get(id);
  if (index === 1) {
    entry.video = track;
    track.onunmute = renderScreen;
    track.onmute = () => {};
    renderScreen();
  } else if (index === 2) {
    entry.systemAudio = track;
    track.onunmute = renderScreen;
    renderScreen();
  } else {
    entry.audio.srcObject.addTrack(track);
    entry.audio.play().catch(() => status('点击“播放声音”启用会议音频。', 6000));
  }
}

function renderRoster() {
  $('count').textContent = `${roster.length} / 5`;
  $('peers').replaceChildren();
  const labels = {
    new: '建立连接',
    connecting: '连接中',
    connected: '已连接',
    disconnected: '正在恢复',
    failed: '连接失败，请重连',
    closed: '已断开'
  };

  const myMember = roster.find(p => p.id === session?.id);
  const isHost = Boolean(myMember?.host);
  const canCurrentUserShare = Boolean(myMember?.host || myMember?.canShare);

  for (const p of roster) {
    const li = document.createElement('li');
    li.className = 'peer-card';

    const avatar = document.createElement('div');
    avatar.className = 'peer-avatar';
    avatar.textContent = (p.name || '参')[0].toUpperCase();
    if (!p.muted && p.id !== session?.id) avatar.classList.add('speaking');

    const info = document.createElement('div');
    info.className = 'peer-info';

    // Must include exact readable title for automated smoke tests
    const nameRow = document.createElement('div');
    nameRow.className = 'peer-name-row';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'peer-name';
    nameSpan.textContent = `${p.name}${p.id === session?.id ? '（你）' : ''}${p.host ? ' · 主持人' : ''}${p.muted ? ' · 静音' : ''}`;
    nameRow.append(nameSpan);

    if (p.canShare && !p.host) {
      const badge = document.createElement('span');
      badge.className = 'peer-perm-badge';
      badge.textContent = '可共享';
      nameRow.append(badge);
    }

    if (isHost && p.id !== session?.id) {
      const permBtn = document.createElement('button');
      permBtn.type = 'button';
      permBtn.className = `peer-perm-btn ${p.canShare ? 'granted' : ''}`;
      permBtn.title = p.canShare ? '点击收回屏幕共享权限' : '点击授权屏幕共享权限';
      permBtn.textContent = p.canShare ? '收回共享' : '授权共享';
      permBtn.onclick = e => {
        e.stopPropagation();
        send({ type: 'grant-share', target: p.id, canShare: !p.canShare });
      };
      nameRow.append(permBtn);
    }

    info.append(nameRow);

    const pathVal = paths.get(p.id);
    const pathText = p.id === session?.id ? '本机' : (labels[pathVal] || pathVal || '等待连接');
    const small = document.createElement('small');
    small.className = `peer-path ${pathVal === 'Cloudflare TURN' ? 'turn' : (pathVal === 'P2P 直连' ? 'p2p' : '')}`;
    small.textContent = pathText;
    info.append(small);

    li.append(avatar, info);
    $('peers').append(li);
  }
  if (!canCurrentUserShare && !display) {
    $('share').disabled = true;
    $('share').title = '需主持人授权后方可共享屏幕';
  } else {
    $('share').disabled = capturePending || Boolean(sharer && sharer !== session?.id);
    $('share').title = '';
  }
}

function renderScreen() {
  const isLocal = sharer === session?.id;
  const track = isLocal ? display?.getVideoTracks()[0] : (sfuSubscriberTrack || remote.get(sharer)?.video);
  const systemAudio = isLocal ? null : (sfuSubscriberAudioTrack || remote.get(sharer)?.systemAudio);
  const video = $('screen');

  if (sharer) {
    stageContinuity.show();

    if (track && track.readyState === 'live') {
      const attached = reconcileSharePlayback(video, track, systemAudio, isLocal, MediaStream, () => stageContinuity.hold());
      const shouldPlay = setSharePreviewVisibility(video, isLocal, previewVisible);
      if (shouldPlay && (attached || video.paused)) video.play().catch(() => { if (systemAudio) status('点击“播放声音”启用会议音频。', 6000); });
    }

    const sharerPeer = roster.find(p => p.id === sharer);
    const sharerName = sharerPeer?.name || '成员';
    $('screen-label').textContent = `${sharerName} 正在共享`;

    const path = isLocal ? '本机' : paths.get(sharer);
    const pathBadge = $('stage-path-badge');
    const pathText = $('stage-path-text');
    if (pathBadge && pathText) {
      if (isLocal && sfuPublisher) {
        pathBadge.className = 'stage-path-badge turn';
        pathText.textContent = '☁️ Cloudflare SFU 云端分发 (单路推流)';
      } else if (!isLocal && sfuSubscriberTrack) {
        pathBadge.className = 'stage-path-badge turn';
        pathText.textContent = '☁️ Cloudflare SFU 云端分发';
      } else if (path === 'Cloudflare TURN') {
        pathBadge.className = 'stage-path-badge turn';
        pathText.textContent = '☁️ Cloudflare TURN 中继';
      } else if (path === 'P2P 直连') {
        pathBadge.className = 'stage-path-badge p2p';
        pathText.textContent = '⚡ P2P 直连';
      } else {
        pathBadge.className = 'stage-path-badge';
        pathText.textContent = path || '连接中';
      }
    }
  } else {
    stageContinuity.requestEmpty(() => {
      if (video.srcObject) video.srcObject = null;
      $('screen-label').textContent = '';
    });
  }
  $('share').textContent = display ? '停止共享' : ($('share-source')?.value === 'obs' ? '共享 OBS' : '共享屏幕');
}

// Fullscreen API Handling (with Dual-Engine Native + CSS Web Fullscreen Fallback)
async function toggleFullscreen() {
  const stage = $('stage');
  const isDocFullscreen = Boolean(document.fullscreenElement || document.webkitFullscreenElement);
  const isCssFullscreen = stage?.classList.contains('is-fullscreen');

  if (isDocFullscreen || isCssFullscreen) {
    if (isDocFullscreen) {
      try {
        if (document.exitFullscreen) await document.exitFullscreen();
        else if (document.webkitExitFullscreen) await document.webkitExitFullscreen();
      } catch { /* ignored */ }
    }
    stage?.classList.remove('is-fullscreen');
  } else {
    let nativeSuccess = false;
    try {
      if (stage?.requestFullscreen) {
        await stage.requestFullscreen();
        nativeSuccess = true;
      } else if (stage?.webkitRequestFullscreen) {
        await stage.webkitRequestFullscreen();
        nativeSuccess = true;
      } else if (document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen();
        nativeSuccess = true;
      }
    } catch {
      nativeSuccess = false;
    }
    if (!nativeSuccess || !document.fullscreenElement) {
      stage?.classList.add('is-fullscreen');
    }
  }
  updateFullscreenButtons();
}

function updateFullscreenButtons() {
  const stage = $('stage');
  const isFull = Boolean(document.fullscreenElement || document.webkitFullscreenElement || stage?.classList.contains('is-fullscreen'));
  const text = isFull ? '退出全屏' : '全屏';
  const stageBtn = $('stage-fullscreen-btn');
  const bottomBtn = $('fullscreen-btn');
  if (stageBtn) {
    const span = stageBtn.querySelector('span');
    if (span) span.textContent = text;
  }
  if (bottomBtn) {
    const span = bottomBtn.querySelector('span');
    if (span) span.textContent = text;
  }
}
document.addEventListener('fullscreenchange', updateFullscreenButtons);
document.addEventListener('webkitfullscreenchange', updateFullscreenButtons);

if ($('stage-fullscreen-btn')) $('stage-fullscreen-btn').onclick = toggleFullscreen;
if ($('fullscreen-btn')) $('fullscreen-btn').onclick = toggleFullscreen;
if ($('screen')) $('screen').ondblclick = toggleFullscreen;
document.addEventListener('keydown', e => {
  if ((e.key === 'f' || e.key === 'F') && !['INPUT', 'TEXTAREA'].includes(e.target.tagName)) {
    toggleFullscreen();
  }
  if (e.key === 'Escape' && $('stage')?.classList.contains('is-fullscreen')) {
    $('stage').classList.remove('is-fullscreen');
    updateFullscreenButtons();
  }
});

async function startShare() {
  if (display) { await stopShare(); return; }
  if (capturePending) return;
  if (socket?.readyState !== WebSocket.OPEN || !mesh) throw new Error('请等待连接恢复');
  const myMember = roster.find(p => p.id === session?.id);
  if (!myMember?.host && !myMember?.canShare) throw new Error('需主持人授权后方可共享屏幕');
  const obs = $('share-source')?.value === 'obs';
  const native = $('share-source')?.value === 'native';
  const attempt = ++captureSequence, meeting = session, connectionGeneration = generation;
  capturePending = true;
  updateShareSource();
  try {
    const nativeSession = native ? await captureNativeScreen(window.babaganDesktop, {
      fps: videoPreferences.fps,
      height: videoPreferences.height === 'source' ? 2160 : videoPreferences.height,
      audio: $('system-audio').checked
    }, { onStatus: event => {
      if (event.type === 'error') { status(event.message || '内置采集意外停止，请重试或切换共享来源。'); stopShare().catch(error); }
      else if (event.type === 'ended') stopShare().catch(error);
      else if (event.type === 'resized') {
        mesh?.configureVideo(videoPreferences).catch(error);
        sfuPublisher?.configureVideo(videoPreferences).catch(error);
      }
    } }) : null;
    const stream = nativeSession?.stream || (obs
      ? await captureObsVirtualCamera(navigator.mediaDevices, videoPreferences.fps)
      : await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: videoPreferences.fps, max: videoPreferences.fps } },
        audio: $('system-audio').checked ? {
          echoCancellation: true,
          autoGainControl: false,
          noiseSuppression: false,
          googEchoCancellation: true,
          googAutoGainControl: false,
          googNoiseSuppression: false
        } : false
      }));
    if (attempt !== captureSequence || closed || session !== meeting || generation !== connectionGeneration || socket?.readyState !== WebSocket.OPEN) {
      nativeSession?.stop();
      stream.getTracks().forEach(track => track.stop());
      return;
    }
    nativeCapture = nativeSession;
    display = stream;
    captureMode = native ? 'native' : obs ? 'obs' : 'screen';
    display.getVideoTracks()[0].contentHint = (videoPreferences.fps >= 60 || captureMode === 'native') ? 'motion' : 'detail';
    display.getVideoTracks()[0].onended = () => stopShare().catch(error);
    window.babaganDesktop?.captureStarted();

    let sfu = null;
    if ($('use-sfu')?.checked) {
      status('正在初始化 Cloudflare SFU 云端推流…');
      try {
        sfuPublisher = await createSfuPublisher({
          stream: display,
          workerUrl: $('worker').value,
          videoPreferences,
          preferHardwareEncoding: !$('sfu-compat')?.checked,
          onStatus: msg => status(msg, 3000),
          onError: err => {
            console.error('SFU Publisher error:', err);
            error(err);
          }
        });
        sfu = sfuPublisher.sfuInfo;
        status('Cloudflare SFU 云端推流已就绪', 3000);
        renderMetrics();
      } catch (err) {
        console.warn('SFU publish failed, falling back to P2P mesh:', err);
        status('SFU 服务连接失败，已回退为 P2P Mesh 直连共享', 4000);
        sfuPublisher = null;
      }
    }

    sharingPending = true;
    send({ type: 'share-start', ...(sfu ? { sfu } : {}) });
    clearTimeout(shareTimeout);
    const pendingDisplay = display;
    shareTimeout = setTimeout(() => {
      if (sharingPending && display === pendingDisplay) {
        stopShare().catch(error);
        status('共享请求超时，请重试。', 5000);
      }
    }, 8000);
  } catch (cause) {
    if (attempt !== captureSequence || closed || session !== meeting) return;
    throw cause;
  } finally {
    if (attempt === captureSequence) {
      capturePending = false;
      updateShareSource();
    }
  }
}

async function stopShare(notify = true) {
  ++captureSequence;
  capturePending = false;
  clearTimeout(shareTimeout);
  shareTimeout = null;
  sharingPending = false;
  sfuPublisher?.stop();
  sfuPublisher = null;
  const old = display;
  display = null;
  nativeCapture?.stop();
  nativeCapture = null;
  captureMode = null;
  old?.getTracks().forEach(t => { t.onended = null; t.stop(); });
  if (old) window.babaganDesktop?.captureStopped();
  await Promise.all([mesh?.setTrack(1, null), mesh?.setTrack(2, null)]).catch(() => {});
  if (notify && old) send({ type: 'share-stop' });
  renderScreen();
  renderMetrics();
  updateShareSource();
}

function updateMicButton() {
  const span = $('mic')?.querySelector('span');
  if (span) span.textContent = muted ? '开启麦克风' : '静音';
  else if ($('mic')) $('mic').textContent = muted ? '开启麦克风' : '静音';
}

async function toggleMic() {
  if (!microphone) {
    const rawMic = await navigator.mediaDevices.getUserMedia({
      audio: AUDIO_CONSTRAINTS,
      video: false
    });
    audioProcessor = setupNoiseGate(rawMic);
    microphone = audioProcessor.stream;
    await mesh.setTrack(0, microphone.getAudioTracks()[0]);
    muted = false;
  } else {
    muted = !muted;
    microphone.getAudioTracks().forEach(t => { t.enabled = !muted; });
  }
  updateMicButton();
  send({ type: 'mute', muted });
}

function removeRemote(id) {
  remote.get(id)?.audio.remove();
  remote.delete(id);
  paths.delete(id);
}

function clearRemote() {
  for (const id of remote.keys()) removeRemote(id);
  paths.clear();
}

async function leave(notify = true) {
  closed = true;
  sharePresence.stop();
  ++generation;
  clearTimeout(reconnectTimer);
  clearInterval(heartbeat);
  clearInterval(statsTimer);
  await stopShare(false);
  sfuPublisher?.stop();
  sfuPublisher = null;
  sfuSubscription.stop();
  if (notify && session) {
    send({ type: 'leave' });
    api(roomPath('leave')).catch(() => {});
  }
  socket?.close();
  socket = null;
  mesh?.close();
  mesh = null;
  if (audioProcessor) {
    audioProcessor.track?.stop();
    audioProcessor = null;
  } else if (microphone) {
    microphone.getTracks().forEach(t => t.stop());
  }
  microphone = null;
  clearRemote();
  session = null;
  roster = [];
  sharer = null;
  latestMeshMetrics = [];
  sfuVideoStats = null;
  sfuStatsPc = null;
  await sfuStatsSampler.sample(null);
  $('lobby').hidden = false;
  $('room').hidden = true;
  updateConnectionIndicator('独立客户端 · Windows / Android', '');
  status('');
  renderMetrics();
}

$('create').onclick = () => start(true);
$('join-form').onsubmit = event => { event.preventDefault(); start(false); };
$('mic').onclick = () => toggleMic().catch(error);
$('share').onclick = () => startShare().catch(e => {
  if (e.name !== 'NotAllowedError' && e.name !== 'AbortError' && !e.message?.includes('constraints')) {
    error(e);
  }
});
$('leave').onclick = () => leave();
$('end').onclick = async () => {
  try {
    await api(roomPath('end'));
    await leave(false);
    status('会议已结束。', 5000);
  } catch (e) {
    error(e);
  }
};
$('retry').onclick = async () => {
  try {
    await stopShare();
    await refreshIce();
    connect();
  } catch (e) {
    error(e);
  }
};
$('copy').onclick = async () => {
  try {
    await navigator.clipboard.writeText($('invite-text').textContent);
    status('邀请已复制。请在另一台客户端粘贴后加入。', 2500);
  } catch {
    status(`请复制邀请：${$('invite-text').textContent}`, 5000);
  }
};
$('play').onclick = () => {
  status('');
  for (const { audio } of remote.values()) audio.play().catch(error);
  $('screen').play().catch(error);
};

let backgrounded = false;
function background(hidden) {
  if (hidden === backgrounded) return; backgrounded = hidden; mesh?.setSuspended(hidden); if (!isAndroid || !session) return;


  if (hidden) {
    resumedMuted = muted;
    microphone?.getAudioTracks().forEach(t => { t.enabled = false; });
    send({ type: 'mute', muted: true });
  } else {
    microphone?.getAudioTracks().forEach(t => { t.enabled = !resumedMuted; });
    send({ type: 'mute', muted: resumedMuted });
  }
}
document.addEventListener('visibilitychange', () => background(document.hidden));
window.addEventListener('native-background', () => background(true));
window.addEventListener('native-foreground', () => background(false));
document.addEventListener('freeze', () => background(true));
document.addEventListener('resume', () => background(false));
window.addEventListener('pagehide', () => background(true));
window.addEventListener('pageshow', () => background(false));
window.addEventListener('beforeunload', () => {
  send({ type: 'leave' });
  microphone?.getTracks().forEach(t => t.stop());
  display?.getTracks().forEach(t => t.stop());
});
