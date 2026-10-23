'use strict';
const net = require('net');
const fs = require('fs');
const path = require('path');

// Read active public TCP endpoint
const epFile = path.join(__dirname, '..', 'pinggy_endpoint.json');
const ep = JSON.parse(fs.readFileSync(epFile, 'utf8'));

const host = ep.ip || ep.host;
const port = ep.port;

console.log(`\n════════════════════════════════════════════════════════`);
console.log(`  BARQ LINK · PUBLIC TCP RELAY VERIFICATION TEST`);
console.log(`  Target: ${host}:${port}`);
console.log(`════════════════════════════════════════════════════════\n`);

function createNode(deviceId) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port }, () => {
      sock.write(JSON.stringify({ type: 'REGISTER', deviceId, version: 'BARQ-RELAY-v1' }) + '\r\n');
    });
    sock.once('data', (buf) => {
      try {
        const msg = JSON.parse(buf.toString().trim());
        if (msg.type === 'REGISTER_ACK') {
          resolve({ deviceId, sock });
        } else {
          reject(new Error('Unexpected ACK: ' + buf.toString()));
        }
      } catch (e) {
        reject(e);
      }
    });
    sock.on('error', reject);
    sock.setTimeout(10000, () => {
      sock.destroy();
      reject(new Error(`Timeout connecting node ${deviceId}`));
    });
  });
}

(async () => {
  try {
    console.log('1. Connecting ALPHA and BRAVO to public TCP relay...');
    const alpha = await createNode('ALPHA');
    console.log('  ✅ ALPHA Registered successfully');
    const bravo = await createNode('BRAVO');
    console.log('  ✅ BRAVO Registered successfully');

    let bravoReceived = false;
    let alphaAckReceived = false;

    bravo.sock.on('data', (buf) => {
      const line = buf.toString().trim();
      console.log('  📬 [BRAVO INBOUND]:', line);
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'RELAY' && msg.from === 'ALPHA') {
          bravoReceived = true;
          // Send back verified DELIVERY_ACK
          const ack = JSON.stringify({
            type: 'DELIVERY_ACK',
            deviceId: 'BRAVO',
            msgId: msg.msgId,
            status: 'DELIVERED'
          }) + '\r\n';
          bravo.sock.write(ack);
          console.log('  📤 [BRAVO ACK SENT] DELIVERY_ACK for msgId:', msg.msgId);
        }
      } catch (e) {}
    });

    alpha.sock.on('data', (buf) => {
      const line = buf.toString().trim();
      console.log('  📬 [ALPHA INBOUND]:', line);
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'DELIVERY_ACK' && msg.msgId === 'msg-standalone-cloud-001') {
          alphaAckReceived = true;
          console.log('  🎉 [ALPHA CONFIRMED] Message was delivered to BRAVO!');
        }
      } catch (e) {}
    });

    // ALPHA dispatches RELAY message to BRAVO
    console.log('2. ALPHA dispatching RELAY message to BRAVO...');
    const relayMsg = JSON.stringify({
      type: 'RELAY',
      from: 'ALPHA',
      to: 'BRAVO',
      msgId: 'msg-standalone-cloud-001',
      payload: '{"cmd":"RELAY_ON","trigger":"TEST_PAYLOAD"}'
    }) + '\r\n';
    alpha.sock.write(relayMsg);

    // Wait for round-trip
    await new Promise(r => setTimeout(r, 3000));

    alpha.sock.destroy();
    bravo.sock.destroy();

    if (bravoReceived && alphaAckReceived) {
      console.log('\n════════════════════════════════════════════════════════');
      console.log('  🎯 ALL VERIFICATION CHECKS PASSED SUCCESSFULLY!');
      console.log('  - Independent ALPHA and BRAVO identities: OK');
      console.log('  - Public TCP GPRS Forwarding: OK');
      console.log('  - Bidirectional DELIVERY_ACK Roundtrip: OK');
      console.log('════════════════════════════════════════════════════════\n');
      process.exit(0);
    } else {
      console.error(`\n❌ TEST INCOMPLETE: bravoReceived=${bravoReceived}, alphaAckReceived=${alphaAckReceived}`);
      process.exit(1);
    }
  } catch (err) {
    console.error('❌ Test error:', err.message);
    process.exit(1);
  }
})();
