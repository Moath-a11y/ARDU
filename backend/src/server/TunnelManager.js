/**
 * BARQ LINK — Static Tunnel Manager (serveo.net SSH mode)
 *
 * Pinggy free TCP tunnels are unreachable from GPRS cellular networks.
 * This manager reads a pre-configured endpoint from pinggy_endpoint.json
 * which is populated by the external SSH serveo tunnel:
 *
 *   ssh -R 0:localhost:5050 serveo.net
 *
 * Run that command in a separate terminal before starting the server,
 * then paste the allocated port into pinggy_endpoint.json.
 */
'use strict';

const dns  = require('dns');
const fs   = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { loadFieldConfig } = require('../config/fieldConfig');

class TunnelManager extends EventEmitter {
  constructor(localPort = 5050) {
    super();
    this.localPort = localPort;
    this.currentEndpoint = null;
    this.isRunning = false;
    this.isStarting = false;
  }

  async start() {
    if (this.isRunning || this.isStarting) return this.currentEndpoint;
    this.isStarting = true;

    const field = loadFieldConfig();
    if (field.relay && field.relay.host) {
      this.currentEndpoint = {
        host: field.relay.host,
        port: field.relay.port,
        hostname: field.relay.host,
        ip: field.relay.host,
        url: `tcp://${field.relay.host}:${field.relay.port}`,
        webUrl: null,
        timestamp: new Date().toISOString(),
        source: 'static-ipv4'
      };
      this.isRunning = true;
      this.isStarting = false;
      console.log(`[TUNNEL] ✅ STATIC IPv4: ${this.currentEndpoint.host}:${this.currentEndpoint.port} (Pinggy disabled)`);
      this.emit('ready', this.currentEndpoint);
      return this.currentEndpoint;
    }

    const epFile = path.join(__dirname, '..', '..', 'pinggy_endpoint.json');

    try {
      if (!fs.existsSync(epFile)) {
        throw new Error(`Endpoint file not found: ${epFile}. Run: ssh -R 0:localhost:${this.localPort} serveo.net`);
      }

      const ep = JSON.parse(fs.readFileSync(epFile, 'utf8'));
      if (!ep.host || !ep.port) {
        throw new Error(`Invalid endpoint file — missing host or port in ${epFile}`);
      }

      const hostname = ep.host;
      const port     = Number(ep.port);

      // Resolve to numeric IP for cellular modem reliability (bypass 2G DNS timeouts)
      const resolvedIp = ep.ip || await new Promise((resolve) => {
        dns.lookup(hostname, (err, address) => resolve(err ? null : address));
      });

      this.currentEndpoint = {
        host:      resolvedIp || hostname,
        port,
        hostname,
        ip:        resolvedIp || null,
        url:       `tcp://${hostname}:${port}`,
        webUrl:    ep.webUrl || null,
        timestamp: ep.timestamp || new Date().toISOString()
      };

      this.isRunning  = true;
      this.isStarting = false;

      console.log(`[TUNNEL] ✅ LIVE TCP (serveo): tcp://${hostname}:${port} (IP: ${resolvedIp || 'N/A'})`);
      this.emit('ready', this.currentEndpoint);
      return this.currentEndpoint;

    } catch (err) {
      this.isStarting = false;
      this.isRunning  = false;
      console.warn(`[TUNNEL] ⚠️  Could not load endpoint: ${err.message}`);
      console.warn(`[TUNNEL] ⚠️  Modem relay will use fallback (localhost). Run serveo tunnel first.`);
      return null;
    }
  }

  getEndpoint() {
    return this.currentEndpoint;
  }

  async stop() {
    this.isRunning = false;
    this.isStarting = false;
  }
}

module.exports = TunnelManager;
