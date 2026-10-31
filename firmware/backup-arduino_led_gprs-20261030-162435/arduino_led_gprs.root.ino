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

// ========== غيّر هذين السطرين حسب سيرفرك ==========
const char SERVER_HOST[] PROGMEM = "213.109.192.63";
const uint16_t SERVER_PORT = 33033;
const char CARRIER_APN[] PROGMEM = "internet";
// ====================================================

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

enum State : uint8_t {
  ST_INIT,
  ST_SIM,
  ST_GSM,
  ST_GPRS,
  ST_PDP,
  ST_TCP,
  ST_REG,
  ST_ONLINE
};

static State state = ST_INIT;
static uint32_t lastPing = 0;
static uint32_t lastBlink = 0;
static uint32_t backoffMs = 2000;
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

  if (strstr(json, "LED_BLINK") != nullptr || strstr(json, "BLINK") != nullptr) {
    blinkLed(6);
    setLed(true);
  } else if (strstr(json, "LED_ON") != nullptr || strstr(json, "RELAY_ON") != nullptr) {
    setLed(true);
  } else if (strstr(json, "LED_OFF") != nullptr || strstr(json, "RELAY_OFF") != nullptr) {
    setLed(false);
  } else {
    ack(msgId, "FAILED");
    return;
  }

  if (msgId[0]) {
    strncpy(lastMsgId, msgId, sizeof(lastMsgId) - 1);
    lastMsgId[sizeof(lastMsgId) - 1] = '\0';
    ack(msgId, "EXECUTED");
  }
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

void setup() {
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
  uint32_t now = millis();

  if (state != ST_ONLINE) {
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
        state = ST_TCP;
        backoffMs = 2000;
      } else {
        delay(3000);
      }
      break;
    }

    case ST_TCP: {
      char host[48];
      strcpy_P(host, SERVER_HOST);
      DEBUG.print(F("[6] TCP "));
      DEBUG.print(host);
      DEBUG.print(':');
      DEBUG.println(SERVER_PORT);
      sendAT("AT+QICLOSE", "OK", 2000);
      delay(400);
      char cmd[80];
      snprintf_P(cmd, sizeof(cmd), PSTR("AT+QIOPEN=\"TCP\",\"%s\",%u"), host, SERVER_PORT);
      if (sendAT(cmd, "CONNECT OK", 20000)) {
        DEBUG.println(F("TCP OK"));
        state = ST_REG;
        backoffMs = 2000;
      } else {
        delay(backoffMs);
        if (backoffMs < 30000) backoffMs *= 2;
      }
      break;
    }

    case ST_REG: {
      DEBUG.println(F("[7] تسجيل"));
      int n = snprintf_P(txBuf, TX_BUF_SIZE,
        PSTR("{\"type\":\"REGISTER\",\"deviceId\":\"%s\",\"version\":\"%s\"}\r\n"),
        DEVICE_ID, PROTOCOL_VER);
      if (n > 0 && sendTcp(txBuf, (uint16_t)n)) {
        state = ST_ONLINE;
        lastPing = millis();
        setLed(false);
        DEBUG.println(F("ONLINE — جاهز لأوامر الويب"));
      } else {
        state = ST_TCP;
      }
      break;
    }

    case ST_ONLINE: {
      if (MODEM.available()) {
        uint16_t lIdx = 0;
        char line[64];
        uint32_t t0 = millis();
        while (millis() - t0 < 120) {
          if (MODEM.available()) {
            char ch = (char)MODEM.read();
            if (ch == '\n' || lIdx >= sizeof(line) - 1) break;
            if (ch != '\r') line[lIdx++] = ch;
          }
        }
        line[lIdx] = '\0';
        if (strstr(line, "+QIRDI:") != nullptr) readInbound();
        else if (strstr(line, "CLOSED") != nullptr) {
          DEBUG.println(F("انقطع TCP — إعادة اتصال"));
          state = ST_TCP;
          break;
        }
      }

      if (now - lastPing > PING_MS) {
        lastPing = now;
        int n = snprintf_P(txBuf, TX_BUF_SIZE,
          PSTR("{\"type\":\"PING\",\"deviceId\":\"%s\"}\r\n"), DEVICE_ID);
        if (n > 0 && !sendTcp(txBuf, (uint16_t)n)) {
          DEBUG.println(F("PING فشل — إعادة اتصال"));
          state = ST_TCP;
        }
      }
      break;
    }
  }

  delay(10);
}
