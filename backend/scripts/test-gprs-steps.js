const http = require('http');

async function send(cmd) {
  return new Promise((resolve) => {
    const data = JSON.stringify({ command: cmd, timeoutMs: 25000 });
    const req = http.request({
      hostname: 'localhost',
      port: 4000,
      path: '/api/nodes/ALPHA/at',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(JSON.parse(b)));
    });
    req.write(data); req.end();
  });
}

async function test() {
  console.log('1. Deactivating to get clean IP INITIAL:');
  const r1 = await send('AT+QIDEACT');
  console.log('QIDEACT:', r1.raw);

  console.log('2. Check state:');
  const r2 = await send('AT+QISTAT');
  console.log('QISTAT:', r2.raw);

  console.log('3. Set APN:');
  const r3 = await send('AT+QICSGP=1,"internet"');
  console.log('QICSGP:', r3.raw);

  console.log('4. QIREGAPP:');
  const r4 = await send('AT+QIREGAPP');
  console.log('QIREGAPP:', r4.raw);

  console.log('5. QIACT:');
  const r5 = await send('AT+QIACT');
  console.log('QIACT:', r5.raw);

  console.log('6. Query IP (AT+QILOCIP):');
  const r6 = await send('AT+QILOCIP');
  console.log('QILOCIP:', r6.raw);
}

test();
