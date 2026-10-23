/**
 * BARQ LINK — Autonomous Tunnel Manager (Pinggy SDK Mode)
 * Automatically establishes, monitors, and maintains a public TCP tunnel
 * forwarding to local RelayServer port 5050.
 */
'use strict';

const { pinggy, TunnelType } = require('@pinggy/pinggy');
const net = require('net');
const dns = require('dns');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

class TunnelManager extends EventEmitter {
  constructor(localPort = 5050) {
    super();
    this.localPort = localPort;
    this.tunnel = null;
    this.currentEndpoint = null;
    this.isRunning = false;
    this.isStarting = false;
    this.reconnectTimer = null;
  }

  async start() {
    if (this.isRunning || this.isStarting) return this.currentEndpoint;
    this.isStarting = true;

    try {
      console.log(`[TUNNEL] Establishing Pinggy dual tunnel (TCP 127.0.0.1:${this.localPort} + HTTP 127.0.0.1:4000)...`);

      this.tunnel = await pinggy.createTunnel({
        forwarding: [
          { address: `localhost:${this.localPort}`, type: TunnelType.Tcp },
          { address: 'localhost:4000', type: TunnelType.Http }
        ]
      });

      await this.tunnel.start();

      const urls = await this.tunnel.urls();
      const tcpUrl = urls && urls.find(u => u.startsWith('tcp://'));
      const webUrl = urls && (urls.find(u => u.startsWith('https://')) || urls.find(u => u.startsWith('http://')));
      if (!tcpUrl) {
        throw new Error(`No tcp:// URL found in: ${JSON.stringify(urls)}`);
      }

      const stripped = tcpUrl.replace('tcp://', '');
      const colonIdx = stripped.lastIndexOf(':');
      const pubHost = stripped.slice(0, colonIdx);
      const pubPort = parseInt(stripped.slice(colonIdx + 1), 10);

      // Resolve DNS to direct IP for cellular modem 2G reliability
      const resolvedIp = await new Promise((resolve) => {
        dns.lookup(pubHost, (err, address) => {
          if (!err && address) resolve(address);
          else resolve(null);
        });
      });

      this.currentEndpoint = {
        host: resolvedIp || pubHost,
        port: pubPort,
        hostname: pubHost,
        ip: resolvedIp || null,
        url: tcpUrl,
        webUrl: webUrl || null,
        timestamp: new Date().toISOString()
      };

      this.isRunning = true;
      this.isStarting = false;

      // Persist to files for backward-compatibility with standalone scripts
      this._saveEndpoints();

      console.log(`[TUNNEL] ✅ LIVE TCP: ${tcpUrl} (IP: ${resolvedIp || 'N/A'})`);
      if (webUrl) {
        console.log(`[TUNNEL] 🌐 LIVE WEB: ${webUrl}`);
      }
      this.emit('ready', this.currentEndpoint);

      return this.currentEndpoint;

    } catch (err) {
      this.isStarting = false;
      this.isRunning = false;
      console.error(`[TUNNEL] ❌ Failed to start: ${err.message}`);
      this._scheduleReconnect();
      return null;
    }
  }

  _saveEndpoints() {
    if (!this.currentEndpoint) return;
    try {
      const epFile = path.join(__dirname, '..', '..', 'pinggy_endpoint.json');
      const reachFile = path.join(__dirname, '..', '..', 'relay_reachability.json');

      fs.writeFileSync(epFile, JSON.stringify({
        host: this.currentEndpoint.hostname,
        port: this.currentEndpoint.port,
        url: this.currentEndpoint.url,
        webUrl: this.currentEndpoint.webUrl,
        ip: this.currentEndpoint.ip,
        timestamp: this.currentEndpoint.timestamp
      }, null, 2));

      fs.writeFileSync(reachFile, JSON.stringify({
        endpoint: {
          host: this.currentEndpoint.hostname,
          port: this.currentEndpoint.port,
          url: this.currentEndpoint.url,
          webUrl: this.currentEndpoint.webUrl,
          timestamp: this.currentEndpoint.timestamp
        },
        ips: this.currentEndpoint.ip ? [this.currentEndpoint.ip] : [],
        viaIp: {
          label: 'TUNNEL_IP',
          host: this.currentEndpoint.ip || this.currentEndpoint.hostname,
          port: this.currentEndpoint.port,
          ok: true
        },
        webUrl: this.currentEndpoint.webUrl,
        verifiedAt: this.currentEndpoint.timestamp
      }, null, 2));
    } catch (e) {
      console.warn(`[TUNNEL] Warning: Failed to save endpoint files: ${e.message}`);
    }
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      console.log('[TUNNEL] Attempting to reconnect tunnel...');
      await this.start();
    }, 10000);
  }

  getEndpoint() {
    return this.currentEndpoint;
  }

  async stop() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.tunnel) {
      try {
        await this.tunnel.stop();
      } catch (_) {}
      this.tunnel = null;
    }
    this.isRunning = false;
    this.isStarting = false;
  }
}

module.exports = TunnelManager;
