/**
 * BARQ LINK — Test Tunnel End-to-End Connectivity
 * Connects to the public TCP tunnel and sends a challenge.
 * Verifies that ChallengeServer receives and ACKs through the public endpoint.
 */
"use strict";
const net = require("net");
const fs = require("fs");
const crypto = require("crypto");

// Read endpoint from file
let endpoint;
try {
  endpoint = JSON.parse(fs.readFileSync("pinggy_endpoint.json", "utf8"));
} catch(e) {
  console.error("ERROR: Cannot read pinggy_endpoint.json - run tunnel first.");
  process.exit(1);
}

const { host, port } = endpoint;
console.log("================================================");
console.log("  BARQ LINK — Tunnel Connectivity Verification");
console.log("  Connecting to: " + host + ":" + port);
console.log("  (This simulates what the modem would do)");
console.log("================================================\n");

const corrId = "TUNNEL_TEST_" + crypto.randomBytes(6).toString("hex").toUpperCase();
const challenge = JSON.stringify({
  type: "barq-challenge-v1",
  correlationId: corrId,
  nodeId: "ALPHA",
  challenge: "BARQ_AIR_PROBE_REAL",
  sentAt: new Date().toISOString()
});

console.log("corrId: " + corrId);
console.log("Connecting...\n");

const t0 = Date.now();
const socket = net.createConnection({ host, port });
let responseBuffer = "";
let done = false;

socket.setTimeout(15000);

socket.on("connect", () => {
  console.log("TCP connected to " + host + ":" + port + " in " + (Date.now() - t0) + "ms");
  console.log("Sending challenge payload (" + challenge.length + " bytes)...\n");
  socket.write(challenge);
});

socket.on("data", (chunk) => {
  responseBuffer += chunk.toString("utf8");
  try {
    const match = responseBuffer.match(/\{[\s\S]*\}/);
    if (match) {
      const ack = JSON.parse(match[0]);
      const rtt = Date.now() - t0;
      done = true;
      socket.destroy();
      
      const corrMatch = ack.correlationId === corrId;
      const typeMatch = ack.status === "ACK_CHALLENGE_VERIFIED";
      
      console.log("================================================");
      if (corrMatch && typeMatch) {
        console.log("  TUNNEL TEST: PASS");
        console.log("  RTT (dial + challenge + ACK): " + rtt + "ms");
        console.log("  corrId: " + (corrMatch ? "MATCH" : "MISMATCH"));
        console.log("  Server ACK: " + JSON.stringify(ack, null, 2));
        console.log("\n  Tunnel is working. SAFE TO RUN GPRS TEST.");
      } else {
        console.log("  TUNNEL TEST: FAIL — corrId or status mismatch");
        console.log("  Expected corrId: " + corrId);
        console.log("  Got: " + JSON.stringify(ack));
      }
      console.log("================================================\n");
    }
  } catch(e) {}
});

socket.on("timeout", () => {
  if (!done) {
    console.error("TIMEOUT: No ACK received in 15 seconds via tunnel.");
    console.error("Check if tunnel and ChallengeServer are both running.");
    socket.destroy();
    process.exit(1);
  }
});

socket.on("error", (err) => {
  if (!done) {
    console.error("SOCKET ERROR: " + err.message);
    process.exit(1);
  }
});
