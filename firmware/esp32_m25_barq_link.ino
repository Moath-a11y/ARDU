/**
 * =========================================================================
 * BARQ LINK · ESP32 + QUECTEL M25 FIRMWARE
 * Protocol: MQTT 3.1.1 over Cellular GPRS 2G
 * Board: ESP32 Dev Module + Quectel M25 GSM/GPRS
 * =========================================================================
 * Wiring:
 *   ESP32 GPIO 16 (RX2) <---> Quectel M25 TXD
 *   ESP32 GPIO 17 (TX2) <---> Quectel M25 RXD
 *   GND                 <---> GND
 * =========================================================================
 */

#define TINY_GSM_MODEM_M25
#include <TinyGsmClient.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>

// --- Network & Cellular Config ---
const char apn[]      = "internet"; // Change to your local carrier APN (e.g., znet, orange, fast.t-mobile.com)
const char gprsUser[] = "";
const char gprsPass[] = "";

// --- MQTT Broker Config ---
// Set to your computer's local IP on the network (e.g., 192.168.1.50) or public cloud server IP
const char* mqttServer   = "192.168.1.100";
const int   mqttPort     = 1883;
const char* deviceId     = "ESP32_BARQ_GW_01";
const char* mqttUser     = "";
const char* mqttPassword = "";

// --- MQTT Topics (BARQ LINK Specification) ---
String topicStatus    = "barq/devices/" + String(deviceId) + "/status";
String topicTelemetry = "barq/devices/" + String(deviceId) + "/telemetry";
String topicCmdReq    = "barq/commands/" + String(deviceId) + "/req";
String topicCmdAck    = "barq/commands/" + String(deviceId) + "/ack";

// --- Hardware Pins ---
#define RELAY_PIN_1 2
#define RELAY_PIN_2 4
#define MODEM_RX 16
#define MODEM_TX 17

HardwareSerial SerialAT(2);
TinyGsm modem(SerialAT);
TinyGsmClient client(modem);
PubSubClient mqtt(client);

unsigned long lastTelemetryTime = 0;
const unsigned long telemetryInterval = 10000; // Publish every 10 seconds

// --- MQTT Inbound Message Callback (Command Dispatcher) ---
void mqttCallback(char* topic, byte* payload, unsigned int length) {
  String message = "";
  for (unsigned int i = 0; i < length; i++) {
    message += (char)payload[i];
  }

  Serial.println("\n[BARQ CMD RECEIVED] Topic: " + String(topic));
  Serial.println("[PAYLOAD] " + message);

  // Parse Command JSON
  StaticJsonDocument<512> doc;
  DeserializationError error = deserializeJson(doc, message);
  if (error) {
    Serial.println("[ERR] JSON parse failed");
    return;
  }

  const char* cmdId = doc["commandId"];
  const char* action = doc["action"];

  // Execute Hardware Action
  bool success = false;
  String resultMsg = "";

  if (String(action) == "RELAY_1_ON") {
    digitalWrite(RELAY_PIN_1, HIGH);
    success = true;
    resultMsg = "Relay 1 energized (HIGH)";
  } else if (String(action) == "RELAY_1_OFF") {
    digitalWrite(RELAY_PIN_1, LOW);
    success = true;
    resultMsg = "Relay 1 de-energized (LOW)";
  } else if (String(action) == "PING_TEST") {
    success = true;
    resultMsg = "PONG_ACK_CONFIRMED";
  } else if (String(action) == "REBOOT") {
    success = true;
    resultMsg = "System reboot initiated in 3s";
  } else {
    success = false;
    resultMsg = "Unknown action requested";
  }

  // Publish Execution Acknowledgment (ACK) back to BARQ LINK
  StaticJsonDocument<256> ackDoc;
  ackDoc["commandId"] = cmdId;
  ackDoc["status"] = success ? "EXECUTED" : "FAILED";
  ackDoc["result"] = resultMsg;
  ackDoc["timestamp"] = millis();

  char ackBuffer[256];
  serializeJson(ackDoc, ackBuffer);

  mqtt.publish(topicCmdAck.c_str(), ackBuffer);
  Serial.println("[BARQ ACK SENT] " + String(ackBuffer));

  if (String(action) == "REBOOT") {
    delay(3000);
    ESP.restart();
  }
}

// --- MQTT Connection Manager ---
void reconnectMQTT() {
  while (!mqtt.connected()) {
    Serial.print("[MQTT] Connecting to BARQ Broker at ");
    Serial.print(mqttServer);
    Serial.print("...");

    // Connect with Last Will and Testament (LWT) for instant offline detection!
    if (mqtt.connect(deviceId, mqttUser, mqttPassword, topicStatus.c_str(), 1, true, "OFFLINE")) {
      Serial.println(" CONNECTED! ⚡");

      // Publish Online status
      mqtt.publish(topicStatus.c_str(), "ONLINE", true);

      // Subscribe to command channel
      mqtt.subscribe(topicCmdReq.c_str());
      Serial.println("[MQTT] Subscribed to " + topicCmdReq);
    } else {
      Serial.print(" failed, rc=");
      Serial.print(mqtt.state());
      Serial.println(" retrying in 5 seconds...");
      delay(5000);
    }
  }
}

// --- Setup ---
void setup() {
  Serial.begin(115200);
  pinMode(RELAY_PIN_1, OUTPUT);
  pinMode(RELAY_PIN_2, OUTPUT);
  digitalWrite(RELAY_PIN_1, LOW);
  digitalWrite(RELAY_PIN_2, LOW);

  Serial.println("\n==========================================");
  Serial.println("  BARQ LINK · ESP32 + QUECTEL M25 SYSTEM  ");
  Serial.println("==========================================");

  // Initialize Quectel M25 UART
  SerialAT.begin(9600, SERIAL_8N1, MODEM_RX, MODEM_TX);
  delay(3000);

  Serial.println("[MODEM] Initializing Quectel M25...");
  modem.restart();

  String modemInfo = modem.getModemInfo();
  Serial.println("[MODEM] Info: " + modemInfo);

  // Connect to GPRS Cellular Network
  Serial.print("[GPRS] Connecting to APN: ");
  Serial.println(apn);
  if (!modem.gprsConnect(apn, gprsUser, gprsPass)) {
    Serial.println("[GPRS] Connection failed! Verify APN and SIM balance.");
  } else {
    Serial.println("[GPRS] Attached and IP acquired successfully!");
  }

  // Setup MQTT
  mqtt.setServer(mqttServer, mqttPort);
  mqtt.setCallback(mqttCallback);
}

// --- Loop ---
void loop() {
  if (!mqtt.connected()) {
    reconnectMQTT();
  }
  mqtt.loop();

  // Periodic Telemetry Publish
  unsigned long now = millis();
  if (now - lastTelemetryTime > telemetryInterval) {
    lastTelemetryTime = now;

    int csq = modem.getSignalQuality();
    float volt = modem.getBattVoltage() / 1000.0;
    int batt = modem.getBattPercent();

    StaticJsonDocument<256> doc;
    doc["signal"] = csq;
    doc["csq"] = csq;
    doc["voltage"] = volt;
    doc["battery"] = batt;
    doc["firmware"] = "BARQ-FW-v1.4";
    doc["relay1"] = digitalRead(RELAY_PIN_1) == HIGH;

    char buffer[256];
    serializeJson(doc, buffer);

    mqtt.publish(topicTelemetry.c_str(), buffer);
    Serial.println("[TELEMETRY PUBLISHED] " + String(buffer));
  }
}
