/**
 * BARQ LINK — Relay Protocol Integration Tests
 * Mode: Local TCP sockets only. No modems, no serial ports, no tunnel.
 *
 * Tests:
 *   1. REGISTER + REGISTER_ACK
 *   2. RELAY delivered and DELIVERY_ACK returned to sender
 *   3. RELAY to offline destination → DESTINATION_OFFLINE error
 *   4. RELAY without REGISTER → NOT_REGISTERED error
 *   5. Fragmented JSON Lines (split across multiple TCP chunks)
 *   6. Combined chunks (two messages in one TCP segment)
 *   7. DELIVERY_TIMEOUT when destination never ACKs
 *   8. INVALID_MSG_ID on spurious DELIVERY_ACK
 *   9. Reconnect: same deviceId re-registers (old session replaced)
 *  10. Legacy BARQ-CHALLENGE-v1 client on same port
 *  11. MSG_TOO_LARGE protection
 */

'use strict';

const net    = require('net');
const assert = require('assert');

const RelayServer = require('../src/server/RelayServer');

// ─────────────────────────────────────────────────────────────────────────────
//  Tiny test harness
// ─────────────────────────────────────────────────────────────────────────────

let total = 0, passed = 0, failed = 0;

async function it(name, fn, timeoutMs = 6000) {
  total++;
  const timer = new Promise((_, rej) =>
    setTimeout(() => rej(new Error(`TIMEOUT after ${timeoutMs}ms`)), timeoutMs));
  try {
    await Promise.race([fn(), timer]);
    passed++;
    console.log(`  ✅ PASS: ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ❌ FAIL: ${name}`);
    console.error(`     ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Socket helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Open a raw TCP connection to the relay server */
function openSocket(port) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: '127.0.0.1', port }, () => resolve(sock));
    sock.on('error', reject);
  });
}

/** Send a BARQ-RELAY-v1 message (JSON + \r\n) */
function sendMsg(sock, obj) {
  sock.write(JSON.stringify(obj) + '\r\n');
}

/**
 * Collect the next N complete \r\n-terminated messages from socket.
 * Returns array of parsed objects.
 */
function collectMessages(sock, count, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const msgs = [];
    const timer = setTimeout(() =>
      reject(new Error(`collectMessages timeout: got ${msgs.length}/${count}`)), timeoutMs);

    sock.on('data', function onData(chunk) {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 2);
        if (!line) continue;
        try { msgs.push(JSON.parse(line)); } catch (_) {}
        if (msgs.length >= count) {
          clearTimeout(timer);
          sock.removeListener('data', onData);
          resolve(msgs);
        }
      }
    });
  });
}

/** Collect exactly one message */
const collectOne = (sock, ms) => collectMessages(sock, 1, ms).then(a => a[0]);

// ─────────────────────────────────────────────────────────────────────────────
//  Test runner
// ─────────────────────────────────────────────────────────────────────────────

const PORT = 15050; // use a separate port so tests don't conflict with live server

async function runAll() {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  BARQ LINK · RELAY PROTOCOL INTEGRATION TESTS');
  console.log('  Mode: Local TCP sockets — Zero hardware required');
  console.log('══════════════════════════════════════════════════════\n');

  const server = new RelayServer({ port: PORT, deliveryTimeoutMs: 1500 });
  await server.start();

  // ── 1. REGISTER + REGISTER_ACK ────────────────────────────────────────────
  await it('should register a device and receive REGISTER_ACK', async () => {
    const sock = await openSocket(PORT);
    sendMsg(sock, { type: 'REGISTER', deviceId: 'DEV_A', version: 'BARQ-RELAY-v1' });
    const ack = await collectOne(sock);
    assert.strictEqual(ack.type, 'REGISTER_ACK');
    assert.strictEqual(ack.deviceId, 'DEV_A');
    assert.ok(ack.serverTime);
    sock.destroy();
  });

  // ── 2. Full relay round-trip ───────────────────────────────────────────────
  await it('should relay a message from A to B and return DELIVERY_ACK to A', async () => {
    const sockA = await openSocket(PORT);
    const sockB = await openSocket(PORT);

    sendMsg(sockA, { type: 'REGISTER', deviceId: 'A2', version: 'BARQ-RELAY-v1' });
    sendMsg(sockB, { type: 'REGISTER', deviceId: 'B2', version: 'BARQ-RELAY-v1' });
    await collectOne(sockA); // REGISTER_ACK
    await collectOne(sockB); // REGISTER_ACK

    sendMsg(sockA, { type: 'RELAY', msgId: 'msg-001', from: 'A2', to: 'B2', payload: 'HELLO_B' });

    // B receives the relay
    const relayAtB = await collectOne(sockB);
    assert.strictEqual(relayAtB.type, 'RELAY');
    assert.strictEqual(relayAtB.msgId, 'msg-001');
    assert.strictEqual(relayAtB.payload, 'HELLO_B');

    // B sends DELIVERY_ACK
    sendMsg(sockB, { type: 'DELIVERY_ACK', msgId: 'msg-001', from: 'B2', to: 'A2', status: 'DELIVERED' });

    // A receives confirmation
    const ackAtA = await collectOne(sockA);
    assert.strictEqual(ackAtA.type, 'DELIVERY_ACK');
    assert.strictEqual(ackAtA.msgId, 'msg-001');
    assert.strictEqual(ackAtA.status, 'DELIVERED');

    sockA.destroy(); sockB.destroy();
  });

  // ── 3. Destination offline ────────────────────────────────────────────────
  await it('should return DESTINATION_OFFLINE when target is not registered', async () => {
    const sock = await openSocket(PORT);
    sendMsg(sock, { type: 'REGISTER', deviceId: 'A3', version: 'BARQ-RELAY-v1' });
    await collectOne(sock);

    sendMsg(sock, { type: 'RELAY', msgId: 'msg-002', from: 'A3', to: 'GHOST', payload: 'HI' });
    const err = await collectOne(sock);
    assert.strictEqual(err.type, 'ERROR');
    assert.strictEqual(err.code, 'DESTINATION_OFFLINE');
    assert.strictEqual(err.msgId, 'msg-002');
    sock.destroy();
  });

  // ── 4. Relay without register ──────────────────────────────────────────────
  await it('should return NOT_REGISTERED when RELAY sent before REGISTER', async () => {
    const sock = await openSocket(PORT);
    sendMsg(sock, { type: 'RELAY', msgId: 'msg-003', from: 'GHOST', to: 'SOMEONE', payload: 'X' });
    const err = await collectOne(sock);
    assert.strictEqual(err.type, 'ERROR');
    assert.strictEqual(err.code, 'NOT_REGISTERED');
    sock.destroy();
  });

  // ── 5. Fragmented JSON Lines ───────────────────────────────────────────────
  await it('should handle REGISTER message split across multiple TCP chunks', async () => {
    const raw = JSON.stringify({ type: 'REGISTER', deviceId: 'FRAG', version: 'BARQ-RELAY-v1' }) + '\r\n';
    const half = Math.floor(raw.length / 2);

    const sock = await openSocket(PORT);
    sock.write(raw.slice(0, half));
    await new Promise(r => setTimeout(r, 20));
    sock.write(raw.slice(half));

    const ack = await collectOne(sock);
    assert.strictEqual(ack.type, 'REGISTER_ACK');
    assert.strictEqual(ack.deviceId, 'FRAG');
    sock.destroy();
  });

  // ── 6. Combined chunks (two messages in one segment) ──────────────────────
  await it('should handle two BARQ-RELAY-v1 messages arriving in a single TCP chunk', async () => {
    const sockA = await openSocket(PORT);
    const sockB = await openSocket(PORT);

    // Register B first so relay target exists
    sendMsg(sockB, { type: 'REGISTER', deviceId: 'B6', version: 'BARQ-RELAY-v1' });
    await collectOne(sockB);

    // Send REGISTER + RELAY for A concatenated in one write
    const regMsg   = JSON.stringify({ type: 'REGISTER', deviceId: 'A6', version: 'BARQ-RELAY-v1' }) + '\r\n';
    const relayMsg = JSON.stringify({ type: 'RELAY', msgId: 'msg-006', from: 'A6', to: 'B6', payload: 'COMBO' }) + '\r\n';

    // Start collecting from B BEFORE writing, to avoid the race where the relay
    // arrives and is dispatched synchronously in the same event-loop tick.
    const relayAtBPromise = collectOne(sockB, 5000);
    sockA.write(regMsg + relayMsg);

    // A receives REGISTER_ACK; B receives RELAY — collect in parallel
    const [ack, relayAtB] = await Promise.all([collectOne(sockA), relayAtBPromise]);
    assert.strictEqual(ack.type, 'REGISTER_ACK');
    assert.strictEqual(relayAtB.type, 'RELAY');
    assert.strictEqual(relayAtB.msgId, 'msg-006');

    sockA.destroy(); sockB.destroy();
  });

  // ── 7. DELIVERY_TIMEOUT ───────────────────────────────────────────────────
  await it('should emit DELIVERY_TIMEOUT error when destination never ACKs (1.5 s deadline)', async () => {
    const sockA = await openSocket(PORT);
    const sockB = await openSocket(PORT);

    sendMsg(sockA, { type: 'REGISTER', deviceId: 'A7', version: 'BARQ-RELAY-v1' });
    sendMsg(sockB, { type: 'REGISTER', deviceId: 'B7', version: 'BARQ-RELAY-v1' });
    await collectOne(sockA); await collectOne(sockB);

    sendMsg(sockA, { type: 'RELAY', msgId: 'msg-007', from: 'A7', to: 'B7', payload: 'TIMEOUT_ME' });
    await collectOne(sockB); // B receives relay but deliberately does not ACK

    const err = await collectOne(sockA, 3500); // wait longer than 1.5 s timeout
    assert.strictEqual(err.type, 'ERROR');
    assert.strictEqual(err.code, 'DELIVERY_TIMEOUT');
    assert.strictEqual(err.msgId, 'msg-007');

    sockA.destroy(); sockB.destroy();
  }, 8000);

  // ── 8. INVALID_MSG_ID ─────────────────────────────────────────────────────
  await it('should return INVALID_MSG_ID for a spurious DELIVERY_ACK with unknown msgId', async () => {
    const sock = await openSocket(PORT);
    sendMsg(sock, { type: 'REGISTER', deviceId: 'A8', version: 'BARQ-RELAY-v1' });
    await collectOne(sock);

    sendMsg(sock, { type: 'DELIVERY_ACK', msgId: 'nonexistent-999', from: 'A8', to: 'B8', status: 'DELIVERED' });
    const err = await collectOne(sock);
    assert.strictEqual(err.type, 'ERROR');
    assert.strictEqual(err.code, 'INVALID_MSG_ID');
    sock.destroy();
  });

  // ── 9. Reconnect — same deviceId replaces old session ────────────────────
  await it('should replace old session when same deviceId re-registers', async () => {
    const sock1 = await openSocket(PORT);
    sendMsg(sock1, { type: 'REGISTER', deviceId: 'RECON', version: 'BARQ-RELAY-v1' });
    await collectOne(sock1);

    const sock2 = await openSocket(PORT);
    sendMsg(sock2, { type: 'REGISTER', deviceId: 'RECON', version: 'BARQ-RELAY-v1' });
    const ack2 = await collectOne(sock2);
    assert.strictEqual(ack2.type, 'REGISTER_ACK');
    assert.strictEqual(ack2.deviceId, 'RECON');

    // The new session should appear in the server's session map
    const sessions = server.getActiveSessions();
    assert.ok(sessions['RECON']);

    sock1.destroy(); sock2.destroy();
  });

  // ── 10. Legacy BARQ-CHALLENGE-v1 ─────────────────────────────────────────
  await it('should handle legacy BARQ-CHALLENGE-v1 JSON (no type field, no \\r\\n) on same port', async () => {
    const sock = await openSocket(PORT);

    // Legacy client sends raw JSON object terminated only by socket close-like pattern
    const legacyPayload = JSON.stringify({
      challenge    : 'CH-LEGACY-001',
      correlationId: 'CID-ABC',
      nodeId       : 'LEGACY_NODE'
    }); // no \r\n — legacy framing

    sock.write(legacyPayload);

    const resp = await collectOne(sock, 4000);
    assert.strictEqual(resp.status, 'ACK_CHALLENGE_VERIFIED');
    assert.strictEqual(resp.correlationId, 'CID-ABC');
    sock.destroy();
  });

  // ── 11. MSG_TOO_LARGE ─────────────────────────────────────────────────────
  await it('should return MSG_TOO_LARGE and close connection on oversized message', async () => {
    const sock = await openSocket(PORT);

    const bigPayload = 'X'.repeat(2100);
    sock.write(bigPayload + '\r\n');

    const err = await collectOne(sock, 3000);
    assert.strictEqual(err.type, 'ERROR');
    assert.strictEqual(err.code, 'MSG_TOO_LARGE');
    sock.destroy();
  });

  // ─────────────────────────────────────────────────────────────────────────
  await server.stop();

  console.log('\n══════════════════════════════════════════════════════');
  if (failed === 0) {
    console.log(`  ALL ${passed}/${total} RELAY PROTOCOL TESTS PASSED ✅`);
  } else {
    console.log(`  ${passed}/${total} passed, ${failed} FAILED ❌`);
  }
  console.log('══════════════════════════════════════════════════════\n');

  if (failed > 0) process.exit(1);
}

runAll().catch(err => {
  console.error('\n[FATAL]', err);
  process.exit(1);
});
