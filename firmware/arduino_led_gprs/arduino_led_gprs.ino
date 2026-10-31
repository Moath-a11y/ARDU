/**
 * BARQ LINK — تجربة بسيطة: أردوينو + مودم AT (Quectel M25)
 *
 * عند توصيل الطاقة فقط (بدون لابتوب):
 *   1) المودم يتصل بشبكة الشريحة (GPRS)
 *   2) يفتح TCP إلى السيرفر
 *   3) يسجّل نفسه كـ ALPHA
 *   4) ينتظر أوامر LED من واجهة الويب
 *
 * لو ضغطت "تشغيل الضوء" على الويب ولاقيت ليد Pin 13 يضيء → التجربة نجحت.
 *
 * التوصيل:
 *   Arduino D2  ←  M25 TXD
 *   Arduino D3  →  مجزئ جهد 1k/2k  →  M25 RXD   (لا توصل 5V مباشرة)
 *   Arduino GND ↔  M25 GND  ↔  أرضي مزود الطاقة
 *   M25 VBAT    ←  3.8V إلى 4.2V وقدرة تيار ~2A  (ليس من 5V الأردوينو)
 *   هوائي GSM مربوط، شريحة 2G بدون PIN
 */

#include <Arduino.h>
#include <SoftwareSerial.h>

// ========== غيّر هذه الإعدادات حسب بيئتك ==========
// عنوان سيرفر Render.com (دائم ومجاني إلى الأبد)
const char SERVER_HOST[] PROGMEM = "jhz-lthkm-n-b-d.onrender.com";
const char CARRIER_APN[] PROGMEM  = "internet";

// رقم الهاتف الذي يستقبل SMS بعد كل عملية (بصيغة دولية)
const char NOTIFY_PHONE[] PROGMEM = "+962000000000"; // ← غيّر هذا الرقم!
// ====================================================

static char currentHost[64] = "";

#define DEVICE_ID "ALPHA"
#define PROTOCOL_VER "BARQ-RELAY-v1"

#define MODEM_RX_PIN 2
#define MODEM_TX_PIN 3
#define PIN_LED 13
#define PIN_LED_EXT 7

SoftwareSerial modemSerial(MODEM_RX_PIN, MODEM_TX_PIN);
#define MODEM modemSerial
#define DEBUG Serial

#define RX_BUF_SIZE 256
#define TX_BUF_SIZE 192
#define MSG_ID_SIZE 48

static char rxBuf[RX_BUF_SIZE];
static char txBuf[TX_BUF_SIZE];
static char lastMsgId[MSG_ID_SIZE] = "";
static bool ledOn = false;
static bool usbHoldLed = false;
static char usbLine[96];
static uint8_t usbIdx = 0;

enum State : uint8_t {
  ST_INIT,
  ST_SIM,
  ST_GSM,
  ST_GPRS,
  ST_PDP,
  ST_HTTP_INIT,   // تهيئة HTTP/SSL مرة واحدة
  ST_HTTP_POLL    // حلقة الاستفسار كل 3 ثوان
};

static State state = ST_INIT;
static uint32_t lastPing  = 0;
static uint32_t lastPoll  = 0;    // توقيت HTTP poll الأخير
static uint32_t lastBlink = 0;
static uint32_t backoffMs = 2000;
static const uint32_t POLL_INTERVAL_MS = 4000; // استفسر كل 4 ثوان
static const uint32_t PING_MS = 25000;


void setLed(bool on) {
  ledOn = on;
  digitalWrite(PIN_LED, on ? HIGH : LOW);
  digitalWrite(PIN_LED_EXT, on ? HIGH : LOW);
}

void blinkLed(uint8_t times) {
  for (uint8_t i = 0; i < times; i++) {
    setLed(true);
    delay(180);
    setLed(false);
    delay(180);
  }
}

// ─────────────────────────────────────────────────────
// sendSMS — ترسل رسالة نصية تأكيد بعد كل عملية
// ملاحظة: المودم Quectel M25 يدعم إرسال SMS أثناء GPRS
// ─────────────────────────────────────────────────────
void sendSMS(const char* msg) {
  char phone[24];
  strcpy_P(phone, NOTIFY_PHONE);

  DEBUG.print(F("[SMS] إرسال إلى: "));
  DEBUG.println(phone);

  // وضع نصي
  if (!sendAT("AT+CMGF=1", "OK", 3000)) {
    DEBUG.println(F("[SMS] CMGF فشل"));
    return;
  }

  // إرسال أمر CMGS — ينتظر '>' من المودم
  MODEM.print(F("AT+CMGS=\""));
  MODEM.print(phone);
  MODEM.print(F("\"\r\n"));
  delay(1500);

  // تأكيد وجود موجّه '>' قبل الإرسال
  bool ready = false;
  uint32_t t0 = millis();
  while (millis() - t0 < 4000) {
    if (MODEM.available() && MODEM.read() == '>') { ready = true; break; }
  }

  if (!ready) {
    DEBUG.println(F("[SMS] لم يظهر '>' — إلغاء"));
    MODEM.print((char)27); // ESC لإلغاء
    return;
  }

  MODEM.print(msg);
  MODEM.print((char)0x1A); // Ctrl+Z لإرسال

  // انتظر +CMGS أو ERROR
  char resp[48];
  uint8_t ri = 0;
  t0 = millis();
  while (millis() - t0 < 8000) {
    if (MODEM.available()) {
      char ch = (char)MODEM.read();
      if (ri < sizeof(resp) - 1) resp[ri++] = ch;
      if (strstr(resp, "+CMGS:") != nullptr) {
        DEBUG.println(F("[SMS] أُرسلت ✓"));
        return;
      }
      if (strstr(resp, "ERROR") != nullptr) {
        DEBUG.println(F("[SMS] خطأ!"));
        return;
      }
    }
  }
  DEBUG.println(F("[SMS] timeout"));
}

void drainModem() {
  while (MODEM.available()) MODEM.read();
}

bool sendAT(const char* cmd, const char* expected, uint32_t timeoutMs) {
  drainModem();
  DEBUG.print(F("[AT] "));
  DEBUG.println(cmd);
  MODEM.print(cmd);
  MODEM.print(F("\r\n"));

  uint32_t start = millis();
  uint16_t idx = 0;
  rxBuf[0] = '\0';

  while (millis() - start < timeoutMs) {
    while (MODEM.available()) {
      char ch = (char)MODEM.read();
      if (idx < RX_BUF_SIZE - 1) {
        rxBuf[idx++] = ch;
        rxBuf[idx] = '\0';
      }
      if (strstr(rxBuf, expected) != nullptr) {
        DEBUG.print(F("  OK "));
        DEBUG.println(expected);
        return true;
      }
    }
  }
  DEBUG.print(F("  FAIL want="));
  DEBUG.println(expected);
  return false;
}

bool sendTcp(const char* payload, uint16_t len) {
  drainModem();
  MODEM.print(F("AT+QISEND="));
  MODEM.print(len);
  MODEM.print(F("\r\n"));

  uint32_t start = millis();
  bool prompt = false;
  while (millis() - start < 4000) {
    if (MODEM.available() && (char)MODEM.read() == '>') {
      prompt = true;
      break;
    }
  }
  if (!prompt) {
    DEBUG.println(F("[TCP] no > prompt"));
    return false;
  }

  for (uint16_t i = 0; i < len; i++) MODEM.write(payload[i]);

  start = millis();
  uint16_t rIdx = 0;
  rxBuf[0] = '\0';
  while (millis() - start < 8000) {
    while (MODEM.available()) {
      char ch = (char)MODEM.read();
      if (rIdx < RX_BUF_SIZE - 1) {
        rxBuf[rIdx++] = ch;
        rxBuf[rIdx] = '\0';
      }
      if (strstr(rxBuf, "SEND OK") != nullptr) return true;
      if (strstr(rxBuf, "SEND FAIL") != nullptr || strstr(rxBuf, "ERROR") != nullptr) {
        DEBUG.println(F("[TCP] SEND FAIL"));
        return false;
      }
    }
  }
  DEBUG.println(F("[TCP] SEND timeout"));
  return false;
}

void ack(const char* msgId, const char* status) {
  if (!msgId || !msgId[0]) return;
  int n = snprintf_P(txBuf, TX_BUF_SIZE,
    PSTR("{\"type\":\"DELIVERY_ACK\",\"deviceId\":\"%s\",\"msgId\":\"%s\",\"status\":\"%s\",\"result\":{\"led\":%d}}\r\n"),
    DEVICE_ID, msgId, status, ledOn ? 1 : 0);
  if (n > 0) sendTcp(txBuf, (uint16_t)n);
}

void extractField(const char* json, const char* key, char* out, uint8_t maxLen) {
  out[0] = '\0';
  char needle[24];
  snprintf_P(needle, sizeof(needle), PSTR("\"%s\":\""), key);
  const char* p = strstr(json, needle);
  if (!p) return;
  p += strlen(needle);
  uint8_t i = 0;
  while (*p && *p != '"' && i < maxLen - 1) out[i++] = *p++;
  out[i] = '\0';
}

void handleRelay(const char* json) {
  DEBUG.print(F("[CMD] "));
  DEBUG.println(json);

  char msgId[MSG_ID_SIZE] = "";
  extractField(json, "msgId", msgId, sizeof(msgId));

  if (msgId[0] && strcmp(msgId, lastMsgId) == 0) {
    ack(msgId, "EXECUTED");
    return;
  }

  char smsText[80];

  if (strstr(json, "LED_BLINK") != nullptr || strstr(json, "BLINK") != nullptr) {
    blinkLed(6);
    setLed(true);
    strcpy_P(smsText, PSTR("[BARQ] تم تنفيذ الامر: وميض الضوء - الضوء الان مضاء"));
  } else if (strstr(json, "LED_ON") != nullptr || strstr(json, "RELAY_ON") != nullptr) {
    setLed(true);
    strcpy_P(smsText, PSTR("[BARQ] تم تنفيذ الامر: الضوء مضاء الان"));
  } else if (strstr(json, "LED_OFF") != nullptr || strstr(json, "RELAY_OFF") != nullptr) {
    setLed(false);
    strcpy_P(smsText, PSTR("[BARQ] تم تنفيذ الامر: الضوء مطفا الان"));
  } else {
    ack(msgId, "FAILED");
    return;
  }

  if (msgId[0]) {
    strncpy(lastMsgId, msgId, sizeof(lastMsgId) - 1);
    lastMsgId[sizeof(lastMsgId) - 1] = '\0';
    ack(msgId, "EXECUTED");
  }

  // إرسال SMS تأكيد بعد كل عملية
  sendSMS(smsText);
}

void parseJsonFrames(char* p) {
  while (*p) {
    char* start = strchr(p, '{');
    if (!start) break;
    int depth = 0;
    char* end = nullptr;
    for (char* cur = start; *cur; cur++) {
      if (*cur == '{') depth++;
      else if (*cur == '}') {
        depth--;
        if (depth == 0) {
          end = cur;
          break;
        }
      }
    }
    if (!end) break;
    char saved = *(end + 1);
    *(end + 1) = '\0';
    if (strstr(start, "\"type\":\"RELAY\"") != nullptr) handleRelay(start);
    else if (strstr(start, "\"type\":\"REGISTER_ACK\"") != nullptr) DEBUG.println(F("[NET] مسجّل على السيرفر"));
    *(end + 1) = saved;
    p = end + 1;
  }
}

void readInbound() {
  MODEM.print(F("AT+QIRD=0,1,0,256\r\n"));
  uint32_t start = millis();
  uint16_t rIdx = 0;
  rxBuf[0] = '\0';
  while (millis() - start < 2000) {
    while (MODEM.available()) {
      char ch = (char)MODEM.read();
      if (rIdx < RX_BUF_SIZE - 1) {
        rxBuf[rIdx++] = ch;
        rxBuf[rIdx] = '\0';
      }
    }
    if (strstr(rxBuf, "\r\nOK\r\n") != nullptr) break;
  }
  if (strstr(rxBuf, "+QIRD:") != nullptr) {
    char* headerEnd = strstr(rxBuf, "\r\n");
    if (headerEnd) parseJsonFrames(headerEnd + 2);
  }
}

void usbDumpModem(const char* cmd, uint32_t timeoutMs) {
  drainModem();
  DEBUG.print(F("[USB-AT] "));
  DEBUG.println(cmd);
  MODEM.print(cmd);
  MODEM.print(F("\r\n"));
  uint32_t start = millis();
  uint16_t idx = 0;
  rxBuf[0] = '\0';
  while (millis() - start < timeoutMs) {
    while (MODEM.available()) {
      char ch = (char)MODEM.read();
      if (idx < RX_BUF_SIZE - 1) {
        rxBuf[idx++] = ch;
        rxBuf[idx] = '\0';
      }
    }
  }
  DEBUG.print(F("[USB-RX] "));
  if (rxBuf[0]) DEBUG.println(rxBuf);
  else DEBUG.println(F("(لا رد من المودم)"));
}

void pollUsb() {
  while (DEBUG.available()) {
    char c = (char)DEBUG.read();
    if (c == '\r') continue;
    if (c != '\n') {
      if (usbIdx < sizeof(usbLine) - 1) usbLine[usbIdx++] = c;
      continue;
    }
    usbLine[usbIdx] = '\0';
    usbIdx = 0;
    if (!usbLine[0]) continue;

    if (strcmp(usbLine, "USB_LED_ON") == 0) {
      usbHoldLed = true;
      setLed(true);
      DEBUG.println(F("[USB] LED ON"));
    } else if (strcmp(usbLine, "USB_LED_OFF") == 0) {
      usbHoldLed = true;
      setLed(false);
      DEBUG.println(F("[USB] LED OFF"));
    } else if (strcmp(usbLine, "USB_LED_BLINK") == 0) {
      usbHoldLed = true;
      blinkLed(6);
      setLed(true);
      DEBUG.println(F("[USB] LED BLINK"));
    } else if (strcmp(usbLine, "STATUS") == 0) {
      DEBUG.print(F("[USB] state="));
      DEBUG.println((int)state);
    } else if (strncmp(usbLine, "SET_SERVER ", 11) == 0) {
      char* p = usbLine + 11;
      char* colon = strchr(p, ':');
      if (colon) {
        *colon = '\0';
        strncpy(currentHost, p, sizeof(currentHost) - 1);
        currentHost[sizeof(currentHost) - 1] = '\0';
        currentPort = (uint16_t)atoi(colon + 1);
        DEBUG.print(F("[USB] SERVER SET: "));
        DEBUG.print(currentHost);
        DEBUG.print(':');
        DEBUG.println(currentPort);
        backoffMs = 1500;
        state = ST_TCP;
      }
    } else if (strncmp(usbLine, "AT", 2) == 0) {
      usbDumpModem(usbLine, 3500);
    }
  }
}

void setup() {
  strcpy_P(currentHost, SERVER_HOST);
  currentPort = SERVER_PORT;

  pinMode(PIN_LED, OUTPUT);
  pinMode(PIN_LED_EXT, OUTPUT);
  setLed(false);

  DEBUG.begin(9600);
  MODEM.begin(9600);
  DEBUG.println(F("BARQ LED — طاقة خارجية + شريحة AT"));
  delay(3000);
  state = ST_INIT;
}

void loop() {
  pollUsb();
  uint32_t now = millis();

  if (state != ST_ONLINE && !usbHoldLed) {
    if (now - lastBlink > 250) {
      lastBlink = now;
      digitalWrite(PIN_LED, !digitalRead(PIN_LED));
    }
  }

  switch (state) {
    case ST_INIT:
      DEBUG.println(F("[1] مودم"));
      sendAT("AT", "OK", 1000);
      sendAT("ATE0", "OK", 1000);
      sendAT("AT+CMEE=2", "OK", 1000);
      state = ST_SIM;
      break;

    case ST_SIM:
      DEBUG.println(F("[2] شريحة"));
      if (sendAT("AT+CPIN?", "READY", 3000)) state = ST_GSM;
      else delay(2000);
      break;

    case ST_GSM:
      DEBUG.println(F("[3] شبكة"));
      if (sendAT("AT+CREG?", ",1", 2000) || sendAT("AT+CREG?", ",5", 2000)) state = ST_GPRS;
      else delay(2500);
      break;

    case ST_GPRS:
      DEBUG.println(F("[4] GPRS"));
      sendAT("AT+CGATT=1", "OK", 6000);
      state = ST_PDP;
      break;

    case ST_PDP: {
      DEBUG.println(F("[5] إنترنت الشريحة"));
      sendAT("AT+QIDEACT", "OK", 4000);
      sendAT("AT+QIFGCNT=0", "OK", 2000);
      sendAT("AT+QINDI=1", "OK", 2000);
      char apn[32];
      strcpy_P(apn, CARRIER_APN);
      char cmd[64];
      snprintf_P(cmd, sizeof(cmd), PSTR("AT+QICSGP=1,\"%s\""), apn);
      sendAT(cmd, "OK", 3000);
      sendAT("AT+QIREGAPP", "OK", 4000);
      if (sendAT("AT+QIACT", "OK", 12000)) {
        sendAT("AT+QILOCIP", ".", 3000);
        state = ST_HTTP_INIT;   // استخدم HTTP polling بدل TCP
        backoffMs = 2000;
      } else {
        delay(3000);
      }
      break;
    }

    case ST_HTTP_INIT: {
      DEBUG.println(F("[6] HTTP/SSL تهيئة"));
      // ضبط SSL: بدون تحقّق من الشهادة (يعمل مع Render.com)
      sendAT("AT+QHTTPCFG=\"contextid\",1",    "OK", 2000);
      sendAT("AT+QHTTPCFG=\"sslctxid\",1",      "OK", 2000);
      sendAT("AT+QHTTPCFG=\"responseheader\",0","OK", 2000);
      sendAT("AT+QSSLCFG=\"sslversion\",1,4",   "OK", 2000); // TLS 1.2
      sendAT("AT+QSSLCFG=\"securitylevel\",1,0","OK", 2000); // لا تحقق
      strcpy_P(currentHost, SERVER_HOST);
      setLed(false);
      DEBUG.print(F("[HTTP] سيتصل بـ: "));
      DEBUG.println(currentHost);
      state = ST_HTTP_POLL;
      lastPoll = millis() - POLL_INTERVAL_MS; // ابدأ فوراً
      break;
    }

    case ST_HTTP_POLL: {
      if (now - lastPoll < POLL_INTERVAL_MS) break;
      lastPoll = now;

      // بناء URL: https://host/api/device/poll?id=ALPHA
      char urlBuf[128];
      snprintf_P(urlBuf, sizeof(urlBuf),
        PSTR("https://%s/api/device/poll?id=%s"), currentHost, DEVICE_ID);
      uint16_t urlLen = (uint16_t)strlen(urlBuf);

      // [A] أرسل طول URL للمودم
      char atCmd[40];
      drainModem();
      snprintf_P(atCmd, sizeof(atCmd), PSTR("AT+QHTTPURL=%u,30"), urlLen);
      MODEM.print(atCmd);
      MODEM.print(F("\r\n"));

      // انتظر CONNECT قبل إرسال URL
      bool gotConnect = false;
      {
        char rb[32]; uint8_t ri = 0;
        uint32_t t0 = millis();
        while (millis() - t0 < 5000) {
          if (MODEM.available()) {
            char ch = (char)MODEM.read();
            if (ri < 31) rb[ri++] = ch;
            rb[ri] = '\0';
            if (strstr(rb, "CONNECT") != nullptr) { gotConnect = true; break; }
          }
        }
      }

      if (!gotConnect) {
        DEBUG.println(F("[HTTP] CONNECT timeout - إعادة GPRS"));
        state = ST_PDP;
        break;
      }

      // [B] أرسل URL bytes
      MODEM.print(urlBuf);
      delay(1500);
      drainModem();

      // [C] GET request
      MODEM.print(F("AT+QHTTPGET=30\r\n"));

      // انتظر +QHTTPGET: 0,200
      bool gotOk = false;
      {
        char rb[64]; uint8_t ri = 0;
        uint32_t t0 = millis();
        while (millis() - t0 < 35000) {
          if (MODEM.available()) {
            char ch = (char)MODEM.read();
            if (ri < 63) rb[ri++] = ch;
            rb[ri] = '\0';
            if (strstr(rb, "+QHTTPGET: 0,200") != nullptr) { gotOk = true; break; }
            if (strstr(rb, "+QHTTPGET: 0,")   != nullptr) break; // خطأ HTTP
          }
        }
      }

      if (!gotOk) { DEBUG.println(F("[HTTP] GET فشل")); break; }

      // [D] اقرأ جسم الرد
      drainModem();
      MODEM.print(F("AT+QHTTPREAD=10\r\n"));

      char body[96]; uint8_t bi = 0;
      {
        bool inBody = false;
        char rb[32]; uint8_t ri = 0;
        uint32_t t0 = millis();
        while (millis() - t0 < 12000) {
          if (MODEM.available()) {
            char ch = (char)MODEM.read();
            if (!inBody) {
              if (ri < 31) rb[ri++] = ch;
              rb[ri] = '\0';
              if (strstr(rb, "CONNECT") != nullptr) inBody = true;
            } else {
              if (bi < 95) body[bi++] = ch;
              // توقف عند 'طلب null' أو علامة النهاية
              if (bi > 4 && body[bi-1] == '}') break;
            }
          }
        }
        body[bi] = '\0';
      }
      drainModem();

      DEBUG.print(F("[HTTP] body: "));
      DEBUG.println(body);

      // استخرج cmd من JSON: {"ok":true,"cmd":"LED_ON","msgId":"..."}
      char cmdStr[16] = "";
      char msgId[52]  = "";
      extractField(body, "cmd",   cmdStr, sizeof(cmdStr));
      extractField(body, "msgId", msgId,  sizeof(msgId));

      if (!cmdStr[0] || strcmp(cmdStr, "null") == 0) break; // لا يوجد أمر

      DEBUG.print(F("[HTTP] تنفيذ: "));
      DEBUG.println(cmdStr);

      // نفّذ الأمر
      char smsText[80];
      if (strstr(cmdStr, "LED_ON") || strstr(cmdStr, "RELAY_ON")) {
        setLed(true);
        strcpy_P(smsText, PSTR("[BARQ] تم تنفيذ الامر: الضوء مضاء الان"));
      } else if (strstr(cmdStr, "LED_OFF") || strstr(cmdStr, "RELAY_OFF")) {
        setLed(false);
        strcpy_P(smsText, PSTR("[BARQ] تم تنفيذ الامر: الضوء مطفا الان"));
      } else if (strstr(cmdStr, "BLINK")) {
        blinkLed(6);
        setLed(true);
        strcpy_P(smsText, PSTR("[BARQ] تم تنفيذ الامر: وميض الضوء"));
      } else {
        break; // أمر غير معروف
      }

      // أرسل SMS تأكيد
      sendSMS(smsText);

      // [E] POST النتيجة للسيرفر
      // بناء JSON body للـ POST
      char postBody[96];
      snprintf_P(postBody, sizeof(postBody),
        PSTR("{\"id\":\"%s\",\"cmd\":\"%s\",\"msgId\":\"%s\",\"status\":\"EXECUTED\"}"),
        DEVICE_ID, cmdStr, msgId);
      uint16_t postLen = (uint16_t)strlen(postBody);

      // URL للـ POST
      char postUrl[128];
      snprintf_P(postUrl, sizeof(postUrl),
        PSTR("https://%s/api/device/result"), currentHost);
      uint16_t puLen = (uint16_t)strlen(postUrl);

      drainModem();
      snprintf_P(atCmd, sizeof(atCmd), PSTR("AT+QHTTPURL=%u,30"), puLen);
      MODEM.print(atCmd); MODEM.print(F("\r\n"));
      delay(600);
      // انتظر CONNECT
      { uint32_t t0=millis(); while(millis()-t0<3000){if(MODEM.available()){char c=(char)MODEM.read();if(c==':')break;}} }
      MODEM.print(postUrl);
      delay(1000);
      drainModem();

      // AT+QHTTPPOST=<post_len>,<input_time>,<rsp_time>
      snprintf_P(atCmd, sizeof(atCmd), PSTR("AT+QHTTPPOST=%u,10,10"), postLen);
      MODEM.print(atCmd); MODEM.print(F("\r\n"));
      delay(1000);
      MODEM.print(postBody);
      delay(2000);
      drainModem();

      DEBUG.println(F("[HTTP] نتيجة أُرسلت ✓"));
      break;
    }
  }

  delay(10);
}
