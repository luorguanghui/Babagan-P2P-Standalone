import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MeetingRoom } from '../worker/index.mjs';

async function fixture() {
  const values = new Map(); const sockets = []; let ready;
  const ctx = { storage: { get: async k => values.get(k), put: async obj => Object.entries(obj).forEach(([k,v]) => values.set(k,v)), setAlarm: async () => {}, deleteAll: async () => values.clear() }, blockConcurrencyWhile: fn => { ready = fn(); }, getWebSockets: () => sockets };
  const room = new MeetingRoom(ctx, {}); await ready;
  const id = 'a'.repeat(32);
  const request = (action, body, token) => room.fetch(new Request(`https://test/rooms/${id}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body || {}) }));
  const host = await (await request('create', { name: 'Host' })).json();
  function connect(member) { const s = { readyState: 1, messages: [], attachment: { id: member.id, count: 0, window: Date.now() }, deserializeAttachment() { return this.attachment; }, serializeAttachment(a) { this.attachment = a; }, send(v) { this.messages.push(JSON.parse(v)); }, close() { this.readyState = 3; } }; sockets.push(s); return s; }
  return { room, request, host, connect };
}
test('five seats maximum, invalid names do not reserve a seat', async () => {
  const f = await fixture();
  assert.equal((await f.request('join', { name: '' })).status, 400);
  for (let i = 0; i < 4; i++) assert.equal((await f.request('join', { name: 'Guest' })).status, 200);
  assert.equal((await f.request('join', { name: 'Sixth' })).status, 409);
});
test('guest cannot end room; host can end and credentials are invalidated', async () => {
  const f = await fixture(); const guest = await (await f.request('join', { name: 'Guest' })).json();
  assert.equal((await f.request('end', {}, guest.token)).status, 403);
  assert.equal((await f.request('ice', {}, 'bogus')).status, 401);
  assert.equal((await f.request('end', {}, f.host.token)).status, 200);
  assert.equal((await f.request('join', { name: 'Later' })).status, 410);
});
test('single sharer, source bound to socket, leave releases lock', async () => {
  const f = await fixture(); const guest = await (await f.request('join', { name: 'Guest' })).json();
  const a = f.connect(f.host), b = f.connect(guest);
  await f.room.webSocketMessage(a, JSON.stringify({ type: 'share-start' }));
  await f.room.webSocketMessage(b, JSON.stringify({ type: 'share-start' }));
  assert.equal(f.room.room.sharer, f.host.id);
  assert.equal(b.messages.at(-1).type, 'error');
  await f.room.webSocketMessage(b, JSON.stringify({ type: 'signal', from: f.host.id, to: f.host.id, description: { type: 'offer', sdp: 'v=0' } }));
  assert.equal(a.messages.at(-1).from, guest.id);
  await f.request('leave', {}, f.host.token);
  assert.equal(f.room.room.sharer, null);
});
test('disconnected guest seat expires, oversized signaling closes socket', async () => {
  const f = await fixture();
  const guest = await (await f.request('join', { name: 'Guest' })).json();
  const a = f.connect(guest);
  await f.room.webSocketMessage(a, 'x'.repeat(50001));
  assert.equal(a.readyState, 3);
  await f.room.webSocketClose(a);
  f.room.members[guest.id].expires = Date.now() - 1;
  f.room.prune();
  assert.equal(f.room.members[guest.id], undefined);
});
test('host never expires even if disconnected and past former timeout', async () => {
  const f = await fixture();
  const a = f.connect(f.host);
  await f.room.webSocketClose(a);
  f.room.members[f.host.id].expires = Date.now() - 1;
  f.room.prune();
  assert.ok(f.room.members[f.host.id]);
  assert.equal((await f.request('leave', {}, f.host.token)).status, 200);
});
test('participant automatically renews expiration via renew message and requests', async () => {
  const f = await fixture();
  const guest = await (await f.request('join', { name: 'Guest' })).json();
  const a = f.connect(guest);
  f.room.members[guest.id].expires = Date.now() + 1000;
  await f.room.webSocketMessage(a, JSON.stringify({ type: 'renew' }));
  assert.equal(a.messages.at(-1).type, 'renewed');
  assert.ok(f.room.members[guest.id].expires > Date.now() + 1000000);
});

test('host can grant and revoke screen sharing permission for guest', async () => {
  const f = await fixture();
  const guest = await (await f.request('join', { name: 'Guest' })).json();
  const a = f.connect(f.host), b = f.connect(guest);

  // Guest initially cannot share without host permission
  await f.room.webSocketMessage(b, JSON.stringify({ type: 'share-start' }));
  assert.equal(b.messages.at(-1).type, 'error');
  assert.match(b.messages.at(-1).message, /需主持人授权/);

  // Non-host cannot grant sharing permission
  await f.room.webSocketMessage(b, JSON.stringify({ type: 'grant-share', target: guest.id, canShare: true }));
  assert.equal(b.messages.at(-1).type, 'error');
  assert.match(b.messages.at(-1).message, /仅主持人/);

  // Host grants sharing permission to guest
  await f.room.webSocketMessage(a, JSON.stringify({ type: 'grant-share', target: guest.id, canShare: true }));
  assert.equal(f.room.members[guest.id].canShare, true);

  // Guest can now share successfully
  await f.room.webSocketMessage(b, JSON.stringify({ type: 'share-start' }));
  assert.equal(f.room.room.sharer, guest.id);

  // Host revoking permission while guest is sharing stops the share
  await f.room.webSocketMessage(a, JSON.stringify({ type: 'grant-share', target: guest.id, canShare: false }));
  assert.equal(f.room.members[guest.id].canShare, false);
  assert.equal(f.room.room.sharer, null);
});
