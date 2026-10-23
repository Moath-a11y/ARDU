/**
 * BARQ LINK — Local radio fallback when GPRS is down.
 * Radio carries the same PIC bus frame, never AT, never JSON on air if possible.
 *
 * Conflict rule: if cellular and radio commands disagree inside the conflict
 * window, apply DO_SAFE — never "last command wins".
 */

'use strict';

const { fromProcessCommand, decodeFrame, encodeFrame, CMD } = require('./PicBus');
const { safeShutdownCommand, validateProcessCommand } = require('./ProcessCommands');

function encodeRadioDatagram(command, seq = 0) {
  const v = validateProcessCommand(command, { armed: command.safety === 'ARMED' });
  if (!v.ok && v.code !== 'NOT_ARMED') {
    throw new Error(`RADIO_BAD_CMD_${v.code}`);
  }
  return fromProcessCommand(command, seq);
}

function decodeRadioDatagram(buf) {
  return decodeFrame(buf);
}

function commandsDisagree(a, b) {
  if (!a || !b) return false;
  if (a.cmd !== b.cmd) return true;
  if (Number(a.ch || 0) !== Number(b.ch || 0)) return true;
  if (Number(a.val || 0) !== Number(b.val || 0)) return true;
  if (Number(a.pulseMs || 0) !== Number(b.pulseMs || 0)) return true;
  return false;
}

/**
 * @param {object|null} cellularCmd
 * @param {object|null} radioCmd
 * @param {number} cellularAgeMs
 * @param {number} radioAgeMs
 * @param {number} windowMs
 */
function resolveConflict(cellularCmd, radioCmd, cellularAgeMs, radioAgeMs, windowMs = 2000) {
  const cOk = cellularCmd && cellularAgeMs <= windowMs;
  const rOk = radioCmd && radioAgeMs <= windowMs;

  if (cOk && rOk && commandsDisagree(cellularCmd, radioCmd)) {
    return {
      action: 'SAFE',
      reason: 'CELLULAR_RADIO_CONFLICT',
      command: safeShutdownCommand()
    };
  }
  if (cOk) {
    return { action: 'CELLULAR', reason: 'CELLULAR_FRESH', command: cellularCmd };
  }
  if (rOk) {
    return { action: 'RADIO', reason: 'GPRS_DEGRADED', command: radioCmd };
  }
  return {
    action: 'SAFE',
    reason: 'NO_FRESH_COMMAND',
    command: safeShutdownCommand()
  };
}

function gprsLostSafeFrame(seq = 0) {
  return encodeFrame({ cmd: CMD.DO_SAFE, ch: 0, value: 0, armed: false, seq });
}

module.exports = {
  encodeRadioDatagram,
  decodeRadioDatagram,
  commandsDisagree,
  resolveConflict,
  gprsLostSafeFrame
};
