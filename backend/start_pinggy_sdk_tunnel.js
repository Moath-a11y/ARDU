/**
 * BARQ LINK — Pinggy TCP Tunnel via Official Node.js SDK (Headless)
 * Creates a true TCP tunnel (not HTTP) pointing to local port 5050.
 * The forwarding array with type:"tcp" is required.
 */
"use strict";
const { pinggy, TunnelType } = require("@pinggy/pinggy");
const net = require("net");
const fs = require("fs");

const LOCAL_PORT = 5050;

console.log("================================================");
console.log("  BARQ LINK — Pinggy TCP Tunnel (SDK Mode)");
console.log("  Local target: 127.0.0.1:" + LOCAL_PORT);
console.log("================================================\n");

async function verifyLocalServer() {
  return new Promise((resolve) => {
    const probe = net.createConnection({ host: "127.0.0.1", port: LOCAL_PORT });
    probe.on("connect", () => { probe.destroy(); resolve(true); });
    probe.on("error", () => resolve(false));
    setTimeout(() => resolve(false), 2000);
  });
}

async function main() {
  const localOk = await verifyLocalServer();
  if (!localOk) {
    console.error("ERROR: ChallengeServer NOT running on port " + LOCAL_PORT);
    console.error("Run: node run_challenge_server.js");
    process.exit(1);
  }
  console.log("ChallengeServer confirmed on :" + LOCAL_PORT + "\n");
  console.log("Starting TCP tunnel (free tier)...");

  const tunnel = await pinggy.createTunnel({
    forwarding: [{ address: "localhost:" + LOCAL_PORT, type: TunnelType.Tcp }]
  });

  await tunnel.start();

  const urls = await tunnel.urls();
  if (!urls || urls.length === 0) {
    console.error("No public URLs received");
    process.exit(1);
  }

  const tcpUrl = urls.find(u => u.startsWith("tcp://"));
  if (!tcpUrl) {
    console.error("No tcp:// URL found. Got:", urls);
    process.exit(1);
  }

  const stripped = tcpUrl.replace("tcp://", "");
  const colonIdx = stripped.lastIndexOf(":");
  const pubHost = stripped.slice(0, colonIdx);
  const pubPort = parseInt(stripped.slice(colonIdx + 1), 10);

  console.log("================================================");
  console.log("  TUNNEL ACTIVE");
  console.log("  Public URL : " + tcpUrl);
  console.log("  Host       : " + pubHost);
  console.log("  Port       : " + pubPort);
  console.log("================================================\n");
  console.log("  ALPHA MODEM AT COMMAND:");
  console.log('  AT+QIOPEN="TCP","' + pubHost + '",' + pubPort);
  console.log("\n  Keep this window open during modem test.\n");

  const endpointData = { host: pubHost, port: pubPort, url: tcpUrl, timestamp: new Date().toISOString() };
  fs.writeFileSync("pinggy_endpoint.json", JSON.stringify(endpointData, null, 2));
  console.log("  Endpoint saved to pinggy_endpoint.json");

  process.on("SIGINT", async () => {
    console.log("\nClosing tunnel...");
    try { await tunnel.stop(); } catch(e) {}
    process.exit(0);
  });

  setInterval(() => {}, 10000);
}

main().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
