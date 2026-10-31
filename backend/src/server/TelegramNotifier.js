'use strict';

/**
 * BARQ LINK — TelegramNotifier
 * يرسل إشعارات Telegram عند:
 *   1. تشغيل السيرفر (مع الرابط العام)
 *   2. اتصال/انقطاع الأردوينو
 *   3. تنفيذ كل أمر LED
 *
 * الإعداد: ضع في ملف .env أو متغيرات البيئة:
 *   TELEGRAM_BOT_TOKEN=123456:ABC...
 *   TELEGRAM_CHAT_ID=987654321
 */

const https = require('https');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '';

function isConfigured() {
  return !!(BOT_TOKEN && CHAT_ID);
}

/**
 * يرسل رسالة نصية إلى تيليغرام
 * @param {string} text - نص الرسالة (يدعم HTML بسيط)
 * @returns {Promise<void>}
 */
function send(text) {
  if (!isConfigured()) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const body = JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: 'HTML'
    });

    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      res.resume();
      resolve();
    });

    req.on('error', (err) => {
      console.warn('[Telegram] فشل الإرسال:', err.message);
      resolve();
    });

    req.setTimeout(8000, () => {
      console.warn('[Telegram] timeout');
      req.destroy();
      resolve();
    });

    req.write(body);
    req.end();
  });
}

function notifyStartup(httpUrl, tcpHost, tcpPort) {
  const msg =
    `🚀 <b>BARQ LINK — السيرفر شغّال</b>\n\n` +
    `🌐 <b>واجهة التحكم:</b>\n<code>${httpUrl}</code>\n\n` +
    `📡 <b>نقطة اتصال الأردوينو (TCP):</b>\n<code>${tcpHost}:${tcpPort}</code>\n\n` +
    `⏰ ${new Date().toLocaleString('ar')}`;
  return send(msg);
}

function notifyDeviceOnline(deviceId) {
  return send(`✅ <b>${deviceId}</b> اتصل وجاهز لاستقبال الأوامر`);
}

function notifyDeviceOffline(deviceId) {
  return send(`❌ <b>${deviceId}</b> انقطع عن السيرفر`);
}

function notifyCommandExecuted(deviceId, cmd, result) {
  const icons = { LED_ON: '💡', LED_OFF: '🔴', LED_BLINK: '✨' };
  const icon  = icons[cmd] || '⚡';
  return send(
    `${icon} <b>${cmd}</b> على <b>${deviceId}</b>\n` +
    `نتيجة: ${result || 'EXECUTED'}`
  );
}

module.exports = {
  isConfigured,
  send,
  notifyStartup,
  notifyDeviceOnline,
  notifyDeviceOffline,
  notifyCommandExecuted
};
