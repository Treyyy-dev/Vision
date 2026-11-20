// Vision game server: serves the game and relays room messages over WebSocket.
// No dependencies — runs with plain Node (18+). Start with: node server.js
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const MAX_ROOMS = 200, MAX_PLAYERS = 8, MAX_MSG = 64 * 1024;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.css': 'text/css' };
const PUBLIC = new Set(['/index.html', '/manifest.json']);

const server = http.createServer((req, res) => {
  let url = decodeURIComponent((req.url || '/').split('?')[0]);
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
  return { send: s => { if (!closed) try { socket.write(frame(s)); } catch (e) { close(); } }, ping: () => { if (!closed) try { socket.write(Buffer.from([0x89, 0])); } catch (e) {} }, close };
}

/* ---------- rooms ---------- */
const rooms = new Map();
let nextId = 1;
function newCode() { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; for (;;) { let c = ''; for (let i = 0; i < 4; i++) c += A[crypto.randomInt(A.length)]; if (!rooms.has(c)) return c; } }

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if ((req.url || '').split('?')[0] !== '/ws' || !key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);
  const me = { id: nextId++, room: null, ws: null };
  const send = (c, o) => c.ws.send(JSON.stringify(o));
  const leave = () => {
    const room = me.room; if (!room) return; me.room = null;
    room.clients.delete(me.id);
    if (room.host === me) { for (const c of room.clients.values()) { send(c, { t: 'closed' }); c.room = null; } rooms.delete(room.code); }
    else send(room.host, { t: 'left', id: me.id });
  };
  me.ws = attach(socket, raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'create') {
      if (me.room) return;
      if (rooms.size >= MAX_ROOMS) return send(me, { t: 'error', msg: 'Server is full, try again later' });
      const room = { code: newCode(), host: me, clients: new Map([[me.id, me]]) };
      rooms.set(room.code, room); me.room = room;
      send(me, { t: 'created', code: room.code, id: me.id });
    } else if (m.t === 'join') {
      if (me.room) return;
      const room = rooms.get(String(m.code || '').toUpperCase());
      if (!room) return send(me, { t: 'error', msg: 'No room with that code' });
      if (room.clients.size >= MAX_PLAYERS) return send(me, { t: 'error', msg: 'That room is full' });
      room.clients.set(me.id, me); me.room = room;
      send(me, { t: 'joined', code: room.code, id: me.id });
      send(room.host, { t: 'peer', id: me.id, info: m.info || null });
    } else if (m.t === 'to') {
      const room = me.room; if (!room) return;
      const out = { t: 'msg', from: me.id, d: m.d };
      if (m.to === 'all') { for (const c of room.clients.values()) if (c !== me) send(c, out); }
      else if (m.to === 'host') { if (room.host !== me) send(room.host, out); }
      else { const c = room.clients.get(m.to); if (c && (room.host === me || c === room.host)) send(c, out); }
    } else if (m.t === 'leave') leave();
  }, leave);
});
setInterval(() => { for (const r of rooms.values()) for (const c of r.clients.values()) c.ws.ping(); }, 25000).unref();

server.listen(PORT, () => console.log('Vision server listening on ' + PORT));
