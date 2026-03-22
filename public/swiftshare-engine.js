/**
 * SwiftShare Engine v3 — Socket.IO Relay (No WebRTC/P2P)
 * Files go through server — works on ALL networks, no TURN needed!
 */
class SwiftShareEngine {
  constructor({ serverUrl, onPeerJoined, onPeerLeft, onFileReceived, onProgress, onTransferDone }) {
    this.serverUrl      = serverUrl || window.location.origin;
    this.onPeerJoined   = onPeerJoined   || (() => {});
    this.onPeerLeft     = onPeerLeft     || (() => {});
    this.onFileReceived = onFileReceived || (() => {});
    this.onProgress     = onProgress     || (() => {});
    this.onTransferDone = onTransferDone || (() => {});
    this.socket         = null;
    this.hallCode       = null;
    this.myId           = null;
    this.CHUNK_SIZE     = 256 * 1024; // 256KB chunks
    this._recvBuffers   = {}; // fileId -> {chunks, received, meta}
  }

  async connect() {
    return new Promise((resolve, reject) => {
      if (typeof io === 'undefined') { reject(new Error('Socket.IO not loaded')); return; }
      this.socket = io(this.serverUrl, { transports: ['websocket', 'polling'] });
      this._bindEvents();
      this.socket.on('connect', () => { this.myId = this.socket.id; resolve(this.socket.id); });
      this.socket.on('connect_error', reject);
    });
  }

  joinHall(hallCode, name, deviceType) {
    this.hallCode = hallCode.toUpperCase();
    this.socket.emit('join-hall', { hallCode: this.hallCode, name, deviceType });
  }

  _bindEvents() {
    const s = this.socket;

    s.on('hall-joined', ({ peers }) => {
      console.log('[Engine] Hall joined, peers:', peers.length);
    });

    s.on('peer-joined', ({ id, name, deviceType }) => {
      console.log('[Engine] Peer joined:', name);
      this.onPeerJoined({ id, name, deviceType });
    });

    s.on('peer-left', ({ id, name }) => {
      this.onPeerLeft({ id, name });
    });

    // Receive file chunk
    s.on('file-chunk', ({ from, fromName, fileId, fileName, filePath, fileSize, fileMime, chunkIndex, totalChunks, chunk }) => {
      if (!this._recvBuffers[fileId]) {
        this._recvBuffers[fileId] = {
          chunks:   new Array(totalChunks),
          received: 0,
          meta:     { fileId, fileName, filePath, fileSize, fileMime, fromName, totalChunks }
        };
      }
      const buf = this._recvBuffers[fileId];
      buf.chunks[chunkIndex] = chunk;
      buf.received++;
      const pct = Math.round((buf.received / totalChunks) * 100);
      this.onProgress({ fileId, pct, from });

      if (buf.received === totalChunks) {
        // All chunks received — reconstruct file
        const byteArrays = buf.chunks.map(c => {
          const b = atob(c);
          const arr = new Uint8Array(b.length);
          for (let i = 0; i < b.length; i++) arr[i] = b.charCodeAt(i);
          return arr;
        });
        const blob = new Blob(byteArrays, { type: fileMime || 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        this.onFileReceived({ name: fileName, path: filePath, size: fileSize, url, from: fromName });
        delete this._recvBuffers[fileId];
      }
    });

    s.on('send-progress', ({ fileId, pct }) => {
      this.onProgress({ fileId, pct, sending: true });
    });

    s.on('transfer-done', ({ from }) => {
      this.onTransferDone({ from });
    });
  }

  async sendFiles(files, targetId, onFileProgress) {
    if (!this.socket) throw new Error('Not connected');
    const to = targetId || 'all';

    for (const item of files) {
      const { file, path: filePath, id: fileId } = item;
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      const totalChunks = Math.ceil(bytes.length / this.CHUNK_SIZE);

      for (let i = 0; i < totalChunks; i++) {
        const start = i * this.CHUNK_SIZE;
        const end = Math.min(start + this.CHUNK_SIZE, bytes.length);
        const chunkBytes = bytes.slice(start, end);

        // Convert to base64 for socket transmission
        let binary = '';
        chunkBytes.forEach(b => binary += String.fromCharCode(b));
        const chunk = btoa(binary);

        this.socket.emit('file-chunk', {
          to,
          fileId,
          fileName:   file.name,
          filePath:   filePath || '',
          fileSize:   file.size,
          fileMime:   file.type,
          chunkIndex: i,
          totalChunks,
          chunk
        });

        const pct = Math.round(((i + 1) / totalChunks) * 100);
        onFileProgress?.({ id: fileId, pct });

        // Small delay to prevent overwhelming the server
        if (i % 10 === 0) await new Promise(r => setTimeout(r, 10));
      }
    }

    this.socket.emit('transfer-done', { to });
  }

  disconnect() {
    this.socket?.disconnect();
  }
}

if (typeof module !== 'undefined') module.exports = SwiftShareEngine;
else window.SwiftShareEngine = SwiftShareEngine;
