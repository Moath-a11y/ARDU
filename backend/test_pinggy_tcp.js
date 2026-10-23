"use strict";
const { pinggy, TunnelType } = require("@pinggy/pinggy");

async function main() {
  console.log("Testing TCP tunnel creation...");
  console.log("TunnelType.Tcp =", TunnelType.Tcp);
  
  // Method: forwarding as array with type field
  const tunnel = await pinggy.createTunnel({
    forwarding: [{ address: "localhost:5050", type: TunnelType.Tcp }]
  });
  
  await tunnel.start();
  
  const urls = await tunnel.urls();
  console.log("URLs:", urls);
  
  setTimeout(async () => {
    await tunnel.stop();
  }, 3000);
}

main().catch(e => { console.error("Error:", e.message); process.exit(1); });
