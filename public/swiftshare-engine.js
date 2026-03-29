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
    this.CHUNK_SIZE     = 512 * 1024; // 512KB chunks — faster
    this._recvBuffers   = {};
  }

  async connect() {
    return new Promise((resolve, reject) => {
      if (typeof io === 'undefined') { reject(new Error('Socket.IO not loaded')); return; }
      this.socket = io(this.serverUrl, {
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: 5,
        timeout: 10000,
      });
      this._bindEvents();
      this.socket.on('connect', () => {
        this.myId = this.socket.id;
        console.log('[Engine] Connected:', this.myId);
        resolve(this.socket.id);
      });
      this.socket.on('connect_error', (err) => {
        console.error('[Engine] Error:', err.message);
        reject(err);
      });
    });
  }

  joinHall(hallCode, name, deviceType) {
    this.hallCode = hallCode.toUpperCase();
    this.socket.emit('join-hall', { hallCode: this.hallCode, name, deviceType });
  }

  _bindEvents() {
    const s = this.socket;

    s.on('hall-joined', ({ peers }) => {
      console.log('[Engine] Hall joined, existing peers:', peers.length);
      // Notify about all existing peers
      peers.forEach(p => this.onPeerJoined({ id: p.id, name: p.name, deviceType: p.deviceType }));
    });

    s.on('peer-joined', ({ id, name, deviceType }) => {
      console.log('[Engine] New peer:', name);
      this.onPeerJoined({ id, name, deviceType });
    });

    s.on('peer-left', ({ id, name }) => {
      console.log('[Engine] Peer left:', name);
      this.onPeerLeft({ id, name });
    });

    // Receive file chunk — ArrayBuffer direct (no base64!)
    s.on('file-chunk', ({ from, fromName, fileId, fileName, filePath, fileSize, fileMime, chunkIndex, totalChunks, chunk }) => {
      if (!this._recvBuffers[fileId]) {
        this._recvBuffers[fileId] = {
          chunks: new Array(totalChunks).fill(null),
          received: 0,
          meta: { fileId, fileName, filePath, fileSize, fileMime, fromName, totalChunks }
        };
        console.log('[Engine] Receiving:', fileName, fmtSize(fileSize));
      }

      const buf = this._recvBuffers[fileId];
      if (buf.chunks[chunkIndex] === null) {
        buf.chunks[chunkIndex] = chunk;
        buf.received++;
      }

      const pct = Math.round((buf.received / totalChunks) * 100);
      this.onProgress({ fileId, pct, from, sending: false });

      if (buf.received === totalChunks) {
        console.log('[Engine] File complete:', fileName);
        // Reconstruct from base64 chunks
        const byteArrays = buf.chunks.map(c => {
          try {
            const b = atob(c);
            const arr = new Uint8Array(b.length);
            for (let i = 0; i < b.length; i++) arr[i] = b.charCodeAt(i);
            return arr;
          } catch(e) { return new Uint8Array(0); }
        });
        const blob = new Blob(byteArrays, { type: fileMime || 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        this.onFileReceived({
          name: fileName, path: filePath,
          size: fileSize, url, from: fromName
        });
        delete this._recvBuffers[fileId];
      }
    });

    s.on('send-progress', ({ fileId, pct }) => {
      this.onProgress({ fileId, pct, sending: true });
    });

    s.on('transfer-done', ({ from }) => {
      this.onTransferDone({ from });
    });

    s.on('disconnect', () => {
      console.log('[Engine] Disconnected');
    });

    s.on('reconnect', () => {
      console.log('[Engine] Reconnected');
      if (this.hallCode) {
        s.emit('join-hall', { hallCode: this.hallCode, name: window._swiftMyName || 'Device', deviceType: navigator.userAgent });
      }
    });
  }

  async sendFiles(files, targetId, onFileProgress) {
    if (!this.socket?.connected) throw new Error('Not connected to server');
    const to = targetId || 'all';

    for (const item of files) {
      const { file, path: filePath, id: fileId } = item;
      console.log('[Engine] Sending:', file.name, fmtSize(file.size));

      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      const totalChunks = Math.ceil(bytes.length / this.CHUNK_SIZE) || 1;

      for (let i = 0; i < totalChunks; i++) {
        const start = i * this.CHUNK_SIZE;
        const end = Math.min(start + this.CHUNK_SIZE, bytes.length);
        const chunkBytes = bytes.slice(start, end);

        // Fast base64 encoding
        let binary = '';
        const len = chunkBytes.length;
        for (let j = 0; j < len; j++) binary += String.fromCharCode(chunkBytes[j]);
        const chunk = btoa(binary);

        this.socket.emit('file-chunk', {
          to, fileId,
          fileName:    file.name,
          filePath:    filePath || '',
          fileSize:    file.size,
          fileMime:    file.type,
          chunkIndex:  i,
          totalChunks,
          chunk
        });

        const pct = Math.round(((i + 1) / totalChunks) * 100);
        onFileProgress?.({ id: fileId, pct });

        // Yield every 5 chunks to keep UI responsive
        if (i % 5 === 4) await new Promise(r => setTimeout(r, 0));
      }
    }

    this.socket.emit('transfer-done', { to });
  }

  disconnect() {
    this.socket?.disconnect();
  }
}

function fmtSize(b) {
  if (b >= 1e9) return (b/1e9).toFixed(2)+' GB';
  if (b >= 1e6) return (b/1e6).toFixed(1)+' MB';
  if (b >= 1e3) return (b/1e3).toFixed(0)+' KB';
  return b+' B';
}

if (typeof module !== 'undefined') module.exports = SwiftShareEngine;
else window.SwiftShareEngine = SwiftShareEngine;
