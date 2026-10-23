/**
 * BARQ LINK — Operator command path: web → REST → RelayServer → cellular RTU.
 * Laptop USB is not used.
 */

'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');
const {
  validateProcessCommand,
  serializeProcessCommand,
  safeShutdownCommand
} = require('../protocol/ProcessCommands');

class FieldCommandService extends EventEmitter {
  constructor(relayServer, opts = {}) {
    super();
    this.relay = relayServer;
    this.armWindowMs = opts.armWindowMs || 30000;
    this._armedUntil = 0;
    this.commandLog = [];
  }

  isArmed() {
    return Date.now() < this._armedUntil;
  }

  arm(windowMs) {
    const ms = windowMs || this.armWindowMs;
    this._armedUntil = Date.now() + ms;
    const rec = { at: new Date().toISOString(), type: 'ARM', until: this._armedUntil };
    this._log(rec);
    this.emit('armed', rec);
    return rec;
  }

  disarm() {
    this._armedUntil = 0;
    this.emit('disarmed');
  }

  async sendCommand(toDeviceId, command, timeoutMs = 25000) {
    const armed = this.isArmed();
    const payloadObj = typeof command === 'string' ? { cmd: command } : { ...command };
    if (armed && payloadObj.cmd && payloadObj.cmd !== 'DO_SAFE' && payloadObj.cmd !== 'HB' && payloadObj.cmd !== 'DI_READ') {
      payloadObj.safety = 'ARMED';
    }
    const v = validateProcessCommand(payloadObj, { armed });
    if (!v.ok) {
      const err = new Error(v.code);
      err.code = v.code;
      throw err;
    }
    const payload = serializeProcessCommand(v.command);
    const msgId = `HMI-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const t0 = Date.now();
    const entry = {
      id: msgId,
      from: 'HMI',
      to: toDeviceId,
      payload,
      command: v.command,
      status: 'QUEUED',
      sentAt: new Date().toISOString()
    };
    this._log(entry);
    this.emit('queued', entry);

    const ack = await this.relay.injectRelay('HMI', toDeviceId, payload, { msgId, timeoutMs });
    entry.status = 'DELIVERED';
    entry.deliveredAt = new Date().toISOString();
    entry.rttMs = Date.now() - t0;
    entry.ack = ack;
    this.emit('delivered', entry);
    return entry;
  }

  async safeAll(timeoutMs = 15000) {
    const sessions = Object.keys(this.relay.getActiveSessions());
    const results = {};
    this.disarm();
    for (const id of sessions) {
      if (id === 'HMI') continue;
      try {
        results[id] = await this.sendCommand(id, safeShutdownCommand(), timeoutMs);
      } catch (err) {
        results[id] = { status: 'FAILED', error: err.message };
      }
    }
    return results;
  }

  _log(entry) {
    this.commandLog.unshift(entry);
    if (this.commandLog.length > 100) this.commandLog.pop();
  }
}

module.exports = FieldCommandService;
