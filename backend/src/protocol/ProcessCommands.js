/**
 * BARQ LINK — Process command catalogue carried inside RELAY.payload.
 * SEND OK is never execution. DELIVERY_ACK is allowed only after PIC I/O completes.
 */

'use strict';

const CATALOG = {
  DO_SET:   { pic: true,  requiresArm: true,  channels: true },
  DO_PULSE: { pic: true,  requiresArm: true,  channels: true },
  DI_READ:  { pic: true,  requiresArm: false, channels: true },
  DO_SAFE:  { pic: true,  requiresArm: false, channels: false },
  HB:       { pic: false, requiresArm: false, channels: false }
};

function parsePayload(payload) {
  if (payload && typeof payload === 'object') return payload;
  if (typeof payload !== 'string') return null;
  try {
    return JSON.parse(payload);
  } catch (_) {
    return null;
  }
}

function isProcessCommand(payload) {
  const obj = parsePayload(payload);
  return !!(obj && typeof obj.cmd === 'string' && CATALOG[obj.cmd]);
}

function validateProcessCommand(payload, opts = {}) {
  const obj = parsePayload(payload);
  if (!obj || typeof obj.cmd !== 'string') {
    return { ok: false, code: 'NOT_PROCESS_CMD', command: null };
  }
  const spec = CATALOG[obj.cmd];
  if (!spec) {
    return { ok: false, code: 'UNKNOWN_CMD', command: obj };
  }
  if (spec.channels) {
    const ch = Number(obj.ch);
    if (!Number.isInteger(ch) || ch < 1 || ch > 8) {
      return { ok: false, code: 'BAD_CHANNEL', command: obj };
    }
  }
  if (obj.cmd === 'DO_SET') {
    const val = Number(obj.val);
    if (val !== 0 && val !== 1) {
      return { ok: false, code: 'BAD_VALUE', command: obj };
    }
  }
  if (obj.cmd === 'DO_PULSE') {
    const pulseMs = Number(obj.pulseMs || 0);
    if (!Number.isInteger(pulseMs) || pulseMs < 1 || pulseMs > 60000) {
      return { ok: false, code: 'BAD_PULSE', command: obj };
    }
  }
  const armed = obj.safety === 'ARMED' || opts.armed === true;
  if (spec.requiresArm && !armed) {
    return { ok: false, code: 'NOT_ARMED', command: obj, spec };
  }
  return { ok: true, code: 'OK', command: obj, spec };
}

function serializeProcessCommand(command) {
  return JSON.stringify(command);
}

function safeShutdownCommand() {
  return { cmd: 'DO_SAFE', safety: 'SAFE', ts: new Date().toISOString() };
}

module.exports = {
  CATALOG,
  parsePayload,
  isProcessCommand,
  validateProcessCommand,
  serializeProcessCommand,
  safeShutdownCommand
};
