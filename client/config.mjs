export const DEFAULT_WORKER = 'https://p2p.babagan.cloud';
export function workerUrl(value) {
  const url = new URL(value.trim());
  const local = ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('请输入 HTTPS Worker 地址');
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Worker 地址只需域名，不含路径或密码');
  return url.origin === 'https://babagan-p2p.1312479965.workers.dev' ? DEFAULT_WORKER : url.origin;
}
export function parseInvitation(value, fallback) {
  const raw = value.trim();
  if (/^[a-f0-9]{32}$/.test(raw)) return { worker: workerUrl(fallback), room: raw };
  const url = new URL(raw);
  const match = url.pathname.match(/^\/room\/([a-f0-9]{32})$/);
  if (!match || url.search || url.hash) throw new Error('请粘贴完整邀请或 32 位房间码');
  return { worker: workerUrl(url.origin), room: match[1] };
}
