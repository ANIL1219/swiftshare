const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 100e6, // 100MB per message
  pingTimeout: 60000,
  pingInterval: 25000,
});

app.use(cors());
app.use(express.json());
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

// Cleanup empty halls after 4 hours
setInterval(() => {
  const now = Date.now();
  Object.keys(halls).forEach(code => {
    if (Object.keys(halls[code].peers).length === 0 && now - halls[code].createdAt > 4*60*60*1000) {
      delete halls[code];
    }
  });
}, 30 * 60 * 1000);

io.on('connection', (socket) => {
  console.log('[+]', socket.id);

  socket.on('join-hall', ({ hallCode, name, deviceType }) => {
    const code = hallCode.toUpperCase().trim();
    if (!/^[A-Z0-9]{6}$/.test(code)) return;

    // If already in a hall, leave it first
    if (socket.data.hall) {
      const oldCode = socket.data.hall;
      if (halls[oldCode]) {
        delete halls[oldCode].peers[socket.id];
        socket.to(oldCode).emit('peer-left', { id: socket.id, name: socket.data.name });
        socket.leave(oldCode);
      }
    }

    const hall = getOrCreateHall(code);
    hall.peers[socket.id] = { name, deviceType, joinedAt: Date.now() };
    socket.join(code);
    socket.data.hall = code;
    socket.data.name = name;

    // Send existing peers list to new joiner
    const existingPeers = hallPeerList(code).filter(p => p.id !== socket.id);
    socket.emit('hall-joined', { hallCode: code, peers: existingPeers });

    // Notify all existing peers about new joiner
    socket.to(code).emit('peer-joined', { id: socket.id, name, deviceType });

    console.log(`[hall:${code}] ${name} joined (${Object.keys(hall.peers).length} total)`);
  });

  socket.on('disconnect', () => {
    const code = socket.data.hall;
    if (!code || !halls[code]) return;
    const name = halls[code].peers[socket.id]?.name || 'Unknown';
    delete halls[code].peers[socket.id];
    socket.leave(code);
    io.to(code).emit('peer-left', { id: socket.id, name });
    console.log(`[hall:${code}] ${name} left (${Object.keys(halls[code]?.peers||{}).length} total)`);
  });

  // FILE RELAY — fast relay through server
  socket.on('file-chunk', (data) => {
    const code = socket.data.hall;
    if (!code) return;
    data.from = socket.id;
    data.fromName = socket.data.name || 'Unknown';

    if (data.to === 'all') {
      // Send to ALL peers in hall except sender — true multi-device!
      socket.to(code).emit('file-chunk', data);
    } else {
      io.to(data.to).emit('file-chunk', data);
    }

    // Send progress back to sender
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
  const hallList = Object.entries(halls).map(([code, h]) => ({
    code, peers: Object.keys(h.peers).length,
    names: Object.values(h.peers).map(p => p.name)
  }));
  res.json({ status: 'ok', halls: Object.keys(halls).length, peers: totalPeers, hallList, uptime: process.uptime() });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 SwiftShare running on :${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Mode: Multi-device Socket.IO relay\n`);
});
