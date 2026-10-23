/**
 * BARQ LINK — Hardware Preflight Runner (Read-Only)
 * Target: ALPHA (COM3), BRAVO (COM4) @ 9600 Baud
 * Performs non-destructive inspection of firmware, signal, and TCP/IP stack configuration.
 */

const { SerialPort } = require('serialport');

const COMMANDS = [
  // A. Basic & Signal Checks
  { id: 'A1',  cmd: 'AT',         desc: 'Modem AT responsiveness', readOnly: true },
  { id: 'A2',  cmd: 'ATE0',       desc: 'Disable echo for clean parsing', readOnly: false },
  { id: 'A3',  cmd: 'AT+CMEE=2',  desc: 'Enable verbose error reporting', readOnly: false },
  { id: 'A4',  cmd: 'ATI',        desc: 'Product Identification & firmware', readOnly: true },
  { id: 'A5',  cmd: 'AT+CGMR',    desc: 'Firmware release version', readOnly: true },
  { id: 'A6',  cmd: 'AT+CPIN?',   desc: 'SIM card status', readOnly: true },
  { id: 'A7',  cmd: 'AT+CSQ',     desc: 'Signal quality (RSSI, BER)', readOnly: true },
  { id: 'A8',  cmd: 'AT+CREG?',   desc: 'GSM network registration status', readOnly: true },
  { id: 'A9',  cmd: 'AT+CGREG?',  desc: 'GPRS network registration status', readOnly: true },
  { id: 'A10', cmd: 'AT+CGATT?',  desc: 'GPRS packet attachment status', readOnly: true },
  { id: 'A11', cmd: 'AT+COPS?',   desc: 'Operator / Carrier selection', readOnly: true },

  // B. TCP Receive Mode & Stack Checks (Critical Focus)
  { id: 'B1',  cmd: 'AT+QIMODE?', desc: 'TCP/IP connection mode (0=Normal, 1=Transparent)', readOnly: true },
  { id: 'B2',  cmd: 'AT+QINDI?',  desc: 'TCP data receive mode (0=Push, 1=Buffer, 2=Buffer+details)', readOnly: true },
  { id: 'B3',  cmd: 'AT+QIFGCNT?',desc: 'Foreground context count', readOnly: true },
  { id: 'B4',  cmd: 'AT+QISTATE', desc: 'Current TCP socket states', readOnly: true },
  { id: 'B5',  cmd: 'AT+QIRD=?',  desc: 'Test command for AT+QIRD syntax (2 vs 4 params)', readOnly: true },
  { id: 'B6',  cmd: 'AT+QHTTPCFG?', desc: 'HTTP configuration query (stack sanity)', readOnly: true },

  // C. TCP State Query
  { id: 'C1',  cmd: 'AT+QISTAT',  desc: 'Query socket protocol status (IP INITIAL / CONNECT OK)', readOnly: true },
  { id: 'C2',  cmd: 'AT+QILOCIP', desc: 'Query allocated local IP address (if PDP active)', readOnly: true, expectIp: true },

  // D. Configuration & Battery
  { id: 'D1',  cmd: 'AT+QICSGP?', desc: 'GPRS APN and user credentials query', readOnly: true },
  { id: 'D2',  cmd: 'AT+QIHEAD?', desc: 'Add IP header to received data (0/1)', readOnly: true },
  { id: 'D3',  cmd: 'AT+QISHOWRA?', desc: 'Display remote IP address on receipt (0/1)', readOnly: true },
  { id: 'D4',  cmd: 'AT+CBC',     desc: 'Battery connection and voltage (mV)', readOnly: true }
];

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class PreflightPort {
  constructor(portPath, baudRate = 9600) {
    this.portPath = portPath;
    this.baudRate = baudRate;
    this.port = null;
    this.rxBuffer = '';
    this.activeListener = null;
  }

  async open() {
    return new Promise((resolve, reject) => {
      this.port = new SerialPort({
        path: this.portPath,
        baudRate: this.baudRate,
        autoOpen: false
      });

      this.port.on('data', (chunk) => {
        const str = chunk.toString('utf8');
        this.rxBuffer += str;
        if (this.activeListener) {
          this.activeListener(str);
        }
      });

      this.port.on('error', (err) => {
        console.error(`[${this.portPath}] Serial Error:`, err.message);
      });

      this.port.open((err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  async close() {
    if (!this.port || !this.port.isOpen) return;
    return new Promise((resolve) => {
      this.port.close(() => {
        this.port = null;
        resolve();
      });
    });
  }

  async executeCommand(cmdObj, timeoutMs = 3000) {
    const { id, cmd, expectIp } = cmdObj;
    this.rxBuffer = '';
    const start = Date.now();

    return new Promise((resolve) => {
      let resolved = false;

      const finish = (status, error = null) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        this.activeListener = null;
        const duration = Date.now() - start;
        const raw = this.rxBuffer.trim();
        resolve({
          id,
          cmd,
          status,
          raw,
          duration,
          error
        });
      };

      const timer = setTimeout(() => {
        finish('TIMEOUT');
      }, timeoutMs);

      this.activeListener = () => {
        const buf = this.rxBuffer;

        // Special case for AT+QILOCIP which returns IP without OK
        if (expectIp) {
          const match = buf.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
          if (match) {
            setTimeout(() => finish('OK'), 100);
            return;
          }
        }

        // Standard terminal detection
        if (buf.includes('\r\nOK\r\n') || buf.endsWith('OK\r\n') || buf === 'OK') {
          setTimeout(() => finish('OK'), 80);
          return;
        }

        if (
          buf.includes('\r\nERROR\r\n') || buf.endsWith('ERROR\r\n') ||
          buf.includes('+CME ERROR:') || buf.includes('+CMS ERROR:')
        ) {
          setTimeout(() => finish('ERROR'), 80);
          return;
        }
      };

      // Write command with CR LF
      this.port.write(cmd + '\r\n', (err) => {
        if (err) finish('WRITE_FAIL', err.message);
      });
    });
  }
}

async function runPreflightForNode(nodeName, portPath) {
  console.log(`\n=============================================================`);
  console.log(`  STARTING PREFLIGHT: ${nodeName} on ${portPath}`);
  console.log(`=============================================================`);

  const p = new PreflightPort(portPath, 9600);
  try {
    await p.open();
    console.log(`[PASS] ${nodeName} (${portPath}) opened successfully.`);
  } catch (err) {
    console.error(`[FAIL] Could not open ${portPath}: ${err.message}`);
    return { nodeName, portPath, error: err.message, results: [] };
  }

  // Wake-up sync: send AT once and wait 300ms
  await p.executeCommand({ id: 'INIT', cmd: 'AT' }, 1500);
  await delay(300);

  const results = [];
  for (const cmdObj of COMMANDS) {
    process.stdout.write(`  Executing ${cmdObj.id.padEnd(3)}: ${cmdObj.cmd.padEnd(16)} ... `);
    const res = await p.executeCommand(cmdObj, 3500);
    const summary = res.raw.replace(/\r?\n/g, ' | ').slice(0, 60);
    console.log(`[${res.status}] (${res.duration}ms) => ${summary}`);
    results.push(res);
    await delay(200); // 200ms inter-command spacing
  }

  await p.close();
  console.log(`[PASS] ${nodeName} (${portPath}) closed cleanly.`);
  return { nodeName, portPath, results };
}

async function main() {
  console.log('BARQ LINK · Hardware Preflight Runner');
  console.log('Mode: READ-ONLY (Safe inspection of COM3 & COM4)');
  console.log('Timestamp:', new Date().toISOString());

  // 1. Run ALPHA on COM3
  const alphaResults = await runPreflightForNode('NODE ALPHA', 'COM3');
  await delay(1000);

  // 2. Run BRAVO on COM4
  const bravoResults = await runPreflightForNode('NODE BRAVO', 'COM4');

  // 3. Print Structured JSON Summary to stdout for capture
  console.log('\n--- FINAL_PREFLIGHT_RESULTS_JSON ---');
  console.log(JSON.stringify({ alpha: alphaResults, bravo: bravoResults }, null, 2));
}

main().catch(err => {
  console.error('Preflight runner failed:', err);
  process.exit(1);
});
