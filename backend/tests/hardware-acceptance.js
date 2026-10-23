/**
 * BARQ LINK — Stage 2 Physical Hardware Acceptance Test
 * Connects to physical COM3 (ALPHA) and COM4 (BRAVO), executes non-destructive queries,
 * and outputs verified hardware evidence without any simulation or mock.
 */

const HardwareController = require('../src/hardware/HardwareController');

async function runHardwareAcceptance() {
  console.log('\n=============================================================');
  console.log('  BARQ LINK · STAGE 2 PHYSICAL HARDWARE ACCEPTANCE TEST');
  console.log('  Target: Physical Quectel M25 Modules on COM3 & COM4');
  console.log('  Safety: Read-Only Non-Destructive AT Queries (Zero Cost)');
  console.log('=============================================================\n');

  const controller = new HardwareController({
    alphaPort: 'COM3',
    bravoPort: 'COM4',
    baudRate: 9600
  });

  try {
    // 1. Port Enumeration
    console.log('[STEP 1] Enumerating System COM Ports...');
    const ports = await controller.listAvailablePorts();
    console.log(`Found ${ports.length} ports:`);
    for (const p of ports) {
      console.log(`  - ${p.path} [${p.friendlyName}] (VID: ${p.vendorId}, PID: ${p.productId})`);
    }

    const hasAlpha = ports.some(p => p.path === 'COM3');
    const hasBravo = ports.some(p => p.path === 'COM4');

    if (!hasAlpha || !hasBravo) {
      throw new Error(`Required ports not both detected! (COM3: ${hasAlpha}, COM4: ${hasBravo})`);
    }
    console.log('✅ Port Discovery: Both COM3 and COM4 are physically enumerated.\n');

    // 2. Concurrent Port Open
    console.log('[STEP 2] Initializing and opening COM3 & COM4 concurrently...');
    await controller.initialize();
    const openResults = await controller.startAll();
    console.log('Port Open Results:', JSON.stringify(openResults, null, 2));

    for (const [node, res] of Object.entries(openResults)) {
      if (res.status !== 'OPENED') {
        throw new Error(`Failed to open port for ${node}: ${res.error}`);
      }
    }
    console.log('✅ Concurrency: Both COM3 and COM4 opened simultaneously with exclusive ownership.\n');

    // Wait a brief moment for any pending boot banner
    await new Promise(r => setTimeout(r, 600));

    // 3. Stage 2 Non-Destructive Diagnostics on Both Modems
    console.log('[STEP 3] Running Non-Destructive Read-Only Diagnostics...');
    console.log('(Querying ATI, CPIN, CSQ, CREG, CGREG, CGATT, COPS, CBC)\n');

    const reports = await controller.runAllDiagnostics();

    console.log('=============================================================');
    console.log('  PHYSICAL HARDWARE EVIDENCE RECORD');
    console.log('=============================================================');

    for (const [nodeId, rep] of Object.entries(reports)) {
      console.log(`\n----------------- [NODE ${nodeId}] -----------------`);
      console.log(`Port:              ${rep.port}`);
      console.log(`Final State:       ${rep.state}`);
      console.log(`Firmware/Model:    ${rep.attributes.model || 'Unknown'} / ${rep.attributes.firmware || 'Unknown'}`);
      console.log(`SIM Status:        ${rep.attributes.simStatus}`);
      console.log(`Signal Quality:    CSQ ${rep.attributes.signalCsq !== null ? rep.attributes.signalCsq : '--'}/31 (${rep.attributes.signalPct !== null ? rep.attributes.signalPct : '--'}%) | BER: ${rep.attributes.signalBer !== null ? rep.attributes.signalBer : '--'}`);
      console.log(`GSM Registration:  ${rep.attributes.gsmRegistration}`);
      console.log(`GPRS Registration: ${rep.attributes.gprsRegistration}`);
      console.log(`GPRS Attached:     ${rep.attributes.gprsAttached ? 'YES (CGATT: 1)' : 'NO (CGATT: 0)'}`);
      console.log(`Operator:          ${rep.attributes.operator || 'Not Reported / Auto'}`);
      console.log(`Battery Voltage:   ${rep.attributes.voltage ? rep.attributes.voltage + ' V' : 'N/A'}`);

      console.log('\nCommand Execution Evidence:');
      for (const cmdRec of rep.commandsExecuted) {
        const status = cmdRec.ok ? 'OK' : 'FAIL';
        const cleanRaw = (cmdRec.raw || cmdRec.error || '').replace(/\r?\n/g, ' | ');
        console.log(`  > ${cmdRec.cmd.padEnd(12)} -> [${status}] ${cleanRaw}`);
      }
    }

    console.log('\n=============================================================');
    console.log('  STAGE 2 PHYSICAL ACCEPTANCE EVALUATION');
    console.log('=============================================================');

    let allPassed = true;
    for (const [nodeId, rep] of Object.entries(reports)) {
      if (!rep.success) {
        console.log(`❌ NODE ${nodeId}: One or more non-destructive queries failed!`);
        allPassed = false;
      } else {
        console.log(`✅ NODE ${nodeId}: Successfully verified! State: ${rep.state}`);
      }
    }

    if (allPassed) {
      console.log('\n🎯 STAGE 2 PHYSICAL HARDWARE ACCEPTANCE: PASSED (100% EVIDENCE)\n');
    } else {
      console.log('\n⚠️ STAGE 2 ACCEPTANCE HAS WARNINGS / UNRESOLVED RESPONSES\n');
    }

  } catch (err) {
    console.error('\n❌ FATAL HARDWARE ACCEPTANCE ERROR:', err.message);
  } finally {
    console.log('[CLEANUP] Closing all serial ports cleanly...');
    await controller.shutdown();
    console.log('[CLEANUP] Ports closed and handles released.');
  }
}

runHardwareAcceptance();
