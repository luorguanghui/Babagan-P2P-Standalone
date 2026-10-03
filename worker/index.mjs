import { validRoomId, cleanName, validateMessage, allowedIceServers } from './protocol.mjs';

const randomId = () => [...crypto.getRandomValues(new Uint8Array(16))].map(n => n.toString(16).padStart(2, '0')).join('');
const headers = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS', 'access-control-allow-headers': 'Content-Type, Authorization', 'cache-control': 'no-store', 'content-type': 'application/json' };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers });
const failure = (message, status = 400) => json({ error: message }, status);

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/sfu/')) {
      const callsAppId = env.CALLS_APP_ID;
      const callsAppToken = env.CALLS_APP_TOKEN;
      if (!callsAppId || !callsAppToken) return json({ errorDescription: "SFU 服务尚未配置" }, 503);
      const subPath = url.pathname.replace(/^\/api\/sfu\//, '');
      const targetUrl = `https://rtc.live.cloudflare.com/v1/apps/${callsAppId}/${subPath}`;
      const rawBody = ['POST', 'PUT', 'PATCH'].includes(request.method) ? await request.text() : null;
      const body = rawBody && rawBody.trim().length > 0 ? rawBody : undefined;
      try {
        const upstream = await fetch(targetUrl, {
          method: request.method,
          headers: {
            ...(body ? { 'content-type': 'application/json' } : {}),
            'authorization': `Bearer ${callsAppToken}`
          },
          body
        });
        const respText = await upstream.text();
        return new Response(respText, {
          status: upstream.status,
          headers: { ...headers, 'content-type': 'application/json' }
        });
      } catch (e) {
        return failure(e.message || 'SFU 代理通信失败', 502);
      }
    }
    // Consume small POST bodies before forwarding: workerd cannot proxy an
    // unread body after a Durable Object returns an early auth/ended response.
    if (request.method === 'POST') {
      const reader = request.body?.getReader();
      const chunks = []; let size = 0;
      if (reader) for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 2048) { await reader.cancel(); return failure('请求过大', 413); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      request = new Request(request.url, { method: request.method, headers: request.headers, body: bytes });
    }
    if (url.pathname === '/health') return json({ service: 'babagan-p2p', version: 1, turnConfigured: Boolean(env.TURN_KEY_ID && env.TURN_API_TOKEN) });
    if (request.method === 'POST' && url.pathname === '/rooms') {
      const ip = request.headers.get('cf-connecting-ip') || 'local';
      if (env.CREATE_LIMITER && !(await env.CREATE_LIMITER.limit({ key: ip })).success) return failure('创建过于频繁，请稍后再试', 429);
      const id = randomId();
      return env.ROOMS.get(env.ROOMS.idFromName(id)).fetch(new Request(`${url.origin}/rooms/${id}/create`, request));
    }
    const match = url.pathname.match(/^\/rooms\/([^/]+)\/(join|ws|ice|leave|end)$/);
    if (!match || !validRoomId(match[1])) return failure('房间不存在', 404);
    return env.ROOMS.get(env.ROOMS.idFromName(match[1])).fetch(request);
  }
};

export class MeetingRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.room = null;
    this.members = {};
    ctx.blockConcurrencyWhile(async () => {
      this.room = await ctx.storage.get('room') || null;
      this.members = await ctx.storage.get('members') || {};
    });
    // Runtime-level ping/pong keeps hibernated rooms inexpensive.
    if (typeof WebSocketRequestResponsePair !== 'undefined') ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
  }
  sockets() { return this.ctx.getWebSockets(); }
  socket(id) { return this.sockets().find(s => s.deserializeAttachment()?.id === id && s.readyState === 1); }
  send(socket, data) { try { socket.send(JSON.stringify(data)); } catch { /* closure is processed by the runtime */ } }
  broadcast(data) { for (const socket of this.sockets()) this.send(socket, data); }
  roster() {
    return Object.values(this.members).filter(m => this.socket(m.id)).map(({ id, name, host, muted, canShare, epoch }) => ({ id, name, host, muted, canShare: Boolean(canShare || host), epoch }));
  }
  async save() { await this.ctx.storage.put({ room: this.room, members: this.members }); }
  state() { return { type: 'roster', peers: this.roster(), sharer: this.room?.sharer || null, sfu: this.room?.sfu || null }; }
  prune() {
    for (const [id, m] of Object.entries(this.members)) {
      if (m.host) continue;
      if (!this.socket(id) && m.expires < Date.now()) delete this.members[id];
    }
  }
  async body(request) {
    const text = await request.text();
    if (text.length > 2048) throw new Error('请求过大');
    return JSON.parse(text);
  }
  authenticate(request) {
    const url = new URL(request.url);
    const token = request.headers.get('authorization')?.replace(/^Bearer /, '') || url.searchParams.get('token');
    if (!token) return null;
    return Object.values(this.members).find(m => {
      if (m.token !== token) return false;
      if (m.host) return true;
      if (this.socket(m.id) || m.expires > Date.now()) {
        m.expires = Math.max(m.expires, Date.now() + 1800000);
        return true;
      }
      return false;
    });
  }
  async fetch(request) {
    try {
      const url = new URL(request.url);
      const action = url.pathname.split('/').pop();
      if (request.method === 'POST' && action === 'create') {
        if (this.room) return failure('房间已存在', 409);
        const body = await this.body(request);
        const name = cleanName(body.name);
        this.room = { id: url.pathname.split('/')[2], expires: Date.now() + 86400000, sharer: null, ended: false };
        const member = this.addMember(name, true);
        await this.save();
        await this.ctx.storage.setAlarm(this.room.expires);
        return json({ room: this.room.id, ...member });
      }
      if (!this.room || this.room.ended || this.room.expires <= Date.now()) return failure('会议已结束或不存在', 410);
      this.prune();
      if (request.method === 'POST' && action === 'join') {
        const body = await this.body(request);
        const name = cleanName(body.name);
        if (Object.keys(this.members).length >= 5) return failure('会议最多 5 人；离线席位会在保留期后释放', 409);
        const member = this.addMember(name, false);
        await this.save();
        return json({ room: this.room.id, ...member });
      }
      const member = this.authenticate(request);
      if (!member) return failure('入会凭证已过期，请重新加入', 401);
      if (action === 'ws' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
        const pair = new WebSocketPair();
        const old = this.socket(member.id);
        if (old) old.close(4000, 'replaced');
        this.ctx.acceptWebSocket(pair[1]);
        pair[1].serializeAttachment({ id: member.id, window: Date.now(), count: 0 });
        member.epoch = randomId();
        if (!member.host) member.expires = Date.now() + 1800000;
        await this.save();
        this.send(pair[1], { ...this.state(), type: 'welcome', id: member.id });
        this.broadcast(this.state());
        return new Response(null, { status: 101, webSocket: pair[0] });
      }
      if (request.method === 'POST' && action === 'ice') {
        if (!member.host) {
          member.expires = Date.now() + 1800000;
          await this.save();
        }
        return await this.ice();
      }
      if (request.method === 'POST' && action === 'leave') { await this.remove(member.id); return json({ ok: true }); }
      if (request.method === 'POST' && action === 'end') {
        if (!member.host) return failure('仅主持人可结束会议', 403);
        await this.end(); return json({ ok: true });
      }
      return failure('不支持的请求', 405);
    } catch (error) { return failure(error.message || '请求失败'); }
  }
  addMember(name, host) {
    const member = { id: randomId(), token: randomId() + randomId(), name, host, muted: false, canShare: Boolean(host), expires: host ? (this.room?.expires || Date.now() + 86400000) : Date.now() + 1800000 };
    this.members[member.id] = member;
    return member;
  }
  async ice() {
    if (!this.env.TURN_KEY_ID || !this.env.TURN_API_TOKEN) return failure('Worker 尚未配置 Cloudflare TURN', 503);
    if (this.iceCache && this.iceCache.expiresAt > Date.now() + 300000) return json(this.iceCache);
    if (!this.icePending) this.icePending = (async () => {
      const response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(this.env.TURN_KEY_ID)}/credentials/generate-ice-servers`, {
        method: 'POST', headers: { authorization: `Bearer ${this.env.TURN_API_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ ttl: 86400 }), signal: AbortSignal.timeout(12000)
      });
      if (!response.ok) throw new Error('Cloudflare TURN 凭据暂时不可用，请稍后重试');
      const payload = await response.json();
      this.iceCache = { iceServers: allowedIceServers(payload.iceServers), expiresAt: Date.now() + 86400000 };
      return this.iceCache;
    })().finally(() => { this.icePending = null; });
    try { return json(await this.icePending); } catch (error) { return failure(error.message, 503); }
  }
  async webSocketMessage(socket, data) {
    const attachment = socket.deserializeAttachment();
    if (!attachment || this.socket(attachment.id) !== socket) return;
    const member = this.members[attachment.id];
    if (!member || this.room?.ended || this.room?.expires <= Date.now()) { socket.close(4001, 'expired'); return; }
    if (typeof data !== 'string' || data.length > 50000) { socket.close(1009, 'too large'); return; }
    if (Date.now() - attachment.window > 10000) { attachment.window = Date.now(); attachment.count = 0; }
    attachment.count++;
    socket.serializeAttachment(attachment);
    if (attachment.count > 400) { socket.close(1008, 'rate limited'); return; }
    try {
      const msg = validateMessage(JSON.parse(data));
      if (!member.host && member.expires < Date.now() + 900000) {
        member.expires = Date.now() + 1800000;
        await this.save();
      }
      if (msg.type === 'ping') { this.send(socket, { type: 'pong' }); return; }
      if (msg.type === 'renew') {
        if (!member.host) {
          member.expires = Date.now() + 1800000;
          await this.save();
        }
        this.send(socket, { type: 'renewed', expires: member.expires });
        return;
      }
      if (msg.type === 'signal') {
        const peer = this.socket(msg.to);
        if (peer && msg.to !== member.id) this.send(peer, { ...msg, from: member.id });
        return;
      }
      if (msg.type === 'end') { if (!member.host) throw new Error('仅主持人可结束会议'); await this.end(); return; }
      if (msg.type === 'leave') { await this.remove(member.id); return; }
      if (msg.type === 'grant-share') {
        if (!member.host) throw new Error('仅主持人可分配共享权限');
        const target = this.members[msg.target];
        if (target) {
          target.canShare = Boolean(msg.canShare);
          if (this.room.sharer === msg.target && !msg.canShare) {
            this.room.sharer = null;
            this.room.sfu = null;
          }
        }
      }
      if (msg.type === 'share-start') {
        if (!member.host && !member.canShare) throw new Error('需主持人授权后方可共享屏幕');
        if (this.room.sharer && this.room.sharer !== member.id) throw new Error('已有成员正在共享');
        this.room.sharer = member.id;
        this.room.sfu = msg.sfu || null;
      }
      if (msg.type === 'share-stop' && this.room.sharer === member.id) {
        this.room.sharer = null;
        this.room.sfu = null;
      }
      if (msg.type === 'mute') member.muted = msg.muted;
      await this.save();
      this.broadcast(this.state());
    } catch (error) { this.send(socket, { type: 'error', message: error.message }); }
  }
  async remove(id) {
    const socket = this.socket(id);
    delete this.members[id];
    if (this.room.sharer === id) {
      this.room.sharer = null;
      this.room.sfu = null;
    }
    await this.save();
    if (socket) socket.close(1000, 'left');
    this.broadcast(this.state());
  }
  async webSocketClose(socket) {
    const id = socket.deserializeAttachment()?.id;
    if (this.socket(id)) return; // A replacement connection already owns this identity.
    if (this.members[id] && !this.members[id].host) this.members[id].expires = Date.now() + 1800000;
    if (this.room?.sharer === id) {
      this.room.sharer = null;
      this.room.sfu = null;
    }
    await this.save();
    this.broadcast(this.state());
  }
  async webSocketError(socket) { socket.close(1011, 'connection failed'); await this.webSocketClose(socket); }
  async end() {
    this.room.ended = true;
    this.room.sharer = null;
    this.room.sfu = null;
    this.members = {};
    await this.save();
    this.broadcast({ type: 'ended' });
    for (const socket of this.sockets()) socket.close(1000, 'ended');
  }
  async alarm() { if (this.room) await this.end(); await this.ctx.storage.deleteAll(); }
}
