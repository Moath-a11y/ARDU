/**
 * BARQ LINK — Live Stage 3 Test Runner for NODE ALPHA (COM3)
 * Communicates strictly via the running HardwareController REST API (Port 4000)
 * Preserves exclusive port ownership. Records all raw evidence.
 */

const http = require('http');

function apiCall(endpoint, method = 'GET', data = null) {
  return new Promise((resolve, reject) => {
    const postData = data ? JSON.stringify(data) : null;
    const req = http.request({
      hostname: 'localhost',
      port: 4000,
      path: endpoint,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {})
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (res.statusCode >= 400) {
            reject(new Error(parsed.error || `HTTP_${res.statusCode}`));
          } else {
            resolve(parsed);
          }
        } catch (e) {
          resolve(body);
        }
      });
    });

    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

async function runStage3LiveTest() {
  console.log('\n=============================================================');
  console.log('  BARQ LINK · STAGE 3 PHYSICAL CELLULAR TEST (NODE ALPHA)');
  console.log('  Target: Quectel M25 on COM3 @ 9600 Baud');
  console.log('  Carrier: Jawwal Palestine (APN: internet)');
  console.log('  Architecture: Sole Ownership via Central Hardware Controller');
  console.log('=============================================================\n');

  const evidenceReport = {
    testStartTime: new Date().toISOString(),
    nodeId: 'ALPHA',
    steps: []
  };

  function logStep(name, status, details = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      step: name,
      status,
      details
    };
    evidenceReport.steps.push(entry);
    const mark = status === 'PASS' ? '✅' : (status === 'FAIL' ? '❌' : 'ℹ️');
    console.log(`${mark} [${entry.timestamp}] ${name}: ${status}`);
    if (Object.keys(details).length > 0) {
      console.log('   Evidence:', JSON.stringify(details));
    }
    return entry;
  }

  try {
    // -------------------------------------------------------------
    // STEP 1: Verify Hardware Controller & Node Status
    // -------------------------------------------------------------
    console.log('\n--- STEP 1: Verifying ALPHA Hardware Readiness ---');
    const health = await apiCall('/api/health');
    logStep('HEALTH_CHECK', health.status === 'HEALTHY' ? 'PASS' : 'FAIL', {
      uptime: health.uptimeSec,
      challengeServerRunning: health.challengeServerRunning
    });

    const nodeSnapshot = await apiCall('/api/nodes/ALPHA');
    logStep('NODE_READINESS', nodeSnapshot.state === 'PACKET_ATTACHED' ? 'PASS' : 'WARN', {
      state: nodeSnapshot.state,
      port: nodeSnapshot.portPath,
      simStatus: nodeSnapshot.attributes.simStatus,
      signalCsq: nodeSnapshot.attributes.signalCsq,
      operator: nodeSnapshot.attributes.operator
    });

    if (nodeSnapshot.attributes.simStatus !== 'READY') {
      throw new Error(`SIM card not ready! Status: ${nodeSnapshot.attributes.simStatus}`);
    }

    // -------------------------------------------------------------
    // STEP 2: Configure APN 'internet'
    // -------------------------------------------------------------
    console.log('\n--- STEP 2: Configuring PDP Context Parameters (APN: internet) ---');
    const configStart = Date.now();
    try {
      const configRes = await apiCall('/api/nodes/ALPHA/gprs/configure', 'POST', { apn: 'internet' });
      logStep('PDP_CONFIGURATION', 'PASS', {
        apn: 'internet',
        elapsedMs: Date.now() - configStart,
        result: configRes
      });
    } catch (err) {
      logStep('PDP_CONFIGURATION', 'FAIL', { error: err.message });
      throw err;
    }

    // -------------------------------------------------------------
    // STEP 3: Activate GPRS PDP Session & Query Assigned IP
    // -------------------------------------------------------------
    console.log('\n--- STEP 3: Activating GPRS PDP Session (AT+QIREGAPP & AT+QIACT) ---');
    const activateStart = Date.now();
    let assignedIp = null;

    try {
      const activateRes = await apiCall('/api/nodes/ALPHA/gprs/activate', 'POST');
      assignedIp = activateRes.ip;
      const elapsed = Date.now() - activateStart;

      logStep('PDP_ACTIVATION', 'PASS', {
        elapsedMs: elapsed,
        response: activateRes
      });

      logStep('IP_ASSIGNMENT', assignedIp ? 'PASS' : 'FAIL', {
        assignedIp: assignedIp,
        elapsedMs: elapsed
      });
      console.log(`\n🎉 [CARRIER ASSIGNED IP]: ${assignedIp}\n`);
    } catch (err) {
      logStep('PDP_ACTIVATION', 'FAIL', {
        elapsedMs: Date.now() - activateStart,
        error: err.message
      });
      throw err;
    }

    // -------------------------------------------------------------
    // STEP 4: TCP Socket Connectivity Test
    // -------------------------------------------------------------
    console.log('\n--- STEP 4: Testing TCP Socket Connectivity from Modem ---');

    // Test A: Public Internet Reachability (Public Host 44.232.241.40:1883)
    console.log('\n[Test 4A] Testing TCP socket to Public Host (44.232.241.40:1883 - broker.emqx.io)...');
    let publicTcpConnected = false;
    const tcpStart = Date.now();

    try {
      await apiCall('/api/nodes/ALPHA/tcp/connect', 'POST', { host: '44.232.241.40', port: 1883 });
      publicTcpConnected = true;
      logStep('TCP_CONNECT_PUBLIC_INTERNET', 'PASS', {
        target: '44.232.241.40:1883',
        elapsedMs: Date.now() - tcpStart
      });
    } catch (err) {
      logStep('TCP_CONNECT_PUBLIC_INTERNET', 'FAIL', {
        target: '44.232.241.40:1883',
        elapsedMs: Date.now() - tcpStart,
        error: err.message
      });
    }



    // If connected, test sending real packet over cellular link
    if (publicTcpConnected) {
      console.log('\n[Test 4C] Transmitting Cellular Data Packet...');
      const correlationId = 'CHALLENGE_' + Date.now().toString(36).toUpperCase();
      const sendStart = Date.now();
      try {
        const sendRes = await apiCall('/api/nodes/ALPHA/tcp/send', 'POST', {
          payload: `BARQ_PING:${correlationId}`
        });
        logStep('CELLULAR_DATA_TX', 'PASS', {
          correlationId,
          elapsedMs: Date.now() - sendStart,
          result: sendRes
        });
      } catch (err) {
        logStep('CELLULAR_DATA_TX', 'FAIL', { error: err.message });
      }

      // Close TCP socket
      console.log('\n--- Closing TCP Socket ---');
      try {
        await apiCall('/api/nodes/ALPHA/tcp/close', 'POST');
        logStep('TCP_SOCKET_CLOSE', 'PASS');
      } catch (err) {
        logStep('TCP_SOCKET_CLOSE', 'WARN', { error: err.message });
      }
    }

    // -------------------------------------------------------------
    // STEP 5: Clean Teardown (Deactivate PDP Context)
    // -------------------------------------------------------------
    console.log('\n--- STEP 5: Clean Teardown (AT+QIDEACT) ---');
    try {
      await apiCall('/api/nodes/ALPHA/gprs/deactivate', 'POST');
      logStep('PDP_DEACTIVATION', 'PASS');
    } catch (err) {
      logStep('PDP_DEACTIVATION', 'WARN', { error: err.message });
    }

  } catch (fatalErr) {
    console.error('\n❌ FATAL TEST EXECUTION ERROR:', fatalErr.message);
  } finally {
    evidenceReport.testEndTime = new Date().toISOString();
    console.log('\n=============================================================');
    console.log('  STAGE 3 LIVE TEST EVIDENCE REPORT SUMMARY');
    console.log('=============================================================');
    for (const step of evidenceReport.steps) {
      console.log(`[${step.status.padEnd(13)}] ${step.step}`);
    }
    console.log('=============================================================\n');
  }
}

runStage3LiveTest();
