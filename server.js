/**
 * SwiftShare Server v5 — Production Grade
 *
 * Design decisions:
 * - Socket.IO relay (not WebRTC) — works on every network, no TURN needed
 * - Binary chunks — no base64 overhead (33% smaller on wire)
 * - Per-socket backpressure via ack callbacks
 * - Hall state includes full peer info for late joiners
 * - Name prompt on join — stored per socket
 */

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const cors   = require('cors');
const path   = require('path');

const app    = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },

  // Binary data — chunks are raw ArrayBuffer, no base64
  // Each chunk = 256KB raw = 256KB on wire (was 512KB base64 = 683KB on wire)
  maxHttpBufferSize: 512 * 1024,  // 512KB per message — enough for one chunk + header

  // Aggressive ping to detect dead connections fast
  pingTimeout:  20_000,   // 20s — if no pong in 20s, drop
  pingInterval:  8_000,   // ping every 8s

  // No compression — binary data doesn't compress, wastes CPU
  perMessageDeflate: false,
  httpCompression:   false,

  // Allow upgrade from polling to websocket
  upgradeTimeout: 10_000,
});

app.use(cors());
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── Hall State ───────────────────────────────────────────────────────────────
// halls[code] = { createdAt, peers: { socketId: { name, deviceType, joinedAt } } }
const halls = {};

function getOrCreateHall(code) {
  if (!halls[code]) halls[code] = { createdAt: Date.now(), peers: {} };
  return halls[code];
}

function hallPeers(code) {
  if (!halls[code]) return [];
  return Object.entries(halls[code].peers).map(([id, info]) => ({ id, ...info }));
}

// Clean empty halls after 4h
setInterval(() => {
  const now = Date.now();
  for (const code of Object.keys(halls)) {
    if (!Object.keys(halls[code].peers).length && now - halls[code].createdAt > 4 * 3600_000) {
      delete halls[code];
    }
  }
}, 30 * 60_000);

// ─── Connections ──────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] ${socket.id} connected`);

  // ── join-hall ──────────────────────────────────────────────────────────────
  socket.on('join-hall', ({ hallCode, name, deviceType }) => {
    if (typeof hallCode !== 'string' || typeof name !== 'string') return;
    const code = hallCode.toUpperCase().trim();
    if (!/^[A-Z0-9]{6}$/.test(code)) return;
    if (!name.trim()) return;

    // Leave current hall if any
    if (socket.data.hall) {
      const old = socket.data.hall;
      if (halls[old]?.peers[socket.id]) {
        delete halls[old].peers[socket.id];
        socket.to(old).emit('peer-left', { id: socket.id, name: socket.data.name });
        socket.leave(old);
      }
    }

    const hall = getOrCreateHall(code);
    hall.peers[socket.id] = { name: name.trim(), deviceType, joinedAt: Date.now() };

    socket.join(code);
    socket.data.hall       = code;
    socket.data.name       = name.trim();
    socket.data.deviceType = deviceType;

    // Send full peer list to new joiner (including those who joined before)
    const existingPeers = hallPeers(code).filter(p => p.id !== socket.id);
    socket.emit('hall-joined', {
      hallCode:  code,
      myId:      socket.id,
      peers:     existingPeers,
    });

    // Announce new joiner to everyone else
    socket.to(code).emit('peer-joined', {
      id:         socket.id,
      name:       name.trim(),
      deviceType,
    });

    console.log(`[hall:${code}] "${name.trim()}" joined — ${Object.keys(hall.peers).length} peer(s)`);
  });

  // ── disconnect / leave ─────────────────────────────────────────────────────
  function leaveHall() {
    const code = socket.data.hall;
    if (!code || !halls[code]) return;
    const name = halls[code].peers[socket.id]?.name || 'Unknown';
    delete halls[code].peers[socket.id];
    socket.leave(code);
    io.to(code).emit('peer-left', { id: socket.id, name });
    console.log(`[hall:${code}] "${name}" left — ${Object.keys(halls[code]?.peers || {}).length} peer(s)`);
    socket.data.hall = null;
  }

  socket.on('leave-hall', leaveHall);
  socket.on('disconnect', (reason) => {
    console.log(`[-] ${socket.id} disconnected: ${reason}`);
    leaveHall();
  });

  // ── File chunk relay (binary, with ack for backpressure) ──────────────────
  // data = { to, meta: {fileId,fileName,filePath,fileSize,fileMime,chunkIndex,totalChunks}, chunk: Buffer }
  socket.on('file-chunk', ({ to, meta, chunk }, ack) => {
    const code = socket.data.hall;
    if (!code) { ack?.({ ok: false, reason: 'not in hall' }); return; }

    const payload = {
      from:     socket.id,
      fromName: socket.data.name,
      meta,
      chunk,    // raw Buffer — Socket.IO handles binary transparently
    };

    if (to === 'all') {
      // Broadcast to all in hall except sender
      socket.to(code).emit('file-chunk', payload);
    } else {
      io.to(to).emit('file-chunk', payload);
    }

    // Ack immediately — sender uses this for flow control
    ack?.({ ok: true });
  });

  // ── Transfer signals ───────────────────────────────────────────────────────
  socket.on('transfer-start', ({ to, meta }) => {
    const code = socket.data.hall;
    if (!code) return;
    const payload = { from: socket.id, fromName: socket.data.name, meta };
    if (to === 'all') socket.to(code).emit('transfer-start', payload);
    else io.to(to).emit('transfer-start', payload);
  });

  socket.on('transfer-done', ({ to }) => {
    const code = socket.data.hall;
    if (!code) return;
    const payload = { from: socket.id, fromName: socket.data.name };
    if (to === 'all') socket.to(code).emit('transfer-done', payload);
    else io.to(to).emit('transfer-done', payload);
  });
});

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  const hallList = Object.entries(halls).map(([code, h]) => ({
    code,
    peers: Object.keys(h.peers).length,
    names: Object.values(h.peers).map(p => p.name),
  }));
  res.json({
    status:  'ok',
    halls:   Object.keys(halls).length,
    peers:   hallList.reduce((a, h) => a + h.peers, 0),
    uptime:  Math.round(process.uptime()),
    hallList,
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀  SwiftShare  →  http://localhost:${PORT}`);
  console.log(`    Health: http://localhost:${PORT}/health\n`);
});
