/**
 * BARQ LINK — PIC I/O runtime (lab + firmware contract).
 * Executes armed process commands on 8 digital outputs / 8 digital inputs.
 * Fail-safe: if no valid command within failSafeMs, all outputs drop to 0.
 */

'use strict';

const { validateProcessCommand, safeShutdownCommand } = require('../protocol/ProcessCommands');
const { fromProcessCommand, decodeFrame, requiresArm } = require('../protocol/PicBus');

class PicIoRuntime {
  constructor(opts = {}) {
    this.failSafeMs = opts.failSafeMs || 15000;
    this.outputs = [0, 0, 0, 0, 0, 0, 0, 0];
    this.inputs = [0, 0, 0, 0, 0, 0, 0, 0];
    this.lastCommandAt = 0;
    this.seq = 0;
    this.lastResult = null;
  }

  applyFailSafeIfNeeded(now = Date.now()) {
    if (this.lastCommandAt && now - this.lastCommandAt > this.failSafeMs) {
      this.outputs.fill(0);
      this.lastResult = { ok: true, failSafe: true, command: safeShutdownCommand() };
      return true;
    }
    return false;
  }

  execute(payload, opts = {}) {
    this.applyFailSafeIfNeeded();
    const v = validateProcessCommand(payload, opts);
    if (!v.ok) {
      this.lastResult = { ok: false, code: v.code, executed: false };
      return this.lastResult;
    }
    const cmd = v.command;
    if (v.spec.pic && requiresArm(cmd.cmd) && cmd.safety !== 'ARMED' && !opts.armed) {
      this.lastResult = { ok: false, code: 'NOT_ARMED', executed: false };
      return this.lastResult;
    }

    const frame = fromProcessCommand(cmd, ++this.seq);
    const decoded = decodeFrame(frame);
    if (!decoded.ok) {
      this.lastResult = { ok: false, code: decoded.code, executed: false };
      return this.lastResult;
    }

    switch (cmd.cmd) {
      case 'DO_SET':
        this.outputs[cmd.ch - 1] = cmd.val ? 1 : 0;
        break;
      case 'DO_PULSE':
        this.outputs[cmd.ch - 1] = 1;
        break;
      case 'DI_READ':
        break;
      case 'DO_SAFE':
        this.outputs.fill(0);
        break;
      case 'HB':
        break;
      default:
        this.lastResult = { ok: false, code: 'UNKNOWN_CMD', executed: false };
        return this.lastResult;
    }

    this.lastCommandAt = Date.now();
    this.lastResult = {
      ok: true,
      executed: true,
      command: cmd,
      outputs: this.outputs.slice(),
      input: cmd.cmd === 'DI_READ' ? this.inputs[cmd.ch - 1] : null,
      frame: frame.toString('hex')
    };
    return this.lastResult;
  }

  setInput(ch, val) {
    if (ch >= 1 && ch <= 8) this.inputs[ch - 1] = val ? 1 : 0;
  }
}

module.exports = PicIoRuntime;
