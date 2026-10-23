/**
 * =========================================================================
 * BARQ LINK — ARDUINO QUECTEL M25 TRANSPARENT SERIAL PASSTHROUGH
 * =========================================================================
 * Use this sketch if you want the Web Console on your laptop to control
 * the Quectel M25 modem directly via USB COM port (like COM4 is doing right now).
 * 
 * Pin Connections:
 *   Arduino Pin 2 (RX) <--- Quectel M25 TXD
 *   Arduino Pin 3 (TX) ---> Resistor Divider (1k/2k) ---> Quectel M25 RXD
 *   Arduino GND        <---> Quectel M25 GND & Power Supply GND
 * =========================================================================
 */

#include <SoftwareSerial.h>

// SoftwareSerial on pins 2 (RX) and 3 (TX)
SoftwareSerial modem(2, 3);

void setup() {
  // USB Serial communication with PC
  Serial.begin(9600);
  while (!Serial && millis() < 1000);

  // Serial communication with Quectel M25
  modem.begin(9600);
}

void loop() {
  // Forward data from PC (Web Dashboard / AT Commands) to Quectel M25
  while (Serial.available()) {
    modem.write(Serial.read());
  }

  // Forward data from Quectel M25 (Responses / Inbound Packets) to PC
  while (modem.available()) {
    Serial.write(modem.read());
  }
}
