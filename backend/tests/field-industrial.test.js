'use strict';

const assert = require('assert');
const net = require('net');
const { isIPv4, loadFieldConfig, assertModemHost } = require('../src/config/fieldConfig');
const { validateProcessCommand, isProcessCommand, safeShutdownCommand } = require('../src/protocol/ProcessCommands');
const { encodeFrame, decodeFrame, fromProcessCommand, FRAME_LEN } = require('../src/protocol/PicBus');
const { resolveConflict, commandsDisagree, encodeRadioDatagram } = require('../src/protocol/RadioFallback');
const { nextState, STATES, qiopenCommand } = require('../src/protocol/CommsFsm');
const PicIoRuntime = require('../src/runtime/PicIoRuntime');
const RelayServer = require('../src/server/RelayServer');
const FieldCommandService = require('../src/server/FieldCommandService');

let total = 0, passed = 0, failed = 0;

async function it(name, fn) {
  total++;
  try {
    await fn();
    passed++;
    console.log('  PASS:', name);
  } catch (err) {
    failed++;
    console.error('  FAIL:', name, err.message);
  }
}

async function main() {
  console.log('\n--- Field industrial protocol tests ---\n');

  await it('rejects non-IPv4 modem hosts', () => {
    assert.strictEqual(isIPv4('37.27.37.254'), true);
    assert.throws(() => assertModemHost('serveousercontent.com'));
  });

  await it('Pinggy stays off unless opted in', () => {
    const cfg = loadFieldConfig({ BARQ_MODE: 'field', BARQ_ENABLE_PINGGY: '0' });
    assert.strictEqual(cfg.enablePinggy, false);
  });

  await it('rejects unarmed DO_SET', () => {
    const v = validateProcessCommand({ cmd: 'DO_SET', ch: 1, val: 1 });
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.code, 'NOT_ARMED');
  });

  await it('accepts armed DO_SET and PIC executes', () => {
    const cmd = { cmd: 'DO_SET', ch: 1, val: 1, safety: 'ARMED' };
    assert.strictEqual(validateProcessCommand(cmd).ok, true);
    const pic = new PicIoRuntime();
    const r = pic.execute(cmd);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.executed, true);
    assert.strictEqual(r.outputs[0], 1);
  });

  await it('PicBus roundtrip CRC', () => {
    const frame = encodeFrame({ cmd: 'DO_SAFE', ch: 0, value: 0, seq: 3 });
    assert.strictEqual(frame.length, FRAME_LEN);
    const d = decodeFrame(frame);
    assert.strictEqual(d.ok, true);
    assert.strictEqual(d.cmd, 'DO_SAFE');
  });

  await it('fromProcessCommand maps DO_SET', () => {
    const buf = fromProcessCommand({ cmd: 'DO_SET', ch: 2, val: 1, safety: 'ARMED' }, 1);
    const d = decodeFrame(buf);
    assert.strictEqual(d.ch, 2);
    assert.strictEqual(d.armed, true);
  });

  await it('radio conflict forces SAFE not last-command', () => {
    const a = { cmd: 'DO_SET', ch: 1, val: 1, safety: 'ARMED' };
    const b = { cmd: 'DO_SET', ch: 1, val: 0, safety: 'ARMED' };
    assert.strictEqual(commandsDisagree(a, b), true);
    const r = resolveConflict(a, b, 100, 100, 2000);
    assert.strictEqual(r.action, 'SAFE');
    assert.strictEqual(r.command.cmd, 'DO_SAFE');
  });

  await it('radio fallback used when cellular stale', () => {
    const radio = { cmd: 'DO_SAFE' };
    const r = resolveConflict({ cmd: 'DO_SET', ch: 1, val: 1, safety: 'ARMED' }, radio, 5000, 50, 2000);
    assert.strictEqual(r.action, 'RADIO');
  });

  await it('radio datagram encodes PicBus', () => {
    const buf = encodeRadioDatagram({ cmd: 'HB' }, 9);
    assert.strictEqual(decodeFrame(buf).cmd, 'HB');
  });

  await it('comms FSM reaches ONLINE', () => {
    let s = STATES.BOOT;
    s = nextState(s, 'POWER_OK');
    s = nextState(s, 'AT_OK');
    s = nextState(s, 'READY');
    s = nextState(s, 'REGISTERED');
    s = nextState(s, 'OK');
    s = nextState(s, 'IP');
    s = nextState(s, 'CONNECT_OK');
    s = nextState(s, 'ACK');
    assert.strictEqual(s, STATES.ONLINE);
    assert.ok(qiopenCommand('37.27.37.254', 8406).includes('37.27.37.254'));
  });

  await it('PIC fail-safe drops outputs', async () => {
    const pic = new PicIoRuntime({ failSafeMs: 20 });
    pic.execute({ cmd: 'DO_SET', ch: 1, val: 1, safety: 'ARMED' });
    await new Promise((r) => setTimeout(r, 30));
    pic.applyFailSafeIfNeeded();
    assert.strictEqual(pic.outputs[0], 0);
  });

  await it('isProcessCommand ignores chat RELAY_ON', () => {
    assert.strictEqual(isProcessCommand({ cmd: 'RELAY_ON' }), false);
    assert.strictEqual(isProcessCommand({ cmd: 'DO_SAFE' }), true);
  });

  const PORT = 15051;
  const server = new RelayServer({ port: PORT, deliveryTimeoutMs: 1500 });
  await server.start();

  await it('HMI injectRelay waits for DELIVERY_ACK', async () => {
    const device = net.createConnection({ host: '127.0.0.1', port: PORT });
    await new Promise((res) => device.on('connect', res));
    let buf = '';
    const got = new Promise((resolve) => {
      device.on('data', (c) => {
        buf += c.toString('utf8');
        if (buf.includes('REGISTER_ACK')) {
          /* wait for RELAY */
        }
        const lines = buf.split('\r\n').filter(Boolean);
        for (const line of lines) {
          try {
            const msg = JSON.parse(line);
            if (msg.type === 'RELAY') {
              device.write(JSON.stringify({
                type: 'DELIVERY_ACK',
                msgId: msg.msgId,
                from: 'BRAVO',
                to: 'HMI',
                status: 'DELIVERED'
              }) + '\r\n');
            }
          } catch (_) {}
        }
      });
    });
    device.write(JSON.stringify({ type: 'REGISTER', deviceId: 'BRAVO', version: 'BARQ-RELAY-v1' }) + '\r\n');
    await new Promise((r) => setTimeout(r, 50));
    const field = new FieldCommandService(server, { armWindowMs: 5000 });
    field.arm();
    const p = field.sendCommand('BRAVO', { cmd: 'DO_SET', ch: 1, val: 1 }, 2000);
    const entry = await p;
    assert.strictEqual(entry.status, 'DELIVERED');
    device.destroy();
    void got;
  });

  await it('unarmed field command is rejected before TCP', async () => {
    const field = new FieldCommandService(server, { armWindowMs: 1 });
    await assert.rejects(
      field.sendCommand('BRAVO', { cmd: 'DO_SET', ch: 1, val: 1 }),
      /NOT_ARMED/
    );
  });

  await it('server rejects unarmed process RELAY from a device', async () => {
    const a = net.createConnection({ host: '127.0.0.1', port: PORT });
    const b = net.createConnection({ host: '127.0.0.1', port: PORT });
    await Promise.all([
      new Promise((res) => a.on('connect', res)),
      new Promise((res) => b.on('connect', res))
    ]);
    a.write(JSON.stringify({ type: 'REGISTER', deviceId: 'ALPHA2', version: 'BARQ-RELAY-v1' }) + '\r\n');
    b.write(JSON.stringify({ type: 'REGISTER', deviceId: 'BRAVO2', version: 'BARQ-RELAY-v1' }) + '\r\n');
    await new Promise((r) => setTimeout(r, 40));
    const errP = new Promise((resolve) => {
      a.on('data', (c) => {
        const s = c.toString('utf8');
        if (s.includes('NOT_ARMED')) resolve(true);
      });
    });
    a.write(JSON.stringify({
      type: 'RELAY',
      msgId: 'm1',
      from: 'ALPHA2',
      to: 'BRAVO2',
      payload: JSON.stringify({ cmd: 'DO_SET', ch: 1, val: 1 })
    }) + '\r\n');
    const ok = await Promise.race([errP, new Promise((r) => setTimeout(() => r(false), 1000))]);
    assert.strictEqual(ok, true);
    a.destroy();
    b.destroy();
  });

  await server.stop();
  console.log('\nResult', passed + '/' + total, 'failed', failed);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
