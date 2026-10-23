/**
 * BARQ LINK — Phase 4: Local Challenge Protocol Verification
 * Tests the full challenge/ACK cycle LOCALLY (no modem needed).
 * Must pass before any cellular GPRS test.
 */

"use strict";
const net = require("net");
const crypto = require("crypto");

const PORT = 5050;
const HOST = "127.0.0.1";

let passed = 0;
let failed = 0;
const results = [];

function logResult(name, ok, detail = "") {
  const mark = ok ? "OK" : "FAIL";
  console.log(`[${mark}] ${name}${detail ? " -- " + detail : ""}`);
  results.push({ name, status: mark, detail });
  if (ok) passed++; else failed++;
}

function makeChallengePayload(corrId) {
  return JSON.stringify({
    type: "barq-challenge-v1",
    correlationId: corrId,
    nodeId: "ALPHA",
    challenge: "BARQ_AIR_PROBE_REAL",
    sentAt: new Date().toISOString()
  });
}

function connectAndSend(payload, opts = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: HOST, port: PORT });
    let responseBuffer = "";
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) { resolved = true; socket.destroy(); reject(new Error("TIMEOUT_WAITING_FOR_ACK")); }
    }, opts.timeoutMs || 5000);
    socket.on("connect", () => {
      if (opts.fragment) {
        const half = Math.floor(payload.length / 2);
        socket.write(payload.slice(0, half));
        setTimeout(() => socket.write(payload.slice(half)), 80);
      } else {
        socket.write(payload);
      }
    });
    socket.on("data", (chunk) => {
      responseBuffer += chunk.toString("utf8");
      try {
        const match = responseBuffer.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]);
          if (!resolved) { resolved = true; clearTimeout(timer); socket.destroy(); resolve(parsed); }
        }
      } catch (e) {}
    });
    socket.on("error", (err) => { if (!resolved) { resolved = true; clearTimeout(timer); reject(err); } });
    socket.on("close", () => { if (!resolved) { resolved = true; clearTimeout(timer); reject(new Error("SOCKET_CLOSED_NO_RESPONSE")); } });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runTests() {
  console.log("================================================");
  console.log("  BARQ LINK Phase 4 — Challenge Protocol Test");
  console.log("  Target: ChallengeServer on " + HOST + ":" + PORT);
  console.log("================================================\n");

  // Probe
  try {
    await new Promise((resolve, reject) => {
      const probe = net.createConnection({ host: HOST, port: PORT });
      probe.on("connect", () => { probe.destroy(); resolve(); });
      probe.on("error", reject);
      setTimeout(() => reject(new Error("PROBE_TIMEOUT")), 2000);
    });
    console.log("  ChallengeServer reachable OK\n");
  } catch (e) {
    console.error("FATAL: Cannot reach ChallengeServer: " + e.message);
    process.exit(1);
  }

  // TEST 1: Normal round trip
  const c1 = "TEST_" + crypto.randomBytes(6).toString("hex").toUpperCase();
  const t1 = Date.now();
  try {
    const ack = await connectAndSend(makeChallengePayload(c1));
    const rtt = Date.now() - t1;
    const ok = ack.correlationId === c1 && ack.status === "ACK_CHALLENGE_VERIFIED";
    logResult("Normal Challenge/ACK Round Trip", ok, "RTT=" + rtt + "ms corrId=" + (ack.correlationId === c1 ? "MATCH" : "MISMATCH"));
    if (ok) console.log("   Server ACK: " + JSON.stringify(ack) + "\n");
  } catch (err) { logResult("Normal Challenge/ACK Round Trip", false, err.message); }

  await sleep(200);

  // TEST 2: Fragmented TCP
  const c2 = "FRAG_" + crypto.randomBytes(6).toString("hex").toUpperCase();
  try {
    const ack = await connectAndSend(makeChallengePayload(c2), { fragment: true });
    logResult("Fragmented TCP Delivery", ack.correlationId === c2 && ack.status === "ACK_CHALLENGE_VERIFIED", "corrId=" + (ack.correlationId === c2 ? "MATCH" : "MISMATCH"));
  } catch (err) { logResult("Fragmented TCP Delivery", false, err.message); }

  await sleep(200);

  // TEST 3: 3 sequential
  let seqOk = true;
  let seqDetail = "";
  for (let i = 0; i < 3; i++) {
    const cN = "SEQ" + i + "_" + crypto.randomBytes(4).toString("hex").toUpperCase();
    try {
      const ack = await connectAndSend(makeChallengePayload(cN));
      if (ack.correlationId !== cN || ack.status !== "ACK_CHALLENGE_VERIFIED") { seqOk = false; seqDetail = "Iter " + i + ": corrId MISMATCH"; break; }
    } catch (err) { seqOk = false; seqDetail = "Iter " + i + ": " + err.message; break; }
    await sleep(80);
  }
  logResult("3 Sequential Challenges", seqOk, seqOk ? "3/3 OK" : seqDetail);

  await sleep(200);

  // TEST 4: Server stability with silent connection
  try {
    await new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: HOST, port: PORT });
      sock.on("connect", () => { setTimeout(() => { sock.destroy(); resolve(); }, 1000); });
      sock.on("error", reject);
    });
    logResult("Silent Connection Stability", true, "Server did not crash");
  } catch (err) { logResult("Silent Connection Stability", false, err.message); }

  await sleep(200);

  // TEST 5: corrId integrity
  const c5 = "CORR_" + crypto.randomBytes(4).toString("hex").toUpperCase();
  try {
    const ack = await connectAndSend(makeChallengePayload(c5));
    const ok = ack.correlationId === c5;
    logResult("corrId Integrity", ok, ok ? "Echo: " + c5 : "Got: " + ack.correlationId + " expected: " + c5);
  } catch (err) { logResult("corrId Integrity", false, err.message); }

  console.log("\n================================================");
  console.log("  PHASE 4 SUMMARY: PASSED=" + passed + " FAILED=" + failed + " TOTAL=" + (passed+failed));
  for (const r of results) console.log("  [" + r.status + "] " + r.name);
  console.log("================================================\n");

  if (failed === 0) {
    console.log("ALL PHASE 4 TESTS PASSED - Safe to run cellular test.\n");
  } else {
    console.log(failed + " TEST(S) FAILED - Fix ChallengeServer before cellular test.\n");
    process.exit(1);
  }
}

runTests().catch(err => { console.error("Uncaught:", err); process.exit(1); });
