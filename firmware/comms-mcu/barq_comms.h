#ifndef BARQ_COMMS_H
#define BARQ_COMMS_H

#include <stdint.h>

/* Communications MCU owns modem UART. Never drives power outputs. */

typedef enum {
  BARQ_BOOT = 0,
  BARQ_AT_SYNC,
  BARQ_SIM,
  BARQ_NET,
  BARQ_QINDI,
  BARQ_PDP,
  BARQ_TCP,
  BARQ_REGISTER,
  BARQ_ONLINE,
  BARQ_RECONNECT,
  BARQ_RADIO_DEGRADED,
  BARQ_FAIL_SAFE
} barq_state_t;

#define BARQ_QIOPEN_FMT   "AT+QIOPEN=\"TCP\",\"%u.%u.%u.%u\",%u"
#define BARQ_QIRD_CMD     "AT+QIRD=0,1,0,512"
#define BARQ_QINDI_CMD    "AT+QINDI=1"
#define BARQ_PROTOCOL     "BARQ-RELAY-v1"

typedef struct {
  uint8_t ip[4];
  uint16_t port;
  const char *device_id;
  const char *apn;
} barq_relay_cfg_t;

barq_state_t barq_next_state(barq_state_t cur, const char *event);

#endif
