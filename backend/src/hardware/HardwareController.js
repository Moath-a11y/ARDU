/**
 * BARQ LINK — Central Hardware Controller
 * Coordinates physical serial access for NODE ALPHA (COM3) and NODE BRAVO (COM4).
 * Enforces exclusive port access, manages independent sessions, and broadcasts clean events.
 * Integrates GprsRelayClient and real-time bidirectional message routing.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { SerialPort } = require('serialport');
const SerialTransport = require('./SerialTransport');
const { NodeSession, STATES } = require('./NodeSession');
const GprsRelayClient = require('./GprsRelayClient');

class HardwareController extends EventEmitter {
  constructor(config = {}) {
    super();
    this.alphaPort = config.alphaPort || 'COM3';
    this.bravoPort = config.bravoPort || 'COM4';
    this.baudRate = config.baudRate || 9600;

    this.nodes = new Map();
    this.relayClients = new Map(); // nodeId -> GprsRelayClient
    this.messages = []; // Rolling buffer of chat/relay messages
    this.maxMessages = 100;
    this.rawLogs = []; // Rolling buffer of raw events { id, timestamp, nodeId, dir: 'TX'|'RX', data }
    this.maxLogs = 200;

    this.isInitialized = false;
  }

  setTunnelManager(tm) {
    this.tunnelManager = tm;
  }

  setRelayServer(rs) {
    this.relayServer = rs;
  }

  /**
   * Helper to resolve the active relay endpoint (from reachability or pinggy endpoint)
   * Prefers numeric IP for cellular modem (Quectel M25) connections to bypass slow/unreliable 2G DNS.
   */
  getDefaultRelayEndpoint() {
    if (this.tunnelManager && this.tunnelManager.getEndpoint()) {
      return this.tunnelManager.getEndpoint();
    }

    const epFile    = path.join(__dirname, '..', '..', 'pinggy_endpoint.json');
    const reachFile = path.join(__dirname, '..', '..', 'relay_reachability.json');

    let hostname = null;
    let port = null;
    let ip = null;
    let timestamp = null;

    try {
      if (fs.existsSync(epFile)) {
        const ep = JSON.parse(fs.readFileSync(epFile, 'utf8'));
        if (ep.host && ep.port) {
          hostname = ep.host;
          port = Number(ep.port);
          timestamp = ep.timestamp || null;
        }
      }
    } catch (_) {}

    try {
      if (fs.existsSync(reachFile)) {
        const reach = JSON.parse(fs.readFileSync(reachFile, 'utf8'));
        if (reach.endpoint && reach.endpoint.host) hostname = reach.endpoint.host;
        if (reach.endpoint && reach.endpoint.port) port = Number(reach.endpoint.port);
        if (reach.viaIp && reach.viaIp.host) ip = reach.viaIp.host;
        else if (reach.ips && reach.ips[0]) ip = reach.ips[0];
        if (reach.verifiedAt) timestamp = reach.verifiedAt;
      }
    } catch (_) {}

    if (hostname && port) {
      // Cellular modems on 2G GPRS frequently experience DNS resolution timeouts.
      // Use verified numeric IP as primary host for the modem AT+QIOPEN command.
      const host = ip || hostname;
      return { host, port, hostname, ip: ip || null, timestamp };
    }

    return { host: '127.0.0.1', port: 5050, hostname: 'localhost', ip: '127.0.0.1', timestamp: null };
  }


  /**
   * Discover available COM ports on the system
   */
  async listAvailablePorts() {
    try {
      const ports = await SerialPort.list();
      return ports.map(p => ({
        path: p.path,
        manufacturer: p.manufacturer || 'Unknown',
        friendlyName: p.friendlyName || p.path,
        pnpId: p.pnpId,
        vendorId: p.vendorId,
        productId: p.productId
      }));
    } catch (err) {
      return [];
    }
  }

  /**
   * Initialize both sessions without automatically opening serial ports
   */
  async initialize() {
    if (this.isInitialized) return;

    // 1. Setup ALPHA Node
    const alphaTransport = new SerialTransport(this.alphaPort, this.baudRate);
    const alphaSession = new NodeSession('ALPHA', this.alphaPort, alphaTransport, { baudRate: this.baudRate });
    this._attachSessionListeners(alphaSession);
    this.nodes.set('ALPHA', alphaSession);

    // 2. Setup BRAVO Node
    const bravoTransport = new SerialTransport(this.bravoPort, this.baudRate);
    const bravoSession = new NodeSession('BRAVO', this.bravoPort, bravoTransport, { baudRate: this.baudRate });
    this._attachSessionListeners(bravoSession);
    this.nodes.set('BRAVO', bravoSession);

    this.isInitialized = true;
  }

  _attachSessionListeners(session) {
    session.on('state_change', (evt) => {
      this.emit('node_state_change', evt);
    });

    session.on('gprs_state_change', (evt) => {
      this.emit('node_gprs_change', evt);
    });

    session.on('telemetry', (evt) => {
      this.emit('node_telemetry', evt);
    });

    session.on('raw_tx', (evt) => {
      this._addRawLog(evt.nodeId, 'TX', evt.command);
      this.emit('raw_event', { ...evt, dir: 'TX' });
    });

    session.on('raw_rx', (evt) => {
      this._addRawLog(evt.nodeId, 'RX', evt.raw);
      this.emit('raw_event', { ...evt, dir: 'RX' });
    });

    session.on('error', (evt) => {
      this.emit('node_error', evt);
    });
  }

  _addRawLog(nodeId, dir, data) {
    const logItem = {
      id: 'log_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
      timestamp: new Date().toISOString(),
      nodeId,
      dir,
      data: String(data).trim()
    };
    if (logItem.data) {
      this.rawLogs.unshift(logItem);
      if (this.rawLogs.length > this.maxLogs) this.rawLogs.pop();
    }
  }

  _addMessage(msg) {
    // Deduplication: if a message with the same id already exists (e.g. sent by us and
    // now reflected back as relay_received on the destination side), enrich the existing
    // entry rather than duplicating it.
    const existingIdx = this.messages.findIndex(m => m.id === msg.id);
    if (existingIdx !== -1) {
      const existing = this.messages[existingIdx];
      // Merge received-side fields (receivedAt, contentMatch, payloadHash) into the existing record
      if (msg.receivedAt) existing.receivedAt = msg.receivedAt;
      if (msg.contentMatch !== undefined) existing.contentMatch = msg.contentMatch;
      if (msg.payloadHash !== undefined) existing.payloadHash = msg.payloadHash;
      // Promote status only if incoming is "more complete" (DELIVERED > SENT > QUEUED)
      const rank = { QUEUED: 0, SENT: 1, DELIVERED: 2, FAILED: 3 };
      const incomingRank = rank[msg.status] ?? -1;
      const existingRank = rank[existing.status] ?? -1;
      if (incomingRank > existingRank) existing.status = msg.status;
      return; // Do NOT push a duplicate
    }

    this.messages.unshift(msg);
    if (this.messages.length > this.maxMessages) this.messages.pop();
  }

  /**
   * Open single hardware node serial port
   */
  async openNode(nodeId) {
    if (!this.isInitialized) await this.initialize();
    const session = this.getNode(nodeId);
    if (!session) throw new Error(`Node ${nodeId} not found`);
    await session.open();
    return { nodeId, status: 'OPENED', port: session.portPath };
  }

  /**
   * Close single hardware node serial port (and disconnect its relay if active)
   */
  async closeNode(nodeId) {
    const session = this.getNode(nodeId);
    if (!session) throw new Error(`Node ${nodeId} not found`);

    if (this.relayClients.has(nodeId)) {
      try {
        await this.relayClients.get(nodeId).disconnect();
      } catch (_) {}
    }

    await session.close();
    return { nodeId, status: 'CLOSED', port: session.portPath };
  }

  /**
   * Open all ports
   */
  async startAll() {
    if (!this.isInitialized) await this.initialize();

    const results = {};
    for (const [nodeId, session] of this.nodes) {
      try {
        await session.open();
        results[nodeId] = { status: 'OPENED', port: session.portPath };
      } catch (err) {
        results[nodeId] = { status: 'FAILED', port: session.portPath, error: err.message };
      }
    }
    return results;
  }

  /**
   * Initialize GPRS (APN + QINDI=1 + Activate PDP + Query IP)
   */
  async initGprs(nodeId, apn = 'internet') {
    const session = this.getNode(nodeId);
    if (!session) throw new Error(`Node ${nodeId} not found`);
    if (session.state === STATES.SERIAL_DISCONNECTED) {
      throw new Error(`Cannot initialize GPRS: Serial port for ${nodeId} is closed`);
    }

    await session.gprsEngine.configurePdp(apn);
    await session.gprsEngine.activatePdp();
    const ipRes = await session.gprsEngine.queryAssignedIp();
    return { nodeId, apn, ip: ipRes.ip };
  }

  /**
   * Connect node to Relay Server
   */
  async connectRelay(nodeId, host, port, apn = 'internet') {
    const session = this.getNode(nodeId);
    if (!session) throw new Error(`Node ${nodeId} not found`);
    if (session.state === STATES.SERIAL_DISCONNECTED) {
      throw new Error(`Cannot connect relay: Serial port for ${nodeId} is closed`);
    }

    // Resolve endpoint
    let targetHost = host;
    let targetPort = port;
    if (!targetHost || !targetPort) {
      const ep = this.getDefaultRelayEndpoint();
      targetHost = ep.host;
      targetPort = ep.port;
    }

    // Ensure previous relay client is cleanly disposed
    if (this.relayClients.has(nodeId)) {
      try {
        await this.relayClients.get(nodeId).disconnect();
      } catch (_) {}
      this.relayClients.delete(nodeId);
    }

    const client = new GprsRelayClient(session, targetHost, targetPort, nodeId, { apn });
    this.relayClients.set(nodeId, client);

    client.on('registered', (evt) => {
      this.emit('relay_state_change', { nodeId, state: 'REGISTERED', details: evt });
    });

    client.on('relay_received', async (msg) => {
      const chatMsg = {
        id: msg.msgId,
        from: msg.from,
        to: nodeId,
        payload: msg.payload,
        receivedAt: new Date().toISOString(),
        status: 'DELIVERED',
        direction: `${msg.from}->${nodeId}`,
        contentMatch: msg.contentMatch ?? true,
        payloadHash: msg.payloadHash
      };
      this._addMessage(chatMsg);
      this.emit('message_received', chatMsg);

      // Automatic DELIVERY_ACK confirmation back to sender
      if (typeof msg.confirm === 'function') {
        try {
          await msg.confirm();
          this.emit('delivery_ack_sent', { nodeId, msgId: msg.msgId, payloadHash: msg.payloadHash });
        } catch (e) {
          console.error(`[${nodeId}] Failed to send DELIVERY_ACK:`, e.message);
        }
      }
    });

    client.on('disconnected', () => {
      this.emit('relay_state_change', { nodeId, state: 'IDLE' });
    });

    // Execute connect sequence (PDP config + activate + IP + TCP connect + REGISTER handshake)
    const ack = await client.connect(apn);
    return {
      nodeId,
      relayHost: targetHost,
      relayPort: targetPort,
      serverTime: ack.serverTime,
      assignedIp: session.gprsEngine.assignedIp
    };
  }

  /**
   * Disconnect node from Relay Server
   */
  async disconnectRelay(nodeId) {
    const client = this.relayClients.get(nodeId);
    if (client) {
      await client.disconnect();
      this.relayClients.delete(nodeId);
    }
    const session = this.getNode(nodeId);
    if (session && session.gprsEngine) {
      try { await session.gprsEngine.closeTcp(); } catch (_) {}
      try { await session.gprsEngine.deactivatePdp(); } catch (_) {}
    }
    return { nodeId, status: 'DISCONNECTED' };
  }

  /**
   * Refresh hardware status via read-only AT queries
   */
  async refreshNodeStatus(nodeId) {
    const session = this.getNode(nodeId);
    if (!session) throw new Error(`Node ${nodeId} not found`);
    if (session.state === STATES.SERIAL_DISCONNECTED) {
      throw new Error(`Cannot refresh: Serial port for ${nodeId} is closed`);
    }

    try { await session.sendCommand('AT', { timeoutMs: 2000 }); } catch (e) {}
    try {
      const cpin = await session.sendCommand('AT+CPIN?', { timeoutMs: 3000 });
      session.attributes.simStatus = cpin.raw.includes('READY') ? 'READY' : 'NOT_READY';
    } catch (e) {}
    try {
      const csq = await session.sendCommand('AT+CSQ', { timeoutMs: 2000 });
      const match = csq.raw.match(/\+CSQ:\s*(\d+),(\d+)/);
      if (match) {
        session.attributes.signalCsq = parseInt(match[1], 10);
        session.attributes.signalBer = parseInt(match[2], 10);
        session.attributes.signalPct = Math.min(100, Math.round((session.attributes.signalCsq / 31) * 100));
      }
    } catch (e) {}
    try {
      const creg = await session.sendCommand('AT+CREG?', { timeoutMs: 2000 });
      const match = creg.raw.match(/\+CREG:\s*\d+,(\d+)/);
      if (match) session.attributes.gsmRegistration = (match[1] === '1' || match[1] === '5') ? 'REGISTERED' : 'SEARCHING';
    } catch (e) {}
    try {
      const cgreg = await session.sendCommand('AT+CGREG?', { timeoutMs: 2000 });
      const match = cgreg.raw.match(/\+CGREG:\s*\d+,(\d+)/);
      if (match) session.attributes.gprsRegistration = (match[1] === '1' || match[1] === '5') ? 'REGISTERED' : 'SEARCHING';
    } catch (e) {}
    try {
      const cbc = await session.sendCommand('AT+CBC', { timeoutMs: 2000 });
      const match = cbc.raw.match(/\+CBC:\s*\d+,\d+,(\d+)/);
      if (match) session.attributes.voltage = (parseInt(match[1], 10) / 1000).toFixed(2);
    } catch (e) {}

    return session.getSnapshot();
  }

  /**
   * Send application message from one node to another and await verified DELIVERY_ACK
   */
  async sendRelayMessage(fromId, toId, payload, timeoutMs = 25000) {
    const client = this.relayClients.get(fromId);
    if (!client || client._state !== 'REGISTERED') {
      throw new Error(`Node ${fromId} is not registered on the Relay Server`);
    }

    const msgId = `${fromId}-${Date.now()}-${Math.floor(Math.random() * 1000).toString(36)}`;
    const t0 = Date.now();
    const chatMsg = {
      id: msgId,
      from: fromId,
      to: toId,
      payload: typeof payload === 'object' ? JSON.stringify(payload) : String(payload),
      sentAt: new Date().toISOString(),
      status: 'QUEUED',
      direction: `${fromId}->${toId}`,
      rttMs: null
    };

    this._addMessage(chatMsg);
    this.emit('message_queued', chatMsg);

    try {
      chatMsg.status = 'SENT';
      this.emit('message_sent', chatMsg);

      // sendRelay() awaits true DELIVERY_ACK from destination
      const ack = await client.sendRelay(toId, chatMsg.payload, timeoutMs);
      chatMsg.status = 'DELIVERED';
      chatMsg.deliveredAt = new Date().toISOString();
      chatMsg.rttMs = Date.now() - t0;
      chatMsg.ack = ack;
      chatMsg.contentMatch = ack.contentMatch ?? true;
      chatMsg.payloadHash = ack.payloadHash;
      this.emit('message_delivered', chatMsg);
      return chatMsg;
    } catch (err) {
      chatMsg.status = 'FAILED';
      chatMsg.error = err.message;
      chatMsg.failedAt = new Date().toISOString();
      chatMsg.rttMs = Date.now() - t0;
      this.emit('message_failed', chatMsg);
      throw err;
    }
  }

  /**
   * Emergency Stop All: Tear down all TCP sockets, deactivate all PDP contexts, and close all serial ports
   */
  async emergencyStopAll() {
    const results = {};
    for (const [nodeId, session] of this.nodes) {
      results[nodeId] = { relay: 'N/A', tcp: 'N/A', gprs: 'N/A', port: 'N/A' };

      // 1. Disconnect relay client
      if (this.relayClients.has(nodeId)) {
        try {
          await Promise.race([
            this.relayClients.get(nodeId).disconnect(),
            new Promise((_, r) => setTimeout(() => r(new Error('TIMEOUT')), 5000))
          ]);
          results[nodeId].relay = 'DISCONNECTED';
        } catch (e) {
          results[nodeId].relay = `ERR: ${e.message}`;
        }
        this.relayClients.delete(nodeId);
      }

      // 2. Close TCP & Deactivate PDP via GprsEngine (only if serial is connected)
      if (session.state !== STATES.SERIAL_DISCONNECTED && session.gprsEngine) {
        try {
          await session.gprsEngine.closeTcp();
          results[nodeId].tcp = 'CLOSED';
        } catch (e) {}
        try {
          await session.gprsEngine.deactivatePdp();
          results[nodeId].gprs = 'DEACTIVATED';
        } catch (e) {}
      }

      // 3. Close Serial Port
      try {
        await session.close();
        results[nodeId].port = 'CLOSED';
      } catch (e) {
        results[nodeId].port = `ERR: ${e.message}`;
      }
    }
    return results;
  }

  getNode(nodeId) {
    return this.nodes.get(nodeId) || null;
  }

  getSnapshot() {
    const nodesSnapshot = {};
    for (const [id, session] of this.nodes) {
      const snap = session.getSnapshot();
      const relayClient = this.relayClients.get(id);
      const isStandaloneRegistered = this.relayServer && this.relayServer._sessions.has(id);
      const standalonePeer = isStandaloneRegistered ? this.relayServer.getActiveSessions()[id] : null;

      snap.relay = {
        state: isStandaloneRegistered ? 'REGISTERED' : (relayClient ? relayClient._state : 'IDLE'),
        mode: isStandaloneRegistered ? 'STANDALONE_GPRS' : (relayClient ? 'TETHERED_SERIAL' : 'NONE'),
        remotePeer: standalonePeer,
        host: relayClient ? relayClient._relayHost : null,
        port: relayClient ? relayClient._relayPort : null
      };
      nodesSnapshot[id] = snap;
    }
    return {
      isInitialized: this.isInitialized,
      nodes: nodesSnapshot,
      messages: this.messages.slice(0, 50),
      rawLogsCount: this.rawLogs.length,
      defaultEndpoint: this.getDefaultRelayEndpoint()
    };
  }

  async shutdown() {
    await this.emergencyStopAll();
    this.isInitialized = false;
  }
}

module.exports = HardwareController;
