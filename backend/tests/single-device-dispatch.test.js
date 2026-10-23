/**
 * =========================================================================
 * BARQ LINK — SINGLE-DEVICE DIRECT DISPATCH & PROTOCOL VERIFICATION TESTS
 * =========================================================================
 * Tests console-to-device direct dispatch to ALPHA without requiring BRAVO.
 * Mode: Local in-memory TCP sockets (Zero hardware required).
 * =========================================================================
 */
'use strict';

const net = require('net');
const assert = require('assert');
const RelayServer = require('../src/server/RelayServer');

const TEST_PORT = 15055;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Helper: create a mock TCP client connection that buffers CRLF-delimited JSON */
function createMockDevice(port) {
  const socket = net.createConnection({ host: '127.0.0.1', port });
  let buffer = '';
  const messages = [];
  const listeners = [];

  socket.on('data', (chunk) => {
    buffer += chunk.toString();
    let nlIdx;
    while ((nlIdx = buffer.indexOf('\r\n')) !== -1) {
      const line = buffer.slice(0, nlIdx).trim();
      buffer = buffer.slice(nlIdx + 2);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (listeners.length > 0) {
          const fn = listeners.shift();
          fn(msg);
        } else {
          messages.push(msg);
        }
      } catch (err) {
        console.error('Mock device JSON parse error:', err);
      }
    }
  });

  return {
    socket,
    messages,
    send(obj) {
      socket.write(JSON.stringify(obj) + '\r\n');
    },
    waitForMessage(timeoutMs = 4000) {
      if (messages.length > 0) {
        return Promise.resolve(messages.shift());
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = listeners.indexOf(resolve);
          if (idx !== -1) listeners.splice(idx, 1);
          reject(new Error(`Timed out waiting for message after ${timeoutMs}ms`));
        }, timeoutMs);

        listeners.push((msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
      });
    },
    close() {
      socket.destroy();
    }
  };
}

async function runSingleDeviceTests() {
  console.log('\n======================================================');
  console.log('  BARQ LINK · SINGLE-DEVICE DIRECT DISPATCH TESTS');
  console.log('  Mode: Local TCP sockets — Zero hardware required');
  console.log('======================================================\n');

  let passed = 0;
  let failed = 0;

  const server = new RelayServer({ port: TEST_PORT, deliveryTimeoutMs: 1500 });
  await server.start();

  function pass(name) {
    passed++;
    console.log(`  ✅ PASS: ${name}`);
  }

  function fail(name, err) {
    failed++;
    console.error(`  ❌ FAIL: ${name} ->`, err.message);
  }

  try {
    // ---------------------------------------------------------------
    // Test 1: Register single device ALPHA
    // ---------------------------------------------------------------
    {
      const devAlpha = createMockDevice(TEST_PORT);
      await wait(50);

      devAlpha.send({ type: 'REGISTER', deviceId: 'ALPHA', version: 'BARQ-RELAY-v1' });
      const ack = await devAlpha.waitForMessage();

      assert.strictEqual(ack.type, 'REGISTER_ACK', 'Expected REGISTER_ACK');
      assert.strictEqual(ack.deviceId, 'ALPHA');
      assert.ok(ack.serverTime, 'Expected serverTime in REGISTER_ACK');

      pass('Single device ALPHA registers and receives REGISTER_ACK');
      devAlpha.close();
      await wait(50);
    }

    // ---------------------------------------------------------------
    // Test 2: PING / PONG Heartbeat handling
    // ---------------------------------------------------------------
    {
      const devAlpha = createMockDevice(TEST_PORT);
      await wait(50);

      devAlpha.send({ type: 'REGISTER', deviceId: 'ALPHA', version: 'BARQ-RELAY-v1' });
      await devAlpha.waitForMessage(); // wait for REGISTER_ACK

      devAlpha.send({ type: 'PING', deviceId: 'ALPHA' });
      const pong = await devAlpha.waitForMessage();

      assert.strictEqual(pong.type, 'PONG', 'Expected PONG');
      assert.strictEqual(pong.deviceId, 'ALPHA');
      assert.ok(pong.serverTime, 'Expected serverTime in PONG');

      pass('Device PING receives valid server PONG heartbeat');
      devAlpha.close();
      await wait(50);
    }

    // ---------------------------------------------------------------
    // Test 3: Direct console-to-device command dispatch with EXECUTED ACK
    // ---------------------------------------------------------------
    {
      const devAlpha = createMockDevice(TEST_PORT);
      await wait(50);

      devAlpha.send({ type: 'REGISTER', deviceId: 'ALPHA', version: 'BARQ-RELAY-v1' });
      await devAlpha.waitForMessage();

      // Initiate console dispatch in parallel
      const dispatchPromise = server.sendRelayFromWeb(
        'WEB_CONSOLE',
        'ALPHA',
        JSON.stringify({ cmd: 'RELAY_ON', target: 'ALPHA' }),
        3000
      );

      // Device receives RELAY message
      const relayMsg = await devAlpha.waitForMessage();
      assert.strictEqual(relayMsg.type, 'RELAY');
      assert.strictEqual(relayMsg.to, 'ALPHA');
      assert.strictEqual(relayMsg.from, 'WEB_CONSOLE');
      assert.ok(relayMsg.msgId, 'Expected msgId');

      // Device simulates local GPIO execution and sends truthful DELIVERY_ACK
      devAlpha.send({
        type: 'DELIVERY_ACK',
        deviceId: 'ALPHA',
        msgId: relayMsg.msgId,
        from: 'ALPHA',
        to: 'WEB_CONSOLE',
        status: 'EXECUTED',
        result: { pin: 7, relayState: 1 }
      });

      const confirmed = await dispatchPromise;
      assert.strictEqual(confirmed.status, 'EXECUTED', 'Expected EXECUTED status in server resolution');
      assert.strictEqual(confirmed.id, relayMsg.msgId);
      assert.strictEqual(confirmed.to, 'ALPHA');
      assert.strictEqual(confirmed.result.relayState, 1);
      assert.ok(confirmed.rttMs >= 0);

      pass('Direct console-to-ALPHA dispatch successfully returns verified EXECUTED result');
      devAlpha.close();
      await wait(50);
    }

    // ---------------------------------------------------------------
    // Test 4: Offline device rejection
    // ---------------------------------------------------------------
    {
      try {
        await server.sendRelayFromWeb('WEB_CONSOLE', 'OFFLINE_NODE', '{"cmd":"PING"}', 1000);
        fail('Offline device dispatch did not throw', new Error('Expected rejection'));
      } catch (err) {
        assert.ok(err.message.includes('not connected'), 'Expected device not connected error');
        pass('Dispatch to offline device is immediately rejected');
      }
    }

    // ---------------------------------------------------------------
    // Test 5: Rejection of unauthorized ACK from wrong device session
    // ---------------------------------------------------------------
    {
      const devAlpha = createMockDevice(TEST_PORT);
      const devAttacker = createMockDevice(TEST_PORT);
      await wait(50);

      devAlpha.send({ type: 'REGISTER', deviceId: 'ALPHA', version: 'BARQ-RELAY-v1' });
      await devAlpha.waitForMessage();

      devAttacker.send({ type: 'REGISTER', deviceId: 'ATTACKER', version: 'BARQ-RELAY-v1' });
      await devAttacker.waitForMessage();

      // Send to ALPHA
      const dispatchPromise = server.sendRelayFromWeb('WEB_CONSOLE', 'ALPHA', '{"cmd":"RELAY_ON"}', 1000);
      const relayMsg = await devAlpha.waitForMessage();

      // Attacker tries to ACK ALPHA's message
      devAttacker.send({
        type: 'DELIVERY_ACK',
        deviceId: 'ATTACKER',
        msgId: relayMsg.msgId,
        status: 'EXECUTED'
      });

      const attackerErr = await devAttacker.waitForMessage();
      assert.strictEqual(attackerErr.type, 'ERROR');
      assert.strictEqual(attackerErr.code, 'UNAUTHORIZED_ACK');

      // Now valid ALPHA ACKs
      devAlpha.send({
        type: 'DELIVERY_ACK',
        deviceId: 'ALPHA',
        msgId: relayMsg.msgId,
        status: 'EXECUTED'
      });

      const confirmed = await dispatchPromise;
      assert.strictEqual(confirmed.status, 'EXECUTED');

      pass('Unauthorized ACK from wrong device session is rejected with UNAUTHORIZED_ACK');
      devAlpha.close();
      devAttacker.close();
      await wait(50);
    }

    // ---------------------------------------------------------------
    // Test 6: Unknown msgId returns INVALID_MSG_ID
    // ---------------------------------------------------------------
    {
      const devAlpha = createMockDevice(TEST_PORT);
      await wait(50);

      devAlpha.send({ type: 'REGISTER', deviceId: 'ALPHA', version: 'BARQ-RELAY-v1' });
      await devAlpha.waitForMessage();

      devAlpha.send({
        type: 'DELIVERY_ACK',
        deviceId: 'ALPHA',
        msgId: 'non-existent-msg-id-999',
        status: 'EXECUTED'
      });

      const err = await devAlpha.waitForMessage();
      assert.strictEqual(err.type, 'ERROR');
      assert.strictEqual(err.code, 'INVALID_MSG_ID');

      pass('Spurious ACK with unknown msgId is rejected with INVALID_MSG_ID');
      devAlpha.close();
      await wait(50);
    }

    // ---------------------------------------------------------------
    // Test 7: Delivery timeout cleanup
    // ---------------------------------------------------------------
    {
      const devAlpha = createMockDevice(TEST_PORT);
      await wait(50);

      devAlpha.send({ type: 'REGISTER', deviceId: 'ALPHA', version: 'BARQ-RELAY-v1' });
      await devAlpha.waitForMessage();

      const startTime = Date.now();
      try {
        await server.sendRelayFromWeb('WEB_CONSOLE', 'ALPHA', '{"cmd":"TIMEOUT_TEST"}', 600);
        fail('Command did not timeout', new Error('Expected timeout rejection'));
      } catch (err) {
        const elapsed = Date.now() - startTime;
        assert.ok(err.message.includes('DELIVERY_TIMEOUT'), 'Expected DELIVERY_TIMEOUT message');
        assert.ok(elapsed >= 550, `Expected elapsed >= 550ms, was ${elapsed}ms`);
        pass('Unacknowledged command cleanly times out and releases pending tracking state');
      }

      devAlpha.close();
      await wait(50);
    }

  } catch (fatal) {
    fail('Fatal test runner failure', fatal);
  } finally {
    await server.stop();
  }

  console.log('\n======================================================');
  console.log(`  RESULTS: ${passed} PASSED | ${failed} FAILED`);
  console.log('======================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  runSingleDeviceTests();
}

module.exports = runSingleDeviceTests;
