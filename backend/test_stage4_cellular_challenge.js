/**
 * BARQ LINK — Stage 4: Real Cellular End-to-End Challenge Test
 * 
 * Prerequisites (ALL must be met before this script proceeds):
 *   1. ChallengeServer running on TCP :5050
 *   2. Pinggy TCP tunnel active (run start_pinggy_sdk_tunnel.js)
 *   3. pinggy_endpoint.json exists with valid {host, port}
 *   4. Backend server running on :4000 (HardwareController with ALPHA on COM3)
 *   5. ALPHA SIM ready and GPRS registered on Jawwal Palestine
 *
 * Evidence criteria:
 *   - PASS only if corrId sent from modem appears in server ACK AND received back
 *   - TCP CONNECTED if socket opened but no ACK received
 *   - SEND UNVERIFIED if SEND OK but no corrId in server log
 *   - ROUND-TRIP FAILED with reason if ACK not received by modem
 */

"use strict";
const http = require("http");
const net = require("net");
const fs = require("fs");
const crypto = require("crypto");

// --- Config ------------------------------------------------------------------
const API_PORT = 4000;
const NODE_ID = "ALPHA";
const APN = "internet";

// Read tunnel endpoint
let tunnelEndpoint;
try {
  tunnelEndpoint = JSON.parse(fs.readFileSync("pinggy_endpoint.json", "utf8"));
} catch (e) {
  console.error("FATAL: Cannot read pinggy_endpoint.json");
  console.error("Run: node start_pinggy_sdk_tunnel.js");
  process.exit(1);
}

const { host: TUNNEL_HOST, port: TUNNEL_PORT } = tunnelEndpoint;

// --- Helpers -----------------------------------------------------------------
function apiCall(endpoint, method, data) {
  return new Promise((resolve, reject) => {
    const postData = data ? JSON.stringify(data) : null;
    const req = http.request({
      hostname: "localhost",
      port: API_PORT,
      path: endpoint,
      method: method || "GET",
      headers: {
        "Content-Type": "application/json",
        ...(postData ? { "Content-Length": Buffer.byteLength(postData) } : {})
      }
    }, (res) => {
      let body = "";
      res.on("data", c => body += c);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          if (res.statusCode >= 400) reject(new Error(parsed.error || "HTTP_" + res.statusCode));
          else resolve(parsed);
        } catch (e) { resolve(body); }
      });
    });
    req.on("error", reject);
    if (postData) req.write(postData);
    req.end();
  });
}

const steps = [];
let testOutcome = "BLOCKED";

function logStep(name, status, details) {
  const ts = new Date().toISOString();
  const entry = { timestamp: ts, step: name, status, details: details || {} };
  steps.push(entry);
  const m = status === "PASS" ? "[PASS]" : (status === "FAIL" ? "[FAIL]" : "[INFO]");
  console.log(m + " [" + ts + "] " + name);
  if (details && Object.keys(details).length > 0) console.log("       " + JSON.stringify(details));
  return entry;
}

function saveReport() {
  const report = {
    testId: "STAGE4_CELLULAR_" + Date.now(),
    timestamp: new Date().toISOString(),
    nodeId: NODE_ID,
    tunnelEndpoint: { host: TUNNEL_HOST, port: TUNNEL_PORT },
    outcome: testOutcome,
    steps
  };
  const fname = "stage4_evidence_" + Date.now() + ".json";
  fs.writeFileSync(fname, JSON.stringify(report, null, 2));
  console.log("\nEvidence saved: " + fname);
  return report;
}

// --- Main Test ---------------------------------------------------------------
async function runTest() {
  console.log("\n========================================================");
  console.log("  BARQ LINK — Stage 4: Cellular End-to-End Challenge");
  console.log("  Node: " + NODE_ID + " | Tunnel: " + TUNNEL_HOST + ":" + TUNNEL_PORT);
  console.log("  APN: " + APN);
  console.log("========================================================\n");

  // -- PRE-CHECK 0: Verify server and tunnel ---------------------------------
  console.log("--- PRE-CHECKS ---");

  try {
    const health = await apiCall("/api/health");
    if (!health.challengeServerRunning) throw new Error("ChallengeServer not running in backend");
    logStep("BACKEND_HEALTH", "PASS", { uptime: health.uptimeSec });
  } catch (e) {
    logStep("BACKEND_HEALTH", "FAIL", { error: e.message });
    console.error("\nFATAL: Backend server not reachable on :4000");
    console.error("Start it: node server.js");
    testOutcome = "BLOCKED";
    saveReport();
    process.exit(1);
  }

  // Verify tunnel is still alive by connecting to it
  try {
    await new Promise((resolve, reject) => {
      const probe = net.createConnection({ host: TUNNEL_HOST, port: TUNNEL_PORT });
      probe.on("connect", () => { probe.destroy(); resolve(); });
      probe.on("error", reject);
      setTimeout(() => reject(new Error("TUNNEL_PROBE_TIMEOUT")), 8000);
    });
    logStep("TUNNEL_ALIVE", "PASS", { host: TUNNEL_HOST, port: TUNNEL_PORT });
  } catch (e) {
    logStep("TUNNEL_ALIVE", "FAIL", { error: e.message });
    console.error("\nFATAL: Tunnel not reachable. Restart tunnel.");
    testOutcome = "BLOCKED";
    saveReport();
    process.exit(1);
  }

  // -- STEP 1: Node Status ---------------------------------------------------
  console.log("\n--- STEP 1: Node Status ---");
  let nodeState;
  try {
    const snap = await apiCall("/api/nodes/" + NODE_ID);
    nodeState = snap;
    const simOk = snap.attributes.simStatus === "READY";
    logStep("SIM_READY_CHECK", simOk ? "PASS" : "FAIL", {
      state: snap.state,
      simStatus: snap.attributes.simStatus,
      signalCsq: snap.attributes.signalCsq,
      gprsRegistration: snap.attributes.gprsRegistration,
      operator: snap.attributes.operator
    });
    if (!simOk) throw new Error("SIM not ready: " + snap.attributes.simStatus);
  } catch (e) {
    logStep("SIM_READY_CHECK", "FAIL", { error: e.message });
    testOutcome = "BLOCKED";
    saveReport();
    process.exit(1);
  }

  // -- STEP 2: Configure APN -------------------------------------------------
  console.log("\n--- STEP 2: Configure APN ---");
  try {
    await apiCall("/api/nodes/" + NODE_ID + "/gprs/configure", "POST", { apn: APN });
    logStep("APN_CONFIGURE", "PASS", { apn: APN });
  } catch (e) {
    logStep("APN_CONFIGURE", "FAIL", { error: e.message });
    testOutcome = "BLOCKED";
    saveReport();
    process.exit(1);
  }

  // -- STEP 3: Activate GPRS ------------------------------------------------
  console.log("\n--- STEP 3: Activate GPRS (AT+QIREGAPP + AT+QIACT) ---");
  const activateStart = Date.now();
  let assignedIp = null;
  try {
    const res = await apiCall("/api/nodes/" + NODE_ID + "/gprs/activate", "POST");
    assignedIp = res.ip;
    const elapsed = Date.now() - activateStart;
    logStep("GPRS_ACTIVATE", "PASS", { elapsedMs: elapsed });
    if (assignedIp) {
      logStep("IP_ASSIGNMENT", "PASS", { assignedIp, elapsedMs: elapsed });
      console.log("\n  Carrier-assigned IP: " + assignedIp + "\n");
    } else {
      logStep("IP_ASSIGNMENT", "WARN", { note: "No IP returned from activate" });
    }
  } catch (e) {
    logStep("GPRS_ACTIVATE", "FAIL", { error: e.message, elapsedMs: Date.now() - activateStart });
    testOutcome = "FAIL";
    // Try deactivate and save
    try { await apiCall("/api/nodes/" + NODE_ID + "/gprs/deactivate", "POST"); } catch(_) {}
    saveReport();
    process.exit(1);
  }

  // -- STEP 4: TCP Connect to Tunnel -----------------------------------------
  console.log("\n--- STEP 4: TCP Connect (ALPHA -> Pinggy Tunnel) ---");
  const tcpStart = Date.now();
  try {
    await apiCall("/api/nodes/" + NODE_ID + "/tcp/connect", "POST", {
      host: TUNNEL_HOST,
      port: TUNNEL_PORT
    });
    const elapsed = Date.now() - tcpStart;
    logStep("TCP_CONNECT", "PASS", {
      target: TUNNEL_HOST + ":" + TUNNEL_PORT,
      elapsedMs: elapsed
    });
    console.log("  TCP_CONNECTED: modem connected to tunnel in " + elapsed + "ms\n");
  } catch (e) {
    logStep("TCP_CONNECT", "FAIL", {
      target: TUNNEL_HOST + ":" + TUNNEL_PORT,
      error: e.message,
      elapsedMs: Date.now() - tcpStart
    });
    testOutcome = "FAIL";
    try { await apiCall("/api/nodes/" + NODE_ID + "/gprs/deactivate", "POST"); } catch(_) {}
    saveReport();
    process.exit(1);
  }

  // -- STEP 5: Send Challenge Payload ----------------------------------------
  console.log("--- STEP 5: Send Challenge Payload ---");
  const corrId = "CELLULAR_" + crypto.randomBytes(8).toString("hex").toUpperCase();
  const challengePayload = JSON.stringify({
    type: "barq-challenge-v1",
    correlationId: corrId,
    nodeId: NODE_ID,
    challenge: "BARQ_AIR_PROBE_REAL",
    assignedIp: assignedIp || "UNKNOWN",
    tunnelTarget: TUNNEL_HOST + ":" + TUNNEL_PORT,
    sentAt: new Date().toISOString()
  });

  console.log("  corrId: " + corrId);
  console.log("  payload length: " + challengePayload.length + " bytes\n");

  const sendStart = Date.now();
  let sendOk = false;
  try {
    await apiCall("/api/nodes/" + NODE_ID + "/tcp/send", "POST", { payload: challengePayload });
    sendOk = true;
    logStep("CHALLENGE_SENT", "PASS", {
      corrId,
      payloadBytes: challengePayload.length,
      elapsedMs: Date.now() - sendStart
    });
    console.log("  SEND_OK confirmed by modem\n");
  } catch (e) {
    logStep("CHALLENGE_SENT", "FAIL", { error: e.message });
    testOutcome = "FAIL";
    try { await apiCall("/api/nodes/" + NODE_ID + "/tcp/close", "POST"); } catch(_) {}
    try { await apiCall("/api/nodes/" + NODE_ID + "/gprs/deactivate", "POST"); } catch(_) {}
    saveReport();
    process.exit(1);
  }

  // -- STEP 6: Wait for ACK from Server -------------------------------------
  console.log("--- STEP 6: Waiting for Server ACK (polling challenge log) ---");
  const waitStart = Date.now();
  const maxWaitMs = 30000;
  let ackRecord = null;

  while (Date.now() - waitStart < maxWaitMs) {
    try {
      const challenges = await apiCall("/api/challenges");
      if (Array.isArray(challenges) && challenges.length > 0) {
        const match = challenges.find(c => 
          c.payload && c.payload.correlationId === corrId
        );
        if (match) { ackRecord = match; break; }
      }
    } catch (e) {}
    await new Promise(r => setTimeout(r, 1000));
  }

  const ackWaitMs = Date.now() - waitStart;
  if (ackRecord) {
    logStep("SERVER_RECEIVED_CHALLENGE", "PASS", {
      corrId,
      remoteAddress: ackRecord.remoteAddress,
      remotePort: ackRecord.remotePort,
      receivedAt: ackRecord.receivedAt,
      waitMs: ackWaitMs
    });
    console.log("  corrId " + corrId + " confirmed in server log");
    console.log("  Remote address (carrier IP): " + ackRecord.remoteAddress + ":" + ackRecord.remotePort + "\n");
  } else {
    logStep("SERVER_RECEIVED_CHALLENGE", "FAIL", {
      corrId,
      waitMs: ackWaitMs,
      note: "corrId not found in server challenge log after " + maxWaitMs + "ms"
    });
    testOutcome = "SEND_UNVERIFIED";
    try { await apiCall("/api/nodes/" + NODE_ID + "/tcp/close", "POST"); } catch(_) {}
    try { await apiCall("/api/nodes/" + NODE_ID + "/gprs/deactivate", "POST"); } catch(_) {}
    saveReport();
    process.exit(0);
  }

  // -- STEP 7: Verify ACK received at modem ---------------------------------
  // The ACK was already sent by ChallengeServer when challenge was received.
  // We need to check if the modem received it - look at the ALPHA node's last raw response.
  console.log("--- STEP 7: Verify ACK received at modem ---");
  // We allow 5s extra for the modem-side receive
  await new Promise(r => setTimeout(r, 5000));

  let modemReceivedAck = false;
  try {
    const snap = await apiCall("/api/nodes/" + NODE_ID);
    const lastRaw = snap.attributes.lastRawResponse || "";
    // Look for our corrId in the raw responses
    if (lastRaw.includes(corrId) || lastRaw.includes("ACK_CHALLENGE_VERIFIED")) {
      modemReceivedAck = true;
    }
    // Also check GPRS engine evidence
    if (snap.gprs && snap.gprs.recentEvidence) {
      const evidence = JSON.stringify(snap.gprs.recentEvidence);
      if (evidence.includes(corrId) || evidence.includes("ACK_CHALLENGE_VERIFIED")) {
        modemReceivedAck = true;
      }
    }
    logStep("MODEM_RECEIVED_ACK", modemReceivedAck ? "PASS" : "WARN", {
      corrId,
      lastRawResponse: lastRaw.slice(0, 200),
      note: modemReceivedAck ? "corrId found in modem raw data" : "ACK not confirmed in modem raw data - may still have been received"
    });
  } catch(e) {
    logStep("MODEM_RECEIVED_ACK", "WARN", { error: e.message });
  }

  // -- STEP 8: Compute RTT and Final Outcome ---------------------------------
  const totalRtt = Date.now() - tcpStart;
  const appRtt = ackRecord ? (new Date(ackRecord.receivedAt).getTime() - sendStart) : null;

  logStep("RTT_MEASUREMENT", "PASS", {
    tcpConnectToAckMs: totalRtt,
    appLayerRttMs: appRtt,
    corrId
  });

  // Final outcome
  if (ackRecord) {
    testOutcome = "END_TO_END_PASS";
    console.log("\n  RESULT: TCP CONNECTED + CHALLENGE VERIFIED ON SERVER");
    if (!modemReceivedAck) {
      console.log("  NOTE: Modem-side ACK reception not confirmed in raw data.");
      console.log("  The ChallengeServer did receive and ACK our corrId.");
      testOutcome = "TCP_CHALLENGE_VERIFIED";
    }
  }

  // -- STEP 9: Clean Teardown ------------------------------------------------
  console.log("\n--- STEP 9: Clean Teardown ---");
  try {
    await apiCall("/api/nodes/" + NODE_ID + "/tcp/close", "POST");
    logStep("TCP_CLOSE", "PASS");
  } catch (e) {
    logStep("TCP_CLOSE", "WARN", { error: e.message });
  }

  await new Promise(r => setTimeout(r, 1000));

  try {
    await apiCall("/api/nodes/" + NODE_ID + "/gprs/deactivate", "POST");
    logStep("GPRS_DEACTIVATE", "PASS");
  } catch (e) {
    logStep("GPRS_DEACTIVATE", "WARN", { error: e.message });
  }

  const report = saveReport();

  // -- SUMMARY ---------------------------------------------------------------
  console.log("\n========================================================");
  console.log("  STAGE 4 CELLULAR TEST SUMMARY");
  console.log("========================================================");
  for (const s of steps) {
    const m = s.status === "PASS" ? "OK" : (s.status === "FAIL" ? "FAIL" : "WARN");
    console.log("  [" + m + "] " + s.step);
  }
  console.log("--------------------------------------------------------");
  console.log("  FINAL OUTCOME: " + testOutcome);
  console.log("  corrId Used  : " + corrId);
  console.log("  Carrier IP   : " + (assignedIp || "N/A"));
  console.log("  Tunnel Target: " + TUNNEL_HOST + ":" + TUNNEL_PORT);
  console.log("  RTT (TCP->ACK): " + totalRtt + "ms");
  console.log("========================================================\n");
}

runTest().catch(err => {
  console.error("Uncaught fatal:", err.message);
  testOutcome = "FAIL";
  saveReport();
  process.exit(1);
});
