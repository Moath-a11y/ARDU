# BARQ LINK — Interactive Real Hardware Dashboard Guide

**Date**: 2026-10-16  
**Status**: **DEPLOYED & FULLY FUNCTIONAL**  
**Web Dashboard URL**: `http://localhost:5173`  
**Backend REST API**: `http://localhost:4000/api`  
**WebSocket Stream**: `ws://localhost:4001`  
**Relay Server**: `tcp://localhost:5050`  

---

## 1. Overview & Architecture

The BARQ LINK platform has been transformed from a static validation dashboard into a **real-time, interactive cellular operations console**. The user can now control the physical Quectel M25 hardware nodes (ALPHA on `COM3` and BRAVO on `COM4`), initiate GPRS PDP contexts, connect to the Relay Server, and send/receive real application messages with end-to-end `DELIVERY_ACK` confirmation directly from their browser.

```
+-------------------------------------------------------------------------+
|                  BARQ LINK Web Console (Port 5173)                      |
|   - Device Management (ALPHA / BRAVO)                                  |
|   - Message Lab & Bidirectional Live Chat                               |
|   - Live Topology & State Flow Monitor                                  |
|   - Real-Time Event & UART Audit Stream                                 |
+-------------------+---------------------------------+-------------------+
                    | REST / WebSocket                |
+-------------------v---------------------------------v-------------------+
|                  BARQ Backend Server (Port 4000 / 4001)                 |
|   - HardwareController (Single Serial Owner)                            |
|   - RelayServer (Port 5050 - BARQ-RELAY-v1)                             |
+-------------------+---------------------------------+-------------------+
                    | COM3 (9600)                     | COM4 (9600)
+-------------------v---+                         +---v-------------------+
|  ALPHA (Quectel M25)  |                         |  BRAVO (Quectel M25)  |
|  Jawwal Cellular GPRS |                         |  Jawwal Cellular GPRS |
+-----------------------+                         +-----------------------+
```

---

## 2. Key Interactive Capabilities

### A. Device Management (ALPHA on COM3 & BRAVO on COM4)
- **Zero Auto-Open (Safety First)**: All serial ports, GPRS contexts, and TCP sockets start **CLOSED** on page load.
- **Port Control**:
  - `فتح المنفذ (Open Serial)`: Opens the hardware port at 9600 baud, 8N1.
  - `إغلاق المنفذ (Close Serial)`: Disconnects relay session if active and releases the COM handle.
- **GPRS Management**:
  - `تهيئة GPRS (Init GPRS)`: Sets APN `internet`, enables buffer access mode (`AT+QINDI=1`), activates PDP (`AT+QIACT`), and queries carrier IP (`AT+QILOCIP`).
- **Relay Server Connection**:
  - `ربط Relay (Connect Relay)`: Connects TCP socket to the Relay Server (using the public Pinggy tunnel or local port 5050), transmits `REGISTER`, and verifies `REGISTER_ACK`.
  - `فصل Relay (Disconnect Relay)`: Gracefully closes TCP socket (`AT+QICLOSE`) and bearer (`AT+QIDEACT`).
- **Hardware Telemetry Refresh**:
  - `تحديث الحالة (Refresh Status)`: Issues non-destructive AT queries (`AT`, `AT+CPIN?`, `AT+CSQ`, `AT+CREG?`, `AT+CGREG?`, `AT+CBC`) to update signal CSQ, battery voltage, and network registration.

### B. Message Lab & Bidirectional Chat
- **Direction Toggle**: Switch dynamically between `ALPHA ➔ BRAVO` and `BRAVO ➔ ALPHA`.
- **One-Click PING**: Populates `{"ping":"BARQ_LIVE_PING","seq":...}` and dispatches.
- **True Delivery Guarantee**:
  - The UI tracks the exact 3-stage delivery lifecycle:
    1. `QUEUED`: Message formatted and queued in backend.
    2. `SENT`: Modem accepted the bytes into its transmit buffer (`SEND OK`).
    3. `DELIVERED`: **Target modem received the payload and transmitted a verified `DELIVERY_ACK` through the Relay Server!**
  - Displays the exact Round-Trip-Time (e.g. `⏱️ 1,840 ms RTT`).
- **Bidirectional Chat Feed**:
  - Interactive speech bubbles showing sent and received messages, timestamps, message IDs, and verified delivery status badges.

### C. Live Network Topology Diagram
- Displays real-time connection status across the entire link:
  `[ ALPHA (COM3) ] <=== GPRS/TCP ===> [ RELAY SERVER (:5050) ] <=== GPRS/TCP ===> [ BRAVO (COM4) ]`
- Dynamic glowing badges update automatically via WebSocket whenever a node connects or disconnects.

### D. Emergency Stop All
- Prominently placed red `🚨 STOP ALL` button in the header.
- Upon user confirmation, executes a safe, sequential shutdown of both nodes:
  1. Disconnects both relay sessions.
  2. Closes both TCP sockets (`AT+QICLOSE`).
  3. Deactivates both PDP bearers (`AT+QIDEACT`).
  4. Closes both serial ports (`COM3` and `COM4`).

---

## 3. How to Launch and Operate

### Step 1: Run the Launcher
Double-click or run:
```cmd
start_barq_link.bat
```
This automatically starts:
1. `backend/server.js`: Hardware Controller, Relay Server on 5050, REST API on 4000, and WebSocket on 4001.
2. `start_pinggy_sdk_tunnel.js`: Establishes the public TCP tunnel for cellular 2G connectivity.
3. `frontend/server.cjs`: Serves the interactive web app on port 5173.
4. Opens `http://localhost:5173` in your browser.

### Step 2: Connect the Nodes via the Web UI
1. In the **ALPHA** card, click **🔌 فتح المنفذ (Open Serial)**.
2. In the **BRAVO** card, click **🔌 فتح المنفذ (Open Serial)**.
3. Click **🌐 تهيئة GPRS (Init GPRS)** on each node to obtain dynamic carrier IPs.
4. Click **🔗 ربط Relay (Connect Relay)** on each node to register on the relay server.

### Step 3: Send Live Messages
1. In the **Message Lab**, click **⚡ PING / ECHO**.
2. Click **🚀 إرسال عبر GPRS وانتظار DELIVERY_ACK**.
3. Watch the progress tracker transition to **DELIVERY_ACK ✅** and see the reply appear in the **Bidirectional Feed**!
