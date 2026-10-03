export const validRoomId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
export function cleanName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 40) throw new Error('请输入 1–40 字的名字');
  return value.trim();
}
export function validateMessage(value) {
  if (!value || typeof value !== 'object') throw new Error('无效消息');
  const { type } = value;
  if (type === 'share-start') {
    if (value.sfu && typeof value.sfu === 'object') {
      const { sessionId, videoTrackName, audioTrackName } = value.sfu;
      if (typeof sessionId === 'string' && sessionId.length <= 128 &&
          typeof videoTrackName === 'string' && videoTrackName.length <= 128) {
        return {
          type,
          sfu: {
            sessionId,
            videoTrackName,
            audioTrackName: typeof audioTrackName === 'string' && audioTrackName.length <= 128 ? audioTrackName : null
          }
        };
      }
    }
    return { type };
  }
  if (['ping', 'renew', 'share-stop', 'leave', 'end'].includes(type)) return { type };
  if (type === 'mute' && typeof value.muted === 'boolean') return { type, muted: value.muted };
  if (type === 'grant-share' && typeof value.target === 'string' && value.target.length <= 64 && typeof value.canShare === 'boolean') return { type, target: value.target, canShare: value.canShare };
  if (type !== 'signal' || typeof value.to !== 'string' || value.to.length > 64) throw new Error('无效信令');
  if (value.description) {
    const { type: kind, sdp } = value.description;
    if (!['offer', 'answer'].includes(kind) || typeof sdp !== 'string' || sdp.length > 48000) throw new Error('无效 SDP');
    return { type, to: value.to, description: { type: kind, sdp } };
  }
  const c = value.candidate;
  if (c && typeof c.candidate === 'string' && c.candidate.length <= 4096 &&
      (c.sdpMid == null || typeof c.sdpMid === 'string' && c.sdpMid.length <= 32) &&
      (c.sdpMLineIndex == null || Number.isInteger(c.sdpMLineIndex) && c.sdpMLineIndex >= 0 && c.sdpMLineIndex < 16)) {
    return { type, to: value.to, candidate: { candidate: c.candidate, sdpMid: c.sdpMid ?? null, sdpMLineIndex: c.sdpMLineIndex ?? null, ...(typeof c.usernameFragment === 'string' && c.usernameFragment.length < 256 ? { usernameFragment: c.usernameFragment } : {}) } };
  }
  throw new Error('无效 ICE');
}
export function allowedIceServers(servers) {
  if (!Array.isArray(servers)) throw new Error('TURN 配置无效');
  const result = servers.flatMap(entry => {
    const urls = (Array.isArray(entry.urls) ? entry.urls : [entry.urls]).filter(url => typeof url === 'string' && /^(stun|turn|turns):(stun|turn)\.cloudflare\.com:(3478|5349|443)(\?transport=(udp|tcp))?$/.test(url));
    return urls.length ? [{ urls, ...(typeof entry.username === 'string' ? { username: entry.username } : {}), ...(typeof entry.credential === 'string' ? { credential: entry.credential } : {}) }] : [];
  });
  if (!result.some(s => s.urls.some(url => url.startsWith('turn')) && s.username && s.credential)) throw new Error('没有可用的 Cloudflare TURN 凭据');
  return result;
}
