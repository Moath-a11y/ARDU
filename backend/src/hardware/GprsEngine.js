/**
 * BARQ LINK — GprsEngine
 * Dedicated GPRS & TCP/IP Protocol Engine for Quectel M25 (Firmware M25MAR01A12).
 * Handles the complete lifecycle: PDP Config -> Activation -> IP Retrieval -> TCP Connect -> Send/Receive -> Teardown.
 */

const { EventEmitter } = require('events');

const GPRS_STATES = {
  PACKET_ATTACHED: 'PACKET_ATTACHED',
  PDP_CONFIGURED: 'PDP_CONFIGURED',
  PDP_ACTIVATING: 'PDP_ACTIVATING',
  PDP_ACTIVE: 'PDP_ACTIVE',
  IP_ASSIGNED: 'IP_ASSIGNED',
  TCP_CONNECTING: 'TCP_CONNECTING',
  TCP_CONNECTED: 'TCP_CONNECTED',
  APPLICATION_VERIFIED: 'APPLICATION_VERIFIED',
  DEGRADED: 'DEGRADED',
  ERROR: 'ERROR'
};

class GprsEngine extends EventEmitter {
  constructor(nodeSession) {
    super();
    this.session = nodeSession;
    this.nodeId = nodeSession.nodeId;
    this.gprsState = GPRS_STATES.PACKET_ATTACHED;
    this.apn = null;
    this.assignedIp = null;
    this.socketInfo = { host: null, port: null, isConnected: false };
    this.evidenceLog = [];

    // Attach to session events
    this.session.on('telemetry', (evt) => {
      if (evt.type === 'TCP_STATE') {
        this._recordEvidence('URC_TCP_STATE', evt.data.state);
        this.emit('tcp_state', { nodeId: this.nodeId, state: evt.data.state });
      } else if (evt.type === 'DISCONNECT') {
        this._recordEvidence('URC_DISCONNECT', evt.data.type);
        this.socketInfo.isConnected = false;
        this._setState(GPRS_STATES.DEGRADED, `Remote/Network disconnect: ${evt.data.type}`);
      }
    });
  }

  _recordEvidence(action, details) {
    const entry = {
      timestamp: new Date().toISOString(),
      nodeId: this.nodeId,
      action,
      details
    };
    this.evidenceLog.unshift(entry);
    if (this.evidenceLog.length > 100) this.evidenceLog.pop();
    this.emit('evidence', entry);
    return entry;
  }

  _setState(newState, reason = '') {
    if (this.gprsState === newState) return;
    const oldState = this.gprsState;
    this.gprsState = newState;
    this._recordEvidence('STATE_TRANSITION', `${oldState} -> ${newState} (${reason})`);
    this.emit('state_change', { nodeId: this.nodeId, oldState, newState, reason });
  }

  /**
   * Step 1: Configure PDP Parameters with User-Confirmed APN
   */
  async _pause(ms) {
    await new Promise((r) => setTimeout(r, ms));
  }

  async _tryAt(timeoutMs = 2500) {
    const res = await this.session.sendCommand('AT', { timeoutMs });
    this._recordEvidence('MODEM_ALIVE_CHECK', res.raw || 'OK');
    return true;
  }

  /**
   * Recover a silent/stuck M25: drain parser, poke AT, escape transparent mode, close TCP.
   */
  async _recoverModem() {
    if (typeof this.session.recoverUart === 'function') {
      this.session.recoverUart();
    }

    for (let i = 1; i <= 3; i++) {
      try {
        await this._tryAt(2500);
        return true;
      } catch (e) {
        this._recordEvidence('MODEM_ALIVE_RETRY', { attempt: i, error: e.message });
      }
    }

    // Guard-time escape from transparent/data mode (no CR/LF).
    try {
      if (this.session.transport && this.session.transport.isOpen) {
        this._recordEvidence('MODEM_ESCAPE_PLUS', 'sending +++');
        await this.session.transport.write('+++');
        await this._pause(1200);
      }
    } catch (e) {
      this._recordEvidence('MODEM_ESCAPE_PLUS_FAIL', e.message);
    }

    if (typeof this.session.recoverUart === 'function') {
      this.session.recoverUart();
    }

    try {
      await this._tryAt(3000);
      return true;
    } catch (e) {
      this._recordEvidence('MODEM_STILL_SILENT', e.message);
      return false;
    }
  }

  async configurePdp(apn = 'internet') {
    this._recordEvidence('STEP_PDP_CONFIG_START', { apn });

    try {
      await this._recoverModem();

      try {
        await this.session.sendCommand('AT+QICLOSE', { timeoutMs: 5000 });
        this._recordEvidence('QICLOSE_OK', 'socket closed or none open');
      } catch (e) {
        this._recordEvidence('QICLOSE_SWALLOWED', e.message);
      }
      await this._pause(400);

      try {
        await this.session.sendCommand('AT+QIDEACT', { timeoutMs: 15000 });
        this._recordEvidence('QIDEACT_OK', 'PDP deactivated');
      } catch (e) {
        this._recordEvidence('QIDEACT_SWALLOWED', e.message);
      }

      await this._pause(800);
      if (typeof this.session.recoverUart === 'function') {
        this.session.recoverUart();
      }

      try {
        await this._tryAt(3000);
      } catch (e) {
        this._recordEvidence('POST_DEACT_AT_FAIL', e.message);
      }

      // 1. Select foreground context 0
      try {
        await this.session.sendCommand('AT+QIFGCNT=0', { timeoutMs: 5000 });
      } catch (e) {
        this._recordEvidence('QIFGCNT_RETRY', e.message);
        if (typeof this.session.recoverUart === 'function') this.session.recoverUart();
        await this._pause(300);
        await this.session.sendCommand('AT+QIFGCNT=0', { timeoutMs: 5000 });
      }

      // 2. Set TCP receive mode: Buffer Access Mode (AT+QINDI=1)
      // Confirmed by Hardware Preflight on M25MAR01A12: default QINDI=0 drops data directly to UART.
      // Must set QINDI=1 to emit +QIRDI URC and allow buffer read via AT+QIRD.
      // If this fails, abort PDP configuration immediately to protect UART parser.
      this._recordEvidence('STEP_QINDI_CONFIG_START', { mode: 1 });
      try {
        await this.session.sendCommand('AT+QINDI=1', { timeoutMs: 5000 });
        this._recordEvidence('STEP_QINDI_CONFIG_SUCCESS', { mode: 1 });
      } catch (qindiErr) {
        this._recordEvidence('STEP_QINDI_CONFIG_FAIL', qindiErr.message);
        this._setState(GPRS_STATES.ERROR, `Failed to configure QINDI=1: ${qindiErr.message}`);
        throw new Error(`QINDI_CONFIG_FAILED: ${qindiErr.message}`);
      }

      // 3. Set APN
      await this.session.sendCommand(`AT+QICSGP=1,"${apn}"`, { timeoutMs: 5000 });

      this.apn = apn;
      this._setState(GPRS_STATES.PDP_CONFIGURED, `APN configured: ${apn}`);
      return { success: true, apn };
    } catch (err) {
      this._recordEvidence('PDP_CONFIG_FAIL', err.message);
      this._setState(GPRS_STATES.ERROR, `Configure APN failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Step 2: Activate GPRS PDP Context
   */
  async activatePdp() {
    this._recordEvidence('STEP_ACTIVATE_START', { apn: this.apn });
    this._setState(GPRS_STATES.PDP_ACTIVATING, 'Starting TCPIP task & GPRS context activation');

    try {
      // 0. Ensure GPRS service attachment (CGATT=1)
      const gattRes = await this.session.sendCommand('AT+CGATT?', { timeoutMs: 8000 });
      if (!gattRes.raw.includes('+CGATT: 1')) {
        this._recordEvidence('GPRS_ATTACHING', 'Sending AT+CGATT=1');
        await this.session.sendCommand('AT+CGATT=1', { timeoutMs: 30000 });
      }

      // 1. Start TCPIP Task
      await this.session.sendCommand('AT+QIREGAPP', { timeoutMs: 6000 });

      // 2. Activate GPRS (can take several seconds on 2G networks)
      await this.session.sendCommand('AT+QIACT', { timeoutMs: 30000 });

      this._setState(GPRS_STATES.PDP_ACTIVE, 'PDP Context Activated (AT+QIACT OK)');
      return { success: true };
    } catch (err) {
      this._recordEvidence('ACTIVATE_FAIL', err.message);
      this._setState(GPRS_STATES.ERROR, `Activation failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Step 3: Retrieve Carrier Assigned IP
   */
  async queryAssignedIp() {
    this._recordEvidence('STEP_QUERY_IP_START');

    try {
      const res = await this.session.sendCommand('AT+QILOCIP', { expectIp: true, timeoutMs: 4000 });
      const ip = res.ip;
      this.assignedIp = ip;
      this.session.attributes.ipAddress = ip;
      this._recordEvidence('IP_ASSIGNED_EVIDENCE', { ip });
      this._setState(GPRS_STATES.IP_ASSIGNED, `Carrier assigned IP: ${ip}`);
      return { success: true, ip };
    } catch (err) {
      this._recordEvidence('QUERY_IP_FAIL', err.message);
      throw err;
    }
  }

  /**
   * Step 4: Open TCP Socket (with automatic retry on CONNECT FAIL)
   * Retries up to MAX_TCP_ATTEMPTS times with RETRY_DELAY_MS between attempts.
   * Each attempt closes any lingering socket first and logs AT+QISTAT for diagnostics.
   */
  async connectTcp(host, port) {
    const { assertModemHost, loadFieldConfig } = require('../config/fieldConfig');
    if (loadFieldConfig().mode === 'field') {
      assertModemHost(host);
    }

    const MAX_TCP_ATTEMPTS = 3;
    const RETRY_DELAY_MS   = 3500;

    this._recordEvidence('STEP_TCP_CONNECT_START', { host, port, maxAttempts: MAX_TCP_ATTEMPTS });
    this._setState(GPRS_STATES.TCP_CONNECTING, `Connecting to ${host}:${port}`);

    let lastErr;
    for (let attempt = 1; attempt <= MAX_TCP_ATTEMPTS; attempt++) {
      // Log current socket state before attempting
      try {
        const stat = await this.session.sendCommand('AT+QISTAT', { timeoutMs: 3000 });
        this._recordEvidence(`TCP_ATTEMPT_${attempt}_QISTAT`, stat.raw);
      } catch (_) {}

      // Close any lingering socket
      try {
        await this.session.sendCommand('AT+QICLOSE', { timeoutMs: 5000 });
        // Brief pause to allow modem to fully release the socket
        await new Promise(r => setTimeout(r, 800));
      } catch (_) {}

      try {
        const cmd = `AT+QIOPEN="TCP","${host}",${port}`;
        this._recordEvidence(`TCP_ATTEMPT_${attempt}_START`, { cmd });
        await this.session.sendCommand(cmd, { expectConnect: true, timeoutMs: 25000 });

        // ── SUCCESS ──
        this.socketInfo = { host, port, isConnected: true };
        this._recordEvidence('TCP_CONNECTED_EVIDENCE', { host, port, attempt });
        this._setState(GPRS_STATES.TCP_CONNECTED, `TCP Connected to ${host}:${port} (attempt ${attempt})`);
        return { success: true, attempt };

      } catch (err) {
        lastErr = err;
        this._recordEvidence(`TCP_ATTEMPT_${attempt}_FAIL`, err.message);
        console.warn(`[${this.nodeId}] TCP connect attempt ${attempt}/${MAX_TCP_ATTEMPTS} failed: ${err.message}`);

        if (attempt < MAX_TCP_ATTEMPTS) {
          console.warn(`[${this.nodeId}] Retrying in ${RETRY_DELAY_MS}ms...`);
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        }
      }
    }

    // All attempts exhausted
    this.socketInfo.isConnected = false;
    this._recordEvidence('TCP_CONNECT_ALL_ATTEMPTS_FAILED', lastErr.message);
    this._setState(GPRS_STATES.ERROR, `TCP Connect failed after ${MAX_TCP_ATTEMPTS} attempts: ${lastErr.message}`);
    throw lastErr;
  }

  /**
   * Step 5: Send Raw Payload with Length-Prefix and Prompt Detection
   */
  async sendPayload(payloadStr) {
    if (!this.socketInfo.isConnected) {
      throw new Error('TCP_SOCKET_NOT_CONNECTED');
    }

    const payloadBytes = Buffer.from(payloadStr, 'utf8');
    const length = payloadBytes.length;

    this._recordEvidence('STEP_SEND_START', { length, sample: payloadStr.slice(0, 60) });

    try {
      // 1. Send AT+QISEND=<len> expecting '>' prompt
      await this.session.sendCommand(`AT+QISEND=${length}`, { expectPrompt: true, timeoutMs: 6000 });

      // 2. Transmit raw bytes directly over transport
      await this.session.transport.write(payloadBytes);

      // 3. Await 'SEND OK' from modem
      const promise = new Promise((resolve, reject) => {
        this.session.parser.setPending(resolve, reject, { timeoutMs: 10000 });
      });

      const sendRes = await promise;
      this._recordEvidence('SEND_CONFIRMED', { result: sendRes.raw });
      return { success: true, bytesSent: length };
    } catch (err) {
      this._recordEvidence('SEND_FAIL', err.message);
      throw err;
    }
  }

  /**
   * Step 6: Close TCP Socket Cleanly
   */
  async closeTcp() {
    this._recordEvidence('STEP_TCP_CLOSE_START');
    try {
      await this.session.sendCommand('AT+QICLOSE', { timeoutMs: 5000 });
      this.socketInfo.isConnected = false;
      this._recordEvidence('TCP_CLOSED_EVIDENCE');
      return { success: true };
    } catch (err) {
      this._recordEvidence('TCP_CLOSE_FAIL', err.message);
      throw err;
    }
  }

  /**
   * Step 7: Deactivate GPRS Context Cleanly
   */
  async deactivatePdp() {
    this._recordEvidence('STEP_DEACT_START');
    try {
      await this.session.sendCommand('AT+QIDEACT', { timeoutMs: 8000 });
      this.assignedIp = null;
      this.session.attributes.ipAddress = null;
      this._setState(GPRS_STATES.PACKET_ATTACHED, 'PDP Deactivated cleanly (AT+QIDEACT)');
      return { success: true };
    } catch (err) {
      this._recordEvidence('DEACT_FAIL', err.message);
      throw err;
    }
  }

  getSnapshot() {
    return {
      nodeId: this.nodeId,
      state: this.gprsState,
      apn: this.apn,
      assignedIp: this.assignedIp,
      socketInfo: { ...this.socketInfo },
      recentEvidence: this.evidenceLog.slice(0, 10)
    };
  }
}

module.exports = {
  GprsEngine,
  GPRS_STATES
};
