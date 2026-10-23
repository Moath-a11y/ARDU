# BARQ LINK — Single-Device Hardware Pre-Flight Safety Checklist

**Target Hardware:** Quectel M25 GSM/GPRS Modem Module + Arduino Uno R3 (ATmega328P DIP-28)  
**System Role:** Autonomous Single-Device Cellular IoT Remote Actuator (Node ALPHA)  
**Inspection Date:** 2026-10-23  

---

## 1. Electrical Power Supply Specifications

| Rail | Required Voltage | Current Capacity | Verified Risk / Mitigation |
|------|------------------|------------------|----------------------------|
| **Modem VBAT** | 3.4V – 4.4V (Nominal **3.8V – 4.0V**) | **2.0A Peak** (GSM 2G Burst) | **CRITICAL:** Do NOT power the Quectel M25 from the Arduino 5V or 3.3V pin. Arduino on-board linear regulators (e.g. AMS1117 / LP2985) cannot supply 2A GSM transmission bursts. Voltage will sag below 3.3V causing modem brownout shutdown (`UNDER_VOLTAGE POWER DOWN`). |
| **Arduino VIN / DC Jack** | 7.0V – 12.0V DC | 500mA | Powers Arduino on-board 5V regulator safely when USB is disconnected. |
| **Common Ground (GND)** | 0V Reference | Common Bus | **MANDATORY:** Ground of the external buck regulator, Quectel M25 carrier board, and Arduino Uno GND pin MUST be firmly connected together. Floating grounds cause UART framing errors and false pin triggers. |

### Power Supply Pre-Flight Checklist
- [ ] Dedicated switching buck regulator (LM2596 / MP1584 / MP2307) adjusted to **3.8V–4.0V DC**.
- [ ] Bypass capacitor: Low-ESR 470µF–1000µF electrolytic or tantalum capacitor placed directly across modem `VBAT` and `GND` pins to absorb 2.0A transmission pulses (577µs GSM slot duration).
- [ ] Multimeter verification: Measure VBAT under active network search. Ensure voltage drop does not exceed **300mV**.

---

## 2. UART Level Shifting & Signal Integrity

The Quectel M25 digital I/O operates at **2.8V CMOS logic levels** (Absolute Maximum: 3.1V).  
The Arduino Uno R3 operates at **5.0V TTL logic levels**.

```
Arduino Uno R3                                 Quectel M25
================                               ===========
Pin 3 (TX 5V) -----[ 1 kΩ Resistor ]-----+----> RXD (2.8V input)
                                         |
                                  [ 2 kΩ Resistor ]
                                         |
                                        GND

Pin 2 (RX 5V) <--------------------------+----- TXD (2.8V output)
GND           <-------------------------------- GND (Common)
```

### Signal Verification Checklist
- [ ] **NEVER connect Arduino Pin 3 (5V TX) directly to M25 RXD.** Doing so will degrade the modem's internal input clamping diodes and permanently damage the modem UART port.
- [ ] Resistor voltage divider verified: 1 kΩ in series, 2 kΩ to GND (yields $5.0\text{V} \times \frac{2}{3} \approx 3.33\text{V}$, safe for 2.8V–3.3V logic).
- [ ] Arduino Pin 2 (RX) directly reads M25 TXD (2.8V is above ATmega328P minimum HIGH input threshold of $0.6 \times 5\text{V} = 3.0\text{V}$ in typical ambient conditions; for extended industrial temperature ranges, a bidirectional level shifter IC such as TXS0108E / BSS138 is recommended).

---

## 3. Actuator & Load Safety (Pin 7 Control Output)

Arduino Pin 7 is designated as the control output for local actuation (Relay / Contactor / LED indicator).

```
Arduino Uno Pin 7 (5V)
       |
    [ 1kΩ ]
       |
     B |   NPN Transistor (2N2222 / BC547)
       +---|
         C |---+---- [ 1N4007 Diode (Cathode) ] ---- +12V DC Relay Supply
           |   |
           |   +---- [ Relay Coil Terminals  ] ---- +12V DC Relay Supply
           |   |
           |   +---- [ 1N4007 Diode (Anode)   ] ---- Collector
           |
         E |
          GND
```

### Actuator Safety Checklist
- [ ] **NEVER drive a mechanical relay coil directly from Arduino Pin 7.** ATmega328P GPIO max rating is 40mA (recommended ≤20mA). Relay coils draw 50mA–150mA.
- [ ] Driver circuit: NPN transistor (2N2222/BC547) or N-channel logic-level MOSFET (2N7000/IRLZ44N) installed.
- [ ] **Flyback Protection:** A 1N4001/1N4007 diode MUST be connected across the relay coil with cathode to positive supply and anode to collector/drain. Without flyback protection, inductive kickback EMF (often exceeding 100V) will destroy the switching transistor and reset the microcontroller.
- [ ] Contact isolation: Ensure mains/AC load wiring is physically isolated from the low-voltage DC logic board (creepage distance ≥ 6.3mm).

---

## 4. RF Antenna & SIM Card Safety

- [ ] GSM Quad-Band Antenna (850/900/1800/1900 MHz) firmly screwed onto the IPEX/SMA connector. **Operating the transmitter without an antenna can damage the RF power amplifier.**
- [ ] Micro-SIM card with an active 2G-enabled GPRS data plan inserted into the holder with contacts facing correctly.
- [ ] SIM PIN lock must be disabled (`AT+CPIN?` returns `READY` without requiring PIN prompt).
- [ ] Antenna kept at least 5cm away from Arduino microcontroller and audio/analog wiring to prevent RF radiation interference.

---

## 5. Physical Standalone Verification Procedure

Before powering on the system for live production operation:
1. Verify resistance between `VBAT` and `GND` with power disconnected (must NOT read 0Ω short circuit).
2. Measure external DC buck output with multimeter before connecting to M25 header: **must read 3.85V–4.00V**.
3. Connect external power to Arduino DC barrel jack (9V–12V DC).
4. Verify Arduino 5V pin measures 4.95V–5.05V.
5. Observe Status LED (Pin 13):
   - Fast blinking (250ms): Initializing modem, SIM, network, GPRS, and TCP connection.
   - Solid ON: Registered on Cloud Relay (`BARQ-RELAY-v1`), ready for remote commands.
