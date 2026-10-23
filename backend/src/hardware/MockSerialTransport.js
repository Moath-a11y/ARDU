/**
 * BARQ LINK — Mock Serial Transport
 * Emulates serial communication for deterministic unit tests.
 */

const { EventEmitter } = require('events');

class MockSerialTransport extends EventEmitter {
  constructor(portPath, baudRate = 9600) {
    super();
    this.portPath = portPath;
    this.baudRate = baudRate;
    this.isOpen = false;
    this.writtenHistory = [];
    this.scriptedResponses = new Map(); // Command -> response string or array of chunks
  }

  async open() {
    this.isOpen = true;
    process.nextTick(() => {
      this.emit('open', { port: this.portPath, baudRate: this.baudRate });
    });
  }

  setScriptedResponse(cmd, response, delayMs = 10) {
    this.scriptedResponses.set(cmd.trim(), { response, delayMs });
  }

  async write(data) {
    if (!this.isOpen) throw new Error(`PORT_NOT_OPEN_${this.portPath}`);
    this.writtenHistory.push(data);

    const cmdKey = data.toString().trim();
    if (this.scriptedResponses.has(cmdKey)) {
      const { response, delayMs } = this.scriptedResponses.get(cmdKey);
      setTimeout(() => {
        if (!this.isOpen) return;
        if (Array.isArray(response)) {
          for (let i = 0; i < response.length; i++) {
            setTimeout(() => {
              if (this.isOpen) this.emit('data', response[i], Buffer.from(response[i]));
            }, i * 20);
          }
        } else {
          this.emit('data', response, Buffer.from(response));
        }
      }, delayMs);
    }
  }

  simulateIncoming(chunk) {
    if (this.isOpen) {
      this.emit('data', chunk, Buffer.from(chunk));
    }
  }

  simulateDisconnect() {
    if (this.isOpen) {
      this.isOpen = false;
      this.emit('close', { port: this.portPath });
    }
  }

  async close() {
    this.isOpen = false;
    this.emit('close', { port: this.portPath });
  }
}

module.exports = MockSerialTransport;
