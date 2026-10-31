/*
 * PIC I/O controller: 8 outputs, 8 inputs, local fail-safe.
 * Does not speak AT. Receives 8-byte frames from the comms MCU.
 * Unarmed DO_SET/DO_PULSE are ignored. Loss of host frames drops outputs.
 */

#include "pic_bus.h"

static uint8_t outputs[8];
static uint16_t idle_ticks;

void pic_failsafe_tick(void)
{
  if (++idle_ticks > 15000) {
    int i;
    for (i = 0; i < 8; i++) outputs[i] = 0;
  }
}

int pic_apply_frame(const uint8_t *frame)
{
  uint8_t cmd, ch, seq;
  uint16_t value;
  int armed;
  if (pic_decode(frame, &cmd, &ch, &value, &armed, &seq) != 0) return -1;
  idle_ticks = 0;
  if ((cmd == PIC_CMD_DO_SET || cmd == PIC_CMD_DO_PULSE) && !armed) return -3;
  if (cmd == PIC_CMD_DO_SAFE) {
    int i;
    for (i = 0; i < 8; i++) outputs[i] = 0;
    return 0;
  }
  if (cmd == PIC_CMD_DO_SET && ch >= 1 && ch <= 8) {
    outputs[ch - 1] = value ? 1 : 0;
    return 0;
  }
  return 0;
}
