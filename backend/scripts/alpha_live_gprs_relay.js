/**
 * BARQ LINK — Phase 2 live ALPHA GPRS + TCP Relay test
 *
 * Opens COM3 only (9600 8N1). Never opens COM4.
 * Does NOT send RELAY / application / PIC commands.
 * Does NOT factory-reset the modem.
 *
 * Success criterion: a verified REGISTER_ACK with deviceId ALPHA.
 * TCP CONNECT OK or assigned IP alone is NOT success.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const SerialTransport = require('../src/hardware/SerialTransport');
const { NodeSession } = require('../src/hardware/NodeSession');
const GprsRelayClient = require('../src/hardware/GprsRelayClient');

const PORT_PATH = 'COM3';
const BAUD = 9600;
const DEVICE_ID = 'ALPHA';
const APN = 'internet';
const ENDPOINT_FILE = path.join(__dirname, '..', 'pinggy_endpoint.json');
const REACH_FILE = path.join(__dirname, '..', 'relay_reachability.json');
const OUT_JSON = path.join(__dirname, '..', 'logs', 'alpha-live-gprs-relay.json');

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
    this.uart = [];
    this.clientEvents = [];
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
    if (details && details.raw) {
      console.log('         RAW:', JSON.stringify(details.raw).slice(0, 400));
    }
    return entry;
  }

  uartLine(dir, data) {
    const rec = { at: nowIso(), tMs: Date.now() - this.t0, dir, data: String(data) };
    this.uart.push(rec);
    const preview = String(data).replace(/\r/g, '\\r').replace(/\n/g, '\\n').slice(0, 240);
    console.log(`  UART ${dir} t=${rec.tMs}ms ${preview}`);
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
  const ep = JSON.parse(fs.readFileSync(ENDPOINT_FILE, 'utf8'));
  const reach = JSON.parse(fs.readFileSync(REACH_FILE, 'utf8'));
  if (!reach.viaIp || !reach.viaIp.ok) {
    throw new Error('RELAY_ENDPOINT_NOT_VERIFIED');
  }
  // M25 2G DNS is unreliable; previous live GPRS tests used IPv4.
  // The IPv4 below was verified with REGISTER_ACK through the current Pinggy tunnel.
  const host = reach.ips[0];
  const port = ep.port;
  return {
    hostname: ep.host,
    host,
    port,
    url: ep.url,
    verifiedAt: reach.verifiedAt,
    viaIpAck: reach.viaIp.extra && reach.viaIp.extra.parsed
  };
}

function extractLine(raw, prefix) {
  if (!raw) return null;
  const lines = String(raw).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => l.startsWith(prefix)) || lines.join(' | ');
}

async function abortIf(cond, evidence, stepId, err) {
  if (!cond) return;
  evidence.step(stepId, 'FAIL', { error: err });
  throw new Error(err);
}

async function main() {
  const evidence = new Evidence();
  let session = null;
  let client = null;
  let tcpOpened = false;
  let pdpActivated = false;

  const endpoint = loadVerifiedEndpoint();
  evidence.step('A_ENDPOINT', 'PASS', {
    note: `Using verified IPv4 ${endpoint.host}:${endpoint.port} (hostname ${endpoint.hostname})`,
    endpoint
  });

  try {
    const transport = new SerialTransport(PORT_PATH, BAUD);
    session = new NodeSession(DEVICE_ID, PORT_PATH, transport, { baudRate: BAUD });

    session.on('raw_tx', (evt) => evidence.uartLine('TX', evt.command));
    session.on('raw_rx', (evt) => evidence.uartLine('RX', evt.raw));
    session.on('error', (evt) => {
      evidence.step('SERIAL_ERROR', 'FAIL', { error: evt.error && evt.error.message });
    });

    evidence.step('B_OPEN_COM3', 'START', { port: PORT_PATH, baud: BAUD, framing: '8N1 (serialport default)' });
    const openT0 = Date.now();
    await Promise.race([
      session.open(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('COM3_OPEN_TIMEOUT_5000MS')), 5000))
    ]);
    evidence.step('B_OPEN_COM3', 'PASS', { openMs: msSince(openT0), note: 'COM3 opened; COM4 not opened' });

    const at = async (cmd, timeoutMs, label) => {
      const t0 = Date.now();
      try {
        const res = await session.sendCommand(cmd, { timeoutMs });
        evidence.step(label, 'PASS', { cmd, timeoutMs, elapsedMs: msSince(t0), raw: res.raw });
        return res;
      } catch (err) {
        evidence.step(label, 'FAIL', { cmd, timeoutMs, elapsedMs: msSince(t0), error: err.message });
        throw err;
      }
    };

    await at('AT', 3000, 'B_AT');
    await at('ATE0', 3000, 'B_ATE0');
    await at('AT+CMEE=2', 3000, 'B_CMEE');

    const ati = await at('ATI', 3000, 'B_ATI');
    const cgmr = await at('AT+CGMR', 3000, 'B_CGMR');
    evidence.step('B_FIRMWARE', 'PASS', {
      ati: ati.raw,
      cgmr: cgmr.raw,
      note: 'Expect Quectel M25 / M25MAR01A12'
    });

    const cpin = await at('AT+CPIN?', 4000, 'B_CPIN');
    await abortIf(!String(cpin.raw).includes('READY'), evidence, 'B_CPIN_READY', 'SIM_NOT_READY');

    const csq = await at('AT+CSQ', 3000, 'B_CSQ');
    const creg = await at('AT+CREG?', 4000, 'B_CREG');
    const cgreg = await at('AT+CGREG?', 4000, 'B_CGREG');

    const cregLine = extractLine(creg.raw, '+CREG:');
    const gsmOk = /\+CREG:\s*\d,\s*[15]\b/.test(cregLine || '') || /\+CREG:\s*[15]\b/.test(cregLine || '');
    await abortIf(!gsmOk, evidence, 'B_GSM_REG', `GSM_NOT_REGISTERED ${cregLine}`);

    const cgregLine = extractLine(cgreg.raw, '+CGREG:');
    const gprsRegOk = /\+CGREG:\s*\d,\s*[15]\b/.test(cgregLine || '') || /\+CGREG:\s*[15]\b/.test(cgregLine || '');
    if (!gprsRegOk) {
      evidence.step('B_GPRS_REG', 'WARN', { raw: cgregLine, note: 'CGREG not 1/5; will still attempt attach during PDP' });
    } else {
      evidence.step('B_GPRS_REG', 'PASS', { raw: cgregLine });
    }

    evidence.step('B_PRECHECK', 'PASS', { csq: csq.raw, creg: cregLine, cgreg: cgregLine });

    client = new GprsRelayClient(session, endpoint.host, endpoint.port, DEVICE_ID, { apn: APN, autoReconnect: false });
    client.on('registered', (p) => evidence.clientEvents.push({ at: nowIso(), ev: 'registered', p }));
    client.on('register_ack', (p) => evidence.clientEvents.push({ at: nowIso(), ev: 'register_ack', p }));
    client.on('qird_error', (p) => evidence.clientEvents.push({ at: nowIso(), ev: 'qird_error', p }));
    client.on('parse_error', (p) => evidence.clientEvents.push({ at: nowIso(), ev: 'parse_error', p }));
    client.on('server_error', (p) => evidence.clientEvents.push({ at: nowIso(), ev: 'server_error', p }));
    client.on('disconnected', () => evidence.clientEvents.push({ at: nowIso(), ev: 'disconnected' }));

    session.gprsEngine.on('evidence', (e) => {
      if (e.action && String(e.action).includes('QINDI')) {
        evidence.step('B_QINDI', e.action.includes('SUCCESS') ? 'PASS' : e.action.includes('FAIL') ? 'FAIL' : 'INFO', {
          action: e.action,
          details: e.details,
          note: 'AT+QINDI=1 required by GprsRelayClient QIRD receive path (QINDI=0 would dump REGISTER_ACK onto UART)'
        });
      }
    });

    evidence.step('B_CONNECT_START', 'START', {
      note: `configurePdp(APN=${APN}) → QINDI=1 → QIACT → QILOCIP → QIOPEN ${endpoint.host}:${endpoint.port} → REGISTER ALPHA`
    });

    const connT0 = Date.now();
    const ack = await client.connect(APN);
    tcpOpened = true;
    pdpActivated = true;

    const ackOk = ack && ack.type === 'REGISTER_ACK' && ack.deviceId === DEVICE_ID;
    if (!ackOk) {
      evidence.step('B_REGISTER_ACK', 'FAIL', { ack, elapsedMs: msSince(connT0) });
      throw new Error('INVALID_REGISTER_ACK');
    }

    evidence.step('B_REGISTER_ACK', 'PASS', {
      ack,
      elapsedMs: msSince(connT0),
      assignedIp: session.gprsEngine.assignedIp,
      note: 'Live REGISTER_ACK received; this is the success criterion'
    });
    evidence.finish(true, 'REGISTER_ACK_VERIFIED', {
      ack,
      assignedIp: session.gprsEngine.assignedIp,
      relay: `${endpoint.host}:${endpoint.port}`
    });
  } catch (err) {
    evidence.step('B_ABORTED', 'FAIL', { error: err.message });
    if (!evidence.outcome || evidence.outcome.reason === 'NOT_FINISHED') {
      evidence.finish(false, err.message, {
        assignedIp: session && session.gprsEngine ? session.gprsEngine.assignedIp : null,
        tcp: session && session.gprsEngine ? session.gprsEngine.socketInfo : null
      });
    }
  } finally {
    evidence.step('C_CLEANUP', 'START', { tcpOpened, pdpActivated });
    try {
      if (client) {
        await Promise.race([
          client.disconnect(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('DISCONNECT_TIMEOUT_20000MS')), 20000))
        ]);
        evidence.step('C_CLIENT_DISCONNECT', 'PASS', { note: 'AT+QICLOSE then AT+QIDEACT via GprsRelayClient.disconnect()' });
      } else if (session && session.gprsEngine) {
        try { await session.gprsEngine.closeTcp(); } catch (e) {
          evidence.step('C_QICLOSE', 'WARN', { error: e.message });
        }
        try { await session.gprsEngine.deactivatePdp(); } catch (e) {
          evidence.step('C_QIDEACT', 'WARN', { error: e.message });
        }
      }
    } catch (e) {
      evidence.step('C_CLIENT_DISCONNECT', 'WARN', { error: e.message });
    }

    try {
      if (session) {
        await Promise.race([
          session.close(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('COM3_CLOSE_TIMEOUT_5000MS')), 5000))
        ]);
        evidence.step('C_CLOSE_COM3', 'PASS', { isOpen: session.transport.isOpen === true });
      }
    } catch (e) {
      evidence.step('C_CLOSE_COM3', 'FAIL', { error: e.message });
    }

    const outPath = evidence.write();
    console.log('\nEvidence written:', outPath);
    console.log('OUTCOME:', JSON.stringify(evidence.outcome, null, 2));
  }

  process.exit(evidence.outcome.success ? 0 : 1);
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
