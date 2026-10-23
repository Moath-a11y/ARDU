/**
 * =========================================================================
 * BARQ LINK — AUTONOMOUS CELLULAR IOT FIRMWARE (NODE: BRAVO)
 * =========================================================================
 * Target: Arduino Uno R3 / Nano + Quectel M25 GSM/GPRS Modem (+ PIC Module)
 * Mode: 100% Standalone (Power-Only — No USB Tethering Required)
 * Protocol: BARQ-RELAY-v1 over Public Cloud TCP
 * 
 * Hardware Wiring:
 *   Arduino Pin 2 (RX)  <--- Quectel M25 TXD
 *   Arduino Pin 3 (TX)  ---> Level Divider (1k/2k) ---> Quectel M25 RXD
 *   Arduino Pin 7 (OUT) ---> Relay / Contactor Actuator / PIC Logic Input
 *   Arduino Pin 13 (LED)---> Network & Registration Status Indicator
 *   Common Ground (GND) ---> Quectel M25 GND & Power Supply GND
 * 
 * Power Requirements:
 *   - Arduino: 7V-12V DC input via Barrel Jack or VIN, OR stable 5V
 *   - Quectel M25: Dedicated 3.8V - 4.2V power supply with 2A peak capacity
 *                  (Do NOT power M25 from Arduino's 3.3V or 5V regulator)
 * =========================================================================
 */

#include <Arduino.h>
#include <SoftwareSerial.h>

// =========================================================================
// 1. CONFIGURATION FOR NODE BRAVO
// =========================================================================
#define DEVICE_ID "BRAVO"
#define PEER_ID   "ALPHA"

// Active Public Cloud TCP Relay Endpoint (Pinggy Multi-Tunnel / VPS)
const char* SERVER_HOST = "172.233.255.158"; // Active Public TCP Server IP
const int   SERVER_PORT = 35703;            // Active Public TCP Port

// Cellular Carrier APN (Change to your telecom provider if needed)
const char* CARRIER_APN = "internet";

// Pin Assignments
#define MODEM_RX_PIN    2   // Connects to Quectel M25 TXD
#define MODEM_TX_PIN    3   // Connects to Quectel M25 RXD (via resistor divider)
#define PIN_STATUS_LED  13  // Blinking: Connecting | Solid ON: Registered
#define PIN_RELAY_OUT   7   // Physical relay trigger / PIC interrupt
#define PIN_PIC_TX      8   // Optional hardware serial/logic line to PIC
#define PIN_PIC_RX      9   // Optional hardware serial/logic line to PIC

SoftwareSerial modemSerial(MODEM_RX_PIN, MODEM_TX_PIN);
#define MODEM modemSerial
#define DEBUG Serial        // USB serial for initial diagnostic monitoring

// =========================================================================
// 2. STATE MACHINE
// =========================================================================
enum State {
  ST_INIT_MODEM,
  ST_CHECK_SIM,
  ST_WAIT_GSM,
  ST_ATTACH_GPRS,
  ST_ACTIVATE_PDP,
  ST_CONNECT_TCP,
  ST_SEND_REGISTER,
  ST_ONLINE
};

State currentState = ST_INIT_MODEM;
unsigned long stateTimer = 0;
unsigned long lastPingTime = 0;
unsigned long lastLedBlink = 0;
const unsigned long PING_INTERVAL_MS = 25000; // 25s keep-alive ping

// Clean modem incoming buffer
void clearBuffer() {
  while (MODEM.available()) MODEM.read();
}

// Send AT command and wait for expected response with timeout
bool sendAT(const char* cmd, const char* expected, unsigned long timeoutMs = 3000) {
  clearBuffer();
  DEBUG.print(F("[AT TX] ")); DEBUG.println(cmd);
  MODEM.print(cmd);
  MODEM.print(F("\r\n"));

  unsigned long start = millis();
  String resp = "";
  while (millis() - start < timeoutMs) {
    while (MODEM.available()) {
      char c = (char)MODEM.read();
      resp += c;
      if (resp.indexOf(expected) != -1) {
        DEBUG.print(F("[AT RX OK] ")); DEBUG.println(expected);
        return true;
      }
    }
  }
  DEBUG.print(F("[AT FAIL] Expected: ")); DEBUG.println(expected);
  return false;
}

// Send length-prefixed TCP binary packet via AT+QISEND
bool sendTcpData(const String& payload) {
  DEBUG.print(F("[TCP TX] ")); DEBUG.println(payload);
  clearBuffer();
  MODEM.print(F("AT+QISEND="));
  MODEM.print(payload.length());
  MODEM.print(F("\r\n"));

  // Wait for prompt '>'
  unsigned long start = millis();
  bool prompt = false;
  while (millis() - start < 4000) {
    if (MODEM.available()) {
      char c = (char)MODEM.read();
      if (c == '>') { prompt = true; break; }
    }
  }

  if (!prompt) {
    DEBUG.println(F("[TCP ERR] No prompt > received"));
    return false;
  }

  // Transmit payload
  MODEM.print(payload);

  // Wait for SEND OK
  start = millis();
  String res = "";
  while (millis() - start < 7000) {
    while (MODEM.available()) {
      res += (char)MODEM.read();
      if (res.indexOf("SEND OK") != -1) {
        DEBUG.println(F("[TCP TX OK] SEND OK received"));
        return true;
      }
      if (res.indexOf("SEND FAIL") != -1 || res.indexOf("ERROR") != -1) {
        DEBUG.println(F("[TCP TX FAIL] Socket error"));
        return false;
      }
    }
  }
  return false;
}

// Send verified DELIVERY_ACK confirmation
void sendDeliveryAck(const String& msgId) {
  String ack = "{\"type\":\"DELIVERY_ACK\",\"deviceId\":\"" DEVICE_ID "\",\"msgId\":\"" + msgId + "\",\"status\":\"DELIVERED\"}\r\n";
  sendTcpData(ack);
  DEBUG.print(F("[ACK SENT] Confirmed delivery for msgId: ")); DEBUG.println(msgId);
}

// Parse and execute received application RELAY command
void processIncomingRelay(const String& json) {
  DEBUG.print(F("\n⚡ [RELAY RECEIVED]: ")); DEBUG.println(json);

  // Extract msgId
  String msgId = "";
  int idPos = json.indexOf("\"msgId\":\"");
  if (idPos != -1) {
    int idEnd = json.indexOf("\"", idPos + 9);
    if (idEnd != -1) msgId = json.substring(idPos + 9, idEnd);
  }

  // Actuate Relay / LED based on command
  if (json.indexOf("RELAY_ON") != -1 || json.indexOf("LED_ON") != -1) {
    digitalWrite(PIN_RELAY_OUT, HIGH);
    digitalWrite(PIN_STATUS_LED, HIGH);
    DEBUG.println(F("  -> Hardware Action: Relay Triggered ON (Pin 7 HIGH)"));
  } else if (json.indexOf("RELAY_OFF") != -1 || json.indexOf("LED_OFF") != -1) {
    digitalWrite(PIN_RELAY_OUT, LOW);
    DEBUG.println(F("  -> Hardware Action: Relay Triggered OFF (Pin 7 LOW)"));
  }

  // Send DELIVERY_ACK immediately
  if (msgId.length() > 0) {
    sendDeliveryAck(msgId);
  }
}

// Read incoming cellular buffer via AT+QIRD
void readCellularInbound() {
  clearBuffer();
  MODEM.print(F("AT+QIRD=0,1,0,512\r\n"));

  unsigned long start = millis();
  String qird = "";
  while (millis() - start < 1500) {
    while (MODEM.available()) {
      char c = (char)MODEM.read();
      qird += c;
    }
    if (qird.indexOf("\r\nOK\r\n") != -1) break; // Fast break on command completion
  }

  if (qird.indexOf("+QIRD:") != -1) {
    int jsonStart = qird.indexOf('{');
    int jsonEnd = qird.lastIndexOf('}');
    if (jsonStart != -1 && jsonEnd > jsonStart) {
      String json = qird.substring(jsonStart, jsonEnd + 1);
      if (json.indexOf("\"type\":\"RELAY\"") != -1) {
        processIncomingRelay(json);
      } else if (json.indexOf("\"type\":\"REGISTER_ACK\"") != -1) {
        DEBUG.println(F("✅ [REGISTER_ACK VERIFIED] Connected to Cloud Relay!"));
      }
    }
  }
}

// =========================================================================
// 3. SETUP
// =========================================================================
void setup() {
  pinMode(PIN_STATUS_LED, OUTPUT);
  pinMode(PIN_RELAY_OUT, OUTPUT);
  digitalWrite(PIN_STATUS_LED, LOW);
  digitalWrite(PIN_RELAY_OUT, LOW);

  Serial.begin(9600);
  modemSerial.begin(9600);

  Serial.println(F("=================================================="));
  Serial.println(F("  BARQ LINK · STANDALONE CELLULAR FIRMWARE [BRAVO]"));
  Serial.println(F("  Autonomous Boot Sequence Initiated..."));
  Serial.println(F("=================================================="));

  delay(3000); // Allow Quectel M25 power-up stabilization
  currentState = ST_INIT_MODEM;
}

// =========================================================================
// 4. MAIN LOOP (NON-BLOCKING RESILIENT STATE MACHINE)
// =========================================================================
void loop() {
  unsigned long now = millis();

  // LED indication: Fast blink while connecting, SOLID when online
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
      DEBUG.println(F("[STATE 1] Initializing M25 Modem..."));
      sendAT("AT", "OK", 1000);
      sendAT("ATE0", "OK", 1000);
      sendAT("AT+CMEE=2", "OK", 1000);
      currentState = ST_CHECK_SIM;
      break;

    case ST_CHECK_SIM:
      DEBUG.println(F("[STATE 2] Checking SIM Status..."));
      if (sendAT("AT+CPIN?", "READY", 3000)) {
        currentState = ST_WAIT_GSM;
      } else {
        delay(2000);
      }
      break;

    case ST_WAIT_GSM:
      DEBUG.println(F("[STATE 3] Verifying GSM Network Registration..."));
      if (sendAT("AT+CREG?", ",1", 2000) || sendAT("AT+CREG?", ",5", 2000)) {
        currentState = ST_ATTACH_GPRS;
      } else {
        delay(2500);
      }
      break;

    case ST_ATTACH_GPRS:
      DEBUG.println(F("[STATE 4] Attaching GPRS Service..."));
      sendAT("AT+CGATT=1", "OK", 6000);
      currentState = ST_ACTIVATE_PDP;
      break;

    case ST_ACTIVATE_PDP: {
      DEBUG.println(F("[STATE 5] Activating Cellular PDP Context..."));
      sendAT("AT+QIDEACT", "OK", 4000);
      sendAT("AT+QIFGCNT=0", "OK", 2000);
      sendAT("AT+QINDI=1", "OK", 2000);

      String apnCmd = "AT+QICSGP=1,\"" + String(CARRIER_APN) + "\"";
      sendAT(apnCmd.c_str(), "OK", 3000);
      sendAT("AT+QIREGAPP", "OK", 4000);

      if (sendAT("AT+QIACT", "OK", 12000)) {
        sendAT("AT+QILOCIP", ".", 3000);
        currentState = ST_CONNECT_TCP;
      } else {
        delay(3000);
      }
      break;
    }

    case ST_CONNECT_TCP: {
      DEBUG.print(F("[STATE 6] Connecting to Public TCP: "));
      DEBUG.print(SERVER_HOST); DEBUG.print(F(":")); DEBUG.println(SERVER_PORT);

      sendAT("AT+QICLOSE", "OK", 2000);
      delay(500);

      String openCmd = "AT+QIOPEN=\"TCP\",\"" + String(SERVER_HOST) + "\"," + String(SERVER_PORT);
      if (sendAT(openCmd.c_str(), "CONNECT OK", 20000)) {
        DEBUG.println(F("✅ [CONNECT OK] Public TCP Socket Connected!"));
        currentState = ST_SEND_REGISTER;
      } else {
        DEBUG.println(F("❌ [CONNECT FAIL] Retrying in 5 seconds..."));
        delay(5000);
      }
      break;
    }

    case ST_SEND_REGISTER: {
      DEBUG.println(F("[STATE 7] Registering Node BRAVO on Relay..."));
      String regPayload = "{\"type\":\"REGISTER\",\"deviceId\":\"" DEVICE_ID "\",\"version\":\"BARQ-RELAY-v1\"}\r\n";
      if (sendTcpData(regPayload)) {
        currentState = ST_ONLINE;
        lastPingTime = millis();
        DEBUG.println(F("🚀 [ONLINE] Node BRAVO fully operational!"));
      } else {
        currentState = ST_CONNECT_TCP;
      }
      break;
    }

    case ST_ONLINE: {
      // 1. Process incoming cellular data
      if (MODEM.available()) {
        String line = MODEM.readStringUntil('\n');
        line.trim();

        if (line.indexOf("+QIRDI:") != -1) {
          readCellularInbound();
        } else if (line.indexOf("CLOSED") != -1 || line.indexOf("ERROR") != -1) {
          DEBUG.println(F("⚠️ [DISCONNECT] Socket closed by carrier. Reconnecting..."));
          currentState = ST_CONNECT_TCP;
          break;
        }
      }

      // 2. Keep-Alive Heartbeat PING
      if (now - lastPingTime > PING_INTERVAL_MS) {
        lastPingTime = now;
        String ping = "{\"type\":\"PING\",\"deviceId\":\"" DEVICE_ID "\"}\r\n";
        if (!sendTcpData(ping)) {
          DEBUG.println(F("⚠️ [PING FAIL] Socket unresponsive. Reconnecting..."));
          currentState = ST_CONNECT_TCP;
        }
      }

      break;
    }
  }

  delay(10);
}
