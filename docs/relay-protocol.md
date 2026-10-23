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

### 2.5 ERROR

Sent by the server on protocol violation, routing failure, or timeout.

| Field     | Type   | Description                                                    |
|-----------|--------|----------------------------------------------------------------|
| `type`    | string | Always "ERROR"                                                 |
| `code`    | string | Machine-readable error code (see Section 3)                    |
| `msgId`   | string | The msgId that caused the error, or null for session-level     |
| `message` | string | Human-readable description                                     |

**Example:**
```json
{"type":"ERROR","code":"DESTINATION_OFFLINE","msgId":"msg-7f3a1b","message":"BRAVO is not registered"}
```

---

## 3. Error Codes

| Code                  | Trigger condition                                                  |
|-----------------------|--------------------------------------------------------------------|
| NOT_REGISTERED        | Device sent RELAY or DELIVERY_ACK without registering first        |
| DESTINATION_OFFLINE   | Target deviceId has no active connection                           |
| ALREADY_REGISTERED    | A second REGISTER arrived on an already-registered session         |
| DELIVERY_TIMEOUT      | No DELIVERY_ACK received within the deadline (default: 15 s)      |
| INVALID_MSG_ID        | DELIVERY_ACK.msgId does not match any pending relay                |
| MSG_TOO_LARGE         | Framed message exceeds 2 048 bytes                                 |
| MALFORMED             | JSON parse failure or missing required field                       |

---

## 4. Session Lifecycle

```
Device (ALPHA)               Relay Server               Device (BRAVO)
     |-- TCP connect ----------->|                            |
     |<-- (TCP accepted) --------|                            |
     |-- REGISTER(ALPHA) ------->|                            |
     |<-- REGISTER_ACK ----------|                            |
     |                           |<-- TCP connect ------------|
     |                           |<-- REGISTER(BRAVO) --------|
     |                           |--- REGISTER_ACK ---------->|
     |                           |                            |
     |-- RELAY(to:BRAVO,id:X) -->|                            |
     |                           |--- RELAY(to:BRAVO,id:X) -->|
     |                           |<-- DELIVERY_ACK(id:X) -----|
     |<-- DELIVERY_ACK(id:X) ----|                            |
     |                           |                            |
     |-- TCP close ------------->|                            |
     |                           | (session removed;          |
     |                           |  pending relays -> ERROR)  |
```

---

## 5. Delivery Guarantee and Timeout

- `socket.write()` from the server is **NOT** considered delivery confirmation.
- Only an explicit `DELIVERY_ACK` from the destination constitutes confirmed delivery.
- If no `DELIVERY_ACK` arrives within **15 seconds** of the relay being forwarded, the server
  sends `ERROR { code: "DELIVERY_TIMEOUT" }` to the original sender.
- Pending relay slots are cleaned up on timeout or DELIVERY_ACK.

---

## 6. Backward Compatibility — BARQ-CHALLENGE-v1

Legacy clients that send a raw JSON object without a `type` field (no CRLF framing) are still
accepted on the same port. The server detects them by the absence of a `type` field and routes
them through the original challenge-ACK logic, returning:

```json
{"correlationId":"...","status":"ACK_CHALLENGE_VERIFIED","serverTime":"..."}
```

This ensures all Stage 3 / Stage 4 test scripts continue to work without modification.
