'use strict';

const { spawn } = require('child_process');
const dns = require('dns');
const fs = require('fs');
const net = require('net');
const { patch } = require('./patch_firmware_endpoint');

const LOCAL_PORT = 5050;

function probeLocal() {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port: LOCAL_PORT }, () => {
      s.destroy();
      resolve(true);
    });
    s.on('error', () => resolve(false));
    s.setTimeout(2000, () => { s.destroy(); resolve(false); });
  });
}

function lookup4(host) {
  return new Promise((resolve) => {
    dns.lookup(host, { family: 4 }, (err, address) => resolve(err ? null : address));
  });
}

function saveEndpoint(host, port, ip) {
  const endpoint = {
    host,
    port,
    ip,
    url: `tcp://${host}:${port}`,
    timestamp: new Date().toISOString(),
    source: 'serveo'
  };
  fs.writeFileSync('pinggy_endpoint.json', JSON.stringify(endpoint, null, 2));
  console.log(`[SERVEO] ${ip || host}:${port}`);
  try { patch(ip || host, port); } catch (e) { console.warn(e.message); }
  return endpoint;
}

function keepalive(ip, port) {
  setInterval(() => {
    const s = net.connect({ host: ip, port });
    s.setTimeout(4000);
    s.on('connect', () => s.destroy());
    s.on('timeout', () => { s.destroy(); console.warn('[KEEPALIVE] timeout'); });
    s.on('error', (err) => console.warn('[KEEPALIVE]', err.message));
  }, 20000);
}

async function main() {
  if (!(await probeLocal())) {
    console.error('السيرفر غير شغال على 5050');
    process.exit(1);
  }

  console.log('Opening Serveo TCP tunnel to localhost:' + LOCAL_PORT);
  const ssh = spawn('ssh', [
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ServerAliveInterval=20',
    '-o', 'ServerAliveCountMax=6',
    '-o', 'ExitOnForwardFailure=yes',
    '-R', `0:127.0.0.1:${LOCAL_PORT}`,
    'serveo.net'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let started = false;
  const onData = async (buf) => {
    const text = buf.toString();
    process.stdout.write(text);
    const m = text.match(/Allocated port (\d+)/i) || text.match(/serveousercontent\.com:(\d+)/i);
    if (!started && m) {
      started = true;
      const port = Number(m[1]);
      const ip = (await lookup4('serveousercontent.com')) || '37.27.37.254';
      saveEndpoint('serveousercontent.com', port, ip);
      keepalive(ip, port);
    }
  };
  ssh.stdout.on('data', onData);
  ssh.stderr.on('data', onData);
  ssh.on('exit', (code) => {
    console.error('Serveo exited', code);
    process.exit(code || 1);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
