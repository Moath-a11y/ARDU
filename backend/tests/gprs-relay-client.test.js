/**
 * BARQ LINK -- ATParser QIRD + GprsRelayClient Integration Tests
 * Mode: Mock Serial Transport only. No serial ports, no modems, no tunnel.
 *
 * Test Groups:
 *  A. ATParser QIRD state machine
 *  B. GprsRelayClient registration and relay flow
 *  C. Delivery guarantee semantics
 *  D. Disconnect / reconnect / timer cleanup
 */

'use strict';

const assert              = require('assert');
const ATParser            = require('../src/hardware/ATParser');
const MockSerialTransport = require('../src/hardware/MockSerialTransport');
const { NodeSession }     = require('../src/hardware/NodeSession');
const GprsRelayClient     = require('../src/hardware/GprsRelayClient');

// ── harness ──────────────────────────────────────────────────────────────────
let total = 0, passed = 0, failed = 0;
async function it(name, fn, ms = 5000) {
  total++;
  const guard = new Promise((_, r) => setTimeout(() => r(new Error('TIMEOUT ' + ms + 'ms')), ms));
  try {
    await Promise.race([fn(), guard]);
    passed++;
    console.log('  [PASS] ' + name);
  } catch (e) {
    failed++;
    console.error('  [FAIL] ' + name + '\n     ' + e.message);
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────
async function makeSession(id) {
  const mock = new MockSerialTransport('COM_' + id);
  await mock.open();
  const session = new NodeSession(id, 'COM_' + id, mock);
  return { session, mock };
}

// Builds full +QIRD: N\r\n<data>\r\nOK\r\n response string
function qirdResp(data) {
  return '+QIRD: ' + data.length + '\r\n' + data + '\r\nOK\r\n';
}

// makeRelaySession: session pre-scripted for the full GPRS activation chain
async function makeRelaySession(id) {
  const { session, mock } = await makeSession(id);
  mock.setScriptedResponse('AT+QIDEACT',               '\r\nDEACT OK\r\n', 5);
  mock.setScriptedResponse('AT+QIFGCNT=0',             '\r\nOK\r\n',       5);
  mock.setScriptedResponse('AT+QINDI=1',               '\r\nOK\r\n',       5);
  mock.setScriptedResponse('AT+QICSGP=1,"internet"',   '\r\nOK\r\n',       5);
  mock.setScriptedResponse('AT+CGATT?',                '\r\n+CGATT: 1\r\nOK\r\n', 5);
  mock.setScriptedResponse('AT+QIREGAPP',              '\r\nOK\r\n',       5);
  mock.setScriptedResponse('AT+QIACT',                 '\r\nOK\r\n',       10);
  mock.setScriptedResponse('AT+QILOCIP',               '\r\n10.0.0.99\r\n',5);
  mock.setScriptedResponse('AT+QICLOSE',               '\r\nCLOSE OK\r\n', 5);
  mock.setScriptedResponse('AT+QIDEACT',               '\r\nDEACT OK\r\n', 5);
  return { session, mock };
}

/**
 * Install a single mock.write interceptor that handles:
 *  - AT+QISEND=N  -> injects '> ' prompt
 *  - Raw payload  -> injects SEND OK, calls onPayload(str)
 *  - All other AT commands -> uses existing scriptedResponses map
 */
function interceptWrites(mock, onPayload) {
  mock.write = async (data) => {
    if (!mock.isOpen) return;
    mock.writtenHistory.push(data);
    const str = data.toString();
    const trimmed = str.trim();

    if (trimmed.startsWith('AT+QISEND=')) {
      setTimeout(() => { if (mock.isOpen) mock.simulateIncoming('> '); }, 5);
      return;
    }

    if (trimmed.startsWith('AT+') || trimmed === 'AT') {
      // Regular AT command -- use scripted responses
      if (mock.scriptedResponses.has(trimmed)) {
        const { response, delayMs } = mock.scriptedResponses.get(trimmed);
        setTimeout(() => { if (mock.isOpen) mock.simulateIncoming(response); }, delayMs);
      }
      return;
    }

    // Raw payload bytes (after '>' prompt)
    setTimeout(() => { if (mock.isOpen) mock.simulateIncoming('\r\nSEND OK\r\n'); }, 10);
    if (onPayload) onPayload(trimmed);
  };
}

// ── Group A: ATParser QIRD state machine ─────────────────────────────────────
async function groupA() {
  console.log('\n--- A. ATParser QIRD State Machine ---');

  // A1: full QIRD response in one chunk via setScriptedResponse
  await it('A1: reads exact payload via expectQird (one chunk, 4 params)', async () => {
    const { session, mock } = await makeSession('A1');
    mock.setScriptedResponse('AT+QIRD=0,1,0,128', qirdResp('PAYLOAD'), 5);
    const res = await session.sendCommand('AT+QIRD=0,1,0,128', { expectQird: true, timeoutMs: 3000 });
    assert.strictEqual(res.isQird, true);
    assert.strictEqual(res.data,   'PAYLOAD');
    assert.strictEqual(res.len,    7);
  });

  // A1b: M25MAR01A12 live header includes remote IP:port and protocol
  await it('A1b: reads payload when +QIRD header is ip:port,protocol,len', async () => {
    const { session, mock } = await makeSession('A1b');
    const payload = '{"type":"REGISTER_ACK","deviceId":"ALPHA"}';
    const header = '+QIRD: 172.238.107.192:38511,TCP,' + payload.length + '\r\n';
    mock.setScriptedResponse('AT+QIRD=0,1,0,128', header + payload + '\r\nOK\r\n', 5);
    const res = await session.sendCommand('AT+QIRD=0,1,0,128', { expectQird: true, timeoutMs: 3000 });
    assert.strictEqual(res.isQird, true);
    assert.strictEqual(res.data, payload);
    assert.strictEqual(res.len, payload.length);
  });

  // A2: QIRD payload fragmented across multiple UART chunks
  await it('A2: assembles QIRD payload arriving in multiple TCP chunks', async () => {
    const { session, mock } = await makeSession('A2');
    const promise = session.sendCommand('AT+QIRD=0,1,0,128', { expectQird: true, timeoutMs: 3000 });
    setTimeout(() => mock.simulateIncoming('+QIRD: 11\r\n'), 10);
    setTimeout(() => mock.simulateIncoming('HELLO '),        30);
    setTimeout(() => mock.simulateIncoming('WORLD'),         50);
    setTimeout(() => mock.simulateIncoming('\r\nOK\r\n'),    70);
    const res = await promise;
    assert.strictEqual(res.isQird, true);
    assert.strictEqual(res.data,   'HELLO WORLD');
    assert.strictEqual(res.len,    11);
  });

  // A3: QIRD payload containing CR/LF characters
  await it('A3: preserves CR/LF characters inside QIRD payload', async () => {
    const { session, mock } = await makeSession('A3');
    const payload = 'LINE1\r\nLINE2'; // 12 chars, contains CRLF
    const promise = session.sendCommand('AT+QIRD=0,1,0,128', { expectQird: true, timeoutMs: 3000 });
    setTimeout(() => mock.simulateIncoming('+QIRD: ' + payload.length + '\r\n'), 10);
    setTimeout(() => mock.simulateIncoming(payload), 30);
    setTimeout(() => mock.simulateIncoming('\r\nOK\r\n'), 50);
    const res = await promise;
    assert.strictEqual(res.isQird, true);
    assert.strictEqual(res.data,   payload);
    assert.strictEqual(res.len,    payload.length);
  });

  // A4: +QIRDI URC fires correctly while another AT command is in flight
  await it('A4: +QIRDI URC does not disrupt a concurrent AT+QILOCIP', async () => {
    const { session, mock } = await makeSession('A4');
    mock.setScriptedResponse('AT+QILOCIP', '\r\n10.0.0.1\r\n', 30);
    let urcFired = false;
    session.on('telemetry', (evt) => { if (evt.type === 'TCP_DATA_READY') urcFired = true; });
    const ipPromise = session.sendCommand('AT+QILOCIP', { expectIp: true, timeoutMs: 3000 });
    setTimeout(() => mock.simulateIncoming('+QIRDI: 0,1,0\r\n'), 15);
    const ipRes = await ipPromise;
    assert.strictEqual(ipRes.ip,   '10.0.0.1');
    assert.strictEqual(urcFired,    true, '+QIRDI URC must have fired');
  });

  // A5: multiple +QIRDI URCs — both QINDI=1 (3 fields) and QINDI=2 (6 fields)
  await it('A5: multiple +QIRDI URCs (QINDI=1 and QINDI=2) all parsed correctly', async () => {
    const { session, mock } = await makeSession('A5');
    const urcs = [];
    session.on('telemetry', (evt) => { if (evt.type === 'TCP_DATA_READY') urcs.push(evt.data.len); });
    mock.setScriptedResponse('AT', '\r\nOK\r\n', 5);
    await session.sendCommand('AT', { timeoutMs: 2000 });
    mock.simulateIncoming('+QIRDI: 0,1,0\r\n');            // QINDI=1 format: len is null
    mock.simulateIncoming('+QIRDI: 0,1,0,1,45,45\r\n');    // QINDI=2 format: len is 45
    await new Promise(r => setTimeout(r, 30));
    assert.deepStrictEqual(urcs, [null, 45]);
  });

  // A6: QIRD timeout cleans up parser state
  await it('A6: QIRD timeout cleans up _qirdReading state', async () => {
    const { session, mock } = await makeSession('A6');
    const p = session.sendCommand('AT+QIRD=0,1,0,64', { expectQird: true, timeoutMs: 200 });
    await assert.rejects(p, /COMMAND_TIMEOUT/);
    assert.strictEqual(session.parser._qirdReading,  false);
    assert.strictEqual(session.parser.currentPending, null);
  });

  // A7: normal AT command works cleanly after a completed QIRD
  await it('A7: normal AT command executes cleanly after a QIRD session', async () => {
    const { session, mock } = await makeSession('A7');
    const qirdP = session.sendCommand('AT+QIRD=0,1,0,64', { expectQird: true, timeoutMs: 3000 });
    setTimeout(() => mock.simulateIncoming(qirdResp('HI')), 20);
    const qRes = await qirdP;
    assert.strictEqual(qRes.data, 'HI');
    mock.setScriptedResponse('AT+CSQ', '\r\n+CSQ: 14,0\r\n\r\nOK\r\n', 5);
    const csq = await session.sendCommand('AT+CSQ', { timeoutMs: 2000 });
    assert.ok(csq.raw.includes('+CSQ: 14'));
  });

  // A8b: parseQirdDataLength must use last field, never parseInt(IP)
  await it('A8b: parseQirdDataLength uses last CSV field (live IP header is not 172)', async () => {
    assert.strictEqual(ATParser.parseQirdDataLength('+QIRD: 84'), 84);
    assert.strictEqual(ATParser.parseQirdDataLength('+QIRD: 172.238.107.192:38511,TCP,84'), 84);
    assert.strictEqual(ATParser.parseQirdDataLength('+QIRD:116.228.146.250:7070,TCP,36'), 36);
    assert.strictEqual(ATParser.parseQirdDataLength('+QIRD: 0'), 0);
    assert.ok(Number.isNaN(ATParser.parseQirdDataLength('+QIRD:')));
  });

  // A9: exact live M25MAR01A12 UART chunks from alpha-live-gprs-relay.json
  await it('A9: parses live ALPHA UART QIRD chunks (header + JSON + CR/LF + OK)', async () => {
    const { session, mock } = await makeSession('A9');
    const livePayload = '{"type":"REGISTER_ACK","deviceId":"ALPHA","serverTime":"2026-10-15T22:54:33.682Z"}\r\n';
    assert.strictEqual(livePayload.length, 84);

    const liveChunks = [
      '\r', '\n+Q', 'IRD:', ' 172', '.238', '.107', '.192', ':385', '11,T', 'CP,8',
      '4\r\n{', '"typ', 'e":"', 'REGI', 'STER', '_ACK', '","', 'devi', 'ceId', '":"A',
      'LPHA', '","s', 'erve', 'rTim', 'e":"', '2026', '-10-', '15T2', '2:54', ':33.',
      '682', 'Z"}\r', '\n\r\nO', 'K\r\n'
    ];

    const promise = session.sendCommand('AT+QIRD=0,1,0,512', { expectQird: true, timeoutMs: 3000 });
    let t = 5;
    for (const chunk of liveChunks) {
      setTimeout(() => mock.simulateIncoming(chunk), t);
      t += 4;
    }
    const res = await promise;
    assert.strictEqual(res.isQird, true);
    assert.strictEqual(res.len, 84);
    assert.strictEqual(res.data, livePayload);
    assert.strictEqual(session.parser._qirdReading, false);
  });

  // A10: QIRD ERROR rejects without treating JSON as AT text
  await it('A10: QIRD ERROR rejects and leaves parser idle', async () => {
    const { session, mock } = await makeSession('A10');
    const p = session.sendCommand('AT+QIRD=0,1,0,512', { expectQird: true, timeoutMs: 2000 });
    setTimeout(() => mock.simulateIncoming('\r\nERROR\r\n'), 10);
    await assert.rejects(p, /ERROR/);
    assert.strictEqual(session.parser._qirdReading, false);
    assert.strictEqual(session.parser.currentPending, null);
  });

  // A11: empty socket buffer — OK only (M25 AT manual)
  await it('A11: QIRD empty buffer (OK only) resolves with zero-length data', async () => {
    const { session, mock } = await makeSession('A11');
    mock.setScriptedResponse('AT+QIRD=0,1,0,512', '\r\nOK\r\n', 5);
    const res = await session.sendCommand('AT+QIRD=0,1,0,512', { expectQird: true, timeoutMs: 2000 });
    assert.strictEqual(res.isQird, true);
    assert.strictEqual(res.data, '');
    assert.strictEqual(res.len, 0);
  });

  // A12: QIRD header preceded by other lines (regression test for buffer overwrite bug)
  await it('A12: QIRD header preceded by URC lines processes all lines correctly', async () => {
    const { session, mock } = await makeSession('A12');
    const payload = '{"type":"TEST"}';
    const urcLines = ['+QIRDI: 0,1,0', 'STATE: IP INITIAL'];
    const fullResponse = urcLines.map(l => '\r\n' + l).join('') + '\r\n+QIRD: ' + payload.length + '\r\n' + payload + '\r\nOK\r\n';
    
    let urcCount = 0;
    session.on('telemetry', (evt) => {
      if (evt.type === 'TCP_DATA_READY') urcCount++;
    });
    
    mock.setScriptedResponse('AT+QIRD=0,1,0,64', fullResponse, 5);
    const res = await session.sendCommand('AT+QIRD=0,1,0,64', { expectQird: true, timeoutMs: 3000 });
    assert.strictEqual(res.isQird, true);
    assert.strictEqual(res.data, payload);
    assert.strictEqual(res.len, payload.length);
    assert.strictEqual(urcCount, 1, '+QIRDI should have been processed');
  });

  // A13: Live M25MAR01A12 QIRD header with 84-byte REGISTER_ACK payload
  await it('A13: parses live M25 QIRD header + 84-byte REGISTER_ACK + double CRLF OK', async () => {
    const { session, mock } = await makeSession('A13');
    const livePayload = '{"type":"REGISTER_ACK","deviceId":"ALPHA","serverTime":"2026-10-15T22:54:33.682Z"}\r\n';
    assert.strictEqual(livePayload.length, 84);
    
    const liveHeader = '+QIRD: 172.238.107.192:38511,TCP,84\r\n';
    const liveTrailer = '\r\nOK\r\n';
    const fullResponse = liveHeader + livePayload + liveTrailer;
    
    mock.setScriptedResponse('AT+QIRD=0,1,0,512', fullResponse, 5);
    const res = await session.sendCommand('AT+QIRD=0,1,0,512', { expectQird: true, timeoutMs: 3000 });
    
    assert.strictEqual(res.isQird, true);
    assert.strictEqual(res.len, 84);
    assert.strictEqual(res.data, livePayload);
    assert.strictEqual(session.parser._qirdReading, false);
  });

  // A14: Live 84-byte REGISTER_ACK fragmented into many small chunks
  await it('A14: assembles fragmented 84-byte REGISTER_ACK without loss or duplication', async () => {
    const { session, mock } = await makeSession('A14');
    const livePayload = '{"type":"REGISTER_ACK","deviceId":"ALPHA","serverTime":"2026-10-15T22:54:33.682Z"}\r\n';
    assert.strictEqual(livePayload.length, 84);
    
    const liveHeader = '+QIRD: 172.238.107.192:38511,TCP,84\r\n';
    
    // Fragment exactly as received in live UART log (lines 962-1164)
    const liveChunks = [
      '\r', '\n+Q', 'IRD:', ' 172', '.238', '.107', '.192', ':385', '11,T', 'CP,8',
      '4\r\n{', '"typ', 'e":"', 'REGI', 'STER', '_ACK', '","', 'devi', 'ceId', '":"A',
      'LPHA', '","s', 'erve', 'rTim', 'e":"', '2026', '-10-', '15T2', '2:54', ':33.',
      '682', 'Z"}\r', '\n\r\nO', 'K\r\n'
    ];
    
    const promise = session.sendCommand('AT+QIRD=0,1,0,512', { expectQird: true, timeoutMs: 3000 });
    let t = 5;
    for (const chunk of liveChunks) {
      setTimeout(() => mock.simulateIncoming(chunk), t);
      t += 4;
    }
    
    const res = await promise;
    assert.strictEqual(res.isQird, true);
    assert.strictEqual(res.len, 84);
    assert.strictEqual(res.data, livePayload);
    assert.strictEqual(session.parser._qirdReading, false);
    assert.strictEqual(session.parser._qirdBuf, '');
  });

  // A8: +QIRDI: 0,1,0 without length schedules AT+QIRD=0,1,0,512 by default
  await it('A8: QINDI=1 format without length schedules AT+QIRD=0,1,0,512', async () => {
    const { session, mock } = await makeSession('A8');
    const client = new GprsRelayClient(session, 'relay.test', 5050, 'ALPHA');
    let capturedCmd = null;

    mock.write = async (data) => {
      const s = data.toString().trim();
      if (s.startsWith('AT+QIRD=')) {
        capturedCmd = s;
        setTimeout(() => mock.simulateIncoming(qirdResp('{"type":"TEST"}\r\n')), 5);
      }
    };

    mock.simulateIncoming('+QIRDI: 0,1,0\r\n');
    await new Promise(r => setTimeout(r, 60));
    assert.strictEqual(capturedCmd, 'AT+QIRD=0,1,0,512');
  });
}

// ── Group B: GprsRelayClient registration and relay flow ─────────────────────
async function groupB() {
  console.log('\n--- B. GprsRelayClient Registration & Relay Flow ---');

  // B1: connect() sends REGISTER and resolves on REGISTER_ACK
  await it('B1: connect() resolves when REGISTER_ACK arrives via QIRD', async () => {
    const { session, mock } = await makeRelaySession('B1');
    mock.setScriptedResponse('AT+QIOPEN="TCP","relay.test",5050', '\r\nOK\r\nCONNECT OK\r\n', 15);

    const client = new GprsRelayClient(session, 'relay.test', 5050, 'ALPHA');

    interceptWrites(mock, (payloadStr) => {
      let parsed;
      try { parsed = JSON.parse(payloadStr.replace(/\r\n$/, '')); } catch (_) {}
      if (parsed && parsed.type === 'REGISTER') {
        const ackJson = JSON.stringify({
          type: 'REGISTER_ACK', deviceId: 'ALPHA', serverTime: new Date().toISOString()
        }) + '\r\n';
        setTimeout(() => {
          // 1. Install one-shot QIRD response handler BEFORE sending +QIRDI
          //    so it is in place when _scheduleQirdRead() issues AT+QIRD=...
          const origWrite = mock.write;
          mock.write = async (data) => {
            mock.write = origWrite; // restore immediately
            const s = data.toString().trim();
            if (s.startsWith('AT+QIRD=')) {
              mock.writtenHistory.push(data);
              setTimeout(() => mock.simulateIncoming(qirdResp(ackJson)), 5);
            } else {
              await origWrite(data);
            }
          };
          // 2. NOW send the +QIRDI notification
          mock.simulateIncoming('+QIRDI: 0,1,' + ackJson.length + '\r\n');
        }, 30);
      }
    });

    const result = await client.connect('internet');
    assert.strictEqual(result.type,    'REGISTER_ACK');
    assert.strictEqual(client._state,  'REGISTERED');
    await client.disconnect();
  }, 12000);

  await it('B1-live: connect() parses REGISTER_ACK from live M25 QIRD header form', async () => {
    const { session, mock } = await makeRelaySession('B1live');
    mock.setScriptedResponse('AT+QIOPEN="TCP","relay.test",5050', '\r\nOK\r\nCONNECT OK\r\n', 15);

    const client = new GprsRelayClient(session, 'relay.test', 5050, 'ALPHA');

    interceptWrites(mock, (payloadStr) => {
      let parsed;
      try { parsed = JSON.parse(payloadStr.replace(/\r\n$/, '')); } catch (_) {}
      if (parsed && parsed.type === 'REGISTER') {
        const ackJson = '{"type":"REGISTER_ACK","deviceId":"ALPHA","serverTime":"2026-10-15T22:54:33.682Z"}\r\n';
        setTimeout(() => {
          const origWrite = mock.write;
          mock.write = async (data) => {
            mock.write = origWrite;
            const s = data.toString().trim();
            if (s.startsWith('AT+QIRD=')) {
              mock.writtenHistory.push(data);
              const header = '+QIRD: 172.238.107.192:38511,TCP,' + ackJson.length + '\r\n';
              setTimeout(() => mock.simulateIncoming(header + ackJson + '\r\nOK\r\n'), 5);
            } else {
              await origWrite(data);
            }
          };
          mock.simulateIncoming('+QIRDI: 0,1,0\r\n');
        }, 30);
      }
    });

    const result = await client.connect('internet');
    assert.strictEqual(result.type, 'REGISTER_ACK');
    assert.strictEqual(result.deviceId, 'ALPHA');
    await client.disconnect();
  }, 12000);

  // B2: SEND OK alone must NOT resolve sendRelay
  await it('B2: sendRelay does NOT resolve on SEND OK alone', async () => {
    const { session, mock } = await makeRelaySession('B2');
    const client = new GprsRelayClient(session, 'relay.test', 5050, 'ALPHA');
    client._state = 'REGISTERED';
    client._engine.socketInfo.isConnected = true;

    let sendOkFired = false;
    client.on('relay_sent', () => { sendOkFired = true; });
    interceptWrites(mock, null); // SEND OK only, no ACK injected

    let settled = false;
    const p = client.sendRelay('BRAVO', 'HELLO', 500);
    p.then(() => { settled = true; }).catch(() => { settled = true; });

    await new Promise(r => setTimeout(r, 120));
    assert.strictEqual(sendOkFired, true,  'relay_sent must fire after SEND OK');
    assert.strictEqual(settled,     false, 'promise must NOT settle on SEND OK alone');

    await assert.rejects(p, /DELIVERY_TIMEOUT/);
  }, 3000);

  // B3: sendRelay resolves when DELIVERY_ACK arrives via QIRD
  await it('B3: sendRelay resolves with DELIVERY_ACK payload', async () => {
    const { session, mock } = await makeRelaySession('B3');
    const client = new GprsRelayClient(session, 'relay.test', 5050, 'ALPHA');
    client._state = 'REGISTERED';
    client._engine.socketInfo.isConnected = true;

    interceptWrites(mock, (payloadStr) => {
      let parsed;
      try { parsed = JSON.parse(payloadStr.replace(/\r\n$/, '')); } catch (_) {}
      if (parsed && parsed.type === 'RELAY') {
        const ackJson = JSON.stringify({
          type: 'DELIVERY_ACK', msgId: parsed.msgId,
          from: 'BRAVO', to: 'ALPHA', status: 'DELIVERED'
        }) + '\r\n';
        setTimeout(() => {
          // 1. Install one-shot QIRD handler BEFORE emitting +QIRDI
          const origWrite = mock.write;
          mock.write = async (data) => {
            mock.write = origWrite;
            const s = data.toString().trim();
            if (s.startsWith('AT+QIRD=')) {
              mock.writtenHistory.push(data);
              setTimeout(() => mock.simulateIncoming(qirdResp(ackJson)), 5);
            } else {
              await origWrite(data);
            }
          };
          // 2. Send the notification
          mock.simulateIncoming('+QIRDI: 0,1,' + ackJson.length + '\r\n');
        }, 30);
      }
    });

    const result = await client.sendRelay('BRAVO', 'HELLO', 6000);
    assert.strictEqual(result.status, 'DELIVERED');
    assert.ok(result.msgId);
  }, 8000);

  await it('B4: REGISTER_ACK JSON split across two QIRD reads is assembled', async () => {
    const { session } = await makeRelaySession('B4');
    const client = new GprsRelayClient(session, 'relay.test', 5050, 'ALPHA');
    let ack = null;
    client.on('register_ack', (m) => { ack = m; });
    client._ingestQirdData('{"type":"REGISTER_ACK","deviceId":"ALPHA",');
    assert.strictEqual(ack, null);
    client._ingestQirdData('"serverTime":"2026-10-15T22:54:33.682Z"}\r\n');
    assert.strictEqual(ack && ack.type, 'REGISTER_ACK');
    assert.strictEqual(ack.deviceId, 'ALPHA');
  });
}

// ── Group C: Delivery guarantee semantics ─────────────────────────────────────
async function groupC() {
  console.log('\n--- C. Delivery Guarantee Semantics ---');

  // C1: DELIVERY_ACK only sent after app calls confirmDelivery()
  await it('C1: DELIVERY_ACK sent only after app calls confirmDelivery()', async () => {
    const { session, mock } = await makeRelaySession('C1');
    const client = new GprsRelayClient(session, 'relay.test', 5050, 'ALPHA');
    client._state = 'REGISTERED';
    client._engine.socketInfo.isConnected = true;

    let ackSent = false;
    let relayReceived = false;
    let confirmFn = null;

    client.on('relay_received', ({ confirm }) => {
      relayReceived = true;
      confirmFn = confirm; // app holds confirm, does NOT call it yet
    });

    interceptWrites(mock, (payloadStr) => {
      let p; try { p = JSON.parse(payloadStr.replace(/\r\n$/, '')); } catch (_) {}
      if (p && p.type === 'DELIVERY_ACK') ackSent = true;
    });

    // Inject RELAY directly into the line buffer (simulates a completed QIRD read)
    const relay = JSON.stringify({
      type: 'RELAY', msgId: 'srv-001', from: 'BRAVO', to: 'ALPHA', payload: 'TEST'
    }) + '\r\n';
    client._ingestQirdData(relay);

    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(relayReceived, true,  'relay_received must have fired');
    assert.strictEqual(ackSent,       false, 'DELIVERY_ACK must NOT be sent before confirm()');

    await confirmFn();
    assert.strictEqual(ackSent, true, 'DELIVERY_ACK must be sent after confirm()');
  }, 3000);

  // C2: duplicate msgId dropped
  await it('C2: duplicate msgId relay is silently dropped (not processed twice)', async () => {
    const { session, mock } = await makeRelaySession('C2');
    const client = new GprsRelayClient(session, 'relay.test', 5050, 'ALPHA');
    client._state = 'REGISTERED';
    client._engine.socketInfo.isConnected = true;

    let count = 0;
    client.on('relay_received', () => { count++; });

    const relay = JSON.stringify({
      type: 'RELAY', msgId: 'dup-001', from: 'BRAVO', to: 'ALPHA', payload: 'PING'
    }) + '\r\n';
    client._ingestQirdData(relay);
    client._ingestQirdData(relay);

    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(count, 1, 'relay_received must fire exactly once');
  });

  // C3: server ERROR rejects the matching sendRelay promise
  await it('C3: server ERROR message rejects matching sendRelay promise', async () => {
    const { session, mock } = await makeRelaySession('C3');
    const client = new GprsRelayClient(session, 'relay.test', 5050, 'ALPHA');
    client._state = 'REGISTERED';
    client._engine.socketInfo.isConnected = true;

    interceptWrites(mock, (payloadStr) => {
      let parsed; try { parsed = JSON.parse(payloadStr.replace(/\r\n$/, '')); } catch (_) {}
      if (parsed && parsed.type === 'RELAY') {
        setTimeout(() => {
          client._ingestQirdData(JSON.stringify({
            type: 'ERROR', code: 'DESTINATION_OFFLINE',
            msgId: parsed.msgId, message: 'BRAVO not registered'
          }) + '\r\n');
        }, 30);
      }
    });

    await assert.rejects(
      client.sendRelay('BRAVO', 'HELLO', 5000),
      /SERVER_ERROR_DESTINATION_OFFLINE/
    );
  }, 6000);
}

// ── Group D: Disconnect / timer cleanup ───────────────────────────────────────
async function groupD() {
  console.log('\n--- D. Disconnect / Timer Cleanup ---');

  // D1: disconnect() rejects all in-flight sendRelay promises
  await it('D1: disconnect() rejects all in-flight sendRelay promises', async () => {
    const { session, mock } = await makeRelaySession('D1');
    // Script deactivation for the disconnect() path
    mock.setScriptedResponse('AT+QIDEACT', '\r\nDEACT OK\r\n', 5);

    const client = new GprsRelayClient(session, 'relay.test', 5050, 'ALPHA');
    client._state = 'REGISTERED';
    client._engine.socketInfo.isConnected = true;

    interceptWrites(mock, null); // SEND OK only

    // Attach catch handlers BEFORE disconnect to prevent UnhandledPromiseRejection
    const p1 = client.sendRelay('BRAVO', 'MSG1', 60000);
    const p2 = client.sendRelay('BRAVO', 'MSG2', 60000);
    p1.catch(() => {}); // suppress unhandled rejection
    p2.catch(() => {}); // suppress unhandled rejection

    await new Promise(r => setTimeout(r, 200)); // let SEND OKs arrive

    await client.disconnect();
    const [r1, r2] = await Promise.allSettled([p1, p2]);
    assert.strictEqual(r1.status, 'rejected', 'p1 must be rejected');
    assert.strictEqual(r2.status, 'rejected', 'p2 must be rejected');
  }, 6000);

  // D2: CLOSED URC emits disconnected and clears pending relays
  await it('D2: CLOSED URC emits disconnected event and clears state', async () => {
    const { session, mock } = await makeRelaySession('D2');
    const client = new GprsRelayClient(session, 'relay.test', 5050, 'ALPHA');
    client._state = 'REGISTERED';
    client._engine.socketInfo.isConnected = true;

    let disconnectedFired = false;
    client.on('disconnected', () => { disconnectedFired = true; });

    mock.simulateIncoming('\r\nCLOSED\r\n');
    await new Promise(r => setTimeout(r, 50));

    assert.strictEqual(disconnectedFired,          true,   'disconnected must fire');
    assert.strictEqual(client._state,              'IDLE', 'state must be IDLE');
    assert.strictEqual(client._pendingRelays.size, 0,      'pending map must be empty');
  });

  // D3: QIRD timeout leaves parser clean for next command
  await it('D3: QIRD timeout leaves parser in clean state', async () => {
    const { session, mock } = await makeRelaySession('D3');

    const p = session.sendCommand('AT+QIRD=0,1,0,64', { expectQird: true, timeoutMs: 150 });
    await assert.rejects(p, /COMMAND_TIMEOUT/);

    assert.strictEqual(session.parser._qirdReading,   false);
    assert.strictEqual(session.parser.currentPending, null);

    mock.setScriptedResponse('AT', '\r\nOK\r\n', 5);
    const atRes = await session.sendCommand('AT', { timeoutMs: 2000 });
    assert.ok(atRes.raw.includes('OK'));
  });

  // D4: reconnect after disconnect restores REGISTERED state
  await it('D4: client can cleanly re-connect after disconnect', async () => {
    const { session, mock } = await makeRelaySession('D4');
    mock.setScriptedResponse('AT+QIOPEN="TCP","relay.test",5050', '\r\nOK\r\nCONNECT OK\r\n', 10);
    mock.setScriptedResponse('AT+QIDEACT', '\r\nDEACT OK\r\n', 5);

    const client = new GprsRelayClient(session, 'relay.test', 5050, 'ALPHA');

    interceptWrites(mock, (payloadStr) => {
      let parsed;
      try { parsed = JSON.parse(payloadStr.replace(/\r\n$/, '')); } catch (_) {}
      if (parsed && parsed.type === 'REGISTER') {
        const ackJson = JSON.stringify({
          type: 'REGISTER_ACK', deviceId: 'ALPHA', serverTime: new Date().toISOString()
        }) + '\r\n';
        setTimeout(() => {
          const origWrite = mock.write;
          mock.write = async (data) => {
            mock.write = origWrite;
            const s = data.toString().trim();
            if (s.startsWith('AT+QIRD=')) {
              mock.writtenHistory.push(data);
              setTimeout(() => mock.simulateIncoming(qirdResp(ackJson)), 5);
            } else {
              await origWrite(data);
            }
          };
          mock.simulateIncoming('+QIRDI: 0,1,0\r\n');
        }, 20);
      }
    });

    // First connection
    await client.connect('internet');
    assert.strictEqual(client._state, 'REGISTERED');

    // Disconnect
    await client.disconnect();
    assert.strictEqual(client._state, 'IDLE');

    // Re-arm destroyed flag for reconnection test
    client._destroyed = false;
    session.on('telemetry', client._onTelemetry);

    // Second connection (reconnection)
    await client.connect('internet');
    assert.strictEqual(client._state, 'REGISTERED');

    await client.disconnect();
  }, 10000);
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function runAll() {
  console.log('\n==============================================================');
  console.log('  BARQ LINK - AT PARSER QIRD + GPRS RELAY CLIENT TESTS');
  console.log('  Mode: Mock Serial Transport -- Zero hardware required');
  console.log('==============================================================');

  await groupA();
  await groupB();
  await groupC();
  await groupD();

  console.log('\n==============================================================');
  if (failed === 0) {
    console.log('  ALL ' + passed + '/' + total + ' TESTS PASSED');
  } else {
    console.log('  ' + passed + '/' + total + ' passed | ' + failed + ' FAILED');
  }
  console.log('==============================================================\n');

  if (failed > 0) process.exit(1);
  process.exit(0);
}

runAll().catch(err => {
  console.error('\n[FATAL]', err);
  process.exit(1);
});
