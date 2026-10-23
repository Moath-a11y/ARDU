/**
 * BARQ LINK — RelayServer (BARQ-RELAY-v1)
 *
 * A persistent TCP relay that routes JSON-Lines messages between registered
 * devices (ALPHA, BRAVO, ...) and enforces DELIVERY_ACK confirmation.
 *
 * Backward-compatible with BARQ-CHALLENGE-v1: connections that send a raw JSON
 * object without a "type" field are routed through the original challenge path.
 *
 * Protocol details: docs/relay-protocol.md
 */

'use strict';

const net = require('net');
const { EventEmitter } = require('events');

const MAX_MSG_BYTES     = 2048;
const DELIVERY_TIMEOUT_MS = 30000;
const PROTOCOL_VERSION  = 'BARQ-RELAY-v1';

class RelayServer extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {number} [opts.port=5050]
   * @param {number} [opts.deliveryTimeoutMs=15000]
   */
  constructor(opts = {}) {
    super();
    this.port               = opts.port               ?? 5050;
    this.deliveryTimeoutMs  = opts.deliveryTimeoutMs  ?? DELIVERY_TIMEOUT_MS;

    this.server             = null;
    this.isRunning          = false;

    // deviceId -> socket (relay sessions)
    this._sessions          = new Map();

    // msgId -> { fromId, toId, timeoutHandle, resolve, reject } (pending relays)
    this._pending           = new Map();

    // Legacy challenge audit log (backward-compat)
    this.receivedChallenges = [];
    this.activeSockets      = new Set();
  }

  // ─────────────────────────────────────────────────────────────
  //  Lifecycle
  // ─────────────────────────────────────────────────────────────

  async start() {
    if (this.isRunning) return;
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => this._handleConnection(socket));
      this.server.on('error', reject);
      this.server.listen(this.port, '0.0.0.0', () => {
        this.isRunning = true;
        console.log(`[RELAY] Listening on TCP 0.0.0.0:${this.port} (BARQ-RELAY-v1 + BARQ-CHALLENGE-v1 compat)`);
        resolve();
      });
    });
  }

  async stop() {
    if (!this.isRunning || !this.server) return;

    // Cancel all pending relay timeouts
    for (const p of this._pending.values()) {
      clearTimeout(p.timeoutHandle);
      if (p.reject) p.reject(new Error('SERVER_STOPPED'));
    }
    this._pending.clear();

    for (const s of this.activeSockets) s.destroy();
    this.activeSockets.clear();
    this._sessions.clear();

    return new Promise((resolve) => {
      this.server.close(() => {
        this.isRunning = false;
        resolve();
      });
    });
  }

  // ─────────────────────────────────────────────────────────────
  //  Connection handler
  // ─────────────────────────────────────────────────────────────

  _handleConnection(socket) {
    const remoteInfo = `${socket.remoteAddress}:${socket.remotePort}`;
    this.activeSockets.add(socket);
    this.emit('connection', { remoteInfo });

    // Per-socket state
    let lineBuffer  = '';          // accumulates raw bytes until \r\n
    let deviceId    = null;        // set after REGISTER
    let isLegacy    = false;       // true when BARQ-CHALLENGE-v1 path detected
    let legacyBuf   = '';          // raw JSON accumulator for legacy clients

    // ── Clean-up helper ──────────────────────────────────────
    const cleanup = () => {
      this.activeSockets.delete(socket);
      if (deviceId && this._sessions.get(deviceId) === socket) {
        this._sessions.delete(deviceId);
        this.emit('device_offline', { deviceId });
        console.log(`[RELAY] ${deviceId} disconnected — session removed`);

        // Fail any pending relays that were waiting for this device
        for (const [msgId, p] of this._pending.entries()) {
          if (p.toId === deviceId || p.fromId === deviceId) {
            clearTimeout(p.timeoutHandle);
            this._pending.delete(msgId);
            const errMsg = { type: 'ERROR', code: 'DESTINATION_OFFLINE', msgId, message: `${deviceId} disconnected` };
            if (p.fromId !== deviceId) this._send(this._sessions.get(p.fromId), errMsg);
          }
        }
      }
      this.emit('socket_closed', { remoteInfo, deviceId });
    };

    // ── Data handler ─────────────────────────────────────────
    socket.on('data', (chunk) => {
      const raw = chunk.toString('utf8');

      if (isLegacy) {
        // Fully committed to legacy path — handle additional chunks
        legacyBuf += raw;
        const m = legacyBuf.match(/\{[\s\S]*?\}/);
        if (m) {
          try {
            const p = JSON.parse(m[0]);
            if (!p.type) this._handleLegacyChallenge(socket, remoteInfo, p, legacyBuf);
          } catch (_) {}
          legacyBuf = '';
        }
        return;
      }

      // ── Protocol detection (first data only, before REGISTER) ──
      // Key insight: BARQ-RELAY-v1 always uses \r\n framing.
      // Legacy BARQ-CHALLENGE-v1 never sends \r\n (it's a single JSON blob).
      // If the incoming buffer contains \r\n → it's relay-v1.
      // If it completes a JSON object without \r\n → it's legacy.
      lineBuffer += raw;

      if (lineBuffer.length > MAX_MSG_BYTES) {
        this._send(socket, { type: 'ERROR', code: 'MSG_TOO_LARGE', msgId: null, message: 'Message exceeds 2048 bytes' });
        socket.destroy();
        return;
      }

      // If we haven't registered yet, check whether this looks like a legacy client.
      // We only attempt legacy detection if NO \r\n is present (relay-v1 framing).
      if (!deviceId && !lineBuffer.includes('\r\n')) {
        // Might be legacy — try to parse a complete JSON object
        const m = lineBuffer.match(/\{[\s\S]*?\}/);
        if (m) {
          try {
            const parsed = JSON.parse(m[0]);
            if (!parsed.type) {
              // Confirmed legacy BARQ-CHALLENGE-v1
              isLegacy = true;
              legacyBuf = lineBuffer;
              lineBuffer = '';
              this._handleLegacyChallenge(socket, remoteInfo, parsed, legacyBuf);
              legacyBuf = '';
              return;
            }
            // Has a "type" field but no \r\n yet — wait for framing delimiter
          } catch (_) {
            // Incomplete JSON — keep buffering
          }
        }
        return; // keep buffering until we see \r\n or a complete legacy JSON
      }

      // ── BARQ-RELAY-v1 line framing ───────────────────────
      if (lineBuffer.length > MAX_MSG_BYTES) {
        this._send(socket, { type: 'ERROR', code: 'MSG_TOO_LARGE', msgId: null, message: 'Message exceeds 2048 bytes' });
        socket.destroy();
        return;
      }

      // Extract complete \r\n-terminated lines
      let nlIdx;
      while ((nlIdx = lineBuffer.indexOf('\r\n')) !== -1) {
        const line = lineBuffer.slice(0, nlIdx).trim();
        lineBuffer  = lineBuffer.slice(nlIdx + 2);
        if (!line) continue;

        let msg;
        try {
          msg = JSON.parse(line);
        } catch (_) {
          this._send(socket, { type: 'ERROR', code: 'MALFORMED', msgId: null, message: 'JSON parse failure' });
          continue;
        }

        this._dispatch(socket, remoteInfo, msg, (id) => { deviceId = id; });
      }
    });

    socket.on('close', cleanup);
    socket.on('error', (err) => {
      this.emit('socket_error', { remoteInfo, deviceId, error: err.message });
      cleanup();
    });
  }

  // ─────────────────────────────────────────────────────────────
  //  Message dispatcher (BARQ-RELAY-v1)
  // ─────────────────────────────────────────────────────────────

  _dispatch(socket, remoteInfo, msg, onRegister) {
    const { type, deviceId: dId, msgId, from, to, payload, status } = msg;

    switch (type) {

      // ── REGISTER ─────────────────────────────────────────
      case 'REGISTER': {
        if (!dId || msg.version !== PROTOCOL_VERSION) {
          return this._send(socket, { type: 'ERROR', code: 'MALFORMED', msgId: null,
            message: `REGISTER requires deviceId and version="${PROTOCOL_VERSION}"` });
        }
        if (this._sessions.has(dId) && this._sessions.get(dId) !== socket) {
          // Replace old session (reconnect scenario)
          const old = this._sessions.get(dId);
          old.destroy();
        }
        this._sessions.set(dId, socket);
        onRegister(dId);
        console.log(`[RELAY] REGISTERED: ${dId} from ${remoteInfo}`);
        this.emit('device_registered', { deviceId: dId, remoteInfo });
        this._send(socket, { type: 'REGISTER_ACK', deviceId: dId, serverTime: new Date().toISOString() });
        break;
      }

      // ── RELAY ─────────────────────────────────────────────
      case 'RELAY': {
        const currentDeviceId = [...this._sessions.entries()].find(([, s]) => s === socket)?.[0];
        if (!currentDeviceId) {
          return this._send(socket, { type: 'ERROR', code: 'NOT_REGISTERED', msgId: msgId ?? null,
            message: 'Send REGISTER first' });
        }
        if (!msgId || !to || !payload) {
          return this._send(socket, { type: 'ERROR', code: 'MALFORMED', msgId: msgId ?? null,
            message: 'RELAY requires msgId, to, payload' });
        }
        const destSocket = this._sessions.get(to);
        if (!destSocket || destSocket.destroyed) {
          return this._send(socket, { type: 'ERROR', code: 'DESTINATION_OFFLINE', msgId,
            message: `${to} is not registered` });
        }

        // Forward to destination
        const forwardMsg = { type: 'RELAY', msgId, from: currentDeviceId, to, payload, payloadHash: msg.payloadHash };
        this._send(destSocket, forwardMsg);
        console.log(`[RELAY] RELAY ${msgId} from ${currentDeviceId} -> ${to} (${payload.length} chars)`);
        this.emit('relay_forwarded', { msgId, from: currentDeviceId, to, payloadLength: payload.length });

        // Register pending delivery slot with timeout
        const timeoutHandle = setTimeout(() => {
          if (this._pending.has(msgId)) {
            this._pending.delete(msgId);
            console.log(`[RELAY] DELIVERY_TIMEOUT for ${msgId}`);
            this.emit('delivery_timeout', { msgId, from: currentDeviceId, to });
            this._send(socket, { type: 'ERROR', code: 'DELIVERY_TIMEOUT', msgId,
              message: `No DELIVERY_ACK from ${to} within ${this.deliveryTimeoutMs}ms` });
          }
        }, this.deliveryTimeoutMs);

        this._pending.set(msgId, { fromId: currentDeviceId, toId: to, timeoutHandle, fromSocket: socket });
        break;
      }

      // ── PING / HEARTBEAT ──────────────────────────────────
      case 'PING': {
        const currentDeviceId = dId || [...this._sessions.entries()].find(([, s]) => s === socket)?.[0] || 'UNKNOWN';
        this._send(socket, { type: 'PONG', deviceId: currentDeviceId, serverTime: new Date().toISOString() });
        break;
      }

      // ── DELIVERY_ACK ─────────────────────────────────────
      case 'DELIVERY_ACK': {
        if (!msgId) {
          return this._send(socket, { type: 'ERROR', code: 'MALFORMED', msgId: null, message: 'DELIVERY_ACK requires msgId' });
        }
        const pending = this._pending.get(msgId);
        if (!pending) {
          return this._send(socket, { type: 'ERROR', code: 'INVALID_MSG_ID', msgId,
            message: `No pending relay for msgId ${msgId}` });
        }

        // Verify session binding: the acknowledging socket must belong to the target device
        const currentDeviceId = [...this._sessions.entries()].find(([, s]) => s === socket)?.[0];
        if (currentDeviceId && pending.toId && currentDeviceId !== pending.toId) {
          return this._send(socket, { type: 'ERROR', code: 'UNAUTHORIZED_ACK', msgId,
            message: `Device ${currentDeviceId} cannot acknowledge message destined for ${pending.toId}` });
        }

        clearTimeout(pending.timeoutHandle);
        this._pending.delete(msgId);

        // Resolve Promise if initiated from Web Console
        if (typeof pending.resolve === 'function') {
          pending.resolve(msg);
        }

        // Forward ACK to original sender socket if exists
        if (pending.fromSocket && !pending.fromSocket.destroyed) {
          const ackMsg = {
            type: 'DELIVERY_ACK',
            msgId,
            from: from ?? currentDeviceId ?? 'UNKNOWN',
            to: pending.fromId,
            status: status ?? 'DELIVERED',
            result: msg.result,
            payloadHash: msg.payloadHash
          };
          this._send(pending.fromSocket, ackMsg);
        }

        console.log(`[RELAY] DELIVERY_ACK ${msgId}: ${pending.toId} -> ${pending.fromId} (${status || 'DELIVERED'})`);
        this.emit('delivery_confirmed', { msgId, from: from ?? currentDeviceId, to: pending.fromId, status: status || 'DELIVERED', result: msg.result });
        break;
      }

      default:
        this._send(socket, { type: 'ERROR', code: 'MALFORMED', msgId: msgId ?? null,
          message: `Unknown message type: "${type}"` });
    }
  }

  // ─────────────────────────────────────────────────────────────
  //  Legacy BARQ-CHALLENGE-v1 path
  // ─────────────────────────────────────────────────────────────

  _handleLegacyChallenge(socket, remoteInfo, parsed, rawBuf) {
    const record = {
      id: 'ch_' + Date.now(),
      receivedAt: new Date().toISOString(),
      remoteAddress: socket.remoteAddress,
      remotePort: socket.remotePort,
      payload: parsed
    };
    this.receivedChallenges.unshift(record);
    if (this.receivedChallenges.length > 50) this.receivedChallenges.pop();
    this.emit('challenge_received', record);
    this.emit('raw_inbound', { remoteInfo, raw: rawBuf });

    const responseObj = {
      correlationId : parsed.correlationId || parsed.corrId || 'UNKNOWN',
      corrId        : parsed.correlationId || parsed.corrId || 'UNKNOWN',
      nodeId        : parsed.nodeId        || 'UNKNOWN',
      status        : 'ACK_CHALLENGE_VERIFIED',
      echo          : parsed.challenge     || parsed.echo || parsed.payload || 'NO_ECHO',
      serverTime    : new Date().toISOString(),
      serverPeer    : remoteInfo
    };
    const replyStr = JSON.stringify(responseObj) + '\r\n';
    socket.write(replyStr, () => {
      this.emit('response_sent', { remoteInfo, response: responseObj });
    });
  }

  // ─────────────────────────────────────────────────────────────
  //  Utility
  // ─────────────────────────────────────────────────────────────

  _send(socket, obj) {
    if (!socket || socket.destroyed || socket.writableEnded) return;
    try {
      socket.write(JSON.stringify(obj) + '\r\n');
    } catch (e) {
      this.emit('send_error', { error: e.message });
    }
  }

  /** Returns session map snapshot { deviceId -> remoteInfo } */
  getActiveSessions() {
    const result = {};
    for (const [id, sock] of this._sessions.entries()) {
      result[id] = `${sock.remoteAddress}:${sock.remotePort}`;
    }
    return result;
  }

  /**
   * Dispatch a RELAY message directly from the Web Console to a connected device
   * and await verified DELIVERY_ACK from the device over TCP.
   */
  async sendRelayFromWeb(fromId, toId, payload, timeoutMs = 25000) {
    const destSocket = this._sessions.get(toId);
    if (!destSocket || destSocket.destroyed) {
      throw new Error(`Device ${toId} is not connected to Relay Server`);
    }

    const msgId = `${fromId}-${Date.now()}-${Math.floor(Math.random() * 1000).toString(36)}`;
    const t0 = Date.now();

    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        if (this._pending.has(msgId)) {
          this._pending.delete(msgId);
          reject(new Error(`DELIVERY_TIMEOUT: No DELIVERY_ACK from ${toId} within ${timeoutMs}ms`));
        }
      }, timeoutMs);

      this._pending.set(msgId, {
        fromId,
        toId,
        timeoutHandle,
        resolve: (ack) => {
          clearTimeout(timeoutHandle);
          this._pending.delete(msgId);
          resolve({
            id: msgId,
            from: fromId,
            to: toId,
            payload: typeof payload === 'object' ? JSON.stringify(payload) : String(payload),
            sentAt: new Date(t0).toISOString(),
            deliveredAt: new Date().toISOString(),
            status: ack.status || 'DELIVERED',
            result: ack.result || null,
            direction: `${fromId}->${toId}`,
            rttMs: Date.now() - t0,
            ack
          });
        },
        reject: (err) => {
          clearTimeout(timeoutHandle);
          this._pending.delete(msgId);
          reject(err);
        }
      });

      const forwardMsg = {
        type: 'RELAY',
        msgId,
        from: fromId,
        to: toId,
        payload: typeof payload === 'object' ? JSON.stringify(payload) : String(payload)
      };

      this._send(destSocket, forwardMsg);
      console.log(`[RELAY] RELAY (WEB) ${msgId} from ${fromId} -> ${toId}`);
      this.emit('relay_forwarded', { msgId, from: fromId, to: toId, payloadLength: forwardMsg.payload.length });
    });
  }

  /** Legacy audit log accessor (backward compat with server.js) */
  getAuditLog() {
    return [...this.receivedChallenges];
  }
}

module.exports = RelayServer;
