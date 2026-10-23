/**
 * BARQ LINK — Automated Unit Tests for AT Parser, Command Queue, and State Machine
 * Uses isolated MockSerialTransport to verify behavior without touching physical hardware.
 */

const assert = require('assert');
const ATParser = require('../src/hardware/ATParser');
const MockSerialTransport = require('../src/hardware/MockSerialTransport');
const { NodeSession, STATES } = require('../src/hardware/NodeSession');

let totalTests = 0;
let passedTests = 0;

function it(name, fn) {
  totalTests++;
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passedTests++;
      console.log(`  ✅ PASS: ${name}`);
    })
    .catch((err) => {
      console.error(`  ❌ FAIL: ${name}`);
      console.error(`     Reason: ${err.message}`);
      throw err;
    });
}

async function runAllTests() {
  console.log('\n======================================================');
  console.log('  BARQ LINK · STAGE 2 AUTOMATED UNIT TEST SUITE');
  console.log('  Mode: Isolated Mock Serial (Zero Hardware Impact)');
  console.log('======================================================\n');

  // --------------------------------------------------------
  // TEST GROUP 1: AT Parser Core Logic
  // --------------------------------------------------------
  console.log('--- GROUP 1: ATParser Standard & Error Parsing ---');

  await it('should parse standard OK response', async () => {
    const parser = new ATParser();
    let result = null;
    const promise = new Promise((resolve, reject) => {
      parser.setPending(resolve, reject);
    });

    parser.feed('\r\nOK\r\n');
    result = await promise;
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.lines[0], 'OK');
  });

  await it('should parse multiline response before OK', async () => {
    const parser = new ATParser();
    const promise = new Promise((resolve, reject) => {
      parser.setPending(resolve, reject);
    });

    parser.feed('Quectel\r\nM25\r\nRevision: M25MAR01A12\r\n\r\nOK\r\n');
    const result = await promise;
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.lines.length, 4);
    assert.strictEqual(result.lines[0], 'Quectel');
    assert.strictEqual(result.lines[2], 'Revision: M25MAR01A12');
  });

  await it('should reject on ERROR and +CME ERROR', async () => {
    const parser = new ATParser();
    const p1 = new Promise((resolve, reject) => parser.setPending(resolve, reject));
    parser.feed('\r\nERROR\r\n');
    await assert.rejects(p1, /ERROR/);

    const p2 = new Promise((resolve, reject) => parser.setPending(resolve, reject));
    parser.feed('\r\n+CME ERROR: SIM not inserted\r\n');
    await assert.rejects(p2, /\+CME ERROR: SIM not inserted/);
  });

  // --------------------------------------------------------
  // TEST GROUP 2: Prompt '>' Detection (No Trailing Newline)
  // --------------------------------------------------------
  console.log('\n--- GROUP 2: Prompt > Detection & Non-Newline Handling ---');

  await it('should detect prompt > immediately without newline', async () => {
    const parser = new ATParser();
    const promise = new Promise((resolve, reject) => {
      parser.setPending(resolve, reject, { expectPrompt: true });
    });

    // Feed raw prompt without newline, exactly as Quectel M25 outputs
    parser.feed('> ');
    const result = await promise;
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.isPrompt, true);
  });

  await it('should handle fragmented prompt > chunks', async () => {
    const parser = new ATParser();
    const promise = new Promise((resolve, reject) => {
      parser.setPending(resolve, reject, { expectPrompt: true });
    });

    parser.feed('\r\n');
    parser.feed('>');
    const result = await promise;
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.isPrompt, true);
  });

  // --------------------------------------------------------
  // TEST GROUP 3: Command Queue Serialization & Concurrency
  // --------------------------------------------------------
  console.log('\n--- GROUP 3: Command Queue Serialization ---');

  await it('should execute multiple enqueued commands sequentially without interleaving', async () => {
    const mock = new MockSerialTransport('COM_TEST');
    await mock.open();

    const session = new NodeSession('TEST_NODE', 'COM_TEST', mock);

    mock.setScriptedResponse('AT+CMD1', '\r\nOK\r\n', 40);
    mock.setScriptedResponse('AT+CMD2', '\r\nOK\r\n', 20);
    mock.setScriptedResponse('AT+CMD3', '\r\nOK\r\n', 10);

    // Fire 3 commands simultaneously
    const p1 = session.sendCommand('AT+CMD1');
    const p2 = session.sendCommand('AT+CMD2');
    const p3 = session.sendCommand('AT+CMD3');

    const results = await Promise.all([p1, p2, p3]);

    assert.strictEqual(results[0].success, true);
    assert.strictEqual(results[1].success, true);
    assert.strictEqual(results[2].success, true);

    // Verify written order in transport
    assert.strictEqual(mock.writtenHistory[0], 'AT+CMD1\r\n');
    assert.strictEqual(mock.writtenHistory[1], 'AT+CMD2\r\n');
    assert.strictEqual(mock.writtenHistory[2], 'AT+CMD3\r\n');
  });

  await it('should timeout on silent modem and allow next queued command to proceed', async () => {
    const mock = new MockSerialTransport('COM_TEST');
    await mock.open();

    const session = new NodeSession('TEST_NODE', 'COM_TEST', mock);

    // CMD_SILENT has NO response configured -> will timeout
    mock.setScriptedResponse('AT+RECOVER', '\r\nOK\r\n', 10);

    const pSilent = session.sendCommand('AT+SILENT', { timeoutMs: 150 });
    const pRecover = session.sendCommand('AT+RECOVER', { timeoutMs: 500 });

    await assert.rejects(pSilent, /COMMAND_TIMEOUT_150MS/);
    const recoverRes = await pRecover;
    assert.strictEqual(recoverRes.success, true);
    assert.strictEqual(mock.writtenHistory[1], 'AT+RECOVER\r\n');
  });

  // --------------------------------------------------------
  // TEST GROUP 4: Hardware-First State Machine Transitions
  // --------------------------------------------------------
  console.log('\n--- GROUP 4: State Machine Verified Transitions ---');

  await it('should transition states strictly upon verified responses and URCs', async () => {
    const mock = new MockSerialTransport('COM_TEST');
    const session = new NodeSession('TEST_NODE', 'COM_TEST', mock);

    assert.strictEqual(session.state, STATES.SERIAL_DISCONNECTED);

    // 1. Open port
    await session.open();
    assert.strictEqual(session.state, STATES.SERIAL_CONNECTED);

    // 2. Incoming CPIN URC
    mock.simulateIncoming('\r\n+CPIN: READY\r\n');
    assert.strictEqual(session.state, STATES.SIM_READY);
    assert.strictEqual(session.attributes.simStatus, 'READY');

    // 3. Incoming CREG Searching
    mock.simulateIncoming('\r\n+CREG: 0,2\r\n');
    assert.strictEqual(session.state, STATES.NETWORK_SEARCHING);

    // 4. Incoming CREG Registered
    mock.simulateIncoming('\r\n+CREG: 0,1\r\n');
    assert.strictEqual(session.state, STATES.NETWORK_REGISTERED);
    assert.strictEqual(session.attributes.gsmRegistration, 'REGISTERED');

    // 5. Incoming CGREG Registered
    mock.simulateIncoming('\r\n+CGREG: 0,1\r\n');
    assert.strictEqual(session.state, STATES.PACKET_REGISTERED);
    assert.strictEqual(session.attributes.gprsRegistration, 'REGISTERED');

    // 6. Incoming CGATT Attached
    mock.simulateIncoming('\r\n+CGATT: 1\r\n');
    assert.strictEqual(session.state, STATES.PACKET_ATTACHED);
    assert.strictEqual(session.attributes.gprsAttached, true);

    // 7. CSQ Signal update (does not jump state arbitrarily)
    mock.simulateIncoming('\r\n+CSQ: 22,0\r\n');
    assert.strictEqual(session.attributes.signalCsq, 22);
    assert.strictEqual(session.attributes.signalPct, 71); // Math.round(22/31 * 100)

    // 8. Unexpected port disconnect
    mock.simulateDisconnect();
    assert.strictEqual(session.state, STATES.SERIAL_DISCONNECTED);
  });

  // --------------------------------------------------------
  // TEST GROUP 5: Stage 2 Non-Destructive Diagnostics Flow
  // --------------------------------------------------------
  console.log('\n--- GROUP 5: Stage 2 Non-Destructive Diagnostics Suite ---');

  await it('should run complete Stage 2 diagnostics suite and extract all telemetry', async () => {
    const mock = new MockSerialTransport('COM_TEST');
    await mock.open();

    const session = new NodeSession('ALPHA', 'COM_TEST', mock);
    session._setState(STATES.SERIAL_CONNECTED);

    // Script standard non-destructive responses
    mock.setScriptedResponse('AT', '\r\nOK\r\n', 5);
    mock.setScriptedResponse('ATE0', '\r\nOK\r\n', 5);
    mock.setScriptedResponse('AT+CMEE=2', '\r\nOK\r\n', 5);
    mock.setScriptedResponse('ATI', 'Quectel\r\nM25\r\nRevision: M25MAR01A12\r\n\r\nOK\r\n', 5);
    mock.setScriptedResponse('AT+CPIN?', '\r\n+CPIN: READY\r\n\r\nOK\r\n', 5);
    mock.setScriptedResponse('AT+CSQ', '\r\n+CSQ: 24,0\r\n\r\nOK\r\n', 5);
    mock.setScriptedResponse('AT+CREG?', '\r\n+CREG: 0,1\r\n\r\nOK\r\n', 5);
    mock.setScriptedResponse('AT+CGREG?', '\r\n+CGREG: 0,1\r\n\r\nOK\r\n', 5);
    mock.setScriptedResponse('AT+CGATT?', '\r\n+CGATT: 1\r\n\r\nOK\r\n', 5);
    mock.setScriptedResponse('AT+COPS?', '\r\n+COPS: 0,0,"42505"\r\n\r\nOK\r\n', 5);
    mock.setScriptedResponse('AT+CBC', '\r\n+CBC: 0,85,3940\r\n\r\nOK\r\n', 5);

    const report = await session.runStage2Diagnostics();

    assert.strictEqual(report.success, true);
    assert.strictEqual(report.nodeId, 'ALPHA');
    assert.strictEqual(report.attributes.model, 'Quectel');
    assert.strictEqual(report.attributes.firmware, 'M25');
    assert.strictEqual(report.attributes.simStatus, 'READY');
    assert.strictEqual(report.attributes.signalCsq, 24);
    assert.strictEqual(report.attributes.gsmRegistration, 'REGISTERED');
    assert.strictEqual(report.attributes.gprsRegistration, 'REGISTERED');
    assert.strictEqual(report.attributes.gprsAttached, true);
    assert.strictEqual(report.attributes.operator, '42505');
    assert.strictEqual(report.attributes.voltage, '3.94');
    assert.strictEqual(report.state, STATES.PACKET_ATTACHED);
  });

  console.log('\n======================================================');
  console.log(`  ALL ${passedTests}/${totalTests} TESTS PASSED SUCCESSFULLY! 🎯`);
  console.log('======================================================\n');
}

runAllTests().catch((err) => {
  console.error('\n❌ Test suite failed:', err);
  process.exit(1);
});
