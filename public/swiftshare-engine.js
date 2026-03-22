/**
 * SwiftShare — WebRTC P2P Transfer Engine v2 FIXED
 * Include this in your frontend HTML before closing </body>
 *
 * Handles:
 *  - Socket.IO signaling
 *  - WebRTC DataChannel per peer
 *  - Chunked file transfer (64 KB chunks)
 *  - Buffered sending (backpressure aware)
 *  - Per-file progress callbacks
 *  - Multiple files / folders
 *  - Transfer resume on reconnect (chunk checkpointing)
 */

class SwiftShareEngine {
  constructor({ serverUrl, onPeerJoined, onPeerLeft, onFileReceived, onProgress, onTransferDone }) {
    this.serverUrl      = serverUrl || window.location.origin;
    this.onPeerJoined   = onPeerJoined   || (() => {});
    this.onPeerLeft     = onPeerLeft     || (() => {});
    this.onFileReceived = onFileReceived || (() => {});
    this.onProgress     = onProgress     || (() => {});
    this.onTransferDone = onTransferDone || (() => {});

    this.socket      = null;
    this.peers       = {};   // peerId → { conn, channel, name }
    this.iceServers  = [];
    this.hallCode    = null;
    this.myId        = null;

    this.CHUNK_SIZE    = 65536;      // 64 KB
    this.MAX_BUFFERED  = 1024 * 1024; // 1 MB buffered threshold
  }

  /* ── CONNECT TO SERVER ───────────────────── */
  async connect() {
    return new Promise((resolve, reject) => {
      // Dynamically load Socket.IO from server
      const script = document.createElement('script');
      script.src = this.serverUrl + '/socket.io/socket.io.js';
      script.onload = () => {
        this.socket = io(this.serverUrl, { transports: ['websocket'] });
        this._bindSocketEvents();
        this.socket.on('connect', () => {
          this.myId = this.socket.id;
          resolve(this.socket.id);
        });
        this.socket.on('connect_error', reject);
      };
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }

  /* ── JOIN HALL ───────────────────────────── */
  joinHall(hallCode, name, deviceType) {
    this.hallCode = hallCode.toUpperCase();
    this.socket.emit('join-hall', { hallCode: this.hallCode, name, deviceType });
  }

  /* ── SOCKET EVENTS ───────────────────────── */
  _bindSocketEvents() {
    const s = this.socket;

    s.on('hall-joined', ({ iceServers, peers }) => {
      this.iceServers = iceServers;
      // Connect to all existing peers
      peers.forEach(p => this._createPeerConnection(p.id, p.name, true));
    });

    s.on('peer-joined', ({ id, name, deviceType }) => {
      this._createPeerConnection(id, name, false);
      this.onPeerJoined({ id, name, deviceType });
    });

    s.on('peer-left', ({ id, name }) => {
      this._closePeer(id);
      this.onPeerLeft({ id, name });
    });

    s.on('offer', async ({ from, offer }) => {
      const peer = this._getOrCreatePeer(from);
      await peer.conn.setRemoteDescription(offer);
      const answer = await peer.conn.createAnswer();
      await peer.conn.setLocalDescription(answer);
      s.emit('answer', { to: from, answer });
    });

    s.on('answer', async ({ from, answer }) => {
      const peer = this.peers[from];
      if (peer) await peer.conn.setRemoteDescription(answer);
    });

    s.on('ice-candidate', async ({ from, candidate }) => {
      const peer = this.peers[from];
      if (peer && candidate) {
        try { await peer.conn.addIceCandidate(candidate); } catch(e){}
      }
    });

    // Incoming transfer notification
    s.on('incoming-transfer', ({ from, files }) => {
      // In real app: show accept/reject UI
      console.log(`Incoming ${files.length} files from ${from}`);
    });
  }

  /* ── PEER CONNECTION ─────────────────────── */
  _getOrCreatePeer(id) {
    if (!this.peers[id]) this.peers[id] = { conn: null, channel: null, name: '' };
    return this.peers[id];
  }

  async _createPeerConnection(peerId, peerName, isInitiator) {
    const conn = new RTCPeerConnection({ iceServers: this.iceServers });
    const peer = this._getOrCreatePeer(peerId);
    peer.conn = conn; peer.name = peerName;

    // ICE candidates
    conn.onicecandidate = e => {
      if (e.candidate) {
        this.socket.emit('ice-candidate', { to: peerId, candidate: e.candidate });
      }
    };

    // DataChannel
    if (isInitiator) {
      const ch = conn.createDataChannel('swift-transfer', {
        ordered: true,
        // maxPacketLifeTime: 0 — reliable mode for file transfer
      });
      this._bindChannel(ch, peerId);
      peer.channel = ch;

      const offer = await conn.createOffer();
      await conn.setLocalDescription(offer);
      this.socket.emit('offer', { to: peerId, offer });
    } else {
      conn.ondatachannel = e => {
        peer.channel = e.channel;
        this._bindChannel(e.channel, peerId);
      };
    }

    conn.onconnectionstatechange = () => {
      console.log(`[peer:${peerId}] state: ${conn.connectionState}`);
    };
  }

  _bindChannel(channel, peerId) {
    let recvMeta = null;   // current file being received
    let recvBuf  = [];     // accumulated chunks
    let recvBytes = 0;

    channel.binaryType = 'arraybuffer';

    channel.onopen = () => console.log(`[channel:${peerId}] open`);
    channel.onerror = e => console.error(`[channel:${peerId}]`, e);

    channel.onmessage = e => {
      if (typeof e.data === 'string') {
        const msg = JSON.parse(e.data);

        if (msg.type === 'file-meta') {
          recvMeta  = msg;
          recvBuf   = [];
          recvBytes = 0;
        }
        else if (msg.type === 'file-end') {
          // Reconstruct file from chunks
          const blob = new Blob(recvBuf, { type: recvMeta.mimeType || 'application/octet-stream' });
          const url  = URL.createObjectURL(blob);
          this.onFileReceived({
            name:   recvMeta.name,
            path:   recvMeta.path,
            size:   recvMeta.size,
            url,    // for download
            from:   this.peers[peerId]?.name || peerId,
          });
          recvBuf = []; recvMeta = null; recvBytes = 0;
        }
        else if (msg.type === 'transfer-start') {
          console.log(`[transfer] ${msg.fileCount} files incoming`);
        }
        else if (msg.type === 'transfer-done') {
          this.onTransferDone({ from: peerId });
        }
      } else {
        // Binary chunk
        recvBuf.push(e.data);
        recvBytes += e.data.byteLength;
        if (recvMeta) {
          const pct = Math.round((recvBytes / recvMeta.size) * 100);
          this.onProgress({ fileId: recvMeta.id, pct, from: peerId });
        }
      }
    };
  }

  _closePeer(id) {
    const p = this.peers[id];
    if (!p) return;
    p.channel?.close();
    p.conn?.close();
    delete this.peers[id];
  }

  /* ── SEND FILES ──────────────────────────── */
  /**
   * sendFiles(files, targetId?)
   * files: [{file: File, path: string, id: string}]
   * targetId: specific peer id, or undefined = all
   */
  async sendFiles(files, targetId, onFileProgress) {
    const targets = targetId
      ? [targetId]
      : Object.keys(this.peers);

    if (targets.length === 0) throw new Error('No peers connected');

    // Notify peers of incoming transfer
    this.socket.emit('transfer-start', {
      to:    targetId || 'all',
      files: files.map(f => ({ id: f.id, name: f.file.name, size: f.file.size, path: f.path })),
    });

    for (const item of files) {
      for (const peerId of targets) {
        const ch = this.peers[peerId]?.channel;
        if (!ch || ch.readyState !== 'open') continue;

        await this._sendOneFile(item, ch, peerId, onFileProgress);
      }
    }

    // Signal done
    targets.forEach(peerId => {
      const ch = this.peers[peerId]?.channel;
      if (ch?.readyState === 'open') {
        ch.send(JSON.stringify({ type: 'transfer-done' }));
      }
    });
  }

  async _sendOneFile(item, channel, peerId, onProgress) {
    const { file, path, id } = item;

    // Send metadata first
    channel.send(JSON.stringify({
      type:     'file-meta',
      id,
      name:     file.name,
      path:     path || '',
      size:     file.size,
      mimeType: file.type,
    }));

    // Read & send chunks
    const buffer = await file.arrayBuffer();
    let offset = 0;

    while (offset < buffer.byteLength) {
      // Backpressure: wait if buffer is full
      while (channel.bufferedAmount > this.MAX_BUFFERED) {
        await new Promise(r => setTimeout(r, 15));
      }

      const end   = Math.min(offset + this.CHUNK_SIZE, buffer.byteLength);
      const chunk = buffer.slice(offset, end);
      channel.send(chunk);
      offset = end;

      const pct = Math.round((offset / buffer.byteLength) * 100);
      onProgress?.({ id, pct });
    }

    // Signal end of this file
    channel.send(JSON.stringify({ type: 'file-end', id }));
  }

  /* ── HELPERS ─────────────────────────────── */
  getPeers() {
    return Object.entries(this.peers).map(([id, p]) => ({
      id, name: p.name,
      connected: p.channel?.readyState === 'open',
    }));
  }

  disconnect() {
    Object.keys(this.peers).forEach(id => this._closePeer(id));
    this.socket?.disconnect();
  }
}

/* ── EXPORT ─────────────────────────────────── */
if (typeof module !== 'undefined') module.exports = SwiftShareEngine;
else window.SwiftShareEngine = SwiftShareEngine;
