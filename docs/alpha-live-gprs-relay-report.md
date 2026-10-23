# BARQ LINK — Phase 2: Live GPRS + TCP Relay Connection Report (ALPHA Only)

**Date**: 2026-10-16T08:04:31Z  
**Target Node**: ALPHA on `COM3` (Exclusively)  
**Secondary Node (BRAVO)**: `COM4` (UNTOUCHED — Never Opened)  
**Baud Rate**: 9600 8N1  
**Modem Model**: Quectel M25  
**Firmware Revision**: `M25MAR01A12`  
**Network Operator**: Jawwal Palestine  
**APN**: `internet`  
**Cellular Assigned IP**: `10.130.102.49`  
**Public Relay Endpoint**: `141.94.45.153:45127` (`hhasp-188-161-70-194.run.pinggy-free.link`)  
**Protocol Version**: `BARQ-RELAY-v1`  
**Result**: **100% SUCCESS — REGISTER_ACK VERIFIED**  
**Execution Duration**: 4,556 ms (Connect + Register + ACK)  

---

## 1. Executive Summary

Phase 2 was executed under strict safety constraints to validate the live cellular GPRS connection and TCP relay registration using the physical Quectel M25 modem on node **ALPHA (`COM3`)**.

All operational gates succeeded on the first attempt:
1. **Pre-flight verification**: Relay server and public tunnel reachability verified before touching any serial port.
2. **Serial port exclusivity**: `COM3` opened exclusively at 9600 8N1; `COM4` (BRAVO) was strictly isolated and never opened.
3. **Firmware & SIM sanity**: Verified Quectel M25 firmware `M25MAR01A12`, SIM state `+CPIN: READY`, signal quality `+CSQ: 25,0`, and network registrations (`+CREG: 1,1` and `+CGREG: 0,1`).
4. **Buffer Access Mode (`AT+QINDI=1`)**: Successfully configured and verified. This prevents raw TCP payloads from corrupting the UART AT parser and allows asynchronous buffer notifications via `+QIRDI`.
5. **PDP & TCP Lifecycle**: PDP activated via `AT+QIACT`, dynamic IP `10.130.102.49` assigned, and TCP socket opened to the public relay via `AT+QIOPEN`.
6. **Registration Handshake**: `REGISTER` payload transmitted via `AT+QISEND`, followed by `+QIRDI` notification and read via 4-parameter `AT+QIRD=0,1,0,512`. Verified valid `REGISTER_ACK` containing device ID `ALPHA` and server timestamp `2026-10-16T08:04:31.160Z`.
7. **Guaranteed Clean Teardown**: TCP socket closed (`AT+QICLOSE -> CLOSE OK`), PDP context deactivated (`AT+QIDEACT -> DEACT OK`), and serial port released (`COM3 closed`).

---

## 2. Chronological Execution Timeline & Evidence

| Elapsed | Event ID | Status | Action / Command | Raw Modem / Server Output | Engineering Note |
|---|---|---|---|---|---|
| **0 ms** | `A_ENDPOINT` | **PASS** | Tunnel DNS & Ping | Host resolved to `141.94.45.153:45127` | Pre-flight probe verified `REGISTER_ACK` through tunnel before opening modem |
| **8 ms** | `B_OPEN_COM3` | **PASS** | Serial Port Open | `COM3 opened` (9600 8N1) | `COM4` remained unopened throughout |
| **30 ms** | `B_AT` | **PASS** | `AT` | `OK` | Modem autobaud sync |
| **58 ms** | `B_ATE0` | **PASS** | `ATE0` | `OK` | Echo disabled for clean stream |
| **91 ms** | `B_CMEE` | **PASS** | `AT+CMEE=2` | `OK` | Verbose error reporting enabled |
| **169 ms** | `B_ATI` | **PASS** | `ATI` | `Quectel_Ltd\r\nQuectel_M25\r\nRevision: M25MAR01A12\r\nOK` | Hardware identity confirmed |
| **222 ms** | `B_CGMR` | **PASS** | `AT+CGMR` | `Revision: M25MAR01A12\r\nOK` | Firmware matches preflight matrix |
| **267 ms** | `B_CPIN` | **PASS** | `AT+CPIN?` | `+CPIN: READY\r\nOK` | SIM card authenticated |
| **312 ms** | `B_CSQ` | **PASS** | `AT+CSQ` | `+CSQ: 25,0\r\nOK` | Signal strength RSSI 25 (~-63 dBm, Excellent) |
| **357 ms** | `B_CREG` | **PASS** | `AT+CREG?` | `+CREG: 1,1\r\nOK` | Registered on home cellular network (Jawwal) |
| **402 ms** | `B_CGREG` | **PASS** | `AT+CGREG?` | `+CGREG: 0,1\r\nOK` | GPRS network attached and ready |
| **439 ms** | `B_DEACT_INIT` | **PASS** | `AT+QIDEACT` | `DEACT OK` | Ensured clean `IP INITIAL` state |
| **472 ms** | `B_FGCNT` | **PASS** | `AT+QIFGCNT=0` | `OK` | Foreground context 0 selected |
| **505 ms** | `B_QINDI` | **PASS** | `AT+QINDI=1` | `OK` | **Critical**: Buffer access mode enabled |
| **558 ms** | `B_APN` | **PASS** | `AT+QICSGP=1,"internet"` | `OK` | APN set to `internet` |
| **603 ms** | `B_CGATT` | **PASS** | `AT+CGATT?` | `+CGATT: 1\r\nOK` | Packet domain service attached |
| **635 ms** | `B_REGAPP` | **PASS** | `AT+QIREGAPP` | `OK` | TCPIP stack task initiated |
| **1,705 ms** | `B_ACTIVATE` | **PASS** | `AT+QIACT` | `OK` (in 1,069 ms) | GPRS PDP context successfully activated |
| **1,745 ms** | `B_LOCIP` | **PASS** | `AT+QILOCIP` | `10.130.102.49` | Cellular dynamic IP assigned by carrier |
| **1,844 ms** | `B_QIOPEN` | **PASS** | `AT+QIOPEN="TCP","141.94.45.153",45127` | `OK` | Socket dial command accepted |
| **2,552 ms** | `B_TCP_CONN` | **PASS** | Asynchronous Event | `CONNECT OK` (in 708 ms) | 3-way TCP handshake established with RelayServer |
| **2,588 ms** | `B_SEND_PROMPT` | **PASS** | `AT+QISEND=66` | `>` | Modem tx buffer opened for 66 bytes |
| **2,672 ms** | `B_SEND_OK` | **PASS** | Raw payload transmit | `SEND OK` | 66 bytes accepted into cellular modem buffer |
| **4,391 ms** | `B_QIRDI_URC` | **PASS** | URC Event | `+QIRDI: 0,1,0` | Inbound data notification emitted by M25 |
| **4,424 ms** | `B_QIRD_CMD` | **PASS** | `AT+QIRD=0,1,0,512` | Socket buffer read initiated | 4-parameter syntax supported by M25MAR01A12 |
| **4,555 ms** | `B_REGISTER_ACK` | **PASS** | Inbound Payload Parsed | `+QIRD: 141.94.45.153:45127,TCP,84\r\n{"type":"REGISTER_ACK","deviceId":"ALPHA","serverTime":"2026-10-16T08:04:31.160Z"}\r\n\r\nOK` | **PRIMARY SUCCESS CRITERION ACHIEVED** |
| **4,596 ms** | `C_QICLOSE` | **PASS** | `AT+QICLOSE` | `CLOSE OK` | Graceful TCP socket closure |
| **6,926 ms** | `C_QIDEACT` | **PASS** | `AT+QIDEACT` | `DEACT OK` | Cellular PDP bearer cleanly deactivated |
| **6,928 ms** | `C_CLOSE_COM3` | **PASS** | Serial Transport Close | Port closed | `COM3` handle released cleanly |

---

## 3. Protocol Verification Details

### 3.1 Transmitted Registration Line
```json
{"type":"REGISTER","deviceId":"ALPHA","version":"BARQ-RELAY-v1"}\r\n
```
- **Byte Count**: 66 bytes (including `\r\n`).
- **Framing**: JSON Lines delimited with CRLF.

### 3.2 Inbound `REGISTER_ACK` Payload
```
+QIRD: 141.94.45.153:45127,TCP,84\r\n
{"type":"REGISTER_ACK","deviceId":"ALPHA","serverTime":"2026-10-16T08:04:31.160Z"}\r\n
\r\nOK\r\n
```
- **Header Parsing**: Correctly extracted socket metadata (`141.94.45.153:45127,TCP`) and length (`84` bytes).
- **Trailer Parsing**: Correctly consumed the double-CRLF trailer `\r\n\r\nOK\r\n` without leaving stray characters in the UART stream buffer.
- **Server Validation**: The server confirmed registration of node `ALPHA` and synchronized the server time.

---

## 4. Safety & Constraint Verification Audit

1. **Isolation of BRAVO (`COM4`)**:
   - `COM4` was neither queried, opened, nor touched at any time during this phase.
2. **Zero Unauthorized Traffic**:
   - Zero `RELAY` application messages were sent.
   - Zero PIC microcontroller or hardware control commands were issued.
3. **Hardware Preservation**:
   - No NVRAM reset (`AT&F`), baud rate alteration, or non-volatile profile modification was performed.
4. **Guaranteed Resource Cleanup**:
   - Both TCP and GPRS PDP sessions were explicitly closed and confirmed with `CLOSE OK` and `DEACT OK`.
   - `COM3` was verified closed inside the execution `finally` block.

---

## 5. Phase 2 Verdict & Next Step Gate

> [!IMPORTANT]
> **VERDICT**: **PHASE 2 COMPLETED SUCCESSFULLY.**
> The Quectel M25 hardware, ATParser buffer access state machine, GprsEngine PDP pipeline, and GprsRelayClient protocol stack are fully operational and verified over live 2G cellular data.

> [!CAUTION]
> **NEXT STEP STOP GATE**:
> Per project directives, **do NOT proceed to Phase 3 (BRAVO connection or bilateral message relaying) without explicit user authorization.**
