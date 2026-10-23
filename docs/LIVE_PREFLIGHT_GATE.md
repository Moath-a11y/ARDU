# BARQ LINK — Live Hardware Pre-Flight Gate & Acceptance Protocol

**Protocol Status:** STANDBY — PENDING USER EXPLICIT AUTHORIZATION  
**Physical System:** 1x Quectel M25 GSM Modem + 1x Arduino Uno R3 (Node ALPHA)  
**Safety Rule:** Do NOT energize high-voltage loads or upload firmware without explicit operator approval.

---

## 1. Safety & Pre-Condition Gate

Before initiating any live cellular or electrical operations, each gate condition must be checked and confirmed.

| Gate # | Check Description | Method / Evidence | Pass Criteria | Safe Fallback on Failure |
|--------|-------------------|-------------------|---------------|--------------------------|
| **G1** | Power Rail Voltage | Digital Multimeter on M25 VBAT | 3.85V – 4.05V DC steady | Disconnect power immediately. Adjust buck potentiometer. |
| **G2** | Voltage Sag Under Burst | DMM / Oscilloscope on VBAT during TX | Drop < 300mV (never < 3.4V) | Add 1000µF Low-ESR electrolytic capacitor across VBAT/GND. |
| **G3** | Common Ground | Continuity tester between Arduino GND and M25 GND | R < 0.2 Ω | Connect heavy-gauge jumper between GND points. |
| **G4** | UART Level Divider | Inspect resistor values on Arduino Pin 3 | 1kΩ in series, 2kΩ to GND | Do NOT connect Pin 3 to M25 RX until divider is installed. |
| **G5** | GSM RF Antenna | Visual inspection of IPEX/SMA connector | Quad-band antenna securely attached | Never power modem without antenna. |
| **G6** | Active SIM Card | SIM inserted, valid 2G data plan, PIN disabled | CPIN returns READY | Disable PIN using mobile phone or `AT+CPIN`. |
| **G7** | Isolated Test Load | Connect a 5V LED + 330Ω resistor to Pin 7 | LED illuminates on HIGH | Do NOT connect 220V AC mains or industrial contactor. |

---

## 2. Step-by-Step Live Execution Procedure

### Step 1: Physical Inspection & Safe Power-On
- **Action:** Connect external DC power supply (3.9V, 2A) to M25 carrier board. Connect 9V DC to Arduino barrel jack.
- **Expected Evidence:** Modem NETLIGHT / POWER LED illuminates. Arduino Power LED illuminates. Status LED (Pin 13) starts fast blinking (250ms).
- **Failure Condition:** No LEDs, smoking, or voltage dropping below 3.4V.
- **Recovery:** Cut power immediately. Check polarity.

### Step 2: Cellular Network Attachment (2G GSM / GPRS)
- **Action:** Observe modem NETLIGHT. Modem searches for GSM cell tower and registers on home/roaming network.
- **Expected Evidence:** NETLIGHT changes from fast flashing (64ms ON / 800ms OFF) to slow flashing (64ms ON / 2000ms OFF) or Arduino USB Serial outputs:
  ```
  [2/7] Checking SIM PIN/Status... [AT OK] READY
  [3/7] Verifying Cellular Network Registration... [AT OK] ,1
  [4/7] Attaching GPRS Packet Service... [AT OK] OK
  ```
- **Failure Condition:** Continuous fast flashing after 60s, or `+CREG: 0,2` (searching).
- **Recovery:** Verify SIM orientation, antenna connection, and local 2G coverage.

### Step 3: GPRS PDP Activation & Carrier IP Acquisition
- **Action:** Firmware issues `AT+QICSGP=1,"internet"` and `AT+QIACT`.
- **Expected Evidence:** `AT+QIACT` returns `OK`. `AT+QILOCIP` returns carrier IP (e.g. `10.x.x.x` or public IP).
- **Failure Condition:** `+CME ERROR: 148` (PDP activation failed).
- **Recovery:** Verify carrier APN string. Reissue `AT+QIDEACT` then `AT+QIACT`.

### Step 4: Public Server TCP Socket Connection
- **Action:** Firmware issues `AT+QIOPEN="TCP","<SERVER_IP>",<PORT>`.
- **Expected Evidence:** Asynchronous modem response: `CONNECT OK`.
- **Failure Condition:** `CONNECT FAIL` or socket timeout.
- **Recovery:** Verify server process is running, firewall allows port 5050, and public IP/port is reachable.

### Step 5: Protocol Registration (`BARQ-RELAY-v1`)
- **Action:** Firmware transmits:
  ```json
  {"type":"REGISTER","deviceId":"ALPHA","version":"BARQ-RELAY-v1"}\r\n
  ```
- **Expected Evidence:** Server logs: `[RELAY] REGISTERED: ALPHA`. Modem receives:
  ```json
  {"type":"REGISTER_ACK","deviceId":"ALPHA","serverTime":"..."}\r\n
  ```
  Status LED (Pin 13) turns **SOLID ON**.
- **Failure Condition:** No REGISTER_ACK or server ERROR received.
- **Recovery:** Inspect TCP payload formatting and server console log.

### Step 6: Console-to-ALPHA Command Dispatch
- **Action:** Operator opens BARQ LINK Web UI (`http://<server-ip>:4000`), selects direction `🖥️ CONSOLE ➔ ALPHA`, clicks `🔌 RELAY_ON (تشغيل)`, and clicks `🚀 إرسال الرسالة إلى الشبكة الخلوية`.
- **Expected Evidence:**
  1. Backend logs: `[RELAY] RELAY (WEB) <msgId> from WEB_CONSOLE -> ALPHA`.
  2. Modem outputs URC: `+QIRDI: 0,1,0,<len>`.
  3. Firmware parses command `RELAY_ON`.
  4. Local Pin 7 driven HIGH. Test LED turns ON.
  5. `digitalRead(PIN_RELAY_OUT)` reads `1` (verified).
  6. Firmware transmits:
     ```json
     {"type":"DELIVERY_ACK","deviceId":"ALPHA","msgId":"<msgId>","status":"EXECUTED","result":{"pin":7,"relayState":1}}\r\n
     ```
  7. Web UI shows toast: `✅ تم استلام إقرار التنفيذ الفعلي (EXECUTED) خلال <rtt>ms`.
  8. Web UI audit table records `EXECUTED` state.
- **Failure Condition:** `DELIVERY_TIMEOUT` after 25s, or `status: "FAILED"`.
- **Recovery:** Check UART buffer reception and modem baud rate stability.

### Step 7: Off-Command Verification (`RELAY_OFF`)
- **Action:** Operator clicks `⭕ RELAY_OFF (إطفاء)` in Web UI and submits.
- **Expected Evidence:** Pin 7 driven LOW. Test LED turns OFF. Web UI confirms `EXECUTED` with `relayState: 0`.

### Step 8: Network Loss & Reconnect Resilience
- **Action:** Temporarily disconnect the antenna or stop the relay server for 10 seconds, then restore.
- **Expected Evidence:** Modem reports `CLOSED`. Firmware transitions to `ST_CONNECT_TCP` with exponential backoff (2s, 4s, 8s). Once connection is restored, device issues `REGISTER` and recovers to `ST_ONLINE` automatically without manual reset.

---

## 3. End-to-End Acceptance Sign-Off

The system is only certified `CELLULAR_RELAY_PASS` when:
1. The physical Quectel M25 communicates with the real cloud endpoint exclusively over cellular GPRS.
2. The Arduino operates 100% standalone (powered via barrel jack / DC regulator, zero USB connection).
3. The Web UI command results in observed physical actuation of Pin 7 and verified digital confirmation back to the Web UI.
