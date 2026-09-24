import assert from 'node:assert/strict';
const endpoint = process.env.WORKER_URL || 'http://127.0.0.1:8787';
const api = async (path, body, token) => {
  const r = await fetch(endpoint + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body || {}) });
  return { status: r.status, value: await r.json() };
};
const created = await api('/rooms', { name: 'Smoke host' });
assert.equal(created.status, 200, JSON.stringify(created.value));
const host = created.value;
const join = await api(`/rooms/${host.room}/join`, { name: 'Smoke guest' });
assert.equal(join.status, 200);
const guest = join.value;
function socket(member) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${endpoint.replace(/^http/, 'ws')}/rooms/${host.room}/ws?token=${member.token}`);
    const messages = [];
    const timeout = setTimeout(() => reject(new Error('welcome timeout')), 12000);
    ws.onerror = reject;
    ws.onmessage = e => { const value = JSON.parse(e.data); messages.push(value); if (value.type === 'welcome') { clearTimeout(timeout); resolve({ ws, messages }); } };
  });
}
let a, b;
try {
  a = await socket(host); b = await socket(guest);
  b.ws.send(JSON.stringify({ type: 'signal', to: host.id, from: host.id, description: { type: 'offer', sdp: 'v=0' } }));
  for (let i=0; i<40 && !a.messages.some(m => m.type === 'signal'); i++) await new Promise(r => setTimeout(r, 50));
  assert.equal(a.messages.find(m => m.type === 'signal').from, guest.id);
  assert.equal((await api(`/rooms/${host.room}/end`, {}, guest.token)).status, 403);
  assert.equal((await api(`/rooms/${host.room}/ice`, {}, 'invalid')).status, 401);
  if (process.env.REQUIRE_TURN === '1') {
    const credentials = await api(`/rooms/${host.room}/ice`, {}, host.token);
    assert.equal(credentials.status, 200);
    assert.ok(credentials.value.iceServers.some(s => s.urls.some(u => u.startsWith('turn:'))));
    console.log('Cloudflare short-lived credentials verified (values not logged).');
  }
  console.log('Worker integration: create, join, real WebSocket routing, source binding, authorization PASS');
} finally {
  await api(`/rooms/${host.room}/end`, {}, host.token);
  a?.ws.close(); b?.ws.close();
}
