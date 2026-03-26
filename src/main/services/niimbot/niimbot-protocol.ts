/**
 * NIIMBOT printer protocol — packet encoding/decoding.
 * Based on reverse-engineering from the NiimBlue open-source project.
 *
 * Supports: B1, B18, B21, B3S, D11, D110, D101
 *
 * Packet format:
 *   [0x55 0x55] [CMD] [LEN] [DATA...] [CHECKSUM] [0xAA 0xAA]
 *   - CMD: 1 byte command type
 *   - LEN: 1 byte data length (max 255)
 *   - CHECKSUM: XOR of CMD ^ LEN ^ each DATA byte
 *   - Header/footer are fixed markers
 */

// ═══════════════════════════════════════════════════════
// Protocol constants
// ═══════════════════════════════════════════════════════

export const PACKET_HEADER = Buffer.from([0x55, 0x55]);
export const PACKET_FOOTER = Buffer.from([0xaa, 0xaa]);

/** Request commands (host → printer) */
export enum NiimbotCommand {
  CONNECT                = 0xc0,
  GET_INFO               = 0x40,
  GET_RFID               = 0x1a,
  SET_LABEL_TYPE         = 0x23,
  SET_LABEL_DENSITY      = 0x21,
  START_PRINT            = 0x01,
  END_PRINT              = 0xf3,
  START_PAGE_PRINT       = 0x03,
  END_PAGE_PRINT         = 0xe3,
  SET_DIMENSION          = 0xd4,
  SET_QUANTITY           = 0x15,
  HEARTBEAT              = 0xdc,
  IMAGE_DATA             = 0x85,
  PAGE_END               = 0xe3,
  PRINT_STATUS           = 0xa3,
  PRINT_CLEAR            = 0x20,
  GET_PRINT_STATUS       = 0xa3,
}

/** Response commands (printer → host): generally request CMD + 1 */
export enum NiimbotResponse {
  CONNECT_ACK            = 0xc1,  // … but some B1 models return 0x00 instead
  GET_INFO_ACK           = 0x41,
  GET_RFID_ACK           = 0x1b,
  SET_LABEL_TYPE_ACK     = 0x24,  // 0x23 + 1
  SET_LABEL_DENSITY_ACK  = 0x22,  // 0x21 + 1
  START_PRINT_ACK        = 0x02,  // 0x01 + 1
  END_PRINT_ACK          = 0xf4,
  START_PAGE_ACK         = 0x04,  // 0x03 + 1
  END_PAGE_ACK           = 0xe4,
  SET_DIMENSION_ACK      = 0xd5,  // 0xd4 + 1
  SET_QUANTITY_ACK       = 0x16,  // 0x15 + 1
  HEARTBEAT_ACK          = 0xdd,
  IMAGE_DATA_ACK         = 0x86,  // 0x85 + 1
  PRINT_STATUS_ACK       = 0xa4,
}

/** GET_INFO sub-commands */
export enum InfoCommand {
  DENSITY        = 0x01,
  LABEL_TYPE     = 0x02,
  PRINT_MODE     = 0x06,
  SERIAL_NUMBER  = 0x07,
  HW_VERSION     = 0x08,
  SW_VERSION     = 0x09,
  BATTERY        = 0x0a,
  AREA_WIDTH     = 0x13,
  PRINT_HEAD_MM  = 0x0e,
}

/** Label types */
export enum NiimbotLabelType {
  GAP         = 1,  // Die-cut with gap
  BLACK_MARK  = 2,
  CONTINUOUS  = 3,
  PERFORATED  = 4,
  TRANSPARENT = 5,
}

/** Known Niimbot USB Vendor IDs (decimal) */
export const NIIMBOT_USB_VID = [0x3513];

/** Common serial port name patterns for Niimbot printers */
export const NIIMBOT_PORT_PATTERNS = [
  /niimbot/i,
  /niim/i,
  /b1\b/i,
  /b18\b/i,
  /b21\b/i,
  /b3s/i,
  /d11\b/i,
  /d101\b/i,
  /d110\b/i,
];

/** Printer model specs */
export interface NiimbotModelSpec {
  name: string;
  printWidthDots: number;  // max dots per row
  dpi: number;
  maxWidthMm: number;
}

export const NIIMBOT_MODELS: Record<string, NiimbotModelSpec> = {
  B1:   { name: 'Niimbot B1',   printWidthDots: 384, dpi: 203, maxWidthMm: 48 },
  B18:  { name: 'Niimbot B18',  printWidthDots: 384, dpi: 203, maxWidthMm: 48 },
  B21:  { name: 'Niimbot B21',  printWidthDots: 384, dpi: 203, maxWidthMm: 48 },
  B3S:  { name: 'Niimbot B3S',  printWidthDots: 576, dpi: 203, maxWidthMm: 72 },
  D11:  { name: 'Niimbot D11',  printWidthDots: 96,  dpi: 203, maxWidthMm: 12 },
  D110: { name: 'Niimbot D110', printWidthDots: 96,  dpi: 203, maxWidthMm: 12 },
  D101: { name: 'Niimbot D101', printWidthDots: 96,  dpi: 203, maxWidthMm: 12 },
};

// Default to B1 specs
export const DEFAULT_MODEL = NIIMBOT_MODELS.B1;

// ═══════════════════════════════════════════════════════
// Packet encoding / decoding
// ═══════════════════════════════════════════════════════

/**
 * Build a NIIMBOT protocol packet.
 */
export function encodePacket(cmd: number, data: Buffer | number[]): Buffer {
  const dataBuf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const len = dataBuf.length & 0xff;

  // Checksum = XOR of cmd, len, and all data bytes
  let checksum = cmd ^ len;
  for (const byte of dataBuf) {
    checksum ^= byte;
  }

  return Buffer.concat([
    PACKET_HEADER,
    Buffer.from([cmd, len]),
    dataBuf,
    Buffer.from([checksum & 0xff]),
    PACKET_FOOTER,
  ]);
}

export interface NiimbotPacket {
  command: number;
  data: Buffer;
}

/**
 * Extract NIIMBOT packets from a data buffer.
 * Returns parsed packets and any remaining bytes.
 */
export function decodePackets(buffer: Buffer): { packets: NiimbotPacket[]; remainder: Buffer } {
  const packets: NiimbotPacket[] = [];
  let offset = 0;

  // Minimum packet: header(2) + cmd(1) + len(1) + checksum(1) + footer(2) = 7
  while (offset <= buffer.length - 7) {
    // Find header [0x55 0x55]
    if (buffer[offset] !== 0x55 || buffer[offset + 1] !== 0x55) {
      offset++;
      continue;
    }

    const cmd = buffer[offset + 2];
    const dataLen = buffer[offset + 3]; // 1-byte length

    // Total: header(2) + cmd(1) + len(1) + data(dataLen) + checksum(1) + footer(2)
    const totalLen = 7 + dataLen;
    if (offset + totalLen > buffer.length) break;

    const data = buffer.subarray(offset + 4, offset + 4 + dataLen);
    const checksum = buffer[offset + 4 + dataLen];
    const footerA = buffer[offset + 4 + dataLen + 1];
    const footerB = buffer[offset + 4 + dataLen + 2];

    // Validate footer
    if (footerA !== 0xaa || footerB !== 0xaa) {
      offset++;
      continue;
    }

    // Validate checksum: XOR of cmd, dataLen, and all data bytes
    let expectedChecksum = cmd ^ dataLen;
    for (const byte of data) {
      expectedChecksum ^= byte;
    }
    if (checksum !== (expectedChecksum & 0xff)) {
      console.warn(`[Niimbot] Checksum mismatch: expected 0x${(expectedChecksum & 0xff).toString(16)}, got 0x${checksum.toString(16)}`);
      offset++;
      continue;
    }

    packets.push({ command: cmd, data: Buffer.from(data.buffer, data.byteOffset, data.byteLength) });
    offset += totalLen;
  }

  return { packets, remainder: buffer.subarray(offset) };
}

// ═══════════════════════════════════════════════════════
// Command builders
// ═══════════════════════════════════════════════════════

export function buildConnect(): Buffer {
  return encodePacket(NiimbotCommand.CONNECT, [0x01]);
}

export function buildGetInfo(subCmd: InfoCommand): Buffer {
  return encodePacket(NiimbotCommand.GET_INFO, [subCmd]);
}

export function buildGetRfid(): Buffer {
  return encodePacket(NiimbotCommand.GET_RFID, [0x01]);
}

export function buildSetLabelType(type: NiimbotLabelType): Buffer {
  return encodePacket(NiimbotCommand.SET_LABEL_TYPE, [type]);
}

export function buildSetDensity(density: number): Buffer {
  // Density: 1-5 (1=light, 3=normal, 5=dark)
  return encodePacket(NiimbotCommand.SET_LABEL_DENSITY, [Math.max(1, Math.min(5, density))]);
}

export function buildStartPrint(): Buffer {
  return encodePacket(NiimbotCommand.START_PRINT, [0x01]);
}

export function buildEndPrint(): Buffer {
  return encodePacket(NiimbotCommand.END_PRINT, [0x01]);
}

export function buildSetQuantity(quantity: number): Buffer {
  const hi = (quantity >> 8) & 0xff;
  const lo = quantity & 0xff;
  return encodePacket(NiimbotCommand.SET_QUANTITY, [hi, lo]);
}

export function buildSetDimension(widthDots: number, heightDots: number): Buffer {
  // Wire format: [width_hi, width_lo, height_hi, height_lo] (NiimBlue convention)
  return encodePacket(NiimbotCommand.SET_DIMENSION, [
    (widthDots >> 8) & 0xff, widthDots & 0xff,
    (heightDots >> 8) & 0xff, heightDots & 0xff,
  ]);
}

export function buildStartPagePrint(): Buffer {
  return encodePacket(NiimbotCommand.START_PAGE_PRINT, [0x01]);
}

export function buildEndPagePrint(): Buffer {
  return encodePacket(NiimbotCommand.END_PAGE_PRINT, [0x01]);
}

export function buildHeartbeat(): Buffer {
  return encodePacket(NiimbotCommand.HEARTBEAT, [0x01]);
}

export function buildGetPrintStatus(): Buffer {
  return encodePacket(NiimbotCommand.GET_PRINT_STATUS, [0x01]);
}

/**
 * Build image data packet for one row.
 * The row data is packed 1-bit (8 pixels per byte, MSB first).
 * Black = 1, White = 0.
 *
 * Niimbot B1/B21 image packet format:
 *   [rowIndex_hi, rowIndex_lo, repeatCount_hi, repeatCount_lo, ...rowData]
 * repeatCount=1 for single unique lines.
 */
export function buildImageRow(rowIndex: number, rowData: Buffer): Buffer {
  const payload = Buffer.alloc(4 + rowData.length);
  payload.writeUInt16BE(rowIndex, 0);
  payload.writeUInt16BE(1, 2);  // repeat count = 1
  rowData.copy(payload, 4);
  return encodePacket(NiimbotCommand.IMAGE_DATA, payload);
}
