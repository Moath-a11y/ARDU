'use strict';
const fs = require('fs');
const path = require('path');
const dns = require('dns');

const FILES = [
  path.join(__dirname, '..', 'firmware', 'arduino_led_gprs.ino'),
  path.join(__dirname, '..', 'firmware', 'arduino_led_gprs', 'arduino_led_gprs.ino')
];

function patch(ip, port) {
  for (const file of FILES) {
    if (!fs.existsSync(file)) continue;
    let src = fs.readFileSync(file, 'utf8');
    src = src.replace(/const char SERVER_HOST\[\] PROGMEM = "[^"]*";/, `const char SERVER_HOST[] PROGMEM = "${ip}";`);
    src = src.replace(/const uint16_t SERVER_PORT = \d+;/, `const uint16_t SERVER_PORT = ${port};`);
    fs.writeFileSync(file, src);
    console.log(`[PATCH] ${file} -> ${ip}:${port}`);
  }
}

async function fromEndpointFile() {
  const epFile = path.join(__dirname, 'pinggy_endpoint.json');
  if (!fs.existsSync(epFile)) throw new Error('pinggy_endpoint.json missing');
  const ep = JSON.parse(fs.readFileSync(epFile, 'utf8'));
  const host = ep.ip || ep.host;
  const port = Number(ep.port);
  const ip = await new Promise((resolve, reject) => {
    dns.lookup(host, { family: 4 }, (err, address) => {
      if (err) reject(err);
      else resolve(address);
    });
  });
  ep.ip = ip;
  fs.writeFileSync(epFile, JSON.stringify(ep, null, 2));
  patch(ip, port);
  return { ip, port };
}

if (require.main === module) {
  fromEndpointFile().then((r) => {
    console.log(`Firmware endpoint ${r.ip}:${r.port}`);
  }).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}

module.exports = { patch, fromEndpointFile };
