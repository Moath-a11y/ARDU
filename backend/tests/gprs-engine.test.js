/**
 * BARQ LINK — Stage 3 GPRS Engine Automated Unit Tests
 * Mode: Isolated Mock Serial Transport (Explicitly Labeled MOCK)
 * Tests state transitions, timeout handling, prompt detection, and IP parsing.
 */

const assert = require('assert');
const MockSerialTransport = require('../src/hardware/MockSerialTransport');
const { NodeSession, STATES } = require('../src/hardware/NodeSession');
const { GprsEngine, GPRS_STATES } = require('../src/hardware/GprsEngine');

let totalTests = 0;
let passedTests = 0;

function it(name, fn) {
  totalTests++;
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passedTests++;
      console.log(`  ✅ [MOCK] PASS: ${name}`);
    })
    .catch((err) => {
      console.error(`  ❌ [MOCK] FAIL: ${name}`);
      console.error(`     Reason: ${err.message}`);
      throw err;
    });
}

async function runStage3MockTests() {
  console.log('\n======================================================');
  console.log('  BARQ LINK · STAGE 3 GPRS ENGINE UNIT TESTS (MOCK)');
  console.log('  Mode: Isolated Mock Serial Transport (Zero Cost)');
  console.log('======================================================\n');

  console.log('--- TEST GROUP 1: GPRS PDP Configuration & Activation ---');

  await it('should configure PDP parameters (QIFGCNT, QINDI=1 & QICSGP)', async () => {
    const mock = new MockSerialTransport('COM_MOCK');
    await mock.open();
    const session = new NodeSession('ALPHA', 'COM_MOCK', mock);
    session._setState(STATES.PACKET_ATTACHED);

    mock.setScriptedResponse('AT', '\r\nOK\r\n', 5);
    mock.setScriptedResponse('AT+QICLOSE', '\r\nCLOSE OK\r\n', 5);
    mock.setScriptedResponse('AT+QIDEACT', '\r\nDEACT OK\r\n', 5);
    mock.setScriptedResponse('AT+QIFGCNT=0', '\r\nOK\r\n', 5);
    mock.setScriptedResponse('AT+QINDI=1', '\r\nOK\r\n', 5);
    mock.setScriptedResponse('AT+QICSGP=1,"internet"', '\r\nOK\r\n', 5);

    const engine = new GprsEngine(session);
    const res = await engine.configurePdp('internet');

    assert.strictEqual(res.success, true);
    assert.strictEqual(engine.gprsState, GPRS_STATES.PDP_CONFIGURED);
    assert.strictEqual(engine.apn, 'internet');
  });

  await it('should abort PDP configuration if setting AT+QINDI=1 fails', async () => {
    const mock = new MockSerialTransport('COM_MOCK');
    await mock.open();
    const session = new NodeSession('ALPHA', 'COM_MOCK', mock);
    session._setState(STATES.PACKET_ATTACHED);

    mock.setScriptedResponse('AT', '\r\nOK\r\n', 5);
    mock.setScriptedResponse('AT+QICLOSE', '\r\nCLOSE OK\r\n', 5);
    mock.setScriptedResponse('AT+QIDEACT', '\r\nDEACT OK\r\n', 5);
    mock.setScriptedResponse('AT+QIFGCNT=0', '\r\nOK\r\n', 5);
    mock.setScriptedResponse('AT+QINDI=1', '\r\nERROR\r\n', 5);

    const engine = new GprsEngine(session);
    await assert.rejects(engine.configurePdp('internet'), /QINDI_CONFIG_FAILED/);
    assert.strictEqual(engine.gprsState, GPRS_STATES.ERROR);
  });

  await it('should activate PDP context through QIREGAPP and QIACT', async () => {
    const mock = new MockSerialTransport('COM_MOCK');
    await mock.open();
    const session = new NodeSession('ALPHA', 'COM_MOCK', mock);
    const engine = new GprsEngine(session);

    mock.setScriptedResponse('AT+CGATT?', '\r\n+CGATT: 1\r\n\r\nOK\r\n', 5);
    mock.setScriptedResponse('AT+QIREGAPP', '\r\nOK\r\n', 5);
    mock.setScriptedResponse('AT+QIACT', '\r\nOK\r\n', 15);

    const res = await engine.activatePdp();
    assert.strictEqual(res.success, true);
    assert.strictEqual(engine.gprsState, GPRS_STATES.PDP_ACTIVE);
  });

  await it('should handle PDP activation error cleanly', async () => {
    const mock = new MockSerialTransport('COM_MOCK');
    await mock.open();
    const session = new NodeSession('ALPHA', 'COM_MOCK', mock);
    const engine = new GprsEngine(session);

    mock.setScriptedResponse('AT+CGATT?', '\r\n+CGATT: 1\r\n\r\nOK\r\n', 5);
    mock.setScriptedResponse('AT+QIREGAPP', '\r\nOK\r\n', 5);
    mock.setScriptedResponse('AT+QIACT', '\r\nERROR\r\n', 5);

    await assert.rejects(engine.activatePdp(), /ERROR/);
    assert.strictEqual(engine.gprsState, GPRS_STATES.ERROR);
  });

  console.log('\n--- TEST GROUP 2: Carrier IP Query & Parsing (No OK) ---');

  await it('should parse numeric IP address returned by AT+QILOCIP without trailing OK', async () => {
    const mock = new MockSerialTransport('COM_MOCK');
    await mock.open();
    const session = new NodeSession('ALPHA', 'COM_MOCK', mock);
    const engine = new GprsEngine(session);

    // M25 returns IP directly followed by CRLF without OK
    mock.setScriptedResponse('AT+QILOCIP', '\r\n10.142.66.12\r\n', 5);

    const res = await engine.queryAssignedIp();
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.ip, '10.142.66.12');
    assert.strictEqual(engine.assignedIp, '10.142.66.12');
    assert.strictEqual(engine.gprsState, GPRS_STATES.IP_ASSIGNED);
  });

  console.log('\n--- TEST GROUP 3: TCP Connection & Socket Management ---');

  await it('should open TCP socket and wait for asynchronous CONNECT OK', async () => {
    const mock = new MockSerialTransport('COM_MOCK');
    await mock.open();
    const session = new NodeSession('ALPHA', 'COM_MOCK', mock);
    const engine = new GprsEngine(session);

    mock.setScriptedResponse('AT+QICLOSE', '\r\nCLOSE OK\r\n', 5);
    // M25 returns OK first, then CONNECT OK
    mock.setScriptedResponse('AT+QIOPEN="TCP","44.232.241.40",1883', '\r\nOK\r\n\r\nCONNECT OK\r\n', 20);

    const res = await engine.connectTcp('44.232.241.40', 1883);
    assert.strictEqual(res.success, true);
    assert.strictEqual(engine.gprsState, GPRS_STATES.TCP_CONNECTED);
    assert.strictEqual(engine.socketInfo.isConnected, true);
  });

  await it('should reject on CONNECT FAIL', async () => {
    const mock = new MockSerialTransport('COM_MOCK');
    await mock.open();
    const session = new NodeSession('ALPHA', 'COM_MOCK', mock);
    const engine = new GprsEngine(session);

    mock.setScriptedResponse('AT+QICLOSE', '\r\nCLOSE OK\r\n', 5);
    mock.setScriptedResponse('AT+QIOPEN="TCP","1.2.3.4",80', '\r\nOK\r\n\r\nCONNECT FAIL\r\n', 20);

    await assert.rejects(engine.connectTcp('1.2.3.4', 80), /CONNECT FAIL/);
    assert.strictEqual(engine.socketInfo.isConnected, false);
    assert.strictEqual(engine.gprsState, GPRS_STATES.ERROR);
  });

  console.log('\n--- TEST GROUP 4: Payload Dispatch with > Prompt & SEND OK ---');

  await it('should strictly wait for > prompt before transmitting binary payload and verify SEND OK', async () => {
    const mock = new MockSerialTransport('COM_MOCK');
    await mock.open();
    const session = new NodeSession('ALPHA', 'COM_MOCK', mock);
    const engine = new GprsEngine(session);
    engine.socketInfo.isConnected = true;

    // Script prompt response for AT+QISEND=16
    mock.setScriptedResponse('AT+QISEND=16', '> ', 5);

    // After data is sent to transport, mock simulates SEND OK
    const sendPromise = engine.sendPayload('TEST_PAYLOAD_123');

    // Simulate modem returning SEND OK after data arrives
    setTimeout(() => {
      mock.simulateIncoming('\r\nSEND OK\r\n');
    }, 40);

    const res = await sendPromise;
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.bytesSent, 16);
  });

  console.log('\n--- TEST GROUP 5: Clean Teardown (AT+QICLOSE & AT+QIDEACT) ---');

  await it('should close socket via AT+QICLOSE and verify CLOSE OK', async () => {
    const mock = new MockSerialTransport('COM_MOCK');
    await mock.open();
    const session = new NodeSession('ALPHA', 'COM_MOCK', mock);
    const engine = new GprsEngine(session);
    engine.socketInfo.isConnected = true;

    mock.setScriptedResponse('AT+QICLOSE', '\r\nCLOSE OK\r\n', 5);

    const res = await engine.closeTcp();
    assert.strictEqual(res.success, true);
    assert.strictEqual(engine.socketInfo.isConnected, false);
  });

  await it('should deactivate PDP via AT+QIDEACT and verify DEACT OK', async () => {
    const mock = new MockSerialTransport('COM_MOCK');
    await mock.open();
    const session = new NodeSession('ALPHA', 'COM_MOCK', mock);
    const engine = new GprsEngine(session);
    engine.assignedIp = '10.142.66.12';

    mock.setScriptedResponse('AT+QIDEACT', '\r\nDEACT OK\r\n', 10);

    const res = await engine.deactivatePdp();
    assert.strictEqual(res.success, true);
    assert.strictEqual(engine.assignedIp, null);
    assert.strictEqual(engine.gprsState, GPRS_STATES.PACKET_ATTACHED);
  });

  console.log('\n======================================================');
  console.log(`  ALL ${passedTests}/${totalTests} STAGE 3 MOCK TESTS PASSED! 🎯`);
  console.log('======================================================\n');
}

runStage3MockTests().catch((err) => {
  console.error('\n❌ Stage 3 mock test suite failed:', err);
  process.exit(1);
});
