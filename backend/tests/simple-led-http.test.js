'use strict';

const http = require('http');
const net = require('net');
const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');

const HTTP_PORT = 14000;
const TCP_PORT = 15050;

function httpJson(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: HTTP_PORT,
      path: urlPath,
      method,
      headers: { 'Content-Type': 'application/json' }
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, json: JSON.parse(data) });
        } catch (e) {
          reject(new Error(`bad json ${data}`));
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function waitHealth() {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      httpJson('GET', '/api/health').then(resolve).catch(() => {
        if (Date.now() - t0 > 8000) reject(new Error('server not up'));
        else setTimeout(tick, 200);
      });
    };
    tick();
  });
}

async function main() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(HTTP_PORT), TCP_PORT: String(TCP_PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (d) => process.stdout.write(d));
  child.stderr.on('data', (d) => process.stderr.write(d));

  try {
    const health = await waitHealth();
    assert.strictEqual(health.json.status, 'ok');
    assert.strictEqual(health.json.online, false);

    const offline = await httpJson('POST', '/api/led', { action: 'on' });
    assert.strictEqual(offline.status, 409);

    const device = net.createConnection({ host: '127.0.0.1', port: TCP_PORT });
    let buf = '';
    const inbox = [];
    let waiter = null;
    device.on('data', (chunk) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 2);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (waiter) {
          const w = waiter;
          waiter = null;
          w(msg);
        } else inbox.push(msg);
      }
    });
    await new Promise((resolve) => device.once('connect', resolve));
    device.write(JSON.stringify({ type: 'REGISTER', deviceId: 'ALPHA', version: 'BARQ-RELAY-v1' }) + '\r\n');
    const ack = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no register ack')), 3000);
      waiter = (msg) => { clearTimeout(t); resolve(msg); };
    });
    assert.strictEqual(ack.type, 'REGISTER_ACK');

    const status = await httpJson('GET', '/api/status');
    assert.strictEqual(status.json.online, true);

    const ledPromise = httpJson('POST', '/api/led', { action: 'on' });
    const relayMsg = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no relay')), 3000);
      waiter = (msg) => { clearTimeout(t); resolve(msg); };
      if (inbox.length) {
        const m = inbox.shift();
        waiter = null;
        clearTimeout(t);
        resolve(m);
      }
    });
    assert.strictEqual(relayMsg.type, 'RELAY');
    assert.strictEqual(relayMsg.payload, 'LED_ON');
    device.write(JSON.stringify({
      type: 'DELIVERY_ACK',
      deviceId: 'ALPHA',
      msgId: relayMsg.msgId,
      status: 'EXECUTED',
      result: { led: 1 }
    }) + '\r\n');

    const led = await ledPromise;
    assert.strictEqual(led.status, 200);
    assert.strictEqual(led.json.ok, true);
    device.destroy();
    console.log('PASS simple-led-http');
  } finally {
    child.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
