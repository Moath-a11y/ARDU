/**
 * BARQ LINK — سيرفر بسيط
 * TCP 5050: الأردوينو يتصل عبر شريحة AT
 * HTTP 4000: واجهة أزرار الضوء
 * لا يوجد USB / COM / محاكاة عتاد في مسار التشغيل.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const RelayServer = require('./src/server/RelayServer');
const UsbBridge = require('./src/hardware/UsbBridge');
const TunnelService = require('./src/server/TunnelService');
const tg = require('./src/server/TelegramNotifier');

const HTTP_PORT = parseInt(process.env.PORT || '4000', 10);
const TCP_PORT = parseInt(process.env.TCP_PORT || '5050', 10);
const DEVICE_ID = (process.env.BARQ_DEVICE_ID || 'ALPHA').toUpperCase();
const FRONTEND_DIR = path.resolve(__dirname, '..', 'frontend');

const relay = new RelayServer({ port: TCP_PORT, deliveryTimeoutMs: 25000 });
const usb = new UsbBridge();
const tunnelService = new TunnelService();
const events = [];

// ── صف أوامر HTTP-Poll لكل جهاز (بديل TCP على Render.com) ──
// الأردوينو يستفسر GET /api/device/poll?id=ALPHA كل 3 ثوان
const deviceQueues = new Map(); // deviceId → Array<{cmd, msgId}>

function readEndpoint() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'pinggy_endpoint.json'), 'utf8'));
  } catch {
    return null;
  }
}

function probeTcp(host, port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const t = setTimeout(() => { sock.destroy(); resolve(false); }, timeoutMs);
    sock.on('connect', () => { clearTimeout(t); sock.destroy(); resolve(true); });
    sock.on('error', () => { clearTimeout(t); resolve(false); });
  });
}

let lastTunnelProbe = { time: 0, open: false, key: '' };
async function getCachedTunnelOpen(endpoint) {
  if (!endpoint || (!endpoint.ip && !endpoint.host) || !endpoint.port) return false;
  const key = `${endpoint.ip || endpoint.host}:${endpoint.port}`;
  const now = Date.now();
  if (lastTunnelProbe.key === key && now - lastTunnelProbe.time < 6000) {
    return lastTunnelProbe.open;
  }
  const open = await probeTcp(endpoint.ip || endpoint.host, Number(endpoint.port), 2500);
  lastTunnelProbe = { time: now, open, key };
  return open;
}

function pushEvent(text, extra = {}) {
  const row = { at: new Date().toISOString(), text, ...extra };
  events.unshift(row);
  if (events.length > 40) events.pop();
  console.log(`[EVENT] ${text}`);
}

relay.on('device_registered', (rec) => {
  pushEvent(`الجهاز ${rec.deviceId} اتصل عبر الشبكة وسجّل نفسه`, rec);
  tg.notifyDeviceOnline(rec.deviceId).catch(() => {});
});
relay.on('device_offline', (rec) => {
  pushEvent(`الجهاز ${rec.deviceId} انقطع`, rec);
  tg.notifyDeviceOffline(rec.deviceId).catch(() => {});
});
relay.on('delivery_confirmed', (rec) => {
  pushEvent(`الأمر وصل للجهاز وتم تنفيذه (${rec.status || 'EXECUTED'})`, rec);
  tg.notifyCommandExecuted(rec.deviceId || DEVICE_ID, rec.cmd || rec.payload, rec.status).catch(() => {});
});

function deviceOnline() {
  const sock = relay._sessions.get(DEVICE_ID);
  return Boolean(sock && !sock.destroyed);
}

function sendJson(res, code, data) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('INVALID_JSON'));
      }
    });
  });
}

const COMMANDS = {
  on: 'LED_ON',
  off: 'LED_OFF',
  blink: 'LED_BLINK',
  LED_ON: 'LED_ON',
  LED_OFF: 'LED_OFF',
  LED_BLINK: 'LED_BLINK',
  RELAY_ON: 'LED_ON',
  RELAY_OFF: 'LED_OFF'
};

const apiServer = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (pathname === '/api/health' && req.method === 'GET') {
    return sendJson(res, 200, {
      status: 'ok',
      mode: 'simple-cellular',
      tcpPort: TCP_PORT,
      deviceId: DEVICE_ID,
      online: deviceOnline(),
      httpPollClients: deviceQueues.size
    });
  }

  // ── HTTP Poll: الأردوينو يستفسر هل يوجد أمر معلّق ──
  if (pathname === '/api/device/poll' && req.method === 'GET') {
    const devId = (url.searchParams.get('id') || DEVICE_ID).toUpperCase();
    const queue = deviceQueues.get(devId) || [];
    if (queue.length > 0) {
      const item = queue.shift();
      pushEvent(`[پولينغ] ${devId} يستلم أمر: ${item.cmd}`, { deviceId: devId });
      return sendJson(res, 200, { ok: true, cmd: item.cmd, msgId: item.msgId });
    }
    return sendJson(res, 200, { ok: true, cmd: null });
  }

  // ── HTTP Poll: الأردوينو يبلغ بنتيجة تنفيذ الأمر ──
  if (pathname === '/api/device/result' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const devId = String(body.id || DEVICE_ID).toUpperCase();
      const status = String(body.status || 'EXECUTED');
      const cmd    = String(body.cmd || body.msgId || '');
      pushEvent(`[پولينغ] ${devId} نفّذ ${cmd}: ${status}`, { deviceId: devId, status });
      relay.emit('delivery_confirmed', { deviceId: devId, cmd, status, via: 'http-poll' });
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  if (pathname === '/api/status' && req.method === 'GET') {
    const endpoint = readEndpoint();
    return sendJson(res, 200, {
      deviceId: DEVICE_ID,
      online: deviceOnline(),
      sessions: relay.getActiveSessions(),
      events,
      endpoint,
      usb: usb.snapshot(),
      steps: usb.parseSteps()
    });
  }

  if (pathname === '/api/diag' && req.method === 'GET') {
    const endpoint = readEndpoint();
    const tunnelOpen = await getCachedTunnelOpen(endpoint);
    const sessions = relay.getActiveSessions();
    const remote = sessions[DEVICE_ID] || '';
    const cellular = Boolean(remote);
    return sendJson(res, 200, {
      server: true,
      tcpPort: TCP_PORT,
      deviceOnline: deviceOnline(),
      cellular,
      sessionRemote: remote,
      endpoint,
      tunnelOpen,
      usb: usb.snapshot(),
      steps: usb.parseSteps()
    });
  }

  if (pathname === '/api/tunnel/renew' && req.method === 'POST') {
    try {
      pushEvent('تجديد نفق الإنترنت وربط الأردوينو على العنوان الجديد');
      const result = await tunnelService.renew(usb);
      pushEvent(`النفق ${result.ip}:${result.port}` + (result.uploaded ? ' وتم رفع الكود' : ' — الرفع فشل: ' + (result.uploadError || '')));
      return sendJson(res, 200, result);
    } catch (err) {
      pushEvent('فشل تجديد النفق: ' + err.message);
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  if (pathname === '/api/usb/close' && req.method === 'POST') {
    try {
      await usb.close();
      return sendJson(res, 200, { ok: true, usb: usb.snapshot() });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  if (pathname === '/api/usb/open' && req.method === 'POST') {
    try {
      await usb.ensureOpen();
      pushEvent('فتح منفذ USB COM4 لمراقبة الأردوينو وأوامر AT');
      const ep = readEndpoint();
      if (ep && (ep.ip || ep.host) && ep.port) {
        const target = `${ep.ip || ep.host}:${ep.port}`;
        setTimeout(() => {
          usb.writeLine(`SET_SERVER ${target}`).catch(() => {});
        }, 1500);
      }
      return sendJson(res, 200, { ok: true, usb: usb.snapshot() });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  if ((pathname === '/api/at' || pathname === '/api/usb/cmd') && req.method === 'POST') {
    try {
      const body = await readBody(req);
      let cmd = String(body.cmd || body.command || 'AT').trim();
      const lines = await usb.command(cmd, Number(body.waitMs) || 4000);
      pushEvent('أمر عبر USB: ' + cmd);
      return sendJson(res, 200, { ok: true, cmd, lines });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  if (pathname === '/api/usb/led' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const map = { on: 'USB_LED_ON', off: 'USB_LED_OFF', blink: 'USB_LED_BLINK' };
      const cmd = map[body.action] || map[String(body.action || '').toLowerCase()];
      if (!cmd) return sendJson(res, 400, { ok: false, error: 'on أو off أو blink' });
      const lines = await usb.command(cmd, 2500);
      pushEvent('أمر ضوء عبر USB: ' + cmd);
      return sendJson(res, 200, { ok: true, cmd, lines });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  if ((pathname === '/api/led' || pathname === '/api/command') && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const raw = String(body.action || body.cmd || body.payload || '').trim();
      const cmd = COMMANDS[raw] || COMMANDS[raw.toUpperCase()];
      if (!cmd) {
        return sendJson(res, 400, { ok: false, error: 'استخدم on أو off أو blink' });
      }

      const msgId = `msg-${Date.now()}`;

      // حاول TCP relay أولاً (عندما يكون الأردوينو متصلاً عبر TCP)
      if (deviceOnline()) {
        try {
          pushEvent(`إرسال ${cmd} إلى ${DEVICE_ID} عبر TCP`);
          const result = await relay.sendRelayFromWeb('WEB', DEVICE_ID, cmd, 15000);
          return sendJson(res, 200, { ok: true, cmd, result, via: 'tcp' });
        } catch (tcpErr) {
          pushEvent(`TCP فشل: ${tcpErr.message} — تحويل لـ HTTP-poll`);
        }
      }

      // HTTP-poll fallback: ضع الأمر في الصف (للنشر على Render.com)
      const queue = deviceQueues.get(DEVICE_ID) || [];
      // لا تدع الصف تكبر فوق 3 أوامر معلّقة
      if (queue.length >= 3) queue.shift();
      queue.push({ cmd, msgId });
      deviceQueues.set(DEVICE_ID, queue);
      pushEvent(`[خوادم HTTP-poll] أمر ${cmd} في قائمة الانتظار — سيصللأردوينو خلال 3-5 ثوان`, { deviceId: DEVICE_ID });
      return sendJson(res, 200, { ok: true, cmd, via: 'http-poll', msgId, note: 'سيصللأردوينو خلال 3-5 ثوان' });
    } catch (err) {
      pushEvent(`فشل الأمر: ${err.message}`);
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  if (pathname === '/favicon.ico') {
    res.writeHead(204);
    return res.end();
  }

  if (pathname.startsWith('/api')) {
    return sendJson(res, 404, {
      ok: false,
      error: 'مسار غير موجود. استخدم /api/status أو POST /api/led'
    });
  }

  const indexFile = path.join(FRONTEND_DIR, 'index.html');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  fs.createReadStream(indexFile).pipe(res);
});

async function start() {
  await relay.start();
  await new Promise((resolve) => apiServer.listen(HTTP_PORT, '0.0.0.0', resolve));
  console.log(`واجهة الويب: http://localhost:${HTTP_PORT}`);
  console.log(`TCP للأردوينو (عبر الشريحة): 0.0.0.0:${TCP_PORT}`);
  console.log(`الجهاز المتوقع: ${DEVICE_ID}`);

  if (process.env.NO_AUTO_TUNNEL !== '1') {
    tunnelService.startTunnel().then((ep) => {
      const webUrl  = ep.webUrl  || `http://localhost:${HTTP_PORT}`;
      const tcpHost = ep.ip || ep.host || 'localhost';
      const tcpPort = ep.port || TCP_PORT;
      console.log(`[SERVER] النفق جاهز: ${webUrl} | TCP: ${tcpHost}:${tcpPort}`);
      tg.notifyStartup(webUrl, tcpHost, tcpPort).catch(() => {});
    }).catch((err) => {
      console.warn(`[SERVER] تشغيل النفق: ${err.message}`);
      // حتى بدون نفق — أرسل الرابط المحلي
      tg.notifyStartup(`http://localhost:${HTTP_PORT}`, 'localhost', TCP_PORT).catch(() => {});
    });
  } else {
    // وضع السحابة: لا يوجد نفق — أرسل العنوان الثابت
    const cloudUrl = process.env.PUBLIC_URL || `http://localhost:${HTTP_PORT}`;
    tg.notifyStartup(cloudUrl, process.env.PUBLIC_HOST || 'localhost', TCP_PORT).catch(() => {});
  }
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});

process.on('SIGINT', async () => {
  try { if (usb.port && usb.port.isOpen) usb.port.close(); } catch (_) {}
  try { await tunnelService.killOld(); } catch (_) {}
  await relay.stop();
  process.exit(0);
});

module.exports = { apiServer, challengeServer: relay };
