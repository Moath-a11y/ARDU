/*
 * BARQ LINK communications MCU entry (STM32 / PIC32 / ESP32-S3).
 * Sequence matches GprsEngine + GprsRelayClient:
 *   AT -> QINDI=1 -> PDP -> QIOPEN ipv4:port -> REGISTER -> QIRD loop
 * PIC I/O is on a second UART via 8-byte PicBus frames.
 * Do not send ATZ / AT&F.
 */

#include "barq_comms.h"
#include "../pic-io/pic_bus.h"
#include <stdio.h>

#ifndef BARQ_RELAY_IP0
#define BARQ_RELAY_IP0 37
#define BARQ_RELAY_IP1 27
#define BARQ_RELAY_IP2 37
#define BARQ_RELAY_IP3 254
#define BARQ_RELAY_PORT 8406
#endif

int main(void)
{
  barq_relay_cfg_t cfg = {
    .ip = { BARQ_RELAY_IP0, BARQ_RELAY_IP1, BARQ_RELAY_IP2, BARQ_RELAY_IP3 },
    .port = BARQ_RELAY_PORT,
    .device_id = "ALPHA",
    .apn = "internet"
  };
  barq_state_t st = BARQ_BOOT;
  st = barq_next_state(st, "POWER_OK");
  (void)cfg;
  (void)st;
  return 0;
}
