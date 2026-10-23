/**
 * BARQ LINK — ChallengeServer
 * Configurable TCP Server for end-to-end cellular Internet verification.
 * Receives challenges from modems over TCP, logs remote carrier IP/port,
 * and replies with correlated acknowledgment.
 */

const net = require('net');
const { EventEmitter } = require('events');

class ChallengeServer extends EventEmitter {
  constructor(port = 5050) {
    super();
    this.port = port;
    this.server = null;
    this.isRunning = false;
    this.receivedChallenges = [];
    this.activeSockets = new Set();
  }

  async start() {
    if (this.isRunning) return;

    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        const remoteInfo = `${socket.remoteAddress}:${socket.remotePort}`;
        this.activeSockets.add(socket);
        this.emit('connection', { remoteInfo });

        let buffer = '';

        socket.on('data', (chunk) => {
          const raw = chunk.toString('utf8');
          buffer += raw;

          this.emit('raw_inbound', { remoteInfo, raw });

          // Try to extract JSON or delimited challenge
          try {
            // Support JSON payloads
            const match = buffer.match(/\{[\s\S]*\}/);
            if (match) {
              const parsed = JSON.parse(match[0]);
              buffer = ''; // consumed

              const record = {
                id: 'ch_' + Date.now(),
                receivedAt: new Date().toISOString(),
                remoteAddress: socket.remoteAddress,
                remotePort: socket.remotePort,
                payload: parsed
              };
              this.receivedChallenges.unshift(record);
              if (this.receivedChallenges.length > 50) this.receivedChallenges.pop();

              this.emit('challenge_received', record);

              // Send Correlated Response
              const responseObj = {
                correlationId: parsed.correlationId || parsed.corrId || 'UNKNOWN',
                corrId: parsed.correlationId || parsed.corrId || 'UNKNOWN',
                nodeId: parsed.nodeId || 'UNKNOWN',
                status: 'ACK_CHALLENGE_VERIFIED',
                echo: parsed.challenge || parsed.echo || parsed.payload || 'NO_ECHO',
                serverTime: new Date().toISOString(),
                serverPeer: remoteInfo
              };

              const replyStr = JSON.stringify(responseObj) + '\r\n';
              socket.write(replyStr, () => {
                this.emit('response_sent', { remoteInfo, response: responseObj });
              });
            }
          } catch (e) {
            // Wait for more data if incomplete JSON
          }
        });

        socket.on('close', () => {
          this.activeSockets.delete(socket);
          this.emit('socket_closed', { remoteInfo });
        });

        socket.on('error', (err) => {
          this.activeSockets.delete(socket);
          this.emit('socket_error', { remoteInfo, error: err.message });
        });
      });

      this.server.on('error', reject);

      this.server.listen(this.port, '0.0.0.0', () => {
        this.isRunning = true;
        console.log(`⚡ [CHALLENGE SERVER] Listening on TCP 0.0.0.0:${this.port}`);
        resolve();
      });
    });
  }

  getAuditLog() {
    return [...this.receivedChallenges];
  }

  async stop() {
    if (!this.isRunning || !this.server) return;

    for (const s of this.activeSockets) {
      s.destroy();
    }
    this.activeSockets.clear();

    return new Promise((resolve) => {
      this.server.close(() => {
        this.isRunning = false;
        resolve();
      });
    });
  }
}

module.exports = ChallengeServer;
