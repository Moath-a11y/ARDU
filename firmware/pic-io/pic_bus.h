#ifndef BARQ_PIC_BUS_H
#define BARQ_PIC_BUS_H

#include <stdint.h>

#define PIC_SYNC     0xA5
#define PIC_FRAME_LEN 8
#define PIC_CMD_DO_SET   0x01
#define PIC_CMD_DO_PULSE 0x02
#define PIC_CMD_DI_READ  0x03
#define PIC_CMD_DO_SAFE  0x04
#define PIC_CMD_HB       0x05
#define PIC_CMD_ACK      0x81
#define PIC_FLAG_ARMED   0x01

uint8_t pic_crc8(const uint8_t *bytes, int n);
int pic_encode(uint8_t *out, uint8_t cmd, uint8_t ch, uint16_t value, int armed, uint8_t seq);
int pic_decode(const uint8_t *in, uint8_t *cmd, uint8_t *ch, uint16_t *value, int *armed, uint8_t *seq);

#endif
