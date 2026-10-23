/**
 * BARQ LINK — Short binary bus between comms MCU and PIC I/O controller.
 * Fixed 8-byte frame. Not JSON. Not AT.
 *
 * Byte layout:
 *  0  sync     0xA5
 *  1  cmd
 *  2  channel  1-8 (0 = all)
 *  3  val_lo
 *  4  val_hi
 *  5  flags    bit0 = ARMED
 *  6  seq
 *  7  crc8     Dallas/Maxim over bytes 1-6
 */

'use strict';

const SYNC = 0xA5;
const CMD = {
  DO_SET:   0x01,
  DO_PULSE: 0x02,
  DI_READ:  0x03,
  DO_SAFE:  0x04,
  HB:       0x05,
  ACK:      0x81,
  NACK:     0x82,
  DI_VALUE: 0x83
};

const FLAG_ARMED = 0x01;
const FRAME_LEN = 8;

function crc8(bytes) {
  let crc = 0x00;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let b = 0; b < 8; b++) {
      crc = (crc & 0x80) ? ((crc << 1) ^ 0x31) & 0xFF : (crc << 1) & 0xFF;
    }
  }
  return crc;
}

function encodeFrame({ cmd, ch = 0, value = 0, armed = false, seq = 0 }) {
  const cmdByte = typeof cmd === 'string' ? CMD[cmd] : cmd;
  if (cmdByte === undefined) throw new Error('PIC_BUS_UNKNOWN_CMD');
  const buf = Buffer.alloc(FRAME_LEN);
  buf[0] = SYNC;
  buf[1] = cmdByte & 0xFF;
  buf[2] = ch & 0xFF;
  buf.writeUInt16LE(value & 0xFFFF, 3);
  buf[5] = armed ? FLAG_ARMED : 0;
  buf[6] = seq & 0xFF;
  buf[7] = crc8(buf.subarray(1, 7));
  return buf;
}

function decodeFrame(buf) {
  const frame = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (frame.length !== FRAME_LEN) return { ok: false, code: 'BAD_LEN' };
  if (frame[0] !== SYNC) return { ok: false, code: 'BAD_SYNC' };
  const expect = crc8(frame.subarray(1, 7));
  if (frame[7] !== expect) return { ok: false, code: 'BAD_CRC' };
  const cmdCode = frame[1];
  const name = Object.keys(CMD).find((k) => CMD[k] === cmdCode) || null;
  return {
    ok: true,
    cmd: name,
    cmdCode,
    ch: frame[2],
    value: frame.readUInt16LE(3),
    armed: !!(frame[5] & FLAG_ARMED),
    seq: frame[6]
  };
}

function fromProcessCommand(command, seq = 0) {
  const map = {
    DO_SET: CMD.DO_SET,
    DO_PULSE: CMD.DO_PULSE,
    DI_READ: CMD.DI_READ,
    DO_SAFE: CMD.DO_SAFE,
    HB: CMD.HB
  };
  const cmd = map[command.cmd];
  if (!cmd) throw new Error('PIC_BUS_NO_MAPPING');
  const value = command.cmd === 'DO_PULSE'
    ? Number(command.pulseMs || 0)
    : Number(command.val || 0);
  return encodeFrame({
    cmd,
    ch: Number(command.ch || 0),
    value,
    armed: command.safety === 'ARMED',
    seq
  });
}

function requiresArm(cmdName) {
  return cmdName === 'DO_SET' || cmdName === 'DO_PULSE';
}

module.exports = {
  SYNC,
  CMD,
  FLAG_ARMED,
  FRAME_LEN,
  crc8,
  encodeFrame,
  decodeFrame,
  fromProcessCommand,
  requiresArm
};
