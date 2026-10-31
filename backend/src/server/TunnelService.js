'use strict';

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const net = require('net');
const dns = require('dns');
const path = require('path');

const BACKEND = path.resolve(__dirname, '..', '..');
const ROOT = path.resolve(BACKEND, '..');
const EP_FILE = path.join(BACKEND, 'pinggy_endpoint.json');
const SCRIPT = path.join(BACKEND, 'start_pinggy_sdk_tunnel.js');
const CLI = path.join(ROOT, 'tools', 'arduino-cli.exe');
const CFG = path.join(ROOT, 'tools', 'arduino-data', 'arduino-cli.yaml');
const SKETCH = path.join(ROOT, 'firmware', 'arduino_led_gprs');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function readEndpoint() {
  try {
    return JSON.parse(fs.readFileSync(EP_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function probeTcp(host, port, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const t = setTimeout(() => { sock.destroy(); resolve(false); }, timeoutMs);
    sock.on('connect', () => { clearTimeout(t); sock.destroy(); resolve(true); });
    sock.on('error', () => { clearTimeout(t); resolve(false); });
  });
}

function run(file, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(out.slice(-800) || ('exit ' + code)));
    });
  });
}

const CHILD_PID_FILE = path.join(BACKEND, 'logs', 'tunnel-child.pid');

function pidsForTunnel() {
  return new Promise((resolve) => {
    // كتابة السكريبت لملف مؤقت تتجنب مشكلة الـ quoting
    const ps1 = path.join(BACKEND, 'logs', '_find_tunnel.ps1');
    const script = [
      '$result = @()',
      '$procs = Get-CimInstance Win32_Process -Filter \'Name="node.exe"\' -ErrorAction SilentlyContinue',
      'foreach ($p in $procs) {',
      '  if ($p.CommandLine -match \'start_pinggy_sdk_tunnel|start_serveo_tunnel\') {',
      '    $result += $p.ProcessId',
      '  }',
      '}',
      'if ($result.Count -gt 0) { $result -join \'\n\' }'
    ].join('\r\n');
    try { fs.mkdirSync(path.dirname(ps1), { recursive: true }); } catch (_) {}
    fs.writeFileSync(ps1, script, 'utf8');
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1],
      { windowsHide: true, timeout: 8000 },
      (err, stdout) => {
        const ids = String(stdout || '').split(/\s+/)
          .map((s) => parseInt(s, 10)).filter((n) => n > 0);
        // إضافة PID من ملف التتبع إذا وُجد
        try {
          const filePid = parseInt(fs.readFileSync(CHILD_PID_FILE, 'utf8').trim(), 10);
          if (filePid > 0 && !ids.includes(filePid)) ids.push(filePid);
        } catch (_) {}
        resolve(ids);
      }
    );
  });
}

class TunnelService {
  constructor() {
    this.child = null;
  }

  async killOld() {
    const ids = await pidsForTunnel();
    console.log('[TunnelService] killOld: وجدنا PIDs للنفق:', ids);
    for (const id of ids) {
      await new Promise((resolve) => {
        execFile('taskkill', ['/PID', String(id), '/F', '/T'], (e, o) => {
          console.log(`[TunnelService] taskkill PID ${id}:`, o ? o.trim() : (e && e.message));
          resolve();
        });
      });
    }
    if (this.child && !this.child.killed) {
      try { this.child.kill('SIGKILL'); } catch (_) {}
    }
    this.child = null;
    // امسح ملف الـ PID
    try { fs.unlinkSync(CHILD_PID_FILE); } catch (_) {}
    // انتظر تحرير المنافذ
    await sleep(1500);
  }

  async startTunnel(prevTs) {
    await this.killOld();
    const logDir = path.join(BACKEND, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const log = fs.openSync(path.join(logDir, 'tunnel-child.log'), 'a');
    this.child = spawn(process.execPath, [SCRIPT], {
      cwd: BACKEND,
      windowsHide: true,
      stdio: ['ignore', log, log]
    });
    // احفظ PID الطفل لضمان قدرتنا على قتله لاحقاً
    if (this.child.pid) {
      try { fs.writeFileSync(CHILD_PID_FILE, String(this.child.pid), 'utf8'); } catch (_) {}
    }
    this.child.on('exit', () => {
      this.child = null;
      try { fs.unlinkSync(CHILD_PID_FILE); } catch (_) {}
    });

    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      await sleep(900);
      const ep = readEndpoint();
      if (!ep || !ep.port) continue;
      if (prevTs && ep.timestamp === prevTs) continue;

      const port = Number(ep.port);
      // حاول تحويل الـ hostname لـ IP رقمي أولاً
      let numericIp = ep.ip;
      if (!numericIp || !/^\d+\.\d+\.\d+\.\d+$/.test(numericIp)) {
        numericIp = await new Promise((resolve) => {
          dns.lookup(ep.host || ep.ip, { family: 4 }, (err, addr) => resolve(err ? null : addr));
        });
      }

      // تحقق من الاتصال: IP رقمي أولاً، ثم hostname احتياطياً
      if (numericIp && await probeTcp(numericIp, port, 7000)) {
        // احفظ الـ IP الرقمي في الـ endpoint
        if (numericIp !== ep.ip) {
          ep.ip = numericIp;
          fs.writeFileSync(EP_FILE, JSON.stringify(ep, null, 2));
        }
        return ep;
      }
      if (ep.host && await probeTcp(ep.host, port, 7000)) return ep;
    }
    throw new Error('النفق ما فتح خلال 60 ثانية');
  }

  patchSketch(hostOrIp, port) {
    const inoPath = path.join(SKETCH, 'arduino_led_gprs.ino');
    if (!fs.existsSync(inoPath)) return;
    let code = fs.readFileSync(inoPath, 'utf8');
    code = code.replace(/const char SERVER_HOST\[\] PROGMEM = "[^"]*";/, `const char SERVER_HOST[] PROGMEM = "${hostOrIp}";`);
    code = code.replace(/const uint16_t SERVER_PORT = \d+;/, `const uint16_t SERVER_PORT = ${port};`);
    fs.writeFileSync(inoPath, code, 'utf8');
    console.log(`[TunnelService] Updated sketch with ${hostOrIp}:${port}`);
  }

  async uploadFirmware(endpoint) {
    if (!fs.existsSync(CLI)) throw new Error('arduino-cli غير موجود');
    const ep = endpoint || readEndpoint();
    if (ep && (ep.ip || ep.host) && ep.port) {
      this.patchSketch(ep.ip || ep.host, Number(ep.port));
    }
    await run(CLI, ['--config-file', CFG, 'compile', '--fqbn', 'arduino:avr:uno', SKETCH], ROOT);
    await run(CLI, ['--config-file', CFG, 'upload', '-p', 'COM4', '--fqbn', 'arduino:avr:uno', SKETCH], ROOT);
  }

  async renew(usb) {
    // منع التشغيل المتزامن
    if (this._renewing) {
      throw new Error('تجديد النفق قيد التنفيذ بالفعل — انتظر...');
    }
    this._renewing = true;
    try {
      const prev = readEndpoint();
      const prevTs = prev && prev.timestamp;
      if (usb && typeof usb.close === 'function') {
        try { await usb.close(); } catch (_) {}
        await sleep(400);
      }
      await this.killOld();
      const ep = await this.startTunnel(prevTs);
      let uploaded = false;
      let uploadError = null;
      try {
        await this.uploadFirmware(ep);
        uploaded = true;
      } catch (err) {
        uploadError = err.message;
      }
      if (usb && typeof usb.ensureOpen === 'function') {
        try { await usb.ensureOpen(); } catch (_) {}
      }
      return {
        ok: true,
        ip: ep.ip || ep.host,
        port: ep.port,
        uploaded,
        uploadError,
        endpoint: ep
      };
    } finally {
      this._renewing = false;
    }
  }
}

module.exports = TunnelService;
