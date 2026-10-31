/**
 * BARQ LINK — AT Parser & Response Handler (Extended for Stage 3 TCP/IP + Stage 5 Relay)
 * Handles Quectel M25 command responses, prompt detection ('>' without newline),
 * multiline responses, IP address output without OK, TCP/IP URCs,
 * and binary-safe AT+QIRD data reading (payload may contain CR/LF).
 *
 * QIRD state machine (new in Stage 5):
 *   IDLE         — normal command/URC processing
 *   QIRD_HEADER  — currentPending.expectQird set; waiting for "+QIRD: <len>" line
 *   QIRD_READING — reading exactly <len> raw bytes (line-split disabled)
 *   → resolve pending only after full <len> bytes + trailing OK consumed
 */

class ATParser {
  constructor(options = {}) {
    this.onURC = options.onURC || (() => {});
    this.onRawData = options.onRawData || (() => {});
    this.rxBuffer = '';
    this._rawBuf = Buffer.alloc(0);
    this.currentPending = null;

    // ── QIRD binary-safe read state ────────────────────────────
    this._qirdReading  = false;  // true while consuming raw payload bytes
    this._qirdExpected = 0;      // byte count declared in +QIRD: <n>
    this._qirdBuf      = '';     // current binary payload snapshot (string form) for debug/regression checks
  }

  /**
   * Helper to locate \r\n or \n inside a Buffer without converting the entire Buffer to string.
   */
  _findNewline(buf) {
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x0A) { // \n
        if (i > 0 && buf[i - 1] === 0x0D) { // \r\n
          return { start: i - 1, end: i + 1 };
        }
        return { start: i, end: i + 1 };
      }
    }
    return null;
  }

  /**
   * Feed incoming raw string or Buffer data from the serial transport.
   * Maintains a binary Buffer to prevent UTF-8 multibyte character splitting.
   */
  feed(chunk) {
    if (!chunk || chunk.length === 0) return;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    this._rawBuf = Buffer.concat([this._rawBuf, buf]);

    this._consumeBuffer();
  }

  _consumeBuffer() {
    // ── 1. QIRD binary-safe reading mode ───────────────────────
    if (this._qirdReading) {
      this._tryFlushQird();
      return;
    }

    // ── 2. Prompt detection ('>' without newline) ─────────────
    if (this.currentPending && this.currentPending.expectPrompt) {
      const promptIdx = this._rawBuf.indexOf(0x3E); // ASCII '>'
      if (promptIdx !== -1) {
        const pending = this.currentPending;
        this.currentPending = null;
        clearTimeout(pending.timer);

        const consumed = this._rawBuf.subarray(0, promptIdx + 1).toString('utf8');
        this._rawBuf = this._rawBuf.subarray(promptIdx + 1);

        this.onRawData(consumed);
        pending.resolve({
          success: true,
          isPrompt: true,
          raw: consumed,
          lines: []
        });
        this._consumeBuffer();
        return;
      }
    }

    // ── 3. QIRD header check ───────────────────────────────────
    if (this.currentPending && this.currentPending.expectQird) {
      if (this._tryBeginQirdRead()) return;
    }

    // ── 4. Normal line processing ──────────────────────────────
    let nl;
    while ((nl = this._findNewline(this._rawBuf)) !== null) {
      if (this.currentPending && this.currentPending.expectQird) {
        if (this._tryBeginQirdRead()) return;
      }

      const lineBuf = this._rawBuf.subarray(0, nl.start);
      this._rawBuf = this._rawBuf.subarray(nl.end);

      const lineStr = lineBuf.toString('utf8').trim();
      if (lineStr) {
        this.onRawData(lineStr);
        this._processLine(lineStr);
      }
    }
  }

  // ──────────────────────────────────────────────────────────────
  //  QIRD binary payload consumer
  // ──────────────────────────────────────────────────────────────

  /**
   * Parses declared data length from QIRD header
   */
  static parseQirdDataLength(headerLine) {
    const rest = String(headerLine).replace(/^\+QIRD:/i, '').trim();
    if (!rest) return NaN;
    if (/^\d+$/.test(rest)) return parseInt(rest, 10);
    const parts = rest.split(',');
    const last = (parts[parts.length - 1] || '').trim();
    if (/^\d+$/.test(last)) return parseInt(last, 10);
    return NaN;
  }

  /**
   * If a complete +QIRD: header line is in _rawBuf, switch to binary-safe
   * payload collection using the declared byte length.
   */
  _tryBeginQirdRead() {
    const qirdTag = Buffer.from('+QIRD:');
    const idx = this._rawBuf.indexOf(qirdTag);
    if (idx === -1) return false;

    const fromHeader = this._rawBuf.subarray(idx);
    const nl = this._findNewline(fromHeader);
    if (!nl) return false;

    const headerLine = fromHeader.subarray(0, nl.start).toString('utf8').trim();
    const dataLen = ATParser.parseQirdDataLength(headerLine);
    if (isNaN(dataLen) || dataLen < 0) return false;

    const before = this._rawBuf.subarray(0, idx);
    if (before.length > 0) {
      const beforeStr = before.toString('utf8');
      const lines = beforeStr.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line) {
          this.onRawData(line);
          this._processLine(line);
        }
      }
    }

    if (this.currentPending) this.currentPending.lines.push(headerLine);
    this.onRawData(headerLine);

    this._qirdExpected = dataLen;
    this._qirdBuf = '';
    this._qirdReading = true;
    this._rawBuf = fromHeader.subarray(nl.end);

    this._tryFlushQird();
    return true;
  }

  _tryFlushQird() {
    // Need at least <expectedLen> exact raw bytes before trailer
    if (this._rawBuf.length < this._qirdExpected) {
      this._qirdBuf = this._rawBuf.toString('utf8');
      return;
    }

    const payloadBytes = this._rawBuf.subarray(0, this._qirdExpected);
    this._qirdBuf = payloadBytes.toString('utf8');
    const trailerBytes = this._rawBuf.subarray(this._qirdExpected);

    const okTag = Buffer.from('OK');
    const okIdx = trailerBytes.indexOf(okTag);

    if (okIdx === -1) {
      if (trailerBytes.length <= 30) return;
      // Forced resolution if trailer is unreasonably long
      const dataStr = payloadBytes.toString('utf8');
      this._rawBuf = trailerBytes;
      this._resolveQird(dataStr);
      return;
    }

    // Skip 'OK' and trailing \r\n if present
    let afterOk = trailerBytes.subarray(okIdx + 2);
    if (afterOk.length >= 2 && afterOk[0] === 0x0D && afterOk[1] === 0x0A) {
      afterOk = afterOk.subarray(2);
    } else if (afterOk.length >= 1 && afterOk[0] === 0x0A) {
      afterOk = afterOk.subarray(1);
    }

    const dataStr = payloadBytes.toString('utf8');
    this._rawBuf = afterOk;
    this._resolveQird(dataStr);
  }

  _resolveQird(data) {
    if (!this.currentPending) {
      this._qirdReading  = false;
      this._qirdExpected = 0;
      this._qirdBuf      = '';
      this._consumeBuffer();
      return;
    }

    const pending      = this.currentPending;
    const len          = this._qirdExpected;
    this._qirdReading  = false;
    this._qirdExpected = 0;
    this._qirdBuf      = '';
    this.currentPending = null;
    clearTimeout(pending.timer);

    pending.resolve({ success: true, data, len, isQird: true });

    if (this._rawBuf.length > 0) {
      this._consumeBuffer();
    }
  }

  // ──────────────────────────────────────────────────────────────
  //  Line dispatcher
  // ──────────────────────────────────────────────────────────────

  _processLine(line) {
    if (this.currentPending) {
      this.currentPending.lines.push(line);

      // ── CONNECT OK / FAIL ─────────────────────────────────
      if (line === 'CONNECT OK' || line === 'CONNECT FAIL' || line === 'ALREADY CONNECT') {
        if (this.currentPending.expectConnect) {
          const pending = this.currentPending;
          this.currentPending = null;
          clearTimeout(pending.timer);
          if (line === 'CONNECT OK') {
            pending.resolve({ success: true, lines: pending.lines, raw: line });
          } else {
            pending.reject(new Error(line));
          }
          return;
        }
      }

      // ── OK ────────────────────────────────────────────────
      if (line === 'OK') {
        if (this.currentPending.expectConnect) return; // wait for async CONNECT OK
        const pending = this.currentPending;
        this.currentPending = null;
        clearTimeout(pending.timer);
        // M25 AT manual: QIRD may reply with only OK when the socket buffer is empty.
        if (pending.expectQird) {
          pending.resolve({ success: true, data: '', len: 0, isQird: true, raw: 'OK' });
          return;
        }
        pending.resolve({
          success: true,
          lines: pending.lines,
          raw: pending.lines.join('\r\n')
        });
        return;
      }

      // ── SEND OK ───────────────────────────────────────────
      if (line === 'SEND OK') {
        const pending = this.currentPending;
        this.currentPending = null;
        clearTimeout(pending.timer);
        pending.resolve({ success: true, lines: pending.lines, raw: line });
        return;
      }

      // ── CLOSE OK ──────────────────────────────────────────
      if (line === 'CLOSE OK') {
        const pending = this.currentPending;
        this.currentPending = null;
        clearTimeout(pending.timer);
        pending.resolve({ success: true, lines: pending.lines, raw: line });
        return;
      }

      // ── DEACT OK ──────────────────────────────────────────
      if (line === 'DEACT OK') {
        const pending = this.currentPending;
        this.currentPending = null;
        clearTimeout(pending.timer);
        pending.resolve({ success: true, lines: pending.lines, raw: line });
        return;
      }

      // ── AT+QILOCIP: IP without OK ─────────────────────────
      if (this.currentPending.expectIp && /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(line)) {
        const pending = this.currentPending;
        this.currentPending = null;
        clearTimeout(pending.timer);
        pending.resolve({ success: true, ip: line, lines: [line], raw: line });
        return;
      }

      // ── Errors ────────────────────────────────────────────
      if (
        line === 'ERROR' ||
        line === 'SEND FAIL' ||
        line.startsWith('+CME ERROR:') ||
        line.startsWith('+CMS ERROR:')
      ) {
        const pending = this.currentPending;
        this.currentPending = null;
        clearTimeout(pending.timer);
        pending.reject(new Error(line));
        return;
      }
    }

    // Not consumed as a terminal — inspect as URC
    this._inspectURC(line);
  }

  _inspectURC(line) {
    if (line.startsWith('+CPIN:')) {
      const isReady = line.includes('READY');
      this.onURC('CPIN', { raw: line, ready: isReady, status: isReady ? 'READY' : line.replace('+CPIN:', '').trim() });

    } else if (line.startsWith('+CSQ:')) {
      const parts = line.replace('+CSQ:', '').trim().split(',');
      const rssi  = parseInt(parts[0], 10);
      const ber   = parseInt(parts[1] || '99', 10);
      this.onURC('CSQ', { raw: line, rssi, ber, signalPct: rssi === 99 ? 0 : Math.round((rssi / 31) * 100) });

    } else if (line.startsWith('+CREG:')) {
      const parts = line.replace('+CREG:', '').trim().split(',');
      const stat  = parseInt(parts.length > 1 ? parts[1] : parts[0], 10);
      this.onURC('CREG', { raw: line, stat, registered: stat === 1 || stat === 5, searching: stat === 2 });

    } else if (line.startsWith('+CGREG:')) {
      const parts = line.replace('+CGREG:', '').trim().split(',');
      const stat  = parseInt(parts.length > 1 ? parts[1] : parts[0], 10);
      this.onURC('CGREG', { raw: line, stat, registered: stat === 1 || stat === 5, searching: stat === 2 });

    } else if (line.startsWith('+CGATT:')) {
      const parts   = line.replace('+CGATT:', '').trim().split(':');
      const attached = parseInt(parts[1] || parts[0], 10) === 1;
      this.onURC('CGATT', { raw: line, attached });

    } else if (line.startsWith('STATE:')) {
      const state = line.replace('STATE:', '').trim();
      this.onURC('TCP_STATE', { raw: line, state });

    } else if (line === 'RING') {
      this.onURC('RING', { raw: line });

    } else if (line.startsWith('+CLIP:')) {
      this.onURC('CLIP', { raw: line });

    } else if (line === 'CLOSED' || line === '+PDP: DEACT') {
      this.onURC('DISCONNECT', { raw: line, type: line });

    } else if (line.startsWith('+QIRDI:')) {
      // ── TCP data ready notification (M25 buffer-access mode) ─
      // Format in QINDI=1: +QIRDI: <id>,<sc>,<sid> (3 fields, no byte count)
      // Format in QINDI=2: +QIRDI: <id>,<sc>,<sid>,<num>,<len>,<tlen> (6 fields)
      // Format in legacy:  +QIRDI: <connectID>,<datalen> (2 fields)
      const parts = line.replace('+QIRDI:', '').trim().split(',');
      let len = null;
      if (parts.length >= 6) {
        // QINDI=2: 5th field is <len>
        const parsed = parseInt(parts[4], 10);
        len = isNaN(parsed) ? null : parsed;
      } else if (parts.length === 2) {
        const parsed = parseInt(parts[1], 10);
        len = isNaN(parsed) ? null : parsed;
      }
      // If len is null (QINDI=1), GprsRelayClient will read up to QIRD_MAX_READ
      this.onURC('TCP_DATA_READY', { raw: line, len });

    } else {
      this.onURC('RAW_URC', { raw: line });
    }
  }

  // ──────────────────────────────────────────────────────────────
  //  Public command registration
  // ──────────────────────────────────────────────────────────────

  /**
   * Set the in-flight command expectation.
   * options.expectQird = true  → activates binary-safe QIRD read mode
   */
  setPending(resolve, reject, options = {}) {
    const timeoutMs = options.timeoutMs || 5000;
    const timer = setTimeout(() => {
      if (this.currentPending) {
        const pending = this.currentPending;
        // Clean up QIRD state if a read was in progress during timeout
        if (this._qirdReading) {
          this._qirdReading  = false;
          this._qirdBuf      = '';
          this._qirdExpected = 0;
        }
        this.currentPending = null;
        pending.reject(new Error(`COMMAND_TIMEOUT_${timeoutMs}MS`));
      }
    }, timeoutMs);

    if (this.currentPending) {
      clearTimeout(this.currentPending.timer);
      this.currentPending = null;
    }
    this._qirdReading  = false;
    this._qirdBuf      = '';
    this._qirdExpected = 0;

    this.currentPending = {
      resolve,
      reject,
      timer,
      lines: [],
      expectPrompt:  !!options.expectPrompt,
      expectConnect: !!options.expectConnect,
      expectIp:      !!options.expectIp,
      expectQird:    !!options.expectQird
    };
  }

  /**
   * Drop UART/QIRD residue after a timeout without emitting PARSER_RESET.
   * The timed-out command already rejected.
   */
  clearBuffers() {
    this._qirdReading  = false;
    this._qirdExpected = 0;
    this._qirdBuf      = '';
    this._rawBuf       = Buffer.alloc(0);
    this.rxBuffer      = '';
    if (this.currentPending) {
      clearTimeout(this.currentPending.timer);
      this.currentPending = null;
    }
  }

  reset() {
    if (this.currentPending) {
      clearTimeout(this.currentPending.timer);
      const pending = this.currentPending;
      this.currentPending = null;
      try {
        pending.reject(new Error('PARSER_RESET'));
      } catch (_) {}
    }
    // Reset QIRD state too
    this._qirdReading  = false;
    this._qirdExpected = 0;
    this._qirdBuf      = '';
    this._rawBuf       = Buffer.alloc(0);
    this.rxBuffer      = '';
  }
}

module.exports = ATParser;
