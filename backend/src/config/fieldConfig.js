/**
 * BARQ LINK — Field / lab runtime configuration.
 *
 * Production (autonomous RTUs) uses a static IPv4 relay endpoint.
 * Pinggy is lab-only and must be opted in with BARQ_ENABLE_PINGGY=1.
 */

'use strict';

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

function isIPv4(value) {
  return IPV4_RE.test(String(value || '').trim());
}

function envFlag(name, defaultOn) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultOn;
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function loadFieldConfig(env = process.env) {
  const mode = (env.BARQ_MODE || 'field').toLowerCase() === 'lab' ? 'lab' : 'field';
  const host = String(env.BARQ_RELAY_HOST || '').trim();
  const port = Number(env.BARQ_RELAY_PORT || 5050);
  const enablePinggy = envFlag('BARQ_ENABLE_PINGGY', false);
  const enableUsb = envFlag('BARQ_ENABLE_USB', mode === 'lab');

  const staticRelay = isIPv4(host) && Number.isInteger(port) && port > 0 && port < 65536
    ? { host, port, source: 'static-ipv4' }
    : null;

  return {
    mode,
    relay: staticRelay,
    enablePinggy: enablePinggy && !staticRelay,
    enableUsbHardware: enableUsb,
    requireIpv4ForModem: true,
    apn: env.BARQ_APN || 'internet',
    failSafeMs: Number(env.BARQ_FAILSAFE_MS || 15000),
    armWindowMs: Number(env.BARQ_ARM_WINDOW_MS || 30000),
    conflictWindowMs: Number(env.BARQ_CONFLICT_WINDOW_MS || 2000)
  };
}

function assertModemHost(host) {
  if (!isIPv4(host)) {
    throw new Error(`MODEM_HOST_MUST_BE_IPV4:${host}`);
  }
  return host;
}

module.exports = {
  isIPv4,
  loadFieldConfig,
  assertModemHost
};
