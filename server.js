// Vision game server: serves the game, matches players together and referees each match.
// No dependencies — runs with plain Node (18+). Start with: node server.js
//
// A match is run by loading the game's own script from index.html without a screen
// (drawing calls go to a do-nothing stand-in), so the server and the players always
// share exactly the same rules. Players send inputs; the server sends everyone the same state.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const QUEUE_WAIT_MS = +process.env.QUEUE_WAIT_MS || 10000; // countdown once two players are searching
const TICK_MS = 25, MAX_MATCHES = 12, MAX_MSG = 16 * 1024, MATCH_LIMIT_MS = 15 * 60000, OVER_LINGER_MS = 15000;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.css': 'text/css' };
const PUBLIC = new Set(['/index.html', '/manifest.json']);

const server = http.createServer((req, res) => {
  let url;
  try { url = decodeURIComponent((req.url || '/').split('?')[0]); } catch (e) { res.writeHead(400); return res.end(); }
  if (url === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
  if (url === '/') url = '/index.html';
  const allowed = PUBLIC.has(url) || /^\/icons\/[\w.-]+$/.test(url);
  const file = path.join(ROOT, url);
  if (!allowed || !file.startsWith(ROOT)) { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
});

/* ---------- the game, run without a screen ---------- */
const GAME_JS = (() => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const all = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  return new vm.Script(all[all.length - 1][1], { filename: 'vision-game.js' });
})();
function makeSim(out) {
  // U swallows every drawing / page call and answers 0 when used as a number.
  const U = new Proxy(function () {}, { get: (t, k) => k === Symbol.toPrimitive ? () => 0 : U, apply: () => U, construct: () => U, set: () => true });
  class V3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
    lerp(v, a) { this.x += (v.x - this.x) * a; this.y += (v.y - this.y) * a; this.z += (v.z - this.z) * a; return this; }
    multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
    length() { return Math.hypot(this.x, this.y, this.z); }
    normalize() { const l = this.length() || 1; this.x /= l; this.y /= l; this.z /= l; return this; }
  }
  let raf = null, now = 0;
  const timers = new Set();
  const head = { out, api: null };
  const sb = {
    console, __HEADLESS: head,
    setTimeout: (f, ms) => { const h = setTimeout(() => { timers.delete(h); try { f(); } catch (e) {} }, ms); timers.add(h); return h; },
    clearTimeout: h => { timers.delete(h); clearTimeout(h); },
    THREE: new Proxy({}, { get: (t, k) => k === 'Vector3' ? V3 : U }),
    document: { body: U, activeElement: null, querySelectorAll: () => [], querySelector: () => null, getElementById: () => U, createElement: () => U },
    addEventListener: () => {}, innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1,
    matchMedia: () => ({ matches: false }), getComputedStyle: () => ({}), navigator: { getGamepads: () => [] },
    location: { protocol: 'http:', host: 'localhost' }, performance: { now: () => now },
    requestAnimationFrame: f => { raf = f; },
  };
  sb.window = sb;
  vm.createContext(sb);
  GAME_JS.runInContext(sb, { timeout: 8000 });
  return {
    api: head.api,
    tick(ms) { now += ms; if (raf) { const f = raf; f(now); } },
    stop() { raf = null; for (const h of timers) clearTimeout(h); timers.clear(); },
  };
}

/* ---------- minimal WebSocket ---------- */
function frame(str) {
  const p = Buffer.from(str), n = p.length;
  const h = n < 126 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.from([0x81, 126, n >> 8, n & 255]) : (() => { const b = Buffer.alloc(10); b[0] = 0x81; b[1] = 127; b.writeBigUInt64BE(BigInt(n), 2); return b; })();
  return Buffer.concat([h, p]);
}
function attach(socket, onMessage, onClose) {
  let buf = Buffer.alloc(0), parts = [], closed = false;
  const close = () => { if (closed) return; closed = true; try { socket.destroy(); } catch (e) {} onClose(); };
  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    if (buf.length > MAX_MSG * 2) return close();
    for (;;) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80, op = buf[0] & 0x0f, masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > MAX_MSG || !masked) return close();
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4), data = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < len; i++) data[i] ^= mask[i & 3];
      buf = buf.subarray(off + 4 + len);
      if (op === 8) return close();
      if (op === 9) { try { socket.write(Buffer.concat([Buffer.from([0x8a, data.length]), data])); } catch (e) {} continue; }
      if (op === 10) continue;
      parts.push(data);
      if (fin) { const msg = Buffer.concat(parts).toString('utf8'); parts = []; onMessage(msg); }
      else if (parts.reduce((a, b) => a + b.length, 0) > MAX_MSG) return close();
    }
  });
  socket.on('close', close); socket.on('error', close);
  return {
    sendRaw: b => { if (!closed) try { socket.write(b); } catch (e) { close(); } },
    ping: () => { if (!closed) try { socket.write(Buffer.from([0x89, 0])); } catch (e) {} },
    close,
  };
}

/* ---------- matchmaking ---------- */
const clients = new Set(), queue = [], matches = new Set();
let nextId = 1, qTimer = null, qDeadline = 0;
const send = (c, o) => c.ws.sendRaw(frame(JSON.stringify(o)));
const cleanInfo = inf => { inf = inf && typeof inf === 'object' ? inf : {}; return { name: String(inf.name || 'Player').slice(0, 12), w: String(inf.w || 'kaito').slice(0, 20), s: String(inf.s || 'iron').slice(0, 20) }; };

function qBroadcast() {
  const eta = qTimer ? Math.max(0, Math.ceil((qDeadline - Date.now()) / 1000)) : null;
  for (const c of queue) send(c, { t: 'q', n: queue.length, eta });
}
function qCheck() {
  if (queue.length >= 8) return launch();
  if (queue.length >= 2 && !qTimer) { qDeadline = Date.now() + QUEUE_WAIT_MS; qTimer = setTimeout(launch, QUEUE_WAIT_MS); }
  if (queue.length < 2 && qTimer) { clearTimeout(qTimer); qTimer = null; }
  qBroadcast();
}
function launch() {
  if (qTimer) { clearTimeout(qTimer); qTimer = null; }
  if (queue.length < 2) return qCheck();
  if (matches.size >= MAX_MATCHES) { for (const c of queue) send(c, { t: 'error', msg: 'All matches are full right now — try again in a minute' }); queue.length = 0; return; }
  const group = queue.splice(0, 8);
  startMatch(group);
  if (queue.length) qCheck();
}
function startMatch(group) {
  const M = { clients: new Set(group), t0: Date.now(), overAt: 0, sim: null, iv: null };
  const slots = [null, null, null, null, null, null, null, null];
  group.forEach((c, i) => { c.slot = i % 2 === 0 ? i / 2 : 4 + (i - 1) / 2; slots[c.slot] = Object.assign({ id: c.id }, c.info); });
  try {
    M.sim = makeSim(d => {
      if (!d || d.k !== 's') return;
      const buf = frame(JSON.stringify({ t: 's', d }));
      for (const c of M.clients) c.ws.sendRaw(buf);
      if (d.m === 'over' && !M.overAt) M.overAt = Date.now();
    });
    M.sim.api.start(slots);
  } catch (e) {
    console.error('match failed to start', e);
    for (const c of group) send(c, { t: 'error', msg: 'The match could not start — try again' });
    return;
  }
  matches.add(M);
  for (const c of group) { c.match = M; send(c, { t: 'match', slot: c.slot, sl: slots }); }
  M.iv = setInterval(() => {
    try { M.sim.tick(TICK_MS); } catch (e) { console.error('match error', e); return endMatch(M); }
    if ((M.overAt && Date.now() - M.overAt > OVER_LINGER_MS) || Date.now() - M.t0 > MATCH_LIMIT_MS) endMatch(M);
  }, TICK_MS);
  console.log('match started with', group.length, 'players;', matches.size, 'running');
}
function endMatch(M) {
  if (!matches.has(M)) return;
  matches.delete(M); clearInterval(M.iv); M.sim.stop();
  for (const c of M.clients) { c.match = null; send(c, { t: 'end' }); }
  M.clients.clear();
}
function leaveAll(c) {
  const i = queue.indexOf(c);
  if (i >= 0) { queue.splice(i, 1); qCheck(); }
  const M = c.match;
  if (M) { c.match = null; M.clients.delete(c); try { M.sim.api.drop(c.slot); } catch (e) {} if (!M.clients.size) endMatch(M); }
}

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if ((req.url || '').split('?')[0] !== '/ws' || !key || clients.size >= 200) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);
  const me = { id: nextId++, ws: null, info: cleanInfo(null), match: null, slot: -1, n: 0, sec: 0 };
  me.ws = attach(socket, raw => {
    const sec = Math.floor(Date.now() / 1000);
    if (sec !== me.sec) { me.sec = sec; me.n = 0; }
    if (++me.n > 150) return; // more than a player could ever send
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'in') { if (me.match) try { me.match.sim.api.input(me.slot, m); } catch (e) {} }
    else if (m.t === 'queue') { if (me.match || queue.includes(me)) return; me.info = cleanInfo(m.info); queue.push(me); qCheck(); }
    else if (m.t === 'info') { me.info = cleanInfo(m.info); }
    else if (m.t === 'leave') leaveAll(me);
  }, () => { clients.delete(me); leaveAll(me); });
  clients.add(me);
});
setInterval(() => { if (queue.length) qBroadcast(); }, 1000).unref();
setInterval(() => { for (const c of clients) c.ws.ping(); }, 25000).unref();

server.listen(PORT, () => console.log('Vision server listening on ' + PORT));
