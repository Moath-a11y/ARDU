/**
 * BARQ LINK — Step 4: Physical End-to-End Bidirectional Relay Test
 *
 * Uses physical Quectel M25 modems on COM3 (ALPHA) and COM4 (BRAVO).
 * Reuses existing NodeSession, GprsRelayClient, SerialTransport, and ATParser.
 *
 * Flow:
 *  1. Open COM3 (ALPHA) at 9600 8N1
 *  2. Open COM4 (BRAVO) at 9600 8N1
 *  3. Connect ALPHA via GPRS -> REGISTER ALPHA
 *  4. Connect BRAVO via GPRS -> REGISTER BRAVO
 *  5. ALPHA sends harmless payload to BRAVO -> verifies DELIVERY_ACK
 *  6. BRAVO sends harmless reply payload to ALPHA -> verifies DELIVERY_ACK
 *  7. Clean teardown in finally: disconnect clients, close serial ports.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const SerialTransport = require('../src/hardware/SerialTransport');
const { NodeSession } = require('../src/hardware/NodeSession');
const GprsRelayClient = require('../src/hardware/GprsRelayClient');

const ALPHA_PORT = 'COM3';
const BRAVO_PORT = 'COM4';
const BAUD = 9600;
const APN = 'internet';

const ENDPOINT_FILE = path.join(__dirname, '..', 'pinggy_endpoint.json');
const REACH_FILE = path.join(__dirname, '..', 'relay_reachability.json');
const OUT_JSON = path.join(__dirname, '..', 'logs', 'physical-e2e-relay-test.json');

function nowIso() {
  return new Date().toISOString();
}

function msSince(t0) {
  return Date.now() - t0;
}

class Evidence {
  constructor() {
    this.t0 = Date.now();
    this.startedAt = nowIso();
    this.steps = [];
    this.messages = [];
    this.outcome = { success: false, reason: 'NOT_FINISHED' };
  }

  step(id, status, details) {
    const entry = {
      id,
      status,
      tMs: Date.now() - this.t0,
      at: nowIso(),
      details: details === undefined ? null : details
    };
    this.steps.push(entry);
    const flag = status === 'PASS' ? 'PASS' : status === 'FAIL' ? 'FAIL' : status;
    console.log(`[${String(entry.tMs).padStart(6)}ms] [${flag}] ${id}` + (details && details.note ? ` — ${details.note}` : ''));
    return entry;
  }

  finish(success, reason, extra) {
    this.outcome = { success, reason, extra: extra || null, finishedAt: nowIso(), durationMs: Date.now() - this.t0 };
  }

  write() {
    const dir = path.dirname(OUT_JSON);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(OUT_JSON, JSON.stringify(this, null, 2));
    return OUT_JSON;
  }
}

function loadVerifiedEndpoint() {
  const reach = JSON.parse(fs.readFileSync(REACH_FILE, 'utf8'));
  const ep = JSON.parse(fs.readFileSync(ENDPOINT_FILE, 'utf8'));
  const host = reach.ips[0];
  const port = ep.port;
  return { host, port, hostname: ep.host };
}

async function main() {
  const evidence = new Evidence();
  let sessionAlpha = null;
  let sessionBravo = null;
  let clientAlpha = null;
  let clientBravo = null;

  const endpoint = loadVerifiedEndpoint();
  evidence.step('A_PREFLIGHT', 'PASS', {
    note: `Using relay endpoint ${endpoint.host}:${endpoint.port} (${endpoint.hostname})`,
    endpoint
  });

  try {
    // 1. Open both serial ports
    evidence.step('B_OPEN_PORTS', 'START', { alpha: ALPHA_PORT, bravo: BRAVO_PORT });
    const transportAlpha = new SerialTransport(ALPHA_PORT, BAUD);
    const transportBravo = new SerialTransport(BRAVO_PORT, BAUD);

    sessionAlpha = new NodeSession('ALPHA', ALPHA_PORT, transportAlpha, { baudRate: BAUD });
    sessionBravo = new NodeSession('BRAVO', BRAVO_PORT, transportBravo, { baudRate: BAUD });

    await Promise.all([
      sessionAlpha.open(),
      sessionBravo.open()
    ]);
    evidence.step('B_OPEN_PORTS', 'PASS', { note: 'Both COM3 and COM4 opened at 9600 8N1' });

    // 2. Instantiate GprsRelayClient for both nodes
    clientAlpha = new GprsRelayClient(sessionAlpha, endpoint.host, endpoint.port, 'ALPHA', { apn: APN });
    clientBravo = new GprsRelayClient(sessionBravo, endpoint.host, endpoint.port, 'BRAVO', { apn: APN });

    // Setup incoming relay listeners
    const bravoReceivedRelays = [];
    clientBravo.on('relay_received', async (msg) => {
      evidence.step('RECV_AT_BRAVO', 'PASS', {
        from: msg.from,
        msgId: msg.msgId,
        payload: msg.payload,
        note: 'BRAVO received RELAY message from server'
      });
      bravoReceivedRelays.push(msg);
      if (typeof msg.confirm === 'function') {
        try {
          await msg.confirm();
          evidence.step('BRAVO_DELIVERY_ACK_SENT', 'PASS', { msgId: msg.msgId });
        } catch (e) {
          evidence.step('BRAVO_DELIVERY_ACK_FAIL', 'WARN', { error: e.message });
        }
      }
    });

    const alphaReceivedRelays = [];
    clientAlpha.on('relay_received', async (msg) => {
      evidence.step('RECV_AT_ALPHA', 'PASS', {
        from: msg.from,
        msgId: msg.msgId,
        payload: msg.payload,
        note: 'ALPHA received RELAY reply from server'
      });
      alphaReceivedRelays.push(msg);
      if (typeof msg.confirm === 'function') {
        try {
          await msg.confirm();
          evidence.step('ALPHA_DELIVERY_ACK_SENT', 'PASS', { msgId: msg.msgId });
        } catch (e) {
          evidence.step('ALPHA_DELIVERY_ACK_FAIL', 'WARN', { error: e.message });
        }
      }
    });

    // 3. Connect ALPHA via live GPRS & Register
    evidence.step('C_CONNECT_ALPHA', 'START', { deviceId: 'ALPHA' });
    const alphaAck = await clientAlpha.connect(APN);
    evidence.step('C_CONNECT_ALPHA', 'PASS', {
      deviceId: alphaAck.deviceId,
      serverTime: alphaAck.serverTime,
      assignedIp: sessionAlpha.gprsEngine.assignedIp,
      note: 'ALPHA registered successfully over live GPRS'
    });

    // 4. Connect BRAVO via live GPRS & Register
    evidence.step('D_CONNECT_BRAVO', 'START', { deviceId: 'BRAVO' });
    const bravoAck = await clientBravo.connect(APN);
    evidence.step('D_CONNECT_BRAVO', 'PASS', {
      deviceId: bravoAck.deviceId,
      serverTime: bravoAck.serverTime,
      assignedIp: sessionBravo.gprsEngine.assignedIp,
      note: 'BRAVO registered successfully over live GPRS'
    });

    // 5. Test 1: Send Application Message ALPHA -> BRAVO
    evidence.step('E_RELAY_A_TO_B', 'START', { from: 'ALPHA', to: 'BRAVO' });
    const payloadAtoB = JSON.stringify({ ping: 'BARQ_LIVE_PING', seq: 1, ts: nowIso() });
    
    // sendRelay() awaits DELIVERY_ACK confirmation from BRAVO through the server
    const ackAtoB = await clientAlpha.sendRelay('BRAVO', payloadAtoB, 30000);
    evidence.step('E_RELAY_A_TO_B', 'PASS', {
      ack: ackAtoB,
      sentPayload: payloadAtoB,
      receivedAtBravo: bravoReceivedRelays.length > 0 ? bravoReceivedRelays[0].payload : null,
      note: 'DELIVERY_ACK confirmed for ALPHA -> BRAVO relay'
    });

    // Verify payload match
    const bRecv = bravoReceivedRelays.find(m => m.msgId === ackAtoB.msgId);
    if (!bRecv || bRecv.payload !== payloadAtoB) {
      throw new Error(`PAYLOAD_MISMATCH_AT_BRAVO: expected=${payloadAtoB}, received=${bRecv ? bRecv.payload : 'null'}`);
    }

    // 6. Test 2: Bidirectional Reply Message BRAVO -> ALPHA
    evidence.step('F_RELAY_B_TO_A', 'START', { from: 'BRAVO', to: 'ALPHA' });
    const payloadBtoA = JSON.stringify({ pong: 'BARQ_LIVE_PONG', seq: 2, inReplyTo: ackAtoB.msgId, ts: nowIso() });

    const ackBtoA = await clientBravo.sendRelay('ALPHA', payloadBtoA, 30000);
    evidence.step('F_RELAY_B_TO_A', 'PASS', {
      ack: ackBtoA,
      sentPayload: payloadBtoA,
      receivedAtAlpha: alphaReceivedRelays.length > 0 ? alphaReceivedRelays[0].payload : null,
      note: 'DELIVERY_ACK confirmed for BRAVO -> ALPHA reply'
    });

    // Verify reply payload match
    const aRecv = alphaReceivedRelays.find(m => m.msgId === ackBtoA.msgId);
    if (!aRecv || aRecv.payload !== payloadBtoA) {
      throw new Error(`PAYLOAD_MISMATCH_AT_ALPHA: expected=${payloadBtoA}, received=${aRecv ? aRecv.payload : 'null'}`);
    }

    evidence.finish(true, 'BIDIRECTIONAL_RELAY_VERIFIED', {
      alphaIp: sessionAlpha.gprsEngine.assignedIp,
      bravoIp: sessionBravo.gprsEngine.assignedIp,
      relayAtoB: { sent: payloadAtoB, ack: ackAtoB },
      relayBtoA: { sent: payloadBtoA, ack: ackBtoA }
    });

  } catch (err) {
    evidence.step('TEST_ABORTED', 'FAIL', { error: err.message });
    evidence.finish(false, err.message);
  } finally {
    evidence.step('G_CLEANUP', 'START', { note: 'Teardown all TCP sockets, PDP contexts, and serial ports' });

    // Disconnect clients (AT+QICLOSE then AT+QIDEACT)
    if (clientAlpha) {
      try {
        await Promise.race([
          clientAlpha.disconnect(),
          new Promise((_, r) => setTimeout(() => r(new Error('TIMEOUT')), 10000))
        ]);
        evidence.step('G_ALPHA_DISCONNECT', 'PASS');
      } catch (e) {
        evidence.step('G_ALPHA_DISCONNECT', 'WARN', { error: e.message });
      }
    }

    if (clientBravo) {
      try {
        await Promise.race([
          clientBravo.disconnect(),
          new Promise((_, r) => setTimeout(() => r(new Error('TIMEOUT')), 10000))
        ]);
        evidence.step('G_BRAVO_DISCONNECT', 'PASS');
      } catch (e) {
        evidence.step('G_BRAVO_DISCONNECT', 'WARN', { error: e.message });
      }
    }

    // Close serial ports
    if (sessionAlpha) {
      try {
        await sessionAlpha.close();
        evidence.step('G_ALPHA_PORT_CLOSED', 'PASS');
      } catch (e) {
        evidence.step('G_ALPHA_PORT_CLOSED', 'WARN', { error: e.message });
      }
    }

    if (sessionBravo) {
      try {
        await sessionBravo.close();
        evidence.step('G_BRAVO_PORT_CLOSED', 'PASS');
      } catch (e) {
        evidence.step('G_BRAVO_PORT_CLOSED', 'WARN', { error: e.message });
      }
    }

    const outPath = evidence.write();
    console.log('\nFinal Evidence written to:', outPath);
    console.log('FINAL_OUTCOME:', JSON.stringify(evidence.outcome, null, 2));
  }

  process.exit(evidence.outcome.success ? 0 : 1);
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
