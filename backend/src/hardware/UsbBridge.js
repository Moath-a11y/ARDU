'use strict';

const { SerialPort } = require('serialport');

class UsbBridge {
  constructor() {
    this.portPath = 'COM4';
    this.port = null;
    this.lines = [];
    this.lastOpenError = null;
    this.opening = null;
    this.isCloud = Boolean(process.env.RENDER || process.platform === 'linux');
  }

  snapshot() {
    return {
      port: this.portPath,
      open: Boolean(this.port && this.port.isOpen),
      isCloud: this.isCloud,
      lastOpenError: this.isCloud ? null : this.lastOpenError,
      lines: this.lines.slice(-80)
    };
  }

  _push(line) {
    const text = String(line).replace(/\r/g, '').trimEnd();
    if (!text) return;
    this.lines.push({ at: new Date().toISOString(), text });
    if (this.lines.length > 200) this.lines.splice(0, this.lines.length - 200);
  }

  parseSteps() {
    const blob = this.lines.map((l) => l.text).join('\n');
    const modemOk = /\[AT OK\] OK|OK\r|FAIL want=OK/.test(blob)
      ? !/FAIL want=OK/.test(blob.split('\n').slice(-30).join('\n')) && /OK/.test(blob)
      : false;
    const recent = blob.slice(-2500);
    return {
      firmwareSeen: /BARQ LED/.test(blob),
      modemAtOk: /\[USB-RX\]/.test(recent) && !/\(لا رد من المودم\)/.test(recent.split('[USB-RX]').pop() || '')
        ? !/\(لا رد من المودم\)/.test(recent)
        : /  OK OK/.test(recent) || /\[AT OK\]/.test(recent),
      simReady: /READY/.test(recent) && !/FAIL want=READY/.test(recent.split('\n').slice(-12).join('\n')),
      gsm: /\+CREG:.*,[15]/.test(recent) || /\[3\] شبكة/.test(recent) && !/FAIL want=,1/.test(recent),
      gprs: /QIACT|QILOCIP|\[5\]/.test(recent),
      stuckModem: /FAIL want=OK/.test(recent),
      stuckSim: /FAIL want=READY/.test(recent),
      usbLed: /\[USB\] LED/.test(recent),
      modemSilent: /\(لا رد من المودم\)/.test(recent)
    };
  }

  async ensureOpen() {
    if (this.port && this.port.isOpen) return true;
    if (this.opening) return this.opening;
    this.opening = new Promise((resolve, reject) => {
      const port = new SerialPort({
        path: this.portPath,
        baudRate: 9600,
        autoOpen: false
      });
      this._buffer = '';
      port.on('data', (chunk) => {
        this._buffer += chunk.toString('utf8');
        const parts = this._buffer.split(/\r?\n/);
        this._buffer = parts.pop();
        for (const line of parts) {
          this._push(line);
        }
      });
      port.on('error', (err) => {
        this.lastOpenError = err.message;
        this._push('[USB] ' + err.message);
      });
      port.on('close', () => {
        this._push('[USB] المنفذ أقفل');
        if (this.port === port) this.port = null;
      });
      port.open((err) => {
        this.opening = null;
        if (err) {
          this.lastOpenError = err.message;
          reject(err);
          return;
        }
        this.port = port;
        this.lastOpenError = null;
        this._push('[USB] تم فتح COM4');
        if (typeof port.set === 'function') {
          port.set({ dtr: true, rts: false }, () => resolve(true));
        } else {
          resolve(true);
        }
      });
    });
    return this.opening;
  }

  async writeLine(line) {
    await this.ensureOpen();
    const payload = String(line).replace(/[\r\n]/g, '') + '\r\n';
    this._push('>> ' + line);
    await new Promise((resolve, reject) => {
      this.port.write(payload, (err) => (err ? reject(err) : this.port.drain(resolve)));
    });
  }

  async close() {
    if (!this.port) return;
    await new Promise((resolve) => {
      try {
        this.port.close(() => resolve());
      } catch {
        resolve();
      }
    });
    this.port = null;
    this._push('[USB] تم إغلاق COM4');
  }

  async command(line, waitMs = 4000) {
    const before = this.lines.length;
    await this.writeLine(line);
    const t0 = Date.now();
    while (Date.now() - t0 < waitMs) {
      await new Promise((r) => setTimeout(r, 150));
    }
    return this.lines.slice(before);
  }
}

module.exports = UsbBridge;
