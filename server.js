const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const cors   = require('cors');
const path   = require('path');

const app    = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 5 * 1024 * 1024,   // 5MB per message — chunks are ~700KB each
  pingTimeout:  120_000,   // 2 min — large file transfers block pings
  pingInterval:  30_000,
  upgradeTimeout: 10_000,
  perMessageDeflate: false,  // base64 data doesn't compress — wastes CPU
  httpCompression:   false,
});

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const halls = {};

function getOrCreateHall(code) {
  if (!halls[code]) halls[code] = { createdAt: Date.now(), peers: {} };
  return halls[code];
}
function hallPeerList(code) {
  const hall = halls[code];
  if (!hall) return [];
  return Object.entries(hall.peers).map(([id, info]) => ({ id, ...info }));
}

// Clean up empty halls older than 4h
setInterval(() => {
  const now = Date.now();
  for (const code of Object.keys(halls)) {
    const hall = halls[code];
    if (Object.keys(hall.peers).length === 0 && now - hall.createdAt > 4 * 60 * 60 * 1000) {
      delete halls[code];
      console.log(`[hall:${code}] cleaned up`);
    }
  }
}, 30 * 60 * 1000);

io.on('connection', (socket) => {
  console.log('[+]', socket.id);

  socket.on('join-hall', ({ hallCode, name, deviceType }) => {
    if (typeof hallCode !== 'string') return;
    const code = hallCode.toUpperCase().trim();
    if (!/^[A-Z0-9]{6}$/.test(code)) return;

    if (socket.data.hall) {
      const old = socket.data.hall;
      if (halls[old]) {
        delete halls[old].peers[socket.id];
        socket.to(old).emit('peer-left', { id: socket.id, name: socket.data.name });
        socket.leave(old);
      }
    }

    const hall = getOrCreateHall(code);
    hall.peers[socket.id] = { name, deviceType, joinedAt: Date.now() };
    socket.join(code);
    socket.data.hall       = code;
    socket.data.name       = name;
    socket.data.deviceType = deviceType;

    const existingPeers = hallPeerList(code).filter(p => p.id !== socket.id);
    socket.emit('hall-joined', { hallCode: code, peers: existingPeers });
    socket.to(code).emit('peer-joined', { id: socket.id, name, deviceType });

    console.log(`[hall:${code}] "${name}" joined — ${Object.keys(hall.peers).length} peer(s)`);
  });

  socket.on('disconnect', (reason) => {
    const code = socket.data.hall;
    if (!code || !halls[code]) return;
    const name = halls[code].peers[socket.id]?.name || 'Unknown';
    delete halls[code].peers[socket.id];
    socket.leave(code);
    io.to(code).emit('peer-left', { id: socket.id, name });
    console.log(`[hall:${code}] "${name}" left (${reason}) — ${Object.keys(halls[code]?.peers || {}).length} peer(s)`);
  });

  // Relay with ack-based flow control — sender waits for ack before next chunk
  socket.on('file-chunk', (data, ack) => {
    const code = socket.data.hall;
    if (!code) { ack?.({ ok: false }); return; }

    data.from     = socket.id;
    data.fromName = socket.data.name || 'Unknown';

    if (data.to === 'all') socket.to(code).emit('file-chunk', data);
    else io.to(data.to).emit('file-chunk', data);

    // Ack so sender can pace — backpressure
    ack?.({ ok: true });

    const pct = Math.round(((data.chunkIndex + 1) / data.totalChunks) * 100);
    socket.emit('send-progress', { fileId: data.fileId, pct });
  });

  socket.on('transfer-done', ({ to }) => {
    const code = socket.data.hall;
    if (!code) return;
    const payload = { from: socket.id, fromName: socket.data.name };
    if (to === 'all') socket.to(code).emit('transfer-done', payload);
    else io.to(to).emit('transfer-done', payload);
  });
});

app.get('/health', (req, res) => {
  const totalPeers = Object.values(halls).reduce((a, h) => a + Object.keys(h.peers).length, 0);
  res.json({
    status: 'ok',
    halls:  Object.keys(halls).length,
    peers:  totalPeers,
    uptime: process.uptime(),
    hallList: Object.entries(halls).map(([code, h]) => ({
      code, peers: Object.keys(h.peers).length,
      names: Object.values(h.peers).map(p => p.name),
    })),
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀  SwiftShare  →  http://localhost:${PORT}`);
  console.log(`    Health     →  http://localhost:${PORT}/health\n`);
});
