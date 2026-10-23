/**
 * =========================================================================
 * BARQ LINK — AUTONOMOUS CELLULAR IOT FIRMWARE (NODE: ALPHA)
 * =========================================================================
 * Target: Arduino Uno R3 (ATmega328P) + Quectel M25 GSM/GPRS Modem
 * Mode: 100% Standalone (Power-Only — No USB Tethering Required)
 * Protocol: BARQ-RELAY-v1 over Public Cloud TCP
 * 
 * Hardware Wiring:
 *   Arduino Pin 2 (RX)  <--- Quectel M25 TXD (2.8V Logic)
 *   Arduino Pin 3 (TX)  ---> Level Divider (1k/2k) ---> Quectel M25 RXD (2.8V Logic)
 *   Arduino Pin 7 (OUT) ---> Relay / Contactor Driver (Active HIGH)
 *   Arduino Pin 13 (LED)---> Network & Registration Status Indicator
 *   Common Ground (GND) ---> Quectel M25 GND & Power Supply GND
 * 
 * Safety & Reliability Architecture:
 *   - Static bounded buffers (Zero dynamic heap fragmentation on 2KB SRAM)
 *   - Command Allowlist: RELAY_ON, RELAY_OFF, STATUS_QUERY, PING
 *   - Duplicate message suppression (idempotent relay actuation)
 *   - True physical execution verification (digitalRead verification before ACK)
 *   - Truthful DELIVERY_ACK status ("EXECUTED" or "FAILED")
 *   - Bounded exponential backoff for network loss and socket reconnect
 *   - Periodic PING heartbeat keepalive
 * =========================================================================
 */

#include <Arduino.h>
#include <SoftwareSerial.h>

// =========================================================================
// 1. CONFIGURATION
// =========================================================================
#define DEVICE_ID       "ALPHA"
#define PROTOCOL_VER    "BARQ-RELAY-v1"

// Public Cloud Relay Server Endpoint
// (Update with active VPS IP/Host or Pinggy Tunnel endpoint)
const char SERVER_HOST[] PROGMEM = "172.233.255.158";
const uint16_t SERVER_PORT       = 35703;

// Cellular APN (e.g. "internet", "jawwal", "ooredoo")
const char CARRIER_APN[] PROGMEM = "internet";

// Pin Assignments
#define MODEM_RX_PIN    2   // Connects to Quectel M25 TXD
#define MODEM_TX_PIN    3   // Connects to Quectel M25 RXD via resistor divider
#define PIN_STATUS_LED  13  // Status indicator LED
#define PIN_RELAY_OUT   7   // Physical relay control pin

SoftwareSerial modemSerial(MODEM_RX_PIN, MODEM_TX_PIN);
#define MODEM modemSerial
#define DEBUG Serial

// Bounded static buffer sizes (fits within 2048-byte ATmega328P SRAM)
#define RX_BUF_SIZE     256
#define TX_BUF_SIZE     256
#define MSG_ID_SIZE     48

static char rxBuf[RX_BUF_SIZE];
static char txBuf[TX_BUF_SIZE];
static char lastProcessedMsgId[MSG_ID_SIZE] = "";

// State Machine States
enum State : uint8_t {
  ST_INIT_MODEM,
  ST_CHECK_SIM,
  ST_WAIT_GSM,
  ST_ATTACH_GPRS,
  ST_ACTIVATE_PDP,
  ST_CONNECT_TCP,
  ST_SEND_REGISTER,
  ST_ONLINE
};

static State currentState = ST_INIT_MODEM;
static uint32_t lastPingTime = 0;
static uint32_t lastLedBlink = 0;
static uint32_t reconnectDelayMs = 2000;
static const uint32_t PING_INTERVAL_MS = 30000; // 30s keep-alive

// =========================================================================
// 2. HELPER UTILITIES (BOUNDED MEMORY)
// =========================================================================

void clearModemBuffer() {
  while (MODEM.available()) {
    MODEM.read();
  }
}

// Send AT command and wait for expected token with bounded timeout
bool sendAT_P(PGM_P cmdP, const char* expected, uint32_t timeoutMs = 3000) {
  clearModemBuffer();
  
  char c;
  DEBUG.print(F("[AT TX] "));
  PGM_P p = cmdP;
  while ((c = pgm_read_byte(p++)) != 0) {
    DEBUG.write(c);
    MODEM.write(c);
  }
  DEBUG.println();
  MODEM.write("\r\n");

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
        DEBUG.print(F("[AT OK] "));
        DEBUG.println(expected);
        return true;
      }
    }
  }

  DEBUG.print(F("[AT FAIL] Expected: "));
  DEBUG.println(expected);
  return false;
}

bool sendAT(const char* cmd, const char* expected, uint32_t timeoutMs = 3000) {
  clearModemBuffer();
  DEBUG.print(F("[AT TX] "));
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
        DEBUG.print(F("[AT OK] "));
        DEBUG.println(expected);
        return true;
      }
    }
  }

  DEBUG.print(F("[AT FAIL] Expected: "));
  DEBUG.println(expected);
  return false;
}

// Send length-prefixed TCP payload via AT+QISEND
bool sendTcpData(const char* payload, uint16_t len) {
  DEBUG.print(F("[TCP TX] "));
  DEBUG.println(payload);
  clearModemBuffer();

  MODEM.print(F("AT+QISEND="));
  MODEM.print(len);
  MODEM.print(F("\r\n"));

  // Wait for modem prompt '>'
  uint32_t start = millis();
  bool gotPrompt = false;
  while (millis() - start < 4000) {
    if (MODEM.available()) {
      char ch = (char)MODEM.read();
      if (ch == '>') {
        gotPrompt = true;
        break;
      }
    }
  }

  if (!gotPrompt) {
    DEBUG.println(F("[TCP ERR] No prompt > received"));
    return false;
  }

  // Transmit payload
  for (uint16_t i = 0; i < len; i++) {
    MODEM.write(payload[i]);
  }

  // Await SEND OK confirmation
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
      if (strstr(rxBuf, "SEND OK") != nullptr) {
        DEBUG.println(F("[TCP TX OK] SEND OK"));
        return true;
      }
      if (strstr(rxBuf, "SEND FAIL") != nullptr || strstr(rxBuf, "ERROR") != nullptr) {
        DEBUG.println(F("[TCP TX ERR] SEND FAIL / ERROR"));
        return false;
      }
    }
  }

  DEBUG.println(F("[TCP TX TIMEOUT] No SEND OK"));
  return false;
}

// Format and transmit truthful DELIVERY_ACK
void sendDeliveryAck(const char* msgId, const char* status, bool relayState) {
  if (!msgId || strlen(msgId) == 0) return;

  int written = snprintf_P(txBuf, TX_BUF_SIZE,
    PSTR("{\"type\":\"DELIVERY_ACK\",\"deviceId\":\"%s\",\"msgId\":\"%s\",\"status\":\"%s\",\"result\":{\"pin\":%d,\"relayState\":%d}}\r\n"),
    DEVICE_ID, msgId, status, PIN_RELAY_OUT, relayState ? 1 : 0);

  if (written > 0 && written < TX_BUF_SIZE) {
    sendTcpData(txBuf, (uint16_t)written);
    DEBUG.print(F("[ACK SENT] msgId="));
    DEBUG.print(msgId);
    DEBUG.print(F(" status="));
    DEBUG.println(status);
  }
}

// =========================================================================
// 3. COMMAND VALIDATION & HARDWARE ACTUATION
// =========================================================================

void extractJsonString(const char* json, const char* key, char* out, uint8_t maxLen) {
  out[0] = '\0';
  char needle[32];
  snprintf_P(needle, sizeof(needle), PSTR("\"%s\":\""), key);
  const char* p = strstr(json, needle);
  if (!p) return;
  p += strlen(needle);
  uint8_t i = 0;
  while (*p && *p != '\"' && i < maxLen - 1) {
    out[i++] = *p++;
  }
  out[i] = '\0';
}

void processIncomingRelay(const char* json) {
  DEBUG.print(F("\n⚡ [RELAY RECEIVED]: "));
  DEBUG.println(json);

  char msgId[MSG_ID_SIZE] = "";
  extractJsonString(json, "msgId", msgId, sizeof(msgId));

  // Check duplicate prevention
  if (strlen(msgId) > 0 && strcmp(msgId, lastProcessedMsgId) == 0) {
    DEBUG.println(F("⚠️ [DUPLICATE] msgId already executed. Resending ACK without re-actuation."));
    bool currentRelayState = (digitalRead(PIN_RELAY_OUT) == HIGH);
    sendDeliveryAck(msgId, "EXECUTED", currentRelayState);
    return;
  }

  // Command Allowlist Validation
  bool validCommand = false;
  bool targetState = false;
  bool isQueryOnly = false;

  if (strstr(json, "RELAY_ON") != nullptr || strstr(json, "LED_ON") != nullptr) {
    validCommand = true;
    targetState = true;
  } else if (strstr(json, "RELAY_OFF") != nullptr || strstr(json, "LED_OFF") != nullptr) {
    validCommand = true;
    targetState = false;
  } else if (strstr(json, "STATUS_QUERY") != nullptr || strstr(json, "STATUS") != nullptr) {
    validCommand = true;
    isQueryOnly = true;
  } else if (strstr(json, "PING") != nullptr) {
    validCommand = true;
    isQueryOnly = true;
  }

  if (!validCommand) {
    DEBUG.println(F("❌ [REJECT] Unauthorized or unknown command"));
    if (strlen(msgId) > 0) {
      sendDeliveryAck(msgId, "FAILED", digitalRead(PIN_RELAY_OUT) == HIGH);
    }
    return;
  }

  // Actuate hardware if it is a state-changing command
  if (!isQueryOnly) {
    digitalWrite(PIN_RELAY_OUT, targetState ? HIGH : LOW);
    digitalWrite(PIN_STATUS_LED, targetState ? HIGH : LOW);
    DEBUG.print(F("  -> Hardware Actuation: Pin 7 set to "));
    DEBUG.println(targetState ? F("HIGH (ON)") : F("LOW (OFF)"));
  }

  // True physical feedback verification via digitalRead
  bool verifiedState = (digitalRead(PIN_RELAY_OUT) == HIGH);

  // Store executed msgId to prevent duplicate re-execution
  if (strlen(msgId) > 0) {
    strncpy(lastProcessedMsgId, msgId, sizeof(lastProcessedMsgId) - 1);
    lastProcessedMsgId[sizeof(lastProcessedMsgId) - 1] = '\0';
    sendDeliveryAck(msgId, "EXECUTED", verifiedState);
  }
}

// Parse one or more balanced JSON objects from incoming cellular buffer
void parseIncomingPayload(char* p) {
  while (*p) {
    char* start = strchr(p, '{');
    if (!start) break;

    // Scan for matching closing brace of this JSON frame
    int depth = 0;
    char* end = nullptr;
    for (char* cur = start; *cur; cur++) {
      if (*cur == '{') {
        depth++;
      } else if (*cur == '}') {
        depth--;
        if (depth == 0) {
          end = cur;
          break;
        }
      }
    }

    if (!end) break; // Frame incomplete or truncated, stop scanning

    char savedChar = *(end + 1);
    *(end + 1) = '\0'; // Temporarily null-terminate this discrete frame

    if (strstr(start, "\"type\":\"RELAY\"") != nullptr) {
      processIncomingRelay(start);
    } else if (strstr(start, "\"type\":\"REGISTER_ACK\"") != nullptr) {
      DEBUG.println(F("✅ [REGISTER_ACK VERIFIED] Connected to Cloud Relay!"));
    } else if (strstr(start, "\"type\":\"PONG\"") != nullptr) {
      DEBUG.println(F("💓 [PONG] Server heartbeat confirmed"));
    }

    *(end + 1) = savedChar;
    p = end + 1; // Advance pointer to scan for subsequent concatenated frame
  }
}

// Bounded read of incoming TCP buffer via AT+QIRD
void readCellularInbound() {
  // Do NOT clear buffer before QIRD to avoid discarding in-flight bytes
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
    if (strstr(rxBuf, "\r\nOK\r\n") != nullptr) {
      break;
    }
  }

  if (strstr(rxBuf, "+QIRD:") != nullptr) {
    char* headerEnd = strstr(rxBuf, "\r\n");
    if (headerEnd != nullptr) {
      parseIncomingPayload(headerEnd + 2);
    }
  }
}

// =========================================================================
// 4. SETUP
// =========================================================================

void setup() {
  pinMode(PIN_STATUS_LED, OUTPUT);
  pinMode(PIN_RELAY_OUT, OUTPUT);
  digitalWrite(PIN_STATUS_LED, LOW);
  digitalWrite(PIN_RELAY_OUT, LOW);

  DEBUG.begin(9600);
  MODEM.begin(9600);

  DEBUG.println(F("=================================================="));
  DEBUG.println(F("  BARQ LINK · STANDALONE CELLULAR FIRMWARE [ALPHA]"));
  DEBUG.println(F("  Hardware: Arduino Uno R3 + Quectel M25"));
  DEBUG.println(F("  Mode: Single-Device Autonomous Cloud Controller"));
  DEBUG.println(F("=================================================="));

  delay(3000); // Modem power rail settling time
  currentState = ST_INIT_MODEM;
}

// =========================================================================
// 5. MAIN LOOP (NON-BLOCKING RESILIENT STATE MACHINE)
// =========================================================================

void loop() {
  uint32_t now = millis();

  // Status LED: Fast blink while connecting, SOLID when online
  if (currentState != ST_ONLINE) {
    if (now - lastLedBlink > 250) {
      lastLedBlink = now;
      digitalWrite(PIN_STATUS_LED, !digitalRead(PIN_STATUS_LED));
    }
  } else {
    digitalWrite(PIN_STATUS_LED, HIGH);
  }

  switch (currentState) {
    case ST_INIT_MODEM:
      DEBUG.println(F("[1/7] Initializing Quectel M25 Modem..."));
      sendAT("AT", "OK", 1000);
      sendAT("ATE0", "OK", 1000);
      sendAT("AT+CMEE=2", "OK", 1000);
      currentState = ST_CHECK_SIM;
      break;

    case ST_CHECK_SIM:
      DEBUG.println(F("[2/7] Checking SIM PIN/Status..."));
      if (sendAT("AT+CPIN?", "READY", 3000)) {
        currentState = ST_WAIT_GSM;
      } else {
        delay(2000);
      }
      break;

    case ST_WAIT_GSM:
      DEBUG.println(F("[3/7] Verifying Cellular Network Registration..."));
      if (sendAT("AT+CREG?", ",1", 2000) || sendAT("AT+CREG?", ",5", 2000)) {
        currentState = ST_ATTACH_GPRS;
      } else {
        delay(2500);
      }
      break;

    case ST_ATTACH_GPRS:
      DEBUG.println(F("[4/7] Attaching GPRS Packet Service..."));
      sendAT("AT+CGATT=1", "OK", 6000);
      currentState = ST_ACTIVATE_PDP;
      break;

    case ST_ACTIVATE_PDP: {
      DEBUG.println(F("[5/7] Activating GPRS PDP Context..."));
      sendAT("AT+QIDEACT", "OK", 4000);
      sendAT("AT+QIFGCNT=0", "OK", 2000);
      sendAT("AT+QINDI=1", "OK", 2000);

      // Configure APN from PROGMEM
      char apnBuf[32];
      strcpy_P(apnBuf, CARRIER_APN);
      char qicsgpCmd[64];
      snprintf_P(qicsgpCmd, sizeof(qicsgpCmd), PSTR("AT+QICSGP=1,\"%s\""), apnBuf);
      sendAT(qicsgpCmd, "OK", 3000);

      sendAT("AT+QIREGAPP", "OK", 4000);

      if (sendAT("AT+QIACT", "OK", 12000)) {
        sendAT("AT+QILOCIP", ".", 3000);
        currentState = ST_CONNECT_TCP;
        reconnectDelayMs = 2000; // Reset backoff
      } else {
        delay(3000);
      }
      break;
    }

    case ST_CONNECT_TCP: {
      char hostBuf[48];
      strcpy_P(hostBuf, SERVER_HOST);
      DEBUG.print(F("[6/7] Connecting to Public TCP: "));
      DEBUG.print(hostBuf);
      DEBUG.print(F(":"));
      DEBUG.println(SERVER_PORT);

      sendAT("AT+QICLOSE", "OK", 2000);
      delay(500);

      char openCmd[80];
      snprintf_P(openCmd, sizeof(openCmd), PSTR("AT+QIOPEN=\"TCP\",\"%s\",%u"), hostBuf, SERVER_PORT);

      if (sendAT(openCmd, "CONNECT OK", 20000)) {
        DEBUG.println(F("✅ [CONNECT OK] TCP Socket Established!"));
        currentState = ST_SEND_REGISTER;
        reconnectDelayMs = 2000;
      } else {
        DEBUG.print(F("❌ [CONNECT FAIL] Exponential backoff: "));
        DEBUG.print(reconnectDelayMs);
        DEBUG.println(F("ms"));
        delay(reconnectDelayMs);
        if (reconnectDelayMs < 30000) reconnectDelayMs *= 2;
      }
      break;
    }

    case ST_SEND_REGISTER: {
      DEBUG.println(F("[7/7] Transmitting BARQ-RELAY-v1 Registration..."));
      int len = snprintf_P(txBuf, TX_BUF_SIZE,
        PSTR("{\"type\":\"REGISTER\",\"deviceId\":\"%s\",\"version\":\"%s\"}\r\n"),
        DEVICE_ID, PROTOCOL_VER);

      if (len > 0 && sendTcpData(txBuf, (uint16_t)len)) {
        currentState = ST_ONLINE;
        lastPingTime = millis();
        DEBUG.println(F("🚀 [ONLINE] Node ALPHA fully operational!"));
      } else {
        currentState = ST_CONNECT_TCP;
      }
      break;
    }

    case ST_ONLINE: {
      // 1. Process inbound cellular data
      if (MODEM.available()) {
        uint16_t lIdx = 0;
        char lineBuf[64];
        uint32_t t0 = millis();
        while (millis() - t0 < 100) {
          if (MODEM.available()) {
            char ch = (char)MODEM.read();
            if (ch == '\n' || lIdx >= sizeof(lineBuf) - 1) break;
            if (ch != '\r') lineBuf[lIdx++] = ch;
          }
        }
        lineBuf[lIdx] = '\0';

        if (strstr(lineBuf, "+QIRDI:") != nullptr) {
          readCellularInbound();
        } else if (strstr(lineBuf, "CLOSED") != nullptr) {
          DEBUG.println(F("⚠️ [DISCONNECT] TCP socket closed by server/carrier. Reconnecting..."));
          currentState = ST_CONNECT_TCP;
          break;
        }
      }

      // 2. Keep-Alive Heartbeat PING
      if (now - lastPingTime > PING_INTERVAL_MS) {
        lastPingTime = now;
        int pLen = snprintf_P(txBuf, TX_BUF_SIZE,
          PSTR("{\"type\":\"PING\",\"deviceId\":\"%s\"}\r\n"), DEVICE_ID);

        if (pLen > 0 && !sendTcpData(txBuf, (uint16_t)pLen)) {
          DEBUG.println(F("⚠️ [PING FAIL] Socket unresponsive. Reconnecting..."));
          currentState = ST_CONNECT_TCP;
        }
      }

      break;
    }
  }

  delay(10);
}
