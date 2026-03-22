const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 50e6,
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
setInterval(() => {
  const now = Date.now();
  Object.keys(halls).forEach(code => {
    const hall = halls[code];
    if (Object.keys(hall.peers).length === 0 && (now - hall.createdAt) > 4 * 60 * 60 * 1000) delete halls[code];
  });
}, 30 * 60 * 1000);

io.on('connection', (socket) => {
  console.log('[+]', socket.id);

  socket.on('join-hall', ({ hallCode, name, deviceType }) => {
    const code = hallCode.toUpperCase().trim();
    if (!/^[A-Z0-9]{6}$/.test(code)) return;
    const hall = getOrCreateHall(code);
    hall.peers[socket.id] = { name, deviceType, joinedAt: Date.now() };
    socket.join(code);
    socket.data.hall = code;
    socket.data.name = name;
    socket.emit('hall-joined', { hallCode: code, peers: hallPeerList(code).filter(p => p.id !== socket.id) });
    socket.to(code).emit('peer-joined', { id: socket.id, name, deviceType });
    console.log('[hall:' + code + ']', name, 'joined (' + Object.keys(hall.peers).length + ' total)');
  });

  socket.on('disconnect', () => {
    const code = socket.data.hall;
    if (!code || !halls[code]) return;
    const name = halls[code].peers[socket.id]?.name || 'Unknown';
    delete halls[code].peers[socket.id];
    socket.leave(code);
    io.to(code).emit('peer-left', { id: socket.id, name });
    console.log('[hall:' + code + ']', name, 'left');
  });

  // FILE RELAY — file chunks go through server, no WebRTC/P2P needed!
  socket.on('file-chunk', ({ to, fileId, fileName, filePath, fileSize, fileMime, chunkIndex, totalChunks, chunk }) => {
    const code = socket.data.hall;
    if (!code) return;
    const fromName = socket.data.name || 'Unknown';
    const payload = { from: socket.id, fromName, fileId, fileName, filePath, fileSize, fileMime, chunkIndex, totalChunks, chunk };
    if (to === 'all') socket.to(code).emit('file-chunk', payload);
    else io.to(to).emit('file-chunk', payload);
    const pct = Math.round(((chunkIndex + 1) / totalChunks) * 100);
    socket.emit('send-progress', { fileId, pct });
  });

  socket.on('transfer-done', ({ to }) => {
    const code = socket.data.hall;
    if (!code) return;
    if (to === 'all') socket.to(code).emit('transfer-done', { from: socket.id });
    else io.to(to).emit('transfer-done', { from: socket.id });
  });
});

app.get('/health', (req, res) => {
  const totalPeers = Object.values(halls).reduce((a, h) => a + Object.keys(h.peers).length, 0);
  res.json({ status: 'ok', halls: Object.keys(halls).length, peers: totalPeers, uptime: process.uptime() });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('\n🚀 SwiftShare running on :' + PORT);
  console.log('   Health: http://localhost:' + PORT + '/health');
  console.log('   Mode: Socket.IO relay\n');
});
