# BARQ LINK — Relay Protocol Specification

**Version:** `BARQ-RELAY-v1`
**Transport:** TCP (persistent connection, JSON Lines delimited by `\r\n`)
**Backward Compatibility:** The server simultaneously supports `BARQ-CHALLENGE-v1` clients on the same port.

---

## 1. Framing

Every message is a single line of compact JSON followed by `\r\n`:

```
{"type":"REGISTER","deviceId":"ALPHA","version":"BARQ-RELAY-v1"}\r\n
```

- Newlines **inside** JSON values are prohibited.
- A connection MUST NOT send a second message before receiving the server response to the first.
- Maximum message size: **2 048 bytes** (protects against runaway buffer accumulation).

---

## 2. Message Catalogue

### 2.1 REGISTER

Sent by a device immediately after the TCP connection is established.

| Field      | Type   | Required | Description                          |
|------------|--------|----------|--------------------------------------|
| `type`     | string | YES      | Always "REGISTER"                    |
| `deviceId` | string | YES      | Logical device name, e.g. "ALPHA"    |
| `version`  | string | YES      | Must be "BARQ-RELAY-v1"              |

**Example:**
```json
{"type":"REGISTER","deviceId":"ALPHA","version":"BARQ-RELAY-v1"}
```

---

### 2.2 REGISTER_ACK

Server response to a successful REGISTER.

| Field        | Type   | Description                          |
|--------------|--------|--------------------------------------|
| `type`       | string | Always "REGISTER_ACK"                |
| `deviceId`   | string | Echo of the registered device ID     |
| `serverTime` | string | ISO-8601 UTC timestamp               |

**Example:**
```json
{"type":"REGISTER_ACK","deviceId":"ALPHA","serverTime":"2026-10-15T21:00:00.000Z"}
```

---

### 2.3 RELAY

Sent by a registered source device to forward a payload to a named destination device.

| Field     | Type   | Required | Description                                        |
|-----------|--------|----------|----------------------------------------------------|
| `type`    | string | YES      | Always "RELAY"                                     |
| `msgId`   | string | YES      | Unique message identifier (client-generated)       |
| `from`    | string | YES      | Sender registered deviceId                         |
| `to`      | string | YES      | Target registered deviceId                         |
| `payload` | string | YES      | Arbitrary string payload (max 1 024 chars)         |

**Example:**
```json
{"type":"RELAY","msgId":"msg-7f3a1b","from":"ALPHA","to":"BRAVO","payload":"PING_FROM_ALPHA"}
```

---

### 2.4 DELIVERY_ACK

Sent by the destination device (BRAVO) back to the server after processing an inbound RELAY.
The server then forwards this ACK to the original sender.

| Field    | Type   | Required | Description                                              |
|----------|--------|----------|----------------------------------------------------------|
| `type`   | string | YES      | Always "DELIVERY_ACK"                                    |
| `msgId`  | string | YES      | Must match the msgId of the RELAY being acknowledged     |
| `from`   | string | YES      | ACK sender deviceId (BRAVO)                              |
| `to`     | string | YES      | Original sender deviceId (ALPHA)                         |
| `status` | string | YES      | "DELIVERED" on success                                   |

**Example:**
```json
{"type":"DELIVERY_ACK","msgId":"msg-7f3a1b","from":"BRAVO","to":"ALPHA","status":"DELIVERED"}
```

---

---

### 2.5 PING / HEARTBEAT

Sent periodically by an active device to keep the cellular GPRS/TCP connection alive and verify server reachability.

| Field      | Type   | Required | Description                       |
|------------|--------|----------|-----------------------------------|
| `type`     | string | YES      | Always "PING"                     |
| `deviceId` | string | YES      | Registered device name ("ALPHA")  |

**Example:**
```json
{"type":"PING","deviceId":"ALPHA"}
```

---

### 2.6 PONG

Server response to a PING heartbeat.

| Field        | Type   | Description                       |
|--------------|--------|-----------------------------------|
| `type`       | string | Always "PONG"                     |
| `deviceId`   | string | Echo of deviceId                  |
| `serverTime` | string | ISO-8601 UTC timestamp            |

**Example:**
```json
{"type":"PONG","deviceId":"ALPHA","serverTime":"2026-10-23T18:00:00.000Z"}
```

---

### 2.7 DELIVERY_ACK

Sent by the destination device back to the server after processing and executing an inbound RELAY command.

| Field      | Type   | Required | Description                                                         |
|------------|--------|----------|---------------------------------------------------------------------|
| `type`     | string | YES      | Always "DELIVERY_ACK"                                               |
| `msgId`    | string | YES      | Must match the msgId of the RELAY being acknowledged                |
| `deviceId` | string | YES      | ACK sender deviceId ("ALPHA")                                       |
| `from`     | string | OPTIONAL | Sender device ID (defaults to registered deviceId)                  |
| `to`       | string | OPTIONAL | Original sender deviceId ("WEB_CONSOLE" or "SERVER")                |
| `status`   | string | YES      | "EXECUTED" (verified local actuation), "FAILED", or "DELIVERED"    |
| `result`   | object | OPTIONAL | Local execution metadata (e.g. `{"pin":7,"relayState":1}`)         |

**Example (Verified Hardware Execution):**
```json
{"type":"DELIVERY_ACK","deviceId":"ALPHA","msgId":"WEB_CONSOLE-1729700000-xyz","status":"EXECUTED","result":{"pin":7,"state":1}}
```

---

### 2.8 ERROR

Sent by the server on protocol violation, routing failure, or timeout.

| Field     | Type   | Description                                                    |
|-----------|--------|----------------------------------------------------------------|
| `type`    | string | Always "ERROR"                                                 |
| `code`    | string | Machine-readable error code (see Section 3)                    |
| `msgId`   | string | The msgId that caused the error, or null for session-level     |
| `message` | string | Human-readable description                                     |

**Example:**
```json
{"type":"ERROR","code":"DESTINATION_OFFLINE","msgId":"msg-7f3a1b","message":"ALPHA is not registered"}
```

---

## 3. Error Codes

| Code                  | Trigger condition                                                  |
|-----------------------|--------------------------------------------------------------------|
| NOT_REGISTERED        | Device sent RELAY, PING, or DELIVERY_ACK without registering first |
| DESTINATION_OFFLINE   | Target deviceId has no active connection                           |
| ALREADY_REGISTERED    | A second REGISTER arrived on an already-registered session         |
| DELIVERY_TIMEOUT      | No DELIVERY_ACK received within the deadline (default: 15–25 s)    |
| INVALID_MSG_ID        | DELIVERY_ACK.msgId does not match any pending relay                |
| UNAUTHORIZED_ACK      | A device session attempted to ACK a message addressed to another   |
| MSG_TOO_LARGE         | Framed message exceeds 2 048 bytes                                 |
| MALFORMED             | JSON parse failure or missing required field                       |

---

## 4. Single-Device Operational Lifecycle (Console to ALPHA)

In single-device production mode, commands originate directly from the Web Console / REST API without requiring a secondary peer device:

```
Web Console                 RelayServer                 Node ALPHA (M25 + Uno R3)
     |                           |                                   |
     |                           |<-- GPRS/TCP connect --------------|
     |                           |<-- REGISTER(ALPHA) ---------------|
     |                           |--- REGISTER_ACK ----------------->|
     |                           |                                   |
     |-- POST /api/relay/send -->|                                   |
     |   {to:"ALPHA",cmd:...}    |                                   |
     |                           |--- RELAY(msgId:X, payload) ------>|
     |                           |                                   | (UART AT+QIRD)
     |                           |                                   | Validate cmd allowlist
     |                           |                                   | Actuate Pin 7 (Relay)
     |                           |                                   | Verify digitalRead
     |                           |<-- DELIVERY_ACK(id:X, EXECUTED) --|
     |<-- 200 OK (EXECUTED) -----|                                   |
     |    (WS update to UI)      |                                   |
     |                           |                                   |
     |                           |<-- PING(ALPHA) -------------------| (Heartbeat every 30s)
     |                           |--- PONG ------------------------->|
```

---

## 5. Delivery Guarantee and Truthful Execution Semantics

- TCP `write()` or modem `SEND OK` proves only that the payload left the local UART buffer. It is **NEVER** treated as application delivery or physical actuation.
- Only an explicit `DELIVERY_ACK` from the target device with `status: "EXECUTED"` proves that the physical GPIO was actuated.
- If the command fails local validation, the device returns `status: "FAILED"` with an error reason.
- If no `DELIVERY_ACK` arrives within the deadline (25 seconds), the command promise is rejected with `DELIVERY_TIMEOUT`.

---

## 6. Backward Compatibility — BARQ-CHALLENGE-v1

Legacy clients that send a raw JSON object without a `type` field (no CRLF framing) are still
accepted on the same port. The server detects them by the absence of a `type` field and routes
them through the original challenge-ACK logic, returning:

```json
{"correlationId":"...","status":"ACK_CHALLENGE_VERIFIED","serverTime":"..."}
```

This ensures all Stage 3 / Stage 4 test scripts continue to work without modification.

