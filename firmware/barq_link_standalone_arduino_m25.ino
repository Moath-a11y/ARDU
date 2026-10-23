/**
 * =========================================================================
 * BARQ LINK — AUTONOMOUS STANDALONE CELLULAR IOT FIRMWARE
 * Hardware: Arduino Uno / Nano + Quectel M25 GSM/GPRS Modem (+ PIC Module)
 * Protocol: BARQ-RELAY-v1 over TCP / 2G GPRS
 * 
 * Description:
 *   Operates 100% standalone upon power-up (no PC / USB tethering required).
 *   1. Auto-boots and configures Quectel M25 modem.
 *   2. Attaches to cellular carrier and activates GPRS data.
 *   3. Connects to the public BARQ LINK Relay Server over TCP.
 *   4. Registers device ID (ALPHA or BRAVO).
 *   5. Sends periodic Heartbeats (PING) to keep the socket alive.
 *   6. Listens for incoming RELAY commands from the Web Console or peer node.
 *   7. Automatically sends DELIVERY_ACK confirmation.
 *   8. Controls onboard LED / Relay outputs (and communicates with PIC).
 *   9. Auto-reconnects with watchdog upon network drops.
 * =========================================================================
 */

#include <Arduino.h>
#include <SoftwareSerial.h>

// =========================================================================
// 1. CONFIGURATION (EDIT FOR EACH DEVICE)
// =========================================================================

// --- DEVICE IDENTITY ---
// Set to "ALPHA" for Unit 1, or "BRAVO" for Unit 2
#define DEVICE_ID "ALPHA"

// --- RELAY SERVER ENDPOINT ---
// Set to your public server IP or domain and TCP port
// (Matches the active RelayServer or TunnelManager port)
const char* SERVER_HOST = "172.104.241.200"; // Active Relay Server IP / Host
const int   SERVER_PORT = 44369;           // Active Relay Server TCP Port

// --- CELLULAR CARRIER APN ---
const char* CARRIER_APN = "internet";     // Carrier APN (e.g. internet, znet, etc.)

// --- WIRING SELECTION ---
// 1 = Use SoftwareSerial on pins defined below (recommended for Uno/Nano)
// 0 = Use Hardware Serial (Pins 0/1)
#define USE_SOFTWARE_SERIAL 1

#if USE_SOFTWARE_SERIAL
  #define MODEM_RX_PIN 2   // Arduino Pin 2 connects to Quectel M25 TXD
  #define MODEM_TX_PIN 3   // Arduino Pin 3 connects to Quectel M25 RXD
  SoftwareSerial modemSerial(MODEM_RX_PIN, MODEM_TX_PIN);
  #define MODEM modemSerial
  #define DEBUG Serial
#else
  #define MODEM Serial
#endif

// --- HARDWARE INDICATORS & PINS ---
#define PIN_STATUS_LED 13  // Onboard LED: Blinks during connect, SOLID when registered
#define PIN_RELAY_OUT   7  // Output Pin to trigger Relay / PIC Controller
#define PIN_PIC_RX      8  // Optional serial/logic pin to PIC microcontroller
#define PIN_PIC_TX      9  // Optional serial/logic pin to PIC microcontroller

// =========================================================================
// 2. STATE MACHINE DEFINITIONS
// =========================================================================
enum SystemState {
  STATE_INIT_MODEM,
  STATE_CHECK_SIM,
  STATE_WAIT_NETWORK,
  STATE_ATTACH_GPRS,
  STATE_ACTIVATE_PDP,
  STATE_CONNECT_TCP,
  STATE_SEND_REGISTER,
  STATE_ONLINE
};

SystemState currentState = STATE_INIT_MODEM;
unsigned long stateTimer = 0;
unsigned long lastPingTime = 0;
unsigned long lastLedToggle = 0;
const unsigned long PING_INTERVAL_MS = 25000; // Keep-alive ping every 25 seconds

// Buffer for AT responses and incoming TCP data
char rxBuffer[256];
int rxIndex = 0;

// =========================================================================
// 3. HELPER FUNCTIONS
// =========================================================================

void clearModemBuffer() {
  while (MODEM.available()) {
    MODEM.read();
  }
  rxIndex = 0;
  memset(rxBuffer, 0, sizeof(rxBuffer));
}

// Send command to modem and wait up to timeoutMs for expected response
bool sendCmdWait(const char* cmd, const char* expected, unsigned long timeoutMs = 3000) {
  clearModemBuffer();
#if USE_SOFTWARE_SERIAL
  DEBUG.print(F("[AT TX] "));
  DEBUG.println(cmd);
#endif
  MODEM.print(cmd);
  MODEM.print(F("\r\n"));

  unsigned long start = millis();
  String response = "";
  while (millis() - start < timeoutMs) {
    while (MODEM.available()) {
      char c = (char)MODEM.read();
      response += c;
      if (response.indexOf(expected) != -1) {
#if USE_SOFTWARE_SERIAL
        DEBUG.print(F("[AT RX OK] "));
        DEBUG.println(response);
#endif
        return true;
      }
    }
  }
#if USE_SOFTWARE_SERIAL
  DEBUG.print(F("[AT TIMEOUT/FAIL] "));
  DEBUG.println(response);
#endif
  return false;
}

// Send length-prefixed raw payload over TCP using AT+QISEND
bool sendTcpPayload(const String& payload) {
#if USE_SOFTWARE_SERIAL
  DEBUG.print(F("[TCP SEND] "));
  DEBUG.println(payload);
#endif

  clearModemBuffer();
  MODEM.print(F("AT+QISEND="));
  MODEM.print(payload.length());
  MODEM.print(F("\r\n"));

  // Wait for '>' prompt
  unsigned long start = millis();
  bool gotPrompt = false;
  while (millis() - start < 4000) {
    if (MODEM.available()) {
      char c = (char)MODEM.read();
      if (c == '>') {
        gotPrompt = true;
        break;
      }
    }
  }

  if (!gotPrompt) {
#if USE_SOFTWARE_SERIAL
    DEBUG.println(F("[TCP ERR] No prompt > received"));
#endif
    return false;
  }

  // Transmit payload bytes
  MODEM.print(payload);

  // Wait for SEND OK
  start = millis();
  String res = "";
  while (millis() - start < 8000) {
    while (MODEM.available()) {
      res += (char)MODEM.read();
      if (res.indexOf("SEND OK") != -1) {
#if USE_SOFTWARE_SERIAL
        DEBUG.println(F("[TCP SENT OK]"));
#endif
        return true;
      }
      if (res.indexOf("SEND FAIL") != -1 || res.indexOf("ERROR") != -1) {
        return false;
      }
    }
  }
  return false;
}

// Send DELIVERY_ACK back to server
void sendDeliveryAck(const String& msgId) {
  String ackJson = "{\"type\":\"DELIVERY_ACK\",\"deviceId\":\"" DEVICE_ID "\",\"msgId\":\"" + msgId + "\"}\r\n";
  sendTcpPayload(ackJson);
}

// Process an incoming application RELAY message
void handleRelayMessage(const String& jsonStr) {
#if USE_SOFTWARE_SERIAL
  DEBUG.print(F("\n⚡ [RELAY MSG ARRIVED] "));
  DEBUG.println(jsonStr);
#endif

  // Extract msgId
  int idIdx = jsonStr.indexOf("\"msgId\":\"");
  String msgId = "";
  if (idIdx != -1) {
    int idEnd = jsonStr.indexOf("\"", idIdx + 9);
    if (idEnd != -1) msgId = jsonStr.substring(idIdx + 9, idEnd);
  }

  // Extract payload
  int pIdx = jsonStr.indexOf("\"payload\":");
  String payload = "";
  if (pIdx != -1) {
    int pStart = jsonStr.indexOf("\"", pIdx + 10);
    int pEnd = jsonStr.lastIndexOf("\"");
    if (pStart != -1 && pEnd > pStart) {
      payload = jsonStr.substring(pStart + 1, pEnd);
    } else {
      payload = jsonStr.substring(pIdx + 10);
    }
  }

#if USE_SOFTWARE_SERIAL
  DEBUG.print(F("  ID: ")); DEBUG.println(msgId);
  DEBUG.print(F("  Payload: ")); DEBUG.println(payload);
#endif

  // Hardware Action Dispatcher
  if (payload.indexOf("RELAY_ON") != -1 || payload.indexOf("LED_ON") != -1) {
    digitalWrite(PIN_RELAY_OUT, HIGH);
    digitalWrite(PIN_STATUS_LED, HIGH);
#if USE_SOFTWARE_SERIAL
    DEBUG.println(F("  -> Hardware Trigger: ON (Pin 7 HIGH)"));
#endif
  } else if (payload.indexOf("RELAY_OFF") != -1 || payload.indexOf("LED_OFF") != -1) {
    digitalWrite(PIN_RELAY_OUT, LOW);
#if USE_SOFTWARE_SERIAL
    DEBUG.println(F("  -> Hardware Trigger: OFF (Pin 7 LOW)"));
#endif
  }

  // Send automatic DELIVERY_ACK back to Relay Server
  if (msgId.length() > 0) {
    sendDeliveryAck(msgId);
#if USE_SOFTWARE_SERIAL
    DEBUG.println(F("  -> Sent DELIVERY_ACK confirmed."));
#endif
  }
}

// Read incoming data via QIRD
void readIncomingQird() {
  clearModemBuffer();
  MODEM.print(F("AT+QIRD=0,1,0,512\r\n"));

  unsigned long start = millis();
  String qirdData = "";
  while (millis() - start < 3000) {
    while (MODEM.available()) {
      qirdData += (char)MODEM.read();
    }
  }

  if (qirdData.indexOf("+QIRD:") != -1) {
    // Look for JSON Lines inside QIRD
    int jsonStart = qirdData.indexOf('{');
    int jsonEnd = qirdData.lastIndexOf('}');
    if (jsonStart != -1 && jsonEnd > jsonStart) {
      String json = qirdData.substring(jsonStart, jsonEnd + 1);
      if (json.indexOf("\"type\":\"RELAY\"") != -1) {
        handleRelayMessage(json);
      } else if (json.indexOf("\"type\":\"REGISTER_ACK\"") != -1) {
#if USE_SOFTWARE_SERIAL
        DEBUG.println(F("✅ [REGISTER_ACK RECEIVED] Connected & Registered!"));
#endif
      }
    }
  }
}

// =========================================================================
// 4. SETUP & INITIALIZATION
// =========================================================================
void setup() {
  pinMode(PIN_STATUS_LED, OUTPUT);
  pinMode(PIN_RELAY_OUT, OUTPUT);
  digitalWrite(PIN_STATUS_LED, LOW);
  digitalWrite(PIN_RELAY_OUT, LOW);

#if USE_SOFTWARE_SERIAL
  Serial.begin(9600);
  while (!Serial && millis() < 2000);
  Serial.println(F("========================================"));
  Serial.print(F("  BARQ LINK — NODE "));
  Serial.println(F(DEVICE_ID));
  Serial.println(F("  Autonomous Standalone Firmware Starting..."));
  Serial.println(F("========================================"));
  modemSerial.begin(9600);
#else
  Serial.begin(9600);
#endif

  // Allow modem power-on stabilization (3 seconds)
  delay(3000);
  currentState = STATE_INIT_MODEM;
}

// =========================================================================
// 5. MAIN AUTONOMOUS STATE MACHINE
// =========================================================================
void loop() {
  unsigned long now = millis();

  // Fast LED blink during connection, solid on when registered
  if (currentState != STATE_ONLINE) {
    if (now - lastLedToggle > 250) {
      lastLedToggle = now;
      digitalWrite(PIN_STATUS_LED, !digitalRead(PIN_STATUS_LED));
    }
  } else {
    digitalWrite(PIN_STATUS_LED, HIGH);
  }

  switch (currentState) {

    // ── STEP 1: Basic AT & Echo ─────────────────────────────
    case STATE_INIT_MODEM: {
#if USE_SOFTWARE_SERIAL
      DEBUG.println(F("\n[STATE] Initializing Quectel M25..."));
#endif
      sendCmdWait("AT", "OK", 1000);
      sendCmdWait("ATE0", "OK", 1000);
      sendCmdWait("AT+CMEE=2", "OK", 1000);
      currentState = STATE_CHECK_SIM;
      break;
    }

    // ── STEP 2: Check SIM Card ──────────────────────────────
    case STATE_CHECK_SIM: {
#if USE_SOFTWARE_SERIAL
      DEBUG.println(F("[STATE] Checking SIM Status (AT+CPIN?)..."));
#endif
      if (sendCmdWait("AT+CPIN?", "READY", 3000)) {
        currentState = STATE_WAIT_NETWORK;
      } else {
        delay(3000);
      }
      break;
    }

    // ── STEP 3: Wait for GSM Network ────────────────────────
    case STATE_WAIT_NETWORK: {
#if USE_SOFTWARE_SERIAL
      DEBUG.println(F("[STATE] Checking GSM Registration (AT+CREG?)..."));
#endif
      if (sendCmdWait("AT+CREG?", ",1", 2000) || sendCmdWait("AT+CREG?", ",5", 2000)) {
        currentState = STATE_ATTACH_GPRS;
      } else {
        delay(2500);
      }
      break;
    }

    // ── STEP 4: Attach GPRS Packet Service ─────────────────
    case STATE_ATTACH_GPRS: {
#if USE_SOFTWARE_SERIAL
      DEBUG.println(F("[STATE] Attaching GPRS (AT+CGATT=1)..."));
#endif
      sendCmdWait("AT+CGATT=1", "OK", 6000);
      currentState = STATE_ACTIVATE_PDP;
      break;
    }

    // ── STEP 5: Configure & Activate PDP Context ────────────
    case STATE_ACTIVATE_PDP: {
#if USE_SOFTWARE_SERIAL
      DEBUG.println(F("[STATE] Activating PDP Context..."));
#endif
      sendCmdWait("AT+QIDEACT", "OK", 5000);
      sendCmdWait("AT+QIFGCNT=0", "OK", 2000);
      sendCmdWait("AT+QINDI=1", "OK", 2000);

      String apnCmd = "AT+QICSGP=1,\"" + String(CARRIER_APN) + "\"";
      sendCmdWait(apnCmd.c_str(), "OK", 3000);

      sendCmdWait("AT+QIREGAPP", "OK", 4000);
      if (sendCmdWait("AT+QIACT", "OK", 15000)) {
        sendCmdWait("AT+QILOCIP", ".", 4000); // Display IP
        currentState = STATE_CONNECT_TCP;
      } else {
        delay(4000);
      }
      break;
    }

    // ── STEP 6: Open TCP Socket to Relay Server ────────────
    case STATE_CONNECT_TCP: {
#if USE_SOFTWARE_SERIAL
      DEBUG.println(F("[STATE] Opening TCP Socket to Relay Server..."));
#endif
      sendCmdWait("AT+QICLOSE", "OK", 3000);
      delay(500);

      String openCmd = "AT+QIOPEN=\"TCP\",\"" + String(SERVER_HOST) + "\"," + String(SERVER_PORT);
      if (sendCmdWait(openCmd.c_str(), "CONNECT OK", 25000)) {
#if USE_SOFTWARE_SERIAL
        DEBUG.println(F("✅ [TCP CONNECT OK] Socket established!"));
#endif
        currentState = STATE_SEND_REGISTER;
      } else {
#if USE_SOFTWARE_SERIAL
        DEBUG.println(F("❌ [TCP CONNECT FAIL] Retrying in 5s..."));
#endif
        delay(5000);
      }
      break;
    }

    // ── STEP 7: Register Device on Relay ───────────────────
    case STATE_SEND_REGISTER: {
#if USE_SOFTWARE_SERIAL
      DEBUG.println(F("[STATE] Transmitting REGISTER handshake..."));
#endif
      String regPayload = "{\"type\":\"REGISTER\",\"deviceId\":\"" DEVICE_ID "\",\"version\":\"BARQ-RELAY-v1\"}\r\n";
      if (sendTcpPayload(regPayload)) {
        currentState = STATE_ONLINE;
        lastPingTime = millis();
#if USE_SOFTWARE_SERIAL
        DEBUG.println(F("🚀 [ONLINE] Device fully registered and operational!"));
#endif
      } else {
        currentState = STATE_CONNECT_TCP;
      }
      break;
    }

    // ── STEP 8: Online Loop (Heartbeat + Inbound Listener) ─
    case STATE_ONLINE: {
      // 1. Check for incoming URC data notifications
      if (MODEM.available()) {
        String line = MODEM.readStringUntil('\n');
        line.trim();

        if (line.indexOf("+QIRDI:") != -1) {
          readIncomingQird();
        } else if (line.indexOf("CLOSED") != -1 || line.indexOf("ERROR") != -1) {
#if USE_SOFTWARE_SERIAL
          DEBUG.println(F("⚠️ [DISCONNECT DETECTED] Reconnecting socket..."));
#endif
          currentState = STATE_CONNECT_TCP;
          break;
        }
      }

      // 2. Periodic Keep-Alive Ping (prevents carrier NAT timeout)
      if (now - lastPingTime > PING_INTERVAL_MS) {
        lastPingTime = now;
        String pingJson = "{\"type\":\"PING\",\"deviceId\":\"" DEVICE_ID "\"}\r\n";
        bool pingOk = sendTcpPayload(pingJson);
        if (!pingOk) {
#if USE_SOFTWARE_SERIAL
          DEBUG.println(F("⚠️ [PING FAIL] Socket unresponsive, reconnecting..."));
#endif
          currentState = STATE_CONNECT_TCP;
        }
      }

      break;
    }
  }

  delay(10);
}
