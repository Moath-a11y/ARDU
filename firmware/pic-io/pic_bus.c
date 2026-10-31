#include "pic_bus.h"

uint8_t pic_crc8(const uint8_t *bytes, int n)
{
  uint8_t crc = 0;
  int i, b;
  for (i = 0; i < n; i++) {
    crc ^= bytes[i];
    for (b = 0; b < 8; b++) {
      crc = (crc & 0x80) ? (uint8_t)((crc << 1) ^ 0x31) : (uint8_t)(crc << 1);
    }
  }
  return crc;
}

int pic_encode(uint8_t *out, uint8_t cmd, uint8_t ch, uint16_t value, int armed, uint8_t seq)
{
  out[0] = PIC_SYNC;
  out[1] = cmd;
  out[2] = ch;
  out[3] = (uint8_t)(value & 0xFF);
  out[4] = (uint8_t)((value >> 8) & 0xFF);
  out[5] = armed ? PIC_FLAG_ARMED : 0;
  out[6] = seq;
  out[7] = pic_crc8(&out[1], 6);
  return PIC_FRAME_LEN;
}

int pic_decode(const uint8_t *in, uint8_t *cmd, uint8_t *ch, uint16_t *value, int *armed, uint8_t *seq)
{
  if (in[0] != PIC_SYNC) return -1;
  if (pic_crc8(&in[1], 6) != in[7]) return -2;
  *cmd = in[1];
  *ch = in[2];
  *value = (uint16_t)in[3] | ((uint16_t)in[4] << 8);
  *armed = (in[5] & PIC_FLAG_ARMED) ? 1 : 0;
  *seq = in[6];
  return 0;
}
