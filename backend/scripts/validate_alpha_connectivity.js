/**
 * BARQ LINK — Hardware Connectivity Validation: NODE ALPHA (COM3)
 * Target: COM3 @ 9600 Baud, 8N1
 * Scope: Strictly READ-ONLY Identification, SIM, Signal, Network & Voltage Checks
 * Constraints:
 *  - DO NOT open COM4
 *  - DO NOT activate GPRS/PDP (no AT+QIACT, no AT+QIREGAPP)
 *  - DO NOT open TCP (no AT+QIOPEN)
 *  - Guaranteed serial port closure on completion or error
 */

const { SerialPort } = require('serialport');

const PORT_PATH = 'COM3';
const BAUD_RATE = 9600;

const VALIDATION_COMMANDS = [
  { id: 'VAL-01', cmd: 'AT',        desc: 'Basic AT responsiveness', timeoutMs: 2000 },
  { id: 'VAL-02', cmd: 'ATE0',      desc: 'Disable echo for clean parsing', timeoutMs: 2000 },
  { id: 'VAL-03', cmd: 'AT+CMEE=2', desc: 'Enable verbose error reporting', timeoutMs: 2000 },
  { id: 'VAL-04', cmd: 'ATI',       desc: 'Product Identification & Quectel model', timeoutMs: 2000 },
  { id: 'VAL-05', cmd: 'AT+CGMR',   desc: 'Firmware revision confirmation', timeoutMs: 2000 },
  { id: 'VAL-06', cmd: 'AT+CPIN?',  desc: 'SIM card readiness status', timeoutMs: 2500 },
  { id: 'VAL-07', cmd: 'AT+CSQ',    desc: 'Signal quality (RSSI & BER)', timeoutMs: 2000 },
  { id: 'VAL-08', cmd: 'AT+CREG?',  desc: 'GSM network registration check', timeoutMs: 2500 },
  { id: 'VAL-09', cmd: 'AT+CGREG?', desc: 'GPRS packet network registration check', timeoutMs: 2500 },
  { id: 'VAL-10', cmd: 'AT+CGATT?', desc: 'Packet attachment state query (read-only)', timeoutMs: 2500 },
  { id: 'VAL-11', cmd: 'AT+COPS?',  desc: 'Current cellular network operator query', timeoutMs: 4000 },
  { id: 'VAL-12', cmd: 'AT+CBC',    desc: 'Module battery supply voltage (mV)', timeoutMs: 2000 },
  { id: 'VAL-13', cmd: 'AT+QISTAT', desc: 'TCP protocol state query (must be IP INITIAL)', timeoutMs: 2000 }
];

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class AlphaValidator {
  constructor(portPath, baudRate) {
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
        const text = chunk.toString('utf8');
        this.rxBuffer += text;
        if (this.activeListener) {
          this.activeListener(text);
        }
      });

      this.port.on('error', (err) => {
        console.error(`[SERIAL ERROR] ${err.message}`);
      });

      this.port.open((err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  async close() {
    if (!this.port) return;
    return new Promise((resolve) => {
      if (this.port.isOpen) {
        this.port.close(() => {
          this.port = null;
          resolve();
        });
      } else {
        this.port = null;
        resolve();
      }
    });
  }

  async send(cmdObj) {
    const { id, cmd, timeoutMs = 2500 } = cmdObj;
    this.rxBuffer = '';
    const start = Date.now();

    return new Promise((resolve) => {
      let settled = false;

      const finish = (status, error = null) => {
        if (settled) return;
        settled = true;
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
        finish('TIMEOUT', `No response within ${timeoutMs}ms`);
      }, timeoutMs);

      this.activeListener = () => {
        const buf = this.rxBuffer;
        if (buf.includes('\r\nOK\r\n') || buf.endsWith('OK\r\n') || buf === 'OK') {
          setTimeout(() => finish('OK'), 80);
          return;
        }
        if (
          buf.includes('\r\nERROR\r\n') || buf.endsWith('ERROR\r\n') ||
          buf.includes('+CME ERROR:') || buf.includes('+CMS ERROR:')
        ) {
          setTimeout(() => finish('ERROR', buf), 80);
          return;
        }
      };

      this.port.write(cmd + '\r\n', (err) => {
        if (err) finish('WRITE_FAIL', err.message);
      });
    });
  }
}

async function run() {
  console.log('================================================================');
  console.log('  BARQ LINK · PHASE 1: HARDWARE CONNECTIVITY VALIDATION (ALPHA)');
  console.log(`  Target Port: ${PORT_PATH} @ ${BAUD_RATE} Baud, 8N1`);
  console.log('  Scope: Strictly Isolated ALPHA Validation (COM4 Unopened)');
  console.log('  Mode: Read-Only Identification, Signal & Registration (No GPRS/TCP)');
  console.log(`  Timestamp: ${new Date().toISOString()}`);
  console.log('================================================================\n');

  const validator = new AlphaValidator(PORT_PATH, BAUD_RATE);
  const results = [];
  let portOpened = false;

  // Emergency safety handlers
  const cleanup = async () => {
    try {
      await validator.close();
      console.log(`[SAFETY] ${PORT_PATH} confirmed CLOSED.`);
    } catch (_) {}
  };
  process.on('SIGINT', async () => { await cleanup(); process.exit(1); });
  process.on('SIGTERM', async () => { await cleanup(); process.exit(1); });

  try {
    process.stdout.write(`[PORT] Opening ${PORT_PATH} ... `);
    await validator.open();
    portOpened = true;
    console.log('OPENED SUCCESSFULLY ✅');

    // Wakeup sync (send AT once to synchronize autobauding)
    await validator.send({ id: 'SYNC', cmd: 'AT', timeoutMs: 1500 });
    await delay(200);

    for (const cmdObj of VALIDATION_COMMANDS) {
      process.stdout.write(`  [${cmdObj.id}] ${cmdObj.cmd.padEnd(14)} (${cmdObj.desc}) ... `);
      const res = await validator.send(cmdObj);
      results.push(res);

      if (res.status === 'OK') {
        const compactRaw = res.raw.replace(/\r?\n/g, ' ⏎ ');
        console.log(`PASS ✅ (${res.duration}ms) => ${compactRaw}`);
      } else {
        console.log(`FAIL ❌ (${res.status}) => ${res.raw || res.error}`);
        console.error(`\n[ABORT] Step ${cmdObj.id} failed. Stopping immediately per safety protocol.`);
        break;
      }
      await delay(150);
    }

  } catch (err) {
    console.error(`[EXCEPTION] ${err.message}`);
  } finally {
    process.stdout.write(`\n[PORT] Closing ${PORT_PATH} ... `);
    await validator.close();
    console.log('CLOSED CLEANLY ✅\n');
  }

  // Print structured JSON evidence
  console.log('--- ALPHA_CONNECTIVITY_EVIDENCE_JSON ---');
  console.log(JSON.stringify({
    nodeId: 'ALPHA',
    port: PORT_PATH,
    baudRate: BAUD_RATE,
    timestamp: new Date().toISOString(),
    results
  }, null, 2));
}

run().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
