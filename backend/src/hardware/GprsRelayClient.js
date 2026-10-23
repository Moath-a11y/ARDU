/**
 * BARQ LINK — GprsRelayClient (Stage 5)
 *
 * Connects a Quectel M25 modem to the BARQ RelayServer over GPRS+TCP.
 * Reuses NodeSession (command queue), GprsEngine (PDP/TCP lifecycle),
 * and SerialTransport. Never opens a second owner of the serial port.
 *
 * Key design guarantees
 * ─────────────────────
 * 1. SEND OK ≠ delivery — DELIVERY_ACK must arrive from the server.
 * 2. DELIVERY_ACK is only sent after the application handler confirms it.
 * 3. +QIRDI read requests are serialised through the NodeSession command queue
 *    — no concurrent socket reads possible.
 * 4. Duplicate msgId protection via a bounded seen-set (max 200 entries).
 * 5. All pending promises and timers are cancelled on disconnect.
 */

'use strict';

const { EventEmitter } = require('events');
const crypto           = require('crypto');
const { GprsEngine }   = require('./GprsEngine');

// ── Helpers ─────────────────────────────────────────────────────────────────

let _seq = 0;
function newMsgId(deviceId) {
  return `${deviceId}-${Date.now()}-${(++_seq).toString(36)}`;
}

// ── Constants ────────────────────────────────────────────────────────────────

const QIRD_CONTEXT_ID    = 0;   // M25 context ID (context 0)
const QIRD_SERVICE_TCP   = 1;   // M25 service type (1 = TCP Client)
const QIRD_SESSION_ID    = 0;   // M25 session/socket index (0)
const QIRD_MAX_READ      = 512; // bytes per AT+QIRD call (M25 supports 1-1500)
const RECONNECT_DELAY_MS = 5000;
const MAX_SEEN_IDS       = 200;

class GprsRelayClient extends EventEmitter {
  /**
   * @param {import('./NodeSession').NodeSession} nodeSession
   * @param {string} relayHost
   * @param {number} relayPort
   * @param {string} deviceId   — 'ALPHA' or 'BRAVO'
   * @param {object} [opts]
   * @param {string} [opts.apn='internet']
   * @param {boolean} [opts.autoReconnect=false]
   */
  constructor(nodeSession, relayHost, relayPort, deviceId, opts = {}) {
    super();
    this._session       = nodeSession;
    this._engine        = nodeSession.gprsEngine;
    this._relayHost     = relayHost;
    this._relayPort     = relayPort;
    this._deviceId      = deviceId;
    this._apn           = opts.apn || 'internet';
    this._autoReconnect = !!opts.autoReconnect;

    this._state         = 'IDLE';        // IDLE | CONNECTING | REGISTERED | DISCONNECTING
    this._lineBuffer    = '';            // accumulates JSON Lines from QIRD reads
    this._pendingRelays = new Map();     // msgId → { resolve, reject, timer }
    this._qirdScheduled = false;         // prevents concurrent QIRD enqueue
    this._seenMsgIds    = [];            // dedup list (bounded)
    this._destroyed     = false;

    // Wire URC handler for TCP data notifications
    this._onTelemetry = (evt) => {
      if (evt.type === 'TCP_DATA_READY') {
        this._scheduleQirdRead(evt.data.len);
      } else if (evt.type === 'DISCONNECT') {
        this._handleDisconnect();
      }
    };
    this._session.on('telemetry', this._onTelemetry);
  }

  // ══════════════════════════════════════════════════════════════
  //  Public API
  // ══════════════════════════════════════════════════════════════

  /**
   * Full connection sequence:
   *   configurePdp → activatePdp → queryAssignedIp → connectTcp → sendRegister
   * Resolves when REGISTER_ACK is received from the server.
   */
  async connect(apn) {
    if (this._state !== 'IDLE') throw new Error('ALREADY_CONNECTING_OR_CONNECTED');
    this._state = 'CONNECTING';
    const useApn = apn || this._apn;

    try {
      await this._engine.configurePdp(useApn);
      await this._engine.activatePdp();
      await this._engine.queryAssignedIp();
      await this._engine.connectTcp(this._relayHost, this._relayPort);

      // Send REGISTER and wait for REGISTER_ACK
      await this._sendLine({
        type    : 'REGISTER',
        deviceId: this._deviceId,
        version : 'BARQ-RELAY-v1'
      });

      const ack = await this._waitForInboundType('REGISTER_ACK', 10000);
      this._state = 'REGISTERED';
      this.emit('registered', { deviceId: this._deviceId, serverTime: ack.serverTime });
      return ack;

    } catch (err) {
      this._state = 'IDLE';
      throw err;
    }
  }

  /**
   * Send a RELAY message to another device through the server.
   * Returns a Promise that resolves with the DELIVERY_ACK payload,
   * NOT with SEND OK. SEND OK only means the modem accepted the bytes.
   *
   * @param {string} toDeviceId
   * @param {string} payload
   * @param {number} [timeoutMs=30000]
   */
  sendRelay(toDeviceId, payload, timeoutMs = 30000, customMsgId = null) {
    if (this._state !== 'REGISTERED') return Promise.reject(new Error('NOT_REGISTERED'));

    const msgId = customMsgId || newMsgId(this._deviceId);
    const expectedHash = crypto.createHash('sha256').update(Buffer.from(payload, 'utf8')).digest('hex').slice(0, 16);

    return new Promise(async (resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingRelays.delete(msgId);
        reject(new Error(`DELIVERY_TIMEOUT_${msgId}`));
      }, timeoutMs);

      this._pendingRelays.set(msgId, { resolve, reject, timer, expectedHash });

      try {
        await this._sendLine({ type: 'RELAY', msgId, from: this._deviceId, to: toDeviceId, payload, payloadHash: expectedHash });
        // SEND OK received — this is NOT delivery confirmation
        this.emit('relay_sent', { msgId, to: toDeviceId, payloadHash: expectedHash, note: 'SEND_OK_NOT_DELIVERY_ACK' });
      } catch (err) {
        clearTimeout(timer);
        this._pendingRelays.delete(msgId);
        reject(err);
      }
    });
  }

  /**
   * Application layer calls this after successfully processing an inbound RELAY.
   * Only then is DELIVERY_ACK sent to the server.
   */
  async confirmDelivery(msgId, fromDeviceId, payloadHash = null) {
    if (this._state !== 'REGISTERED') throw new Error('NOT_REGISTERED');
    await this._sendLine({
      type       : 'DELIVERY_ACK',
      msgId,
      from       : this._deviceId,
      to         : fromDeviceId,
      status     : 'DELIVERED',
      payloadHash: payloadHash || undefined
    });
    this.emit('delivery_ack_sent', { msgId, payloadHash });
  }

  /**
   * Graceful disconnect: close TCP socket and deactivate PDP.
   */
  async disconnect() {
    this._state     = 'DISCONNECTING';
    this._destroyed = true;
    this._cancelAllPending(new Error('CLIENT_DISCONNECTED'));
    try { await this._engine.closeTcp(); } catch (_) {}
    try { await this._engine.deactivatePdp(); } catch (_) {}
    this._session.removeListener('telemetry', this._onTelemetry);
    this._state = 'IDLE';
    this.emit('disconnected');
  }

  // ══════════════════════════════════════════════════════════════
  //  Internal: AT+QIRD scheduling & reading
  // ══════════════════════════════════════════════════════════════

  /**
   * Schedule a QIRD read through the NodeSession command queue.
   * Uses a flag to prevent enqueueing multiple reads for the same burst
   * of +QIRDI notifications before the first read executes.
   * Additional +QIRDI URCs that arrive while a read is queued/executing
   * are coalesced — the next scheduled read will pick up whatever is left.
   */
  _scheduleQirdRead(hintLen) {
    if (this._qirdScheduled || this._destroyed) return;
    this._qirdScheduled = true;

    // Enqueue as a normal NodeSession command (goes through the serialize queue)
    const readLen = Math.min(Math.max(hintLen || QIRD_MAX_READ, 1), QIRD_MAX_READ);
    const cmd     = `AT+QIRD=${QIRD_CONTEXT_ID},${QIRD_SERVICE_TCP},${QIRD_SESSION_ID},${readLen}`;

    this._session.sendCommand(cmd, { expectQird: true, timeoutMs: 8000 })
      .then((result) => {
        this._qirdScheduled = false;
        // result.data is the length-delimited TCP payload only (header already stripped).
        // Do not regex-scan UART for JSON — payload may contain CR/LF or partial lines.
        if (result && result.isQird && typeof result.data === 'string' && result.data.length) {
          this._ingestQirdData(result.data);
        }
      })
      .catch((err) => {
        this._qirdScheduled = false;
        this.emit('qird_error', { error: err.message });
      });
  }

  /**
   * Feed raw bytes from a QIRD read into the JSON Lines buffer.
   * Split by \r\n and dispatch complete lines only.
   */
  _ingestQirdData(rawData) {
    this._lineBuffer += rawData;
    let nlIdx;
    while ((nlIdx = this._lineBuffer.indexOf('\r\n')) !== -1) {
      const line = this._lineBuffer.slice(0, nlIdx).trim();
      this._lineBuffer = this._lineBuffer.slice(nlIdx + 2);
      if (line) this._dispatchLine(line);
    }
  }

  // ══════════════════════════════════════════════════════════════
  //  Internal: JSON Line dispatcher
  // ══════════════════════════════════════════════════════════════

  _dispatchLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (_) {
      this.emit('parse_error', { raw: line });
      return;
    }

    switch (msg.type) {

      case 'REGISTER_ACK':
        // Handled by _waitForInboundType — emit for external listeners too
        this.emit('_inbound', msg);
        this.emit('register_ack', msg);
        break;

      case 'RELAY': {
        const { msgId, from, payload, payloadHash } = msg;
        if (!msgId) { this.emit('parse_error', { msg, reason: 'missing msgId' }); return; }

        // Dedup check
        if (this._seenMsgIds.includes(msgId)) {
          this.emit('duplicate_relay', { msgId });
          return;
        }
        this._trackSeen(msgId);

        const computedHash = crypto.createHash('sha256').update(Buffer.from(payload || '', 'utf8')).digest('hex').slice(0, 16);
        const contentMatch = !payloadHash || payloadHash === computedHash;

        // Emit to application layer — app MUST call confirmDelivery(msgId) after processing
        this.emit('relay_received', {
          msgId,
          from,
          payload,
          payloadHash: computedHash,
          contentMatch,
          confirm: () => this.confirmDelivery(msgId, from, computedHash)
        });
        break;
      }

      case 'DELIVERY_ACK': {
        const { msgId, status, payloadHash } = msg;
        this.emit('_inbound', msg);
        const pending = this._pendingRelays.get(msgId);
        if (pending) {
          clearTimeout(pending.timer);
          this._pendingRelays.delete(msgId);
          const contentMatch = !payloadHash || !pending.expectedHash || payloadHash === pending.expectedHash;
          const result = { msgId, status, payloadHash, contentMatch };
          pending.resolve(result);
          this.emit('ack_received', result);
        } else {
          this.emit('ack_received', { msgId, status, note: 'NO_PENDING_RELAY' });
        }
        break;
      }

      case 'ERROR':
        this.emit('_inbound', msg);
        this.emit('server_error', msg);
        // If there's a pending relay with this msgId, reject it
        if (msg.msgId) {
          const pending = this._pendingRelays.get(msg.msgId);
          if (pending) {
            clearTimeout(pending.timer);
            this._pendingRelays.delete(msg.msgId);
            pending.reject(new Error(`SERVER_ERROR_${msg.code}`));
          }
        }
        break;

      default:
        this.emit('unknown_message', msg);
    }
  }

  // ══════════════════════════════════════════════════════════════
  //  Internal: helpers
  // ══════════════════════════════════════════════════════════════

  /** Send a JSON Line via GprsEngine.sendPayload */
  async _sendLine(obj) {
    const line = JSON.stringify(obj) + '\r\n';
    return this._engine.sendPayload(line);
  }

  /**
   * Wait for a specific inbound message type.
   * Listens on the '_inbound' event and rejects on timeout.
   */
  _waitForInboundType(type, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeListener('_inbound', handler);
        reject(new Error(`TIMEOUT_WAITING_${type}`));
      }, timeoutMs);

      const handler = (msg) => {
        if (msg.type === type) {
          clearTimeout(timer);
          this.removeListener('_inbound', handler);
          resolve(msg);
        }
      };
      this.on('_inbound', handler);
    });
  }

  _handleDisconnect() {
    if (this._state === 'DISCONNECTING' || this._destroyed) return;
    this._cancelAllPending(new Error('TCP_DISCONNECTED'));
    this._state = 'IDLE';
    this.emit('disconnected');

    if (this._autoReconnect && !this._destroyed) {
      setTimeout(() => {
        if (!this._destroyed) {
          this._state = 'IDLE';
          this.connect(this._apn).catch((err) => this.emit('reconnect_error', { error: err.message }));
        }
      }, RECONNECT_DELAY_MS);
    }
  }

  _cancelAllPending(err) {
    for (const [msgId, p] of this._pendingRelays.entries()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this._pendingRelays.clear();
    this._qirdScheduled = false;
    this._lineBuffer    = '';
  }

  _trackSeen(msgId) {
    this._seenMsgIds.push(msgId);
    if (this._seenMsgIds.length > MAX_SEEN_IDS) {
      this._seenMsgIds.shift();
    }
  }
}

module.exports = GprsRelayClient;
