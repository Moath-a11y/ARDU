#include "barq_comms.h"
#include <string.h>

barq_state_t barq_next_state(barq_state_t cur, const char *event)
{
  if (!event) return cur;
  if (cur == BARQ_BOOT && strcmp(event, "POWER_OK") == 0) return BARQ_AT_SYNC;
  if (cur == BARQ_BOOT && strcmp(event, "POWER_FAIL") == 0) return BARQ_FAIL_SAFE;
  if (cur == BARQ_AT_SYNC && strcmp(event, "AT_OK") == 0) return BARQ_SIM;
  if (cur == BARQ_SIM && strcmp(event, "READY") == 0) return BARQ_NET;
  if (cur == BARQ_NET && strcmp(event, "REGISTERED") == 0) return BARQ_QINDI;
  if (cur == BARQ_QINDI && strcmp(event, "OK") == 0) return BARQ_PDP;
  if (cur == BARQ_PDP && strcmp(event, "IP") == 0) return BARQ_TCP;
  if (cur == BARQ_TCP && strcmp(event, "CONNECT_OK") == 0) return BARQ_REGISTER;
  if (cur == BARQ_REGISTER && strcmp(event, "ACK") == 0) return BARQ_ONLINE;
  if (cur == BARQ_ONLINE && strcmp(event, "TCP_CLOSED") == 0) return BARQ_RECONNECT;
  if (cur == BARQ_ONLINE && strcmp(event, "GPRS_LOST") == 0) return BARQ_RADIO_DEGRADED;
  if (cur == BARQ_RADIO_DEGRADED && strcmp(event, "GPRS_OK") == 0) return BARQ_TCP;
  if (cur == BARQ_RECONNECT && strcmp(event, "CONNECT_OK") == 0) return BARQ_REGISTER;
  return cur;
}
