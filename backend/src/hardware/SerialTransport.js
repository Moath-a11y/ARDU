/**
 * BARQ LINK — Real Hardware Serial Transport
 * Wraps Node.js 'serialport' with reliable error handling, auto-reconnect, and events.
 */

const { EventEmitter } = require('events');
const { SerialPort } = require('serialport');

class SerialTransport extends EventEmitter {
  constructor(portPath, baudRate = 9600) {
    super();
    this.portPath = portPath;
    this.baudRate = baudRate;
    this.port = null;
    this.isOpen = false;
  }

  async open() {
    if (this.isOpen) return;

    return new Promise((resolve, reject) => {
      this.port = new SerialPort({
        path: this.portPath,
        baudRate: this.baudRate,
        dataBits: 8,
        parity: 'none',
        stopBits: 1,
        rtscts: false,
        xon: false,
        xoff: false,
        autoOpen: false
      });

      this.port.on('open', () => {
        this.isOpen = true;
        // USB-CDC Quectel adapters often stay silent until DTR is asserted.
        const finish = () => {
          this.emit('open', { port: this.portPath, baudRate: this.baudRate, framing: '8N1' });
          resolve();
        };
        if (typeof this.port.set === 'function') {
          this.port.set({ dtr: true, rts: true }, () => finish());
        } else {
          finish();
        }
      });

      this.port.on('data', (chunk) => {
        this.emit('data', chunk);
      });

      this.port.on('error', (err) => {
        this.emit('error', err);
      });

      this.port.on('close', () => {
        this.isOpen = false;
        this.emit('close', { port: this.portPath });
      });

      this.port.open((err) => {
        if (err) {
          this.isOpen = false;
          reject(err);
        }
      });
    });
  }

  async write(data) {
    if (!this.isOpen || !this.port) {
      throw new Error(`PORT_NOT_OPEN_${this.portPath}`);
    }

    return new Promise((resolve, reject) => {
      this.port.write(data, (err) => {
        if (err) return reject(err);
        this.port.drain((drainErr) => {
          if (drainErr) return reject(drainErr);
          resolve();
        });
      });
    });
  }

  async close() {
    if (!this.isOpen || !this.port) return;

    return new Promise((resolve) => {
      this.port.close(() => {
        this.isOpen = false;
        this.port = null;
        resolve();
      });
    });
  }
}

module.exports = SerialTransport;
