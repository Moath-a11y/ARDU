/**
 * BARQ LINK — NodeSession
 * Manages an individual Quectel M25 hardware node (ALPHA or BRAVO).
 * Strictly maintains state transitions based only on verified hardware events.
 */

const { EventEmitter } = require('events');
const ATParser = require('./ATParser');
const { GprsEngine, GPRS_STATES } = require('./GprsEngine');

// Formal State Constants
const STATES = {
  SERIAL_DISCONNECTED: 'SERIAL_DISCONNECTED',
  SERIAL_CONNECTED: 'SERIAL_CONNECTED',
  SIM_NOT_READY: 'SIM_NOT_READY',
  SIM_READY: 'SIM_READY',
  NETWORK_SEARCHING: 'NETWORK_SEARCHING',
  NETWORK_REGISTERED: 'NETWORK_REGISTERED',
  PACKET_SEARCHING: 'PACKET_SEARCHING',
  PACKET_REGISTERED: 'PACKET_REGISTERED',
  PACKET_ATTACHED: 'PACKET_ATTACHED',
  PDP_ACTIVATING: 'PDP_ACTIVATING',
  PDP_ACTIVE: 'PDP_ACTIVE',
  DNS_TESTING: 'DNS_TESTING',
  TCP_CONNECTING: 'TCP_CONNECTING',
  TCP_CONNECTED: 'TCP_CONNECTED',
  APPLICATION_TESTING: 'APPLICATION_TESTING',
  APPLICATION_READY: 'APPLICATION_READY',
  DEGRADED: 'DEGRADED',
  ERROR: 'ERROR'
};

class NodeSession extends EventEmitter {
  constructor(nodeId, portPath, transport, options = {}) {
    super();
    this.nodeId = nodeId; // 'ALPHA' or 'BRAVO'
    this.portPath = portPath; // 'COM3' or 'COM4'
    this.transport = transport;
    this.baudRate = options.baudRate || 9600;

    // Strict Operational State
    this.state = STATES.SERIAL_DISCONNECTED;
    this.stateHistory = [];

    // Verified Hardware Attributes (No default placeholders)
    this.attributes = {
      firmware: null,
      model: null,
      simStatus: 'UNKNOWN',
      signalCsq: null,
      signalPct: null,
      signalBer: null,
      gsmRegistration: 'NOT_CHECKED',
      gprsRegistration: 'NOT_CHECKED',
      gprsAttached: false,
      operator: null,
      voltage: null,
      ipAddress: null, // Only set in Stage 3 after verified activation
      lastCommand: null,
      lastRawResponse: null,
      lastSeen: null,
      lastError: null
    };

    // Command Queue for Strict Serialization
    this.commandQueue = [];
    this.isProcessingQueue = false;

    // Setup AT Parser
    this.parser = new ATParser({
      onURC: (type, data) => this._handleURC(type, data),
      onRawData: (raw) => {
        const text = typeof raw === 'string' ? raw.trim() : String(raw).trim();
        if (text && text.length > 0) {
          this.emit('raw_rx', { nodeId: this.nodeId, raw: text, timestamp: new Date().toISOString() });
        }
      }
    });

    // Wire Transport Events
    this.transport.on('data', (chunk) => {
      this.attributes.lastSeen = new Date().toISOString();
      this.parser.feed(chunk);
    });

    this.transport.on('error', (err) => {
      this.attributes.lastError = err.message;
      this._setState(STATES.ERROR, `Transport Error: ${err.message}`);
      this.emit('error', { nodeId: this.nodeId, error: err });
    });

    this.transport.on('close', () => {
      this._setState(STATES.SERIAL_DISCONNECTED, 'Serial Port Closed');
      this.parser.reset();
      this._flushQueue(new Error('PORT_CLOSED'));
    });

    // Dedicated Stage 3 GPRS Engine
    this.gprsEngine = new GprsEngine(this);
    this.gprsEngine.on('state_change', (evt) => {
      this.emit('gprs_state_change', evt);
    });
  }

  _setState(newState, reason = '') {
    if (this.state === newState) return;
    const oldState = this.state;
    this.state = newState;
    const event = {
      nodeId: this.nodeId,
      oldState,
      newState,
      reason,
      timestamp: new Date().toISOString()
    };
    this.stateHistory.push(event);
    if (this.stateHistory.length > 50) this.stateHistory.shift();
    this.emit('state_change', event);
  }

  async open() {
    try {
      await this.transport.open();
      this._setState(STATES.SERIAL_CONNECTED, 'Port Opened Successfully');
      return true;
    } catch (err) {
      this.attributes.lastError = err.message;
      this._setState(STATES.ERROR, `Port Open Failed: ${err.message}`);
      throw err;
    }
  }

  async close() {
    this._flushQueue(new Error('SESSION_CLOSING'));
    await this.transport.close();
    this._setState(STATES.SERIAL_DISCONNECTED, 'Session Closed');
  }

  /**
   * Enqueue an AT command for serialized execution
   */
  sendCommand(command, options = {}) {
    return new Promise((resolve, reject) => {
      this.commandQueue.push({
        command: command.trim(),
        options,
        resolve,
        reject
      });
      this._processQueue();
    });
  }

  async _processQueue() {
    if (this.isProcessingQueue || this.commandQueue.length === 0) return;
    this.isProcessingQueue = true;

    const item = this.commandQueue.shift();
    const { command, options, resolve, reject } = item;

    try {
      this.attributes.lastCommand = command;
      const cmdStr = command + '\r\n';

      this.emit('raw_tx', { nodeId: this.nodeId, command, timestamp: new Date().toISOString() });

      // Create expectation in parser
      const promise = new Promise((pResolve, pReject) => {
        this.parser.setPending(pResolve, pReject, options);
      });

      // Write to physical port
      await this.transport.write(cmdStr);

      const result = await promise;
      this.attributes.lastRawResponse = result.raw;
      this.attributes.lastSeen = new Date().toISOString();
      resolve(result);
    } catch (err) {
      this.attributes.lastError = err.message;
      this.attributes.lastRawResponse = err.message;
      reject(err);
    } finally {
      this.isProcessingQueue = false;
      setImmediate(() => this._processQueue());
    }
  }

  _flushQueue(error) {
    // Cancel the in-flight ATParser pending first (stops its timer from firing
    // after the queue is gone and producing an unhandled rejection crash).
    if (this.parser) this.parser.reset();
    while (this.commandQueue.length > 0) {
      const item = this.commandQueue.shift();
      try { item.reject(error); } catch (_) {}
    }
    this.isProcessingQueue = false;
  }

  _handleURC(type, data) {
    switch (type) {
      case 'CPIN':
        this.attributes.simStatus = data.status;
        if (data.ready) {
          if (this.state === STATES.SERIAL_CONNECTED || this.state === STATES.SIM_NOT_READY) {
            this._setState(STATES.SIM_READY, 'SIM Reported READY');
          }
        } else {
          this._setState(STATES.SIM_NOT_READY, `SIM Status: ${data.status}`);
        }
        break;

      case 'CSQ':
        this.attributes.signalCsq = data.rssi;
        this.attributes.signalBer = data.ber;
        this.attributes.signalPct = data.signalPct;
        break;

      case 'CREG':
        this.attributes.gsmRegistration = data.registered ? 'REGISTERED' : (data.searching ? 'SEARCHING' : 'NOT_REGISTERED');
        if (data.registered) {
          if (this.state === STATES.SIM_READY || this.state === STATES.NETWORK_SEARCHING) {
            this._setState(STATES.NETWORK_REGISTERED, `GSM Registered (stat=${data.stat})`);
          }
        } else if (data.searching) {
          if (this.state === STATES.SIM_READY) {
            this._setState(STATES.NETWORK_SEARCHING, 'GSM Network Searching...');
          }
        }
        break;

      case 'CGREG':
        this.attributes.gprsRegistration = data.registered ? 'REGISTERED' : (data.searching ? 'SEARCHING' : 'NOT_REGISTERED');
        if (data.registered) {
          if (this.state === STATES.NETWORK_REGISTERED || this.state === STATES.PACKET_SEARCHING) {
            this._setState(STATES.PACKET_REGISTERED, `GPRS Registered (stat=${data.stat})`);
          }
        }
        break;

      case 'CGATT':
        this.attributes.gprsAttached = data.attached;
        if (data.attached && (this.state === STATES.PACKET_REGISTERED || this.state === STATES.NETWORK_REGISTERED)) {
          this._setState(STATES.PACKET_ATTACHED, 'GPRS Attached (CGATT=1)');
        }
        break;

      case 'DISCONNECT':
        if (this.state === STATES.TCP_CONNECTED || this.state === STATES.APPLICATION_READY) {
          this._setState(STATES.DEGRADED, `Modem reported disconnect: ${data.type}`);
        }
        break;
    }

    this.emit('telemetry', { nodeId: this.nodeId, type, data, state: this.state });
  }

  /**
   * Run Stage 2 Non-Destructive Diagnostics
   * Queries firmware, SIM status, signal, registration, attachment, and battery.
   * Does NOT activate GPRS, send SMS, or dial calls.
   */
  async runStage2Diagnostics() {
    if (this.state === STATES.SERIAL_DISCONNECTED) {
      throw new Error(`NODE_${this.nodeId}_PORT_DISCONNECTED`);
    }

    const report = {
      nodeId: this.nodeId,
      port: this.portPath,
      timestamp: new Date().toISOString(),
      commandsExecuted: [],
      success: true
    };

    // Helper step
    const execStep = async (cmd, parserFn, options = {}) => {
      try {
        const res = await this.sendCommand(cmd, { timeoutMs: options.timeoutMs || 4000 });
        report.commandsExecuted.push({ cmd, ok: true, raw: res.raw });
        if (parserFn) parserFn(res);
      } catch (err) {
        report.commandsExecuted.push({ cmd, ok: false, error: err.message });
        report.success = false;
        throw err;
      }
    };

    try {
      // 1. Basic Ping
      await execStep('AT', null, { timeoutMs: 2000 });

      // 2. Echo Off for clean responses
      await execStep('ATE0', null, { timeoutMs: 2000 });

      // 3. Verbose error reporting
      await execStep('AT+CMEE=2', null, { timeoutMs: 2000 });

      // 4. Identification (Model and Firmware)
      await execStep('ATI', (res) => {
        const lines = res.lines.filter(l => l !== 'OK');
        if (lines.length > 0) {
          this.attributes.model = lines[0];
          if (lines.length > 1) this.attributes.firmware = lines[1];
        }
      });

      // 5. Query Firmware explicitly if ATI was brief
      if (!this.attributes.firmware) {
        await execStep('AT+CGMR', (res) => {
          const lines = res.lines.filter(l => l !== 'OK');
          if (lines.length > 0) this.attributes.firmware = lines[0];
        });
      }

      // 6. Query SIM Status
      await execStep('AT+CPIN?', (res) => {
        const match = res.raw.match(/\+CPIN:\s*([^\r\n]+)/);
        if (match) {
          const status = match[1].trim();
          this.attributes.simStatus = status;
          if (status === 'READY') {
            this._setState(STATES.SIM_READY, 'Verified SIM READY');
          } else {
            this._setState(STATES.SIM_NOT_READY, `SIM Status: ${status}`);
          }
        }
      });

      // 7. Query Signal CSQ
      await execStep('AT+CSQ', (res) => {
        const match = res.raw.match(/\+CSQ:\s*(\d+),(\d+)/);
        if (match) {
          const rssi = parseInt(match[1], 10);
          const ber = parseInt(match[2], 10);
          this.attributes.signalCsq = rssi;
          this.attributes.signalBer = ber;
          this.attributes.signalPct = rssi === 99 ? 0 : Math.round((rssi / 31) * 100);
        }
      });

      // 8. Query GSM Registration
      await execStep('AT+CREG?', (res) => {
        const match = res.raw.match(/\+CREG:\s*(\d+),(\d+)/);
        if (match) {
          const stat = parseInt(match[2], 10);
          const isReg = stat === 1 || stat === 5;
          this.attributes.gsmRegistration = isReg ? 'REGISTERED' : (stat === 2 ? 'SEARCHING' : 'NOT_REGISTERED');
          if (isReg) {
            this._setState(STATES.NETWORK_REGISTERED, `Verified GSM Registered (stat=${stat})`);
          } else if (stat === 2) {
            this._setState(STATES.NETWORK_SEARCHING, 'Searching for GSM Network');
          }
        }
      });

      // 9. Query GPRS Registration
      await execStep('AT+CGREG?', (res) => {
        const match = res.raw.match(/\+CGREG:\s*(\d+),(\d+)/);
        if (match) {
          const stat = parseInt(match[2], 10);
          const isReg = stat === 1 || stat === 5;
          this.attributes.gprsRegistration = isReg ? 'REGISTERED' : (stat === 2 ? 'SEARCHING' : 'NOT_REGISTERED');
          if (isReg && this.state === STATES.NETWORK_REGISTERED) {
            this._setState(STATES.PACKET_REGISTERED, `Verified GPRS Packet Registered (stat=${stat})`);
          }
        }
      });

      // 10. Query GPRS Attachment status (Read-only query)
      await execStep('AT+CGATT?', (res) => {
        const match = res.raw.match(/\+CGATT:\s*(\d+)/);
        if (match) {
          const attached = parseInt(match[1], 10) === 1;
          this.attributes.gprsAttached = attached;
          if (attached && (this.state === STATES.PACKET_REGISTERED || this.state === STATES.NETWORK_REGISTERED)) {
            this._setState(STATES.PACKET_ATTACHED, 'Verified GPRS Packet Attached (CGATT: 1)');
          }
        }
      });

      // 11. Query Operator Name (Read-only query)
      try {
        await execStep('AT+COPS?', (res) => {
          const match = res.raw.match(/\+COPS:\s*\d+,\d+,"([^"]+)"/);
          if (match) {
            this.attributes.operator = match[1];
          }
        }, { timeoutMs: 3000 });
      } catch (e) {
        // Operator query can be slow or unselected; non-fatal
      }

      // 12. Query Battery / Voltage
      try {
        await execStep('AT+CBC', (res) => {
          const match = res.raw.match(/\+CBC:\s*\d+,\d+,(\d+)/);
          if (match) {
            this.attributes.voltage = (parseInt(match[1], 10) / 1000).toFixed(2);
          }
        }, { timeoutMs: 2000 });
      } catch (e) {
        // CBC non-fatal
      }

    } catch (err) {
      report.error = err.message;
    }

    report.attributes = { ...this.attributes };
    report.state = this.state;
    return report;
  }

  getSnapshot() {
    return {
      nodeId: this.nodeId,
      portPath: this.portPath,
      baudRate: this.baudRate,
      state: this.state,
      attributes: { ...this.attributes },
      gprs: this.gprsEngine ? this.gprsEngine.getSnapshot() : null,
      queueLength: this.commandQueue.length,
      isProcessingQueue: this.isProcessingQueue
    };
  }
}

module.exports = {
  NodeSession,
  STATES
};
