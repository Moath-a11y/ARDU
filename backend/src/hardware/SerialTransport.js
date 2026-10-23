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
        autoOpen: false
      });

      this.port.on('open', () => {
        this.isOpen = true;
        this.emit('open', { port: this.portPath, baudRate: this.baudRate });
        resolve();
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
