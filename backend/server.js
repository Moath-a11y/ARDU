/**
 * BARQ LINK · IOT ENTERPRISE BACKEND
 * Integrated Real Hardware Controller (COM3 & COM4) + Relay Server (TCP 5050) + REST API (4000) + WebSocket Gateway (4001)
 * 100% Real Hardware Driven · Zero Simulation / Zero Mock in Operational Path
 */

'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const HardwareController = require('./src/hardware/HardwareController');
const RelayServer = require('./src/server/RelayServer');
const TunnelManager = require('./src/server/TunnelManager');
const { STATES } = require('./src/hardware/NodeSession');

// Global Process Error Handlers to prevent hardware/serial disconnects from crashing server
process.on('unhandledRejection', (reason) => {
  console.warn('⚠️ [UNHANDLED REJECTION]', reason && reason.message ? reason.message : reason);
});
process.on('uncaughtException', (err) => {
  console.error('❌ [UNCAUGHT EXCEPTION]', err && err.message ? err.message : err);
});

const HTTP_PORT = parseInt(process.env.PORT || '4000', 10);
const WS_PORT = parseInt(process.env.WS_PORT || '4001', 10);
const TCP_CHALLENGE_PORT = parseInt(process.env.TCP_PORT || '5050', 10);

// ============================================================
// 1. HARDWARE CONTROLLER & RELAY SERVER INSTANTIATION
// ============================================================
const hwController = new HardwareController({
  alphaPort: 'COM3',
  bravoPort: 'COM4',
  baudRate: 9600
});

const challengeServer = new RelayServer({ port: TCP_CHALLENGE_PORT }); // BARQ-RELAY-v1 + BARQ-CHALLENGE-v1 compat
const tunnelManager = new TunnelManager(TCP_CHALLENGE_PORT);
hwController.setTunnelManager(tunnelManager);
hwController.setRelayServer(challengeServer);

// WebSocket Clients Set
const wsClients = new Set();

function broadcastWs(eventType, payload) {
  const msg = JSON.stringify({ type: eventType, data: payload, timestamp: new Date().toISOString() });
  for (const client of wsClients) {
    if (!client.destroyed && client.writable) {
      try {
        sendWsFrame(client, msg);
      } catch (e) {
        wsClients.delete(client);
      }
    }
  }
}

// Attach Hardware Events to WebSocket Broadcaster
hwController.on('node_state_change', (evt) => {
  broadcastWs('NODE_STATE_CHANGE', evt);
  broadcastWs('NODE_SNAPSHOT', hwController.getSnapshot());
});

hwController.on('node_gprs_change', (evt) => {
  broadcastWs('GPRS_STATE_CHANGE', evt);
  broadcastWs('NODE_SNAPSHOT', hwController.getSnapshot());
});

hwController.on('node_telemetry', (evt) => {
  broadcastWs('NODE_TELEMETRY', evt);
});

hwController.on('raw_event', (evt) => {
  broadcastWs('RAW_AT_EVENT', evt);
});

hwController.on('node_error', (evt) => {
  broadcastWs('NODE_ERROR', evt);
});

hwController.on('relay_state_change', (evt) => {
  broadcastWs('RELAY_STATE_CHANGE', evt);
  broadcastWs('NODE_SNAPSHOT', hwController.getSnapshot());
});

hwController.on('message_queued', (msg) => {
  broadcastWs('RELAY_MESSAGE_QUEUED', msg);
});

hwController.on('message_sent', (msg) => {
  broadcastWs('RELAY_MESSAGE_SENT', msg);
});

hwController.on('message_delivered', (msg) => {
  broadcastWs('RELAY_MESSAGE_DELIVERED', msg);
  broadcastWs('NODE_SNAPSHOT', hwController.getSnapshot());
});

hwController.on('message_failed', (msg) => {
  broadcastWs('RELAY_MESSAGE_FAILED', msg);
  broadcastWs('NODE_SNAPSHOT', hwController.getSnapshot());
});

hwController.on('message_received', (msg) => {
  broadcastWs('RELAY_MESSAGE_RECEIVED', msg);
  broadcastWs('NODE_SNAPSHOT', hwController.getSnapshot());
});

hwController.on('delivery_ack_sent', (evt) => {
  broadcastWs('DELIVERY_ACK_SENT', evt);
});

challengeServer.on('challenge_received', (rec) => {
  broadcastWs('SERVER_CHALLENGE_RECEIVED', rec);
});

challengeServer.on('response_sent', (rec) => {
  broadcastWs('SERVER_RESPONSE_SENT', rec);
});

challengeServer.on('device_registered', (rec) => {
  broadcastWs('SERVER_DEVICE_REGISTERED', rec);
});

challengeServer.on('device_offline', (rec) => {
  broadcastWs('SERVER_DEVICE_OFFLINE', rec);
});

challengeServer.on('relay_forwarded', (rec) => {
  broadcastWs('SERVER_RELAY_FORWARDED', rec);
});

challengeServer.on('delivery_confirmed', (rec) => {
  broadcastWs('SERVER_DELIVERY_CONFIRMED', rec);
});

tunnelManager.on('ready', (endpoint) => {
  broadcastWs('TUNNEL_ENDPOINT_UPDATED', endpoint);
  broadcastWs('NODE_SNAPSHOT', hwController.getSnapshot());
});

// ============================================================
// ============================================================
// 2. UNIFIED WEB DASHBOARD & REST API (HTTP Port 4000)
// ============================================================
const FRONTEND_DIR = path.resolve(__dirname, '..', 'frontend');
const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.webp': 'image/webp'
};

const apiServer = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // Serve Static Frontend files for non-API routes
  if (!pathname.startsWith('/api')) {
    let relPath = pathname;
    if (relPath === '/' || relPath === '') relPath = '/index.html';
    const filePath = path.resolve(FRONTEND_DIR, '.' + relPath);
    if (!filePath.startsWith(FRONTEND_DIR)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Forbidden');
    }

    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) {
        if (!path.extname(relPath)) {
          const indexFile = path.join(FRONTEND_DIR, 'index.html');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          return fs.createReadStream(indexFile).pipe(res);
        }
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(`404: Not Found`);
      }

      const ext = path.extname(filePath).toLowerCase();
      const mime = STATIC_MIME[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      fs.createReadStream(filePath).pipe(res);
    });
    return;
  }

  const sendJson = (statusCode, data) => {
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  };

  const readJsonBody = () => new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error('INVALID_JSON'));
      }
    });
  });

  // 1. Platform Health
  if (pathname === '/api/health' && req.method === 'GET') {
    return sendJson(200, {
      status: 'HEALTHY',
      platform: 'BARQ LINK Hardware Controller Core',
      version: '3.1.0-LIVE',
      uptimeSec: Math.floor(process.uptime()),
      activeWsSessions: wsClients.size,
      challengeServerRunning: challengeServer.isRunning,
      hardware: {
        alphaPort: hwController.alphaPort,
        bravoPort: hwController.bravoPort,
        isInitialized: hwController.isInitialized
      }
    });
  }

  // 2. Nodes List (Snapshot)
  if (pathname === '/api/nodes' && req.method === 'GET') {
    return sendJson(200, hwController.getSnapshot());
  }

  // 3. Single Node Details
  if (pathname.startsWith('/api/nodes/') && req.method === 'GET' && !pathname.includes('/', 12)) {
    const nodeId = pathname.replace('/api/nodes/', '').toUpperCase();
    const node = hwController.getNode(nodeId);
    if (!node) return sendJson(404, { error: `Node ${nodeId} not found` });
    return sendJson(200, node.getSnapshot());
  }

  // 4. Trigger Diagnostics Scan
  if (pathname === '/api/diagnostics/stage2' && req.method === 'POST') {
    try {
      const reports = await hwController.runAllDiagnostics();
      broadcastWs('DIAGNOSTICS_COMPLETED', reports);
      return sendJson(200, { success: true, reports });
    } catch (err) {
      return sendJson(500, { success: false, error: err.message });
    }
  }

  // 5. Open Node Serial Port
  if (pathname.match(/^\/api\/nodes\/([^\/]+)\/serial\/open$/) && req.method === 'POST') {
    const nodeId = pathname.match(/^\/api\/nodes\/([^\/]+)\/serial\/open$/)[1].toUpperCase();
    try {
      const result = await hwController.openNode(nodeId);
      broadcastWs('NODE_SNAPSHOT', hwController.getSnapshot());
      return sendJson(200, { success: true, ...result });
    } catch (err) {
      return sendJson(500, { success: false, error: err.message });
    }
  }

  // 6. Close Node Serial Port
  if (pathname.match(/^\/api\/nodes\/([^\/]+)\/serial\/close$/) && req.method === 'POST') {
    const nodeId = pathname.match(/^\/api\/nodes\/([^\/]+)\/serial\/close$/)[1].toUpperCase();
    try {
      const result = await hwController.closeNode(nodeId);
      broadcastWs('NODE_SNAPSHOT', hwController.getSnapshot());
      return sendJson(200, { success: true, ...result });
    } catch (err) {
      return sendJson(500, { success: false, error: err.message });
    }
  }

  // 7. Initialize GPRS (APN + QINDI=1 + Activate + Query IP)
  if (pathname.match(/^\/api\/nodes\/([^\/]+)\/relay\/init-gprs$/) && req.method === 'POST') {
    const nodeId = pathname.match(/^\/api\/nodes\/([^\/]+)\/relay\/init-gprs$/)[1].toUpperCase();
    try {
      const { apn } = await readJsonBody();
      const result = await hwController.initGprs(nodeId, apn || 'internet');
      broadcastWs('NODE_SNAPSHOT', hwController.getSnapshot());
      return sendJson(200, { success: true, ...result });
    } catch (err) {
      return sendJson(500, { success: false, error: err.message });
    }
  }

  // 8. Connect to Relay Server (Full Handshake + REGISTER_ACK)
  if (pathname.match(/^\/api\/nodes\/([^\/]+)\/relay\/connect$/) && req.method === 'POST') {
    const nodeId = pathname.match(/^\/api\/nodes\/([^\/]+)\/relay\/connect$/)[1].toUpperCase();
    try {
      const { host, port, apn } = await readJsonBody();
      const result = await hwController.connectRelay(nodeId, host, port, apn || 'internet');
      broadcastWs('NODE_SNAPSHOT', hwController.getSnapshot());
      return sendJson(200, { success: true, ...result });
    } catch (err) {
      return sendJson(500, { success: false, error: err.message });
    }
  }

  // 9. Disconnect Node from Relay Server
  if (pathname.match(/^\/api\/nodes\/([^\/]+)\/relay\/disconnect$/) && req.method === 'POST') {
    const nodeId = pathname.match(/^\/api\/nodes\/([^\/]+)\/relay\/disconnect$/)[1].toUpperCase();
    try {
      const result = await hwController.disconnectRelay(nodeId);
      broadcastWs('NODE_SNAPSHOT', hwController.getSnapshot());
      return sendJson(200, { success: true, ...result });
    } catch (err) {
      return sendJson(500, { success: false, error: err.message });
    }
  }

  // 10. Refresh Node Hardware Status (Read-Only AT Queries)
  if (pathname.match(/^\/api\/nodes\/([^\/]+)\/status\/refresh$/) && req.method === 'POST') {
    const nodeId = pathname.match(/^\/api\/nodes\/([^\/]+)\/status\/refresh$/)[1].toUpperCase();
    try {
      const snapshot = await hwController.refreshNodeStatus(nodeId);
      broadcastWs('NODE_SNAPSHOT', hwController.getSnapshot());
      return sendJson(200, { success: true, nodeId, snapshot });
    } catch (err) {
      return sendJson(500, { success: false, error: err.message });
    }
  }

  // 11. Send Application Message (RELAY) & Await DELIVERY_ACK
  if (pathname === '/api/relay/send' && req.method === 'POST') {
    try {
      const { from, to, payload, timeoutMs } = await readJsonBody();
      if (!from || !to || !payload) {
        return sendJson(400, { error: 'from, to, and payload are required' });
      }

      const fromId = from.toUpperCase();
      const toId = to.toUpperCase();
      const localClient = hwController.relayClients.get(fromId);
      if (localClient && localClient._state === 'REGISTERED') {
        chatMsg = await hwController.sendRelayMessage(fromId, toId, payload, timeoutMs || 25000);
      } else {
        // Standalone cellular node mode: dispatch through challengeServer directly over TCP
        chatMsg = await challengeServer.sendRelayFromWeb(fromId, toId, payload, timeoutMs || 25000);
        hwController._addMessage(chatMsg);
        broadcastWs('RELAY_MESSAGE_DELIVERED', chatMsg);
      }

      broadcastWs('NODE_SNAPSHOT', hwController.getSnapshot());
      return sendJson(200, { success: true, message: chatMsg });
    } catch (err) {
      return sendJson(500, { success: false, error: err.message });
    }
  }

  // 12. Message History
  if (pathname === '/api/relay/messages' && req.method === 'GET') {
    return sendJson(200, hwController.messages);
  }

  // 13. Emergency STOP ALL
  if (pathname === '/api/emergency/stop-all' && req.method === 'POST') {
    try {
      const results = await hwController.emergencyStopAll();
      broadcastWs('EMERGENCY_STOP', results);
      broadcastWs('NODE_SNAPSHOT', hwController.getSnapshot());
      return sendJson(200, { success: true, results });
    } catch (err) {
      return sendJson(500, { success: false, error: err.message });
    }
  }

  // 14. Active Relay / Tunnel Endpoint
  if (pathname === '/api/tunnel/endpoint' && req.method === 'GET') {
    return sendJson(200, hwController.getDefaultRelayEndpoint());
  }

  // 15. Send Manual AT Command to Node
  if (pathname.match(/^\/api\/nodes\/([^\/]+)\/at$/) && req.method === 'POST') {
    const nodeId = pathname.match(/^\/api\/nodes\/([^\/]+)\/at$/)[1].toUpperCase();
    const node = hwController.getNode(nodeId);
    if (!node) return sendJson(404, { error: `Node ${nodeId} not found` });

    try {
      const { command, timeoutMs } = await readJsonBody();
      if (!command) return sendJson(400, { error: 'Command is required' });

      const result = await node.sendCommand(command, { timeoutMs: timeoutMs || 5000 });
      return sendJson(200, {
        success: true,
        nodeId,
        command,
        raw: result.raw,
        lines: result.lines
      });
    } catch (err) {
      return sendJson(500, { success: false, error: err.message });
    }
  }

  // 16. Raw Logs Feed
  if (pathname === '/api/raw-logs' && req.method === 'GET') {
    return sendJson(200, hwController.rawLogs);
  }

  // Fallback 404
  return sendJson(404, { error: 'Not Found' });
});

apiServer.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`🚀 [BARQ REST API] Listening on http://localhost:${HTTP_PORT}`);
});

// ============================================================
// 3. NATIVE WEBSOCKET GATEWAY (Dual Ports: HTTP_PORT & WS_PORT)
// ============================================================
const wsHttpServer = http.createServer((req, res) => {
  res.writeHead(200); res.end('BARQ WebSocket Endpoint');
});

function handleWsUpgrade(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }

  const acceptKey = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');

  const headers = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey}`,
    '\r\n'
  ];

  socket.write(headers.join('\r\n'));
  wsClients.add(socket);

  // Send initial snapshot
  const initialPayload = JSON.stringify({
    type: 'INIT_SNAPSHOT',
    data: {
      snapshot: hwController.getSnapshot(),
      rawLogs: hwController.rawLogs.slice(0, 50)
    }
  });
  sendWsFrame(socket, initialPayload);

  socket.on('data', (buf) => {
    if (buf[0] === 0x88) { // Close frame
      wsClients.delete(socket);
      socket.end();
    }
  });

  socket.on('close', () => wsClients.delete(socket));
  socket.on('error', () => wsClients.delete(socket));
}

// Upgrade WebSocket on both main web server (HTTP_PORT) and dedicated WS port (WS_PORT)
apiServer.on('upgrade', handleWsUpgrade);
wsHttpServer.on('upgrade', handleWsUpgrade);

function sendWsFrame(sock, dataStr) {
  const payloadBuf = Buffer.from(dataStr, 'utf8');
  const len = payloadBuf.length;
  let headerBuf;

  if (len <= 125) {
    headerBuf = Buffer.from([0x81, len]);
  } else if (len <= 65535) {
    headerBuf = Buffer.alloc(4);
    headerBuf[0] = 0x81; headerBuf[1] = 126;
    headerBuf.writeUInt16BE(len, 2);
  } else {
    headerBuf = Buffer.alloc(10);
    headerBuf[0] = 0x81; headerBuf[1] = 127;
    headerBuf.writeBigUInt64BE(BigInt(len), 2);
  }

  sock.write(Buffer.concat([headerBuf, payloadBuf]));
}

wsHttpServer.listen(WS_PORT, '0.0.0.0', () => {
  console.log(`🌐 [BARQ WebSocket] Listening on ws://localhost:${WS_PORT}`);
});

// ============================================================
// 4. HARDWARE & CHALLENGE SERVER STARTUP SEQUENCE
// ============================================================
async function startAllServices() {
  console.log('⚡ [SERVICES] Starting Relay Server on TCP 5050...');
  try {
    await challengeServer.start();
  } catch (err) {
    console.error('⚠️ [RELAY SERVER] Error:', err.message);
  }

  // Autonomous Pinggy TCP tunnel startup (non-blocking)
  tunnelManager.start().catch((err) => {
    console.warn('⚠️ [TUNNEL] Tunnel initialization warning:', err.message);
  });

  console.log('⚡ [HARDWARE] Initializing Quectel M25 Hardware Controller (Zero Auto-Open)...');
  try {
    await hwController.initialize();
    console.log('⚡ [HARDWARE] Controller initialized. Serial ports remain CLOSED until user action.');
  } catch (err) {
    console.error('❌ [HARDWARE START ERROR]', err.message);
  }
}

startAllServices();

// Clean Process Shutdown
process.on('SIGINT', async () => {
  console.log('\n[SHUTDOWN] Releasing hardware serial ports, stopping tunnel & relay server...');
  await tunnelManager.stop();
  await challengeServer.stop();
  await hwController.shutdown();
  process.exit(0);
});

module.exports = { apiServer, wsHttpServer, challengeServer, hwController };
