/**
 * BARQ LINK — نفق Pinggy المزدوج (HTTP + TCP) مع مراقبة نشطة وإعادة اتصال تلقائية
 * HTTP 4000: واجهة التحكم من أي جهاز
 * TCP  5050: مودم الشريحة (IPv4)
 */
'use strict';
const { pinggy, TunnelType } = require('@pinggy/pinggy');
const net = require('net');
const fs = require('fs');
const path = require('path');
const dns = require('dns');

const TCP_PORT = 5050;
const HTTP_PORT = 4000;
const EP_FILE = path.join(__dirname, 'pinggy_endpoint.json');
const RETRY_DELAY_MS = 4000;
const MAX_RETRIES = 9999;

let currentTunnel = null;
let shuttingDown = false;

function probeLocal(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port }, () => {
      s.destroy();
      resolve(true);
    });
    s.on('error', () => resolve(false));
    setTimeout(() => {
      s.destroy();
      resolve(false);
    }, 2000);
  });
}

function lookup4(host) {
  return new Promise((resolve) => {
    let attempts = 0;
    function tryLookup() {
      dns.lookup(host, { family: 4 }, (err, address) => {
        if (!err && address) return resolve(address);
        if (++attempts < 4) return setTimeout(tryLookup, 1200);
        resolve(null);
      });
    }
    tryLookup();
  });
}

function parseTcp(url) {
  const stripped = String(url).replace(/^tcp:\/\//, '');
  const colonIdx = stripped.lastIndexOf(':');
  return {
    host: stripped.slice(0, colonIdx),
    port: parseInt(stripped.slice(colonIdx + 1), 10)
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function stopCurrent() {
  if (currentTunnel) {
    try {
      await currentTunnel.stop();
    } catch (_) {}
    currentTunnel = null;
  }
}

async function startOnce() {
  console.log('[TUNNEL] بدء فتح نفق Pinggy المزدوج (HTTP ' + HTTP_PORT + ' + TCP ' + TCP_PORT + ')...');

  let forwardingConfig = [
    { address: 'localhost:' + HTTP_PORT, type: TunnelType.Http },
    { address: 'localhost:' + TCP_PORT, type: TunnelType.Tcp }
  ];
  let tunnel;
  try {
    tunnel = await pinggy.createTunnel({ forwarding: forwardingConfig });
    await tunnel.start();
  } catch (err) {
    console.warn('[TUNNEL] فشل النفق المزدوج — التحويل إلى TCP فقط:', err.message);
    forwardingConfig = [{ address: 'localhost:' + TCP_PORT, type: TunnelType.Tcp }];
    tunnel = await pinggy.createTunnel({ forwarding: forwardingConfig });
    await tunnel.start();
  }
  currentTunnel = tunnel;

  const urls = await tunnel.urls();
  console.log('[TUNNEL] URLs المستلمة:', urls);

  const webUrl = urls.find((u) => u.startsWith('https://')) || urls.find((u) => u.startsWith('http://')) || null;
  const tcpUrl = urls.find((u) => u.startsWith('tcp://')) || urls.find((u) => /:\d+$/.test(u));

  if (!tcpUrl) {
    throw new Error('لم يتم استلام رابط TCP من Pinggy: ' + JSON.stringify(urls));
  }

  const parsed = parseTcp(tcpUrl);
  const ip = await lookup4(parsed.host);
  if (!ip) {
    console.warn('[WARN] DNS lookup فشل لـ', parsed.host, '— سيُستخدم hostname');
  }
  const finalIp = ip || parsed.host;

  const endpointData = {
    host: parsed.host,
    port: parsed.port,
    ip: finalIp,
    url: tcpUrl.startsWith('tcp://') ? tcpUrl : ('tcp://' + parsed.host + ':' + parsed.port),
    webUrl,
    timestamp: new Date().toISOString()
  };

  fs.writeFileSync(EP_FILE, JSON.stringify(endpointData, null, 2), 'utf8');
  console.log('[TUNNEL] ✅ تم حفظ العنوان:', finalIp + ':' + parsed.port);
  console.log('[TUNNEL] 🌐 رابط الواجهة العام:', webUrl);

  try {
    require('./patch_firmware_endpoint').patch(finalIp, parsed.port);
  } catch (e) {
    console.warn('[TUNNEL] خطأ في تحديث الفرموير:', e.message);
  }

  // مزامنة العنوان تلقائياً مع الأردوينو عبر USB
  try {
    const http = require('http');
    const req = http.request('http://localhost:4000/api/usb/cmd', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    req.on('error', () => {});
    req.write(JSON.stringify({ cmd: `SET_SERVER ${finalIp}:${parsed.port}` }));
    req.end();
  } catch (_) {}

  return new Promise((resolve) => {
    let finished = false;
    let failCount = 0;
    function triggerDisconnect(reason) {
      if (finished) return;
      finished = true;
      console.log('[TUNNEL] ⚠️ انقطع النفق (' + reason + ') — جاري إعادة الاتصال تلقائياً...');
      resolve();
    }

    try {
      tunnel.setTunnelDisconnectedCallback((info) => {
        triggerDisconnect('DisconnectedCallback: ' + (info?.error || 'closed'));
      });
      tunnel.setTunnelErrorCallback((err) => {
        triggerDisconnect('ErrorCallback: ' + (err?.message || err));
      });
    } catch (e) {
      console.warn('[TUNNEL] تحذير في تسجيل callbacks:', e.message);
    }

    // فحص دوري للحالة (Heartbeat) مع تسامح للأخطاء العابرة
    const timer = setInterval(async () => {
      if (finished || shuttingDown) {
        clearInterval(timer);
        return;
      }
      try {
        const status = await tunnel.getStatus();
        if (status !== 'live') {
          failCount++;
          if (failCount >= 3) {
            clearInterval(timer);
            triggerDisconnect('Status changed to ' + status);
            return;
          }
        } else {
          failCount = 0;
        }
      } catch (err) {
        failCount++;
        if (failCount >= 3) {
          clearInterval(timer);
          triggerDisconnect('getStatus error: ' + err.message);
          return;
        }
      }

      // تأكد أن السيرفر المحلي ما زال يعمل
      const httpOk = await probeLocal(HTTP_PORT);
      if (!httpOk) {
        clearInterval(timer);
        triggerDisconnect('Local HTTP server down');
      }
    }, 12000);
  });
}

async function mainLoop() {
  console.log('[TUNNEL] فحص السيرفر المحلي...');
  // انتظار السيرفر حتى يشتغل إذا لم يكن جاهزاً بعد
  for (let i = 0; i < 15; i++) {
    const ok = (await probeLocal(HTTP_PORT)) && (await probeLocal(TCP_PORT));
    if (ok) break;
    console.log('[TUNNEL] بانتظار تشغيل السيرفر المحلي (4000 و 5050)... ' + (i + 1) + '/15');
    await sleep(2000);
  }

  let attempt = 0;
  while (!shuttingDown && attempt < MAX_RETRIES) {
    attempt++;
    try {
      if (attempt > 1) {
        console.log(`[TUNNEL] محاولة فتح النفق #${attempt}...`);
        await stopCurrent();
        await sleep(RETRY_DELAY_MS);
      }
      await startOnce();
      // إذا عاد startOnce بدون خطأ، فهذا يعني أن النفق انقطع طبيعياً
      attempt = 0;
    } catch (err) {
      console.error('[TUNNEL] خطأ في النفق:', err.message);
      await stopCurrent();
      await sleep(RETRY_DELAY_MS);
    }
  }
}

const stop = async () => {
  shuttingDown = true;
  console.log('[TUNNEL] إيقاف النفق...');
  await stopCurrent();
  process.exit(0);
};

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

mainLoop();
