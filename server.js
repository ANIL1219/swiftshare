/**
 * SwiftShare — Production Signaling Server
 * Node.js + Socket.IO + WebRTC STUN/TURN
 *
 * Install:  npm install express socket.io cors
 * Run:      node server.js
 * Deploy:   Railway / Fly.io / Render (free tier works)
 */

const express   = require('express');
const http      = require('http');
const { Server } = require('socket.io');
const cors      = require('cors');
const path      = require('path');

const app    = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] },
  maxHttpBufferSize: 100e6,  // 100 MB per chunk
  pingTimeout: 60000,
  pingInterval: 25000,
});

app.use(cors());
app.use(express.json());

// Serve frontend
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));

/* ─────────────────────────────────────────────
   STUN / TURN CONFIG
   Free STUN: Google's servers
   TURN: Deploy coturn OR use Metered.ca free tier
   ───────────────────────────────────────────── */
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  // Add TURN server here for NAT traversal (company networks):
  // {
  //   urls:       'turn:your-turn-server.com:3478',
  //   username:   'username',
  //   credential: 'password',
  // }
];

/* ─────────────────────────────────────────────
   HALL STATE
   halls = {
     hallCode: {
       createdAt: Date,
       peers: {
         socketId: { name, deviceType, joinedAt }
       }
     }
   }
   ───────────────────────────────────────────── */
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
function cleanupHalls() {
  const now = Date.now();
  const TTL = 4 * 60 * 60 * 1000; // 4 hours
  Object.keys(halls).forEach(code => {
    const hall = halls[code];
    if (Object.keys(hall.peers).length === 0 && (now - hall.createdAt) > TTL) {
      delete halls[code];
    }
  });
}
setInterval(cleanupHalls, 30 * 60 * 1000);

/* ─────────────────────────────────────────────
   SOCKET EVENTS
   ───────────────────────────────────────────── */
io.on('connection', (socket) => {
  console.log(`[+] Socket connected: ${socket.id}`);

  // ── JOIN HALL ─────────────────────────────
  socket.on('join-hall', ({ hallCode, name, deviceType }) => {
    const code = hallCode.toUpperCase().trim();
    if (!/^[A-Z0-9]{6}$/.test(code)) {
      socket.emit('error', { msg: 'Invalid hall code' });
      return;
    }

    const hall = getOrCreateHall(code);
    hall.peers[socket.id] = { name, deviceType, joinedAt: Date.now() };
    socket.join(code);
    socket.data.hall = code;

    // Send ICE config + current peers to joiner
    socket.emit('hall-joined', {
      hallCode:   code,
      iceServers: ICE_SERVERS,
      peers:      hallPeerList(code).filter(p => p.id !== socket.id),
    });

    // Notify others a new peer joined
    socket.to(code).emit('peer-joined', {
      id:         socket.id,
      name,
      deviceType,
    });

    console.log(`[hall:${code}] ${name} joined (${Object.keys(hall.peers).length} total)`);
  });

  // ── LEAVE HALL ────────────────────────────
  socket.on('leave-hall', () => leaveHall(socket));
  socket.on('disconnect', () => {
    console.log(`[-] Socket disconnected: ${socket.id}`);
    leaveHall(socket);
  });

  function leaveHall(sock) {
    const code = sock.data.hall;
    if (!code || !halls[code]) return;
    const name = halls[code].peers[sock.id]?.name || 'Unknown';
    delete halls[code].peers[sock.id];
    sock.leave(code);
    io.to(code).emit('peer-left', { id: sock.id, name });
    console.log(`[hall:${code}] ${name} left (${Object.keys(halls[code].peers).length} total)`);
  }

  // ── WebRTC SIGNALING ──────────────────────
  // Offer (caller → specific callee)
  socket.on('offer', ({ to, offer }) => {
    io.to(to).emit('offer', { from: socket.id, offer });
  });

  // Answer (callee → caller)
  socket.on('answer', ({ to, answer }) => {
    io.to(to).emit('answer', { from: socket.id, answer });
  });

  // ICE Candidate exchange
  socket.on('ice-candidate', ({ to, candidate }) => {
    io.to(to).emit('ice-candidate', { from: socket.id, candidate });
  });

  // ── FILE TRANSFER METADATA ────────────────
  // Sender broadcasts file list before transfer
  socket.on('transfer-start', ({ to, files }) => {
    const target = to === 'all' ? socket.data.hall : to;
    const emit   = to === 'all'
      ? socket.to(target)
      : io.to(target);

    emit.emit('incoming-transfer', {
      from:  socket.id,
      files, // [{name, size, path, type}]
    });
  });

  // Sender updates progress (optional — mainly P2P via DataChannel)
  socket.on('transfer-progress', ({ to, fileId, pct }) => {
    const target = to === 'all' ? socket.data.hall : to;
    socket.to(target).emit('file-progress', {
      from: socket.id, fileId, pct
    });
  });

  socket.on('transfer-complete', ({ to }) => {
    const target = to === 'all' ? socket.data.hall : to;
    socket.to(target).emit('transfer-done', { from: socket.id });
  });

  // ── HALL STATUS (for UI stats) ────────────
  socket.on('get-hall-info', ({ hallCode }) => {
    const code = hallCode.toUpperCase();
    const hall = halls[code];
    if (!hall) { socket.emit('hall-info', null); return; }
    socket.emit('hall-info', {
      code,
      peers:     hallPeerList(code),
      createdAt: hall.createdAt,
    });
  });
});

/* ─────────────────────────────────────────────
   HEALTH + STATS
   ───────────────────────────────────────────── */
app.get('/health', (req, res) => {
  const totalPeers = Object.values(halls).reduce((a,h) => a + Object.keys(h.peers).length, 0);
  res.json({
    status:     'ok',
    halls:      Object.keys(halls).length,
    peers:      totalPeers,
    uptime:     process.uptime(),
    timestamp:  new Date().toISOString(),
  });
});

/* ─────────────────────────────────────────────
   START
   ───────────────────────────────────────────── */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 SwiftShare signaling server running on :${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Halls:  in-memory (upgrade to Redis for multi-instance)\n`);
});
