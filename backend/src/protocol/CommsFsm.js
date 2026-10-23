/**
 * BARQ LINK — Communications MCU state machine (JS reference for the C port).
 * Owns modem UART. Never drives power outputs.
 */

'use strict';

const STATES = {
  BOOT: 'BOOT',
  POWER_CHECK: 'POWER_CHECK',
  AT_SYNC: 'AT_SYNC',
  SIM: 'SIM',
  NET: 'NET',
  QINDI: 'QINDI',
  PDP: 'PDP',
  TCP: 'TCP',
  REGISTER: 'REGISTER',
  ONLINE: 'ONLINE',
  RECONNECT: 'RECONNECT',
  RADIO_DEGRADED: 'RADIO_DEGRADED',
  FAIL_SAFE: 'FAIL_SAFE'
};

const BOOT_SEQUENCE = [
  'AT',
  'ATE0',
  'AT+CMEE=2',
  'AT+CPIN?',
  'AT+CREG?',
  'AT+CGREG?',
  'AT+QINDI=1',
  'AT+QIFGCNT=0',
  'AT+QICSGP=1,"internet"',
  'AT+QIREGAPP',
  'AT+QIACT',
  'AT+QILOCIP'
];

function nextState(current, event) {
  const t = `${current}:${event}`;
  const map = {
    'BOOT:POWER_OK': STATES.AT_SYNC,
    'BOOT:POWER_FAIL': STATES.FAIL_SAFE,
    'AT_SYNC:AT_OK': STATES.SIM,
    'AT_SYNC:AT_FAIL': STATES.FAIL_SAFE,
    'SIM:READY': STATES.NET,
    'SIM:NOT_READY': STATES.FAIL_SAFE,
    'NET:REGISTERED': STATES.QINDI,
    'NET:SEARCHING': STATES.NET,
    'QINDI:OK': STATES.PDP,
    'QINDI:FAIL': STATES.FAIL_SAFE,
    'PDP:IP': STATES.TCP,
    'PDP:FAIL': STATES.RECONNECT,
    'TCP:CONNECT_OK': STATES.REGISTER,
    'TCP:CONNECT_FAIL': STATES.RECONNECT,
    'REGISTER:ACK': STATES.ONLINE,
    'REGISTER:TIMEOUT': STATES.RECONNECT,
    'ONLINE:TCP_CLOSED': STATES.RECONNECT,
    'ONLINE:GPRS_LOST': STATES.RADIO_DEGRADED,
    'RECONNECT:CONNECT_OK': STATES.REGISTER,
    'RADIO_DEGRADED:GPRS_OK': STATES.TCP,
    'RADIO_DEGRADED:TIMEOUT': STATES.FAIL_SAFE
  };
  return map[t] || current;
}

function qiopenCommand(ipv4, port) {
  return `AT+QIOPEN="TCP","${ipv4}",${port}`;
}

function qirdCommand(len = 512) {
  return `AT+QIRD=0,1,0,${len}`;
}

module.exports = {
  STATES,
  BOOT_SEQUENCE,
  nextState,
  qiopenCommand,
  qirdCommand
};
