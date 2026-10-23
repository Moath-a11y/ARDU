# BARQ LINK — Cloud Tunnel & Gateway Architecture

## 1. Executive Summary & Root Cause Analysis

### Pinggy SSH Authentication Behavior on Windows
When attempting anonymous SSH TCP forwarding using:
```bash
ssh -p 443 -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -R0:127.0.0.1:5050 tcp@free.pinggy.io
```
OpenSSH for Windows halts and outputs:
```text
tcp@free.pinggy.io's password:
Permission denied (publickey,password).
```

#### Technical Root Cause:
1. **Service Policy Changes**: Pinggy's SSH gateway on `free.pinggy.io` and `a.pinggy.io` enforces authentication or key-pair identity for raw TCP tunnels to prevent anonymous abuse. Interactive terminals prompt for a password (where pressing Enter may sometimes bypass), but non-interactive or batch Windows OpenSSH sessions fail with `Permission denied (publickey,password)`.
2. **The Official Solution**: Pinggy's official Node.js SDK (`@pinggy/pinggy`) connects programmatically using secure WebSockets/TLS directly to Pinggy's tunnel endpoints with zero SSH key/password friction, fully headless and zero-configuration on Windows.

---

## 2. Production Tunnel Architecture

```mermaid
graph LR
    subgraph Local Environment
        CS["ChallengeServer.js\n(TCP 0.0.0.0:5050)"]
        SDK["@pinggy/pinggy SDK Runner\n(start_pinggy_sdk_tunnel.js)"]
    end

    subgraph Internet / Cloud
        PINGGY["Pinggy Cloud Gateway\n(hmixo-213-6-167-221.run.pinggy-free.link:35723\nIP: 172.235.166.211)"]
    end

    subgraph Cellular Network (Jawwal)
        MODEM["ALPHA Quectel M25\n(COM3, 9600 Baud, IP: 10.162.207.96)"]
    end

    SDK -- TLS Tunnel Control -- PINGGY
    CS -- Local Loopback Forwarding -- SDK
    MODEM -- Cellular GPRS 2G TCP -- PINGGY
    PINGGY -- Forwarded TCP Stream -- CS
```

---

## 3. Configuration & Startup Procedure

### Step 1: Start the Challenge Server (Local TCP 5050)
```powershell
node backend/run_challenge_server.js
```
- Listens on `0.0.0.0:5050`.
- Implements JSON framing with framing buffer preservation.
- Correlates incoming `corrId` / `correlationId` and echoes payload with `ACK_CHALLENGE_VERIFIED`.

### Step 2: Establish the Pinggy TCP Tunnel
```powershell
node backend/start_pinggy_sdk_tunnel.js
```
- Creates an authorized TCP tunnel pointing to `127.0.0.1:5050`.
- Automatically outputs and stores the live endpoint in `backend/pinggy_endpoint.json`:
```json
{
  "host": "hmixo-213-6-167-221.run.pinggy-free.link",
  "port": 35723,
  "url": "tcp://hmixo-213-6-167-221.run.pinggy-free.link:35723",
  "timestamp": "2026-10-15T21:06:12.395Z"
}
```

### Step 3: Verify Public Endpoint Reachability Locally
```powershell
node backend/test_tunnel_connectivity.js
```
- Directly connects to the public endpoint over the Internet.
- Sends test challenge and verifies server ACK with round-trip latency (< 600 ms).

---

## 4. Modem AT Command Sequence (Quectel M25MAR01A12)

```text
AT+CGATT=1                                            -> Wait for +CGATT: 1 (GPRS Attach)
AT+QIFGCNT=0                                          -> Select Foreground Context 0
AT+QICSGP=1,"internet"                                -> Set APN to "internet" (Jawwal)
AT+QIREGAPP                                           -> Register TCPIP stack
AT+QIACT                                              -> Activate PDP context (returns OK)
AT+QILOCIP                                            -> Query assigned IP (e.g. 10.162.207.96)
AT+QIOPEN="TCP","172.235.166.211",35723               -> Open TCP Socket to Cloud Gateway
-> Returns "OK" then URC "CONNECT OK"
AT+QISEND=<length>                                    -> Modem replies with '>' prompt
<raw_payload_bytes>                                   -> Send challenge JSON
-> Modem replies with "SEND OK"
-> Inbound server ACK received on UART
AT+QICLOSE                                            -> Close TCP socket
AT+QIDEACT                                            -> Deactivate PDP context
```
