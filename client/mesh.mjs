// Each connection reserves microphone, screen video and system audio slots.
// Keeping transceiver order fixed lets screen/mic replacement avoid renegotiation.
import { videoOptions, newBudget, adaptBudget, evenResolutionScale, videoSample, selectedCandidatePair, equalEstimatedBandwidthShare, qualityLimits } from './video-quality.mjs';
import { preferH264, preferredVideoCodecs, tuneVideoSdp } from './video-codec.mjs';
import { tuneOpusSdp } from './audio-processor.mjs';

function serializeDescription(desc) {
  if (!desc) return null;
  const json = typeof desc.toJSON === 'function' ? desc.toJSON() : { type: desc.type, sdp: desc.sdp };
  if (json.sdp) { json.sdp = tuneOpusSdp(json.sdp); json.sdp = tuneVideoSdp(json.sdp); }
  return json;
}

export class Mesh {
  constructor({ id, iceServers, relayOnly, send, onTrack, onStatus, onError, refreshIce, onMetrics }) {
    Object.assign(this, { id, iceServers, relayOnly, send, onTrack, onStatus, onError, refreshIce });
    this.peers = new Map();
    this.tracks = [null, null, null];
    this.closed = false;
    this.video = videoOptions(); this.onMetrics = onMetrics; this.sampling = false;
  }
  ensure(id, epoch) {
    let peer = this.peers.get(id);
    if (peer && peer.epoch !== epoch) { this.remove(id); peer = null; }
    if (peer) return peer;
    const pc = new RTCPeerConnection({ iceServers: this.iceServers, iceTransportPolicy: this.relayOnly ? 'relay' : 'all' });
    peer = { pc, epoch, making: false, ignore: false, pending: [], chain: Promise.resolve(), restarts: 0,
      budget: newBudget(this.effectiveVideo()), previous: new Map(), shareStream: new MediaStream() };
    this.peers.set(id, peer);
    peer.slots = this.id < id ? ['audio', 'video', 'audio'].map((kind, index) => {
      const transceiver = pc.addTransceiver(kind, { direction: 'sendrecv', ...(index > 0 ? { streams: [peer.shareStream] } : {}) });
      if (kind === 'video') preferH264(transceiver, preferredVideoCodecs());
      if (this.tracks[index]) transceiver.sender.replaceTrack(this.tracks[index]).catch(this.onError);
      return transceiver;
    }) : [];
    pc.onicecandidate = ({ candidate }) => { if (candidate) this.send({ type: 'signal', to: id, candidate: candidate.toJSON() }); };
    pc.ontrack = event => this.onTrack(id, Number(event.transceiver.mid), event.track);
    pc.onnegotiationneeded = async () => {
      try {
        peer.making = true;
        await pc.setLocalDescription();
        this.send({ type: 'signal', to: id, description: serializeDescription(pc.localDescription) });
      } catch (e) { if (!this.closed && pc.signalingState !== 'closed') this.onError(e); }
      finally { peer.making = false; }
    };
    pc.onconnectionstatechange = () => {
      this.onStatus(id, pc.connectionState);
      if (this.tracks[1]) void this.applyVideo(peer).catch(this.onError);
      if (pc.connectionState === 'connected') { peer.restarts = 0; clearTimeout(peer.retry); peer.retry = null; }
      if (['failed', 'disconnected'].includes(pc.connectionState) && !peer.retry) peer.retry = setTimeout(async () => {
        peer.retry = null;
        if (this.closed || this.peers.get(id) !== peer || pc.connectionState === 'connected') return;
        if (++peer.restarts > 3) { this.onStatus(id, 'failed'); return; }
        try {
          this.iceServers = await this.refreshIce();
          if (pc.signalingState === 'closed') return;
          pc.setConfiguration({ ...pc.getConfiguration(), iceServers: this.iceServers });
          pc.restartIce();
        } catch (e) { this.onError(e); }
      }, 4000);
    };
    return peer;
  }
  async signal(message) {
    const peer = this.peers.get(message.from);
    if (!peer) return;
    peer.chain = peer.chain.then(async () => {
      const { pc } = peer;
      if (pc.signalingState === 'closed') return;
      if (message.description) {
        const d = message.description;
        const collision = d.type === 'offer' && (peer.making || pc.signalingState !== 'stable');
        peer.ignore = this.id < message.from && collision;
        if (peer.ignore) return;
        await pc.setRemoteDescription(d);
        if (!peer.slots.length) {
          peer.slots = pc.getTransceivers().sort((a, b) => Number(a.mid) - Number(b.mid));
          for (let index = 0; index < peer.slots.length; index++) {
            peer.slots[index].direction = 'sendrecv';
            if (index > 0) peer.slots[index].sender.setStreams?.(peer.shareStream);
            if (index === 1) preferH264(peer.slots[index], preferredVideoCodecs());
            await peer.slots[index].sender.replaceTrack(this.tracks[index] || null);
          }
        }
        for (const candidate of peer.pending.splice(0)) await pc.addIceCandidate(candidate);
        if (d.type === 'offer') {
          await pc.setLocalDescription();
          this.send({ type: 'signal', to: message.from, description: serializeDescription(pc.localDescription) });
        }
      } else if (message.candidate && !peer.ignore) {
        if (pc.remoteDescription) await pc.addIceCandidate(message.candidate);
        else if (peer.pending.length < 100) peer.pending.push(message.candidate);
      }
    }).catch(e => { if (!this.closed && peer.pc.signalingState !== 'closed') this.onError(e); });
    return peer.chain;
  }
  async setTrack(index, track) {
    this.tracks[index] = track;
    await Promise.all([...this.peers.values()].map(p => p.slots[index]?.sender.replaceTrack(track)));
    if (index === 1) {
      for (const peer of this.peers.values()) { peer.budget = newBudget(this.effectiveVideo()); peer.previous = new Map(); peer.sample = null; peer.applied = null; }
      if (track) await Promise.all([...this.peers.values()].map(peer => this.applyVideo(peer)));
    }
  }
  effectiveVideo() {
    const settings = this.tracks[1]?.getSettings() || {};
    return { ...this.video, height: this.video.height === 'source' ? (settings.height || 1080) : this.video.height,
      sourceMode: this.video.height === 'source' };
  }
  async configureVideo(options) {
    this.video = videoOptions(options);
    for (const peer of this.peers.values()) peer.budget = newBudget(this.effectiveVideo());
    await Promise.all([...this.peers.values()].map(peer => this.applyVideo(peer)));
  }
  async applyVideo(peer) {
    const sender = peer.slots[1]?.sender, track = this.tracks[1];
    if (!sender || !track || peer.pc.signalingState !== 'stable') return;
    const params = sender.getParameters();
    if (!params.encodings?.length) return;
    const settings = track.getSettings();
    const options = this.effectiveVideo();
    const selectedHeight = options.height;
    const limits = qualityLimits(options);
    const sourceHeight = settings.height || selectedHeight;
    const rawScale = evenResolutionScale(settings.width, settings.height,
      Math.min(Math.min(selectedHeight, sourceHeight) * peer.budget.scale, limits.maxHeight));
    const scale = rawScale;
    const bitrate = Math.min(peer.budget.bitrate, limits.maxBitrate);
    const signature = `${bitrate}/${scale}/${this.video.fps}/${this.video.degradationPreference || 'maintain-resolution'}`;
    if (peer.applied === signature) return;
    params.degradationPreference = this.video.degradationPreference || 'maintain-resolution';
    params.encodings[0].active = bitrate > 0;
    if (bitrate > 0) params.encodings[0].maxBitrate = bitrate;
    params.encodings[0].maxFramerate = this.video.fps;
    params.encodings[0].scaleResolutionDownBy = scale;
    await sender.setParameters(params); peer.applied = signature;
  }
  setSuspended(suspended) { this.suspended = Boolean(suspended); if (!suspended) { for (const peer of this.peers.values()) peer.previous = new Map(); } }
  async stats() {
    if (this.sampling || this.closed) return;
    this.sampling = true;
    const metrics = [];
    try { for (const [id, peer] of this.peers) {
      const { pc } = peer;
      if (pc.connectionState !== 'connected') continue;
      const reports = await pc.getStats();
      if (this.closed || this.peers.get(id) !== peer) continue;
      const sample = videoSample(reports, peer.previous);
      peer.previous = reports;
      if (this.tracks[1]) {
        peer.sample = sample;
      }
      const pair = selectedCandidatePair(reports);
      let local = pair ? reports.get(pair.localCandidateId) : null;
      let remote = pair ? reports.get(pair.remoteCandidateId) : null;
      if (!local && pair?.localCandidateId) reports.forEach(r => { if (r.type === 'local-candidate' && r.id === pair.localCandidateId) local = r; });
      if (!remote && pair?.remoteCandidateId) reports.forEach(r => { if (r.type === 'remote-candidate' && r.id === pair.remoteCandidateId) remote = r; });
      const isRelay = Boolean(
        this.relayOnly ||
        local?.candidateType === 'relay' ||
        remote?.candidateType === 'relay' ||
        local?.relayProtocol ||
        remote?.relayProtocol ||
        (typeof local?.url === 'string' && (local.url.includes('turn:') || local.url.includes('cloudflare.com'))) ||
        (typeof remote?.url === 'string' && (remote.url.includes('turn:') || remote.url.includes('cloudflare.com')))
      );
      const connectionPath = isRelay ? 'Cloudflare TURN' : (local && remote ? 'P2P 直连' : null);
      this.onStatus(id, connectionPath || '路径待确认');
      metrics.push({ id, ...sample, path: connectionPath || '连接中', budget: { ...peer.budget } });
    }
    if (this.tracks[1]) {
      const fairShare = equalEstimatedBandwidthShare(metrics.map(metric => metric.available));
      for (const metric of metrics) {
        const peer = this.peers.get(metric.id);
        if (!peer) continue;
        peer.budget = adaptBudget(peer.budget, { ...peer.sample, fairShare, suspended: this.suspended }, this.effectiveVideo());
        try { await this.applyVideo(peer); }
        catch (e) { peer.budget.reason = '画质参数暂未生效'; this.onError(e); }
        metric.budget = { ...peer.budget };
      }
    }
    this.onMetrics?.(metrics); } finally { this.sampling = false; }
  }
  remove(id) { const p = this.peers.get(id); if (p) { clearTimeout(p.retry); p.pc.close(); this.peers.delete(id); } }
  close() { this.closed = true; for (const id of this.peers.keys()) this.remove(id); }
}
