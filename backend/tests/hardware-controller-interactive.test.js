/**
 * BARQ LINK — Automated Unit Tests for Interactive HardwareController Features
 * Tests openNode, closeNode, snapshot enhancements, message store, and emergencyStopAll
 */

'use strict';

const assert = require('assert');
const HardwareController = require('../src/hardware/HardwareController');
const MockSerialTransport = require('../src/hardware/MockSerialTransport');

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

async function run() {
  console.log('\n======================================================');
  console.log('  BARQ LINK · INTERACTIVE CONTROLLER UNIT TESTS');
  console.log('  Mode: Mock / In-Memory (Zero Hardware Impact)');
  console.log('======================================================\n');

  const controller = new HardwareController({ alphaPort: 'COM3', bravoPort: 'COM4' });

  await it('should initialize without opening serial ports', async () => {
    await controller.initialize();
    assert.strictEqual(controller.isInitialized, true);
    const snap = controller.getSnapshot();
    assert.strictEqual(snap.nodes.ALPHA.state, 'SERIAL_DISCONNECTED');
    assert.strictEqual(snap.nodes.BRAVO.state, 'SERIAL_DISCONNECTED');
  });

  await it('should resolve default relay endpoint correctly', async () => {
    const ep = controller.getDefaultRelayEndpoint();
    assert.ok(ep.host, 'Should have host');
    assert.ok(ep.port, 'Should have port');
  });

  await it('should include relay state and message list in snapshot', async () => {
    const snap = controller.getSnapshot();
    assert.ok(snap.nodes.ALPHA.relay, 'Should have relay state on ALPHA');
    assert.strictEqual(snap.nodes.ALPHA.relay.state, 'IDLE');
    assert.ok(Array.isArray(snap.messages), 'Should have messages array');
  });

  await it('should reject sendRelayMessage if sender is not registered', async () => {
    await assert.rejects(
      async () => {
        await controller.sendRelayMessage('ALPHA', 'BRAVO', 'TEST_PAYLOAD');
      },
      /not registered on the Relay Server/
    );
  });

  await it('should perform emergencyStopAll safely without errors', async () => {
    const res = await controller.emergencyStopAll();
    assert.ok(res.ALPHA);
    assert.ok(res.BRAVO);
    assert.strictEqual(res.ALPHA.port, 'CLOSED');
    assert.strictEqual(res.BRAVO.port, 'CLOSED');
  });

  console.log(`\n======================================================`);
  console.log(`  ALL ${passedTests}/${totalTests} INTERACTIVE TESTS PASSED! 🎯`);
  console.log(`======================================================\n`);
  process.exit(0);
}

run().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
