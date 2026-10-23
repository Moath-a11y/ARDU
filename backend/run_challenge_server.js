/**
 * BARQ LINK — RelayServer Standalone Runner
 * Listens on TCP 0.0.0.0:5050
 * Supports: BARQ-RELAY-v1 (persistent relay) + BARQ-CHALLENGE-v1 (legacy, backward-compat)
 */

const RelayServer = require('./src/server/RelayServer');
const fs = require('fs');
const path = require('path');

const PORT = 5050;
const server = new RelayServer({ port: PORT });
const logFile = path.join(__dirname, 'challenge_server_audit.log');

function logAudit(event, data) {
  const time = new Date().toISOString();
  const line = `[${time}] [${event}] ${JSON.stringify(data)}\n`;
  console.log(line.trim());
  fs.appendFileSync(logFile, line);
}

server.on('connection', ({ remoteInfo }) => {
  logAudit('CLIENT_CONNECTED', { peer: remoteInfo });
});

server.on('raw_inbound', ({ remoteInfo, raw }) => {
  logAudit('RAW_INBOUND_TCP', { peer: remoteInfo, bytes: raw.length, preview: raw.slice(0, 120) });
});

server.on('challenge_received', (record) => {
  logAudit('CHALLENGE_VERIFIED', {
    id: record.id,
    remoteAddress: record.remoteAddress,
    remotePort: record.remotePort,
    payload: record.payload
  });
});

server.on('response_sent', ({ remoteInfo, response }) => {
  logAudit('RESPONSE_SENT_TO_MODEM', { peer: remoteInfo, response });
});

server.on('socket_closed', ({ remoteInfo }) => {
  logAudit('CLIENT_DISCONNECTED', { peer: remoteInfo });
});

server.on('socket_error', ({ remoteInfo, error }) => {
  logAudit('SOCKET_ERROR', { peer: remoteInfo, error });
});

// ── BARQ-RELAY-v1 events ──────────────────────────────────────
server.on('device_registered', ({ deviceId, remoteInfo }) => {
  logAudit('DEVICE_REGISTERED', { deviceId, peer: remoteInfo });
});

server.on('device_offline', ({ deviceId }) => {
  logAudit('DEVICE_OFFLINE', { deviceId });
});

server.on('relay_forwarded', ({ msgId, from, to, payloadLength }) => {
  logAudit('RELAY_FORWARDED', { msgId, from, to, payloadLength });
});

server.on('delivery_confirmed', ({ msgId, from, to }) => {
  logAudit('DELIVERY_CONFIRMED', { msgId, from, to });
});

server.on('delivery_timeout', ({ msgId, from, to }) => {
  logAudit('DELIVERY_TIMEOUT', { msgId, from, to });
});

server.start().then(() => {
  console.log(`=======================================================`);
  console.log(`  BARQ LINK — CHALLENGE GATEWAY RUNNING ON TCP PORT ${PORT}`);
  console.log(`  Ready to receive cellular TCP connections...`);
  console.log(`=======================================================`);
}).catch((err) => {
  console.error('Fatal error starting ChallengeServer:', err);
  process.exit(1);
});

process.on('SIGINT', async () => {
  console.log('Stopping ChallengeServer...');
  await server.stop();
  process.exit(0);
});
