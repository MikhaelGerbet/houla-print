/**
 * NIIMBOT printer service — serial port communication.
 * Handles device discovery, connection, and print job sending.
 *
 * Supports USB and Bluetooth serial connections.
 */

import { SerialPort } from 'serialport';
import {
  NiimbotPacket,
  NiimbotCommand,
  NiimbotResponse,
  NiimbotLabelType,
  InfoCommand,
  NIIMBOT_PORT_PATTERNS,
  DEFAULT_MODEL,
  NiimbotModelSpec,
  encodePacket,
  decodePackets,
  buildConnect,
  buildGetInfo,
  buildSetLabelType,
  buildSetDensity,
  buildStartPrint,
  buildEndPrint,
  buildSetQuantity,
  buildSetDimension,
  buildStartPagePrint,
  buildEndPagePrint,
  buildHeartbeat,
  buildImageRow,
} from './niimbot-protocol';

export interface NiimbotDeviceInfo {
  port: string;        // e.g. "COM3"
  manufacturer?: string;
  serialNumber?: string;
  vendorId?: string;
  productId?: string;
  friendlyName?: string;
}

export interface NiimbotPrintResult {
  success: boolean;
  error?: string;
}

// ═══════════════════════════════════════════════════════
// Niimbot Service
// ═══════════════════════════════════════════════════════

export class NiimbotService {
  private port: SerialPort | null = null;
  private rxBuffer = Buffer.alloc(0);
  private responsePromise: { resolve: (pkt: NiimbotPacket) => void; reject: (err: Error) => void } | null = null;
  private model: NiimbotModelSpec = DEFAULT_MODEL;
  private connected = false;

  /**
   * List all serial ports that could be Niimbot printers.
   */
  async discover(): Promise<NiimbotDeviceInfo[]> {
    const ports = await SerialPort.list();
    const candidates: NiimbotDeviceInfo[] = [];

    for (const p of ports) {
      const portAny = p as any;
      const friendly = portAny.friendlyName || '';
      const combined = `${p.path} ${p.manufacturer || ''} ${friendly} ${p.pnpId || ''}`;
      const isNiimbot = NIIMBOT_PORT_PATTERNS.some(pattern => pattern.test(combined))
        || (p.vendorId && p.vendorId.toLowerCase() === '3513');

      if (isNiimbot) {
        candidates.push({
          port: p.path,
          manufacturer: p.manufacturer,
          serialNumber: p.serialNumber,
          vendorId: p.vendorId,
          productId: p.productId,
          friendlyName: friendly,
        });
      }
    }

    return candidates;
  }

  /**
   * List all available serial ports (for manual selection).
   */
  async listAllPorts(): Promise<NiimbotDeviceInfo[]> {
    const ports = await SerialPort.list();
    return ports.map(p => ({
      port: p.path,
      manufacturer: p.manufacturer,
      serialNumber: p.serialNumber,
      vendorId: p.vendorId,
      productId: p.productId,
      friendlyName: (p as any).friendlyName,
    }));
  }

  /**
   * Connect to a Niimbot printer on the specified serial port.
   */
  async connect(portPath: string): Promise<void> {
    if (this.port?.isOpen) {
      await this.disconnect();
    }

    return new Promise((resolve, reject) => {
      this.port = new SerialPort({
        path: portPath,
        baudRate: 115200,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        autoOpen: false,
      });

      this.rxBuffer = Buffer.alloc(0);

      this.port.on('data', (chunk: Buffer) => {
        this.rxBuffer = Buffer.concat([this.rxBuffer, chunk]);
        this.processReceivedData();
      });

      this.port.on('error', (err) => {
        console.error('[Niimbot] Serial error:', err.message);
        this.connected = false;
      });

      this.port.on('close', () => {
        console.log('[Niimbot] Port closed.');
        this.connected = false;
      });

      this.port.open(async (err) => {
        if (err) {
          reject(new Error(`Cannot open port ${portPath}: ${err.message}`));
          return;
        }

        console.log(`[Niimbot] Port ${portPath} opened.`);

        try {
          // Send CONNECT command and wait for ACK
          await this.sendAndWait(buildConnect(), NiimbotResponse.CONNECT_ACK, 5000);
          this.connected = true;
          console.log('[Niimbot] Connected to printer.');
          resolve();
        } catch (connErr: any) {
          this.port?.close();
          reject(new Error(`Niimbot handshake failed: ${connErr.message}`));
        }
      });
    });
  }

  /**
   * Disconnect from the printer.
   */
  async disconnect(): Promise<void> {
    this.connected = false;
    if (!this.port?.isOpen) return;

    return new Promise((resolve) => {
      this.port!.close(() => {
        this.port = null;
        resolve();
      });
    });
  }

  isConnected(): boolean {
    return this.connected && (this.port?.isOpen ?? false);
  }

  /**
   * Get printer info (battery, serial, version).
   */
  async getBattery(): Promise<number> {
    const pkt = await this.sendAndWait(buildGetInfo(InfoCommand.BATTERY), NiimbotResponse.GET_INFO_ACK, 3000);
    return pkt.data.length > 0 ? pkt.data[pkt.data.length - 1] : -1;
  }

  async getSerialNumber(): Promise<string> {
    const pkt = await this.sendAndWait(buildGetInfo(InfoCommand.SERIAL_NUMBER), NiimbotResponse.GET_INFO_ACK, 3000);
    return pkt.data.toString('ascii');
  }

  /**
   * Print a monochrome bitmap on the Niimbot printer.
   *
   * @param bitmap - Packed 1-bit bitmap (MSB first, 8 pixels per byte)
   * @param widthDots - Width in dots (must match printer width, typically 384 for B1)
   * @param heightDots - Height in dots
   * @param density - Print density 1-5 (default 3)
   * @param labelType - Label type (default GAP for die-cut)
   * @param quantity - Number of copies (default 1)
   */
  async printBitmap(
    bitmap: Buffer,
    widthDots: number,
    heightDots: number,
    density = 3,
    labelType: NiimbotLabelType = NiimbotLabelType.GAP,
    quantity = 1,
  ): Promise<NiimbotPrintResult> {
    if (!this.isConnected()) {
      return { success: false, error: 'Imprimante non connectée' };
    }

    const bytesPerRow = Math.ceil(widthDots / 8);

    try {
      // 1. Set label parameters
      await this.sendAndWait(buildSetLabelType(labelType), NiimbotResponse.SET_LABEL_TYPE_ACK, 3000);
      await this.sendAndWait(buildSetDensity(density), NiimbotResponse.SET_LABEL_DENSITY_ACK, 3000);
      await this.sendAndWait(buildSetQuantity(quantity), NiimbotResponse.SET_QUANTITY_ACK, 3000);

      // 2. Start print session
      await this.sendAndWait(buildStartPrint(), NiimbotResponse.START_PRINT_ACK, 5000);

      // 3. Set page dimensions
      await this.sendAndWait(buildSetDimension(widthDots, heightDots), NiimbotResponse.SET_DIMENSION_ACK, 3000);

      // 4. Start page
      await this.sendAndWait(buildStartPagePrint(), NiimbotResponse.START_PAGE_ACK, 3000);

      // 5. Send image data row by row
      for (let row = 0; row < heightDots; row++) {
        const rowStart = row * bytesPerRow;
        const rowData = bitmap.subarray(rowStart, rowStart + bytesPerRow);
        // Pad if necessary
        const paddedRow = rowData.length < bytesPerRow
          ? Buffer.concat([rowData, Buffer.alloc(bytesPerRow - rowData.length)])
          : rowData;

        await this.sendAndWait(buildImageRow(row, paddedRow), NiimbotResponse.IMAGE_DATA_ACK, 2000);
      }

      // 6. End page
      await this.sendAndWait(buildEndPagePrint(), NiimbotResponse.END_PAGE_ACK, 5000);

      // 7. End print session
      await this.sendAndWait(buildEndPrint(), NiimbotResponse.END_PRINT_ACK, 5000);

      console.log(`[Niimbot] Print complete: ${widthDots}x${heightDots} dots, ${quantity} copies`);
      return { success: true };
    } catch (err: any) {
      console.error('[Niimbot] Print failed:', err.message);
      return { success: false, error: err.message };
    }
  }

  /**
   * Send a test label (small "Hou.la Print" text).
   */
  async testPrint(): Promise<NiimbotPrintResult> {
    // Generate a simple test pattern: 384x200 dots
    const w = this.model.printWidthDots;
    const h = 200;
    const bytesPerRow = Math.ceil(w / 8);
    const bitmap = Buffer.alloc(bytesPerRow * h, 0x00); // all white

    // Draw a simple border (top, bottom, left, right lines)
    for (let x = 0; x < w; x++) {
      setBit(bitmap, bytesPerRow, 0, x);             // top line
      setBit(bitmap, bytesPerRow, 1, x);
      setBit(bitmap, bytesPerRow, h - 1, x);         // bottom line
      setBit(bitmap, bytesPerRow, h - 2, x);
    }
    for (let y = 0; y < h; y++) {
      setBit(bitmap, bytesPerRow, y, 0);              // left line
      setBit(bitmap, bytesPerRow, y, 1);
      setBit(bitmap, bytesPerRow, y, w - 1);          // right line
      setBit(bitmap, bytesPerRow, y, w - 2);
    }

    // Draw "TEST" in big chunky pixels at center
    const testPattern = renderTextSimple('Hou.la Print TEST', 16);
    const textStartX = Math.floor((w - testPattern.width) / 2);
    const textStartY = Math.floor((h - testPattern.height) / 2);
    overlayBitmap(bitmap, bytesPerRow, testPattern, textStartX, textStartY);

    return this.printBitmap(bitmap, w, h);
  }

  // ═══════════════════════════════════════════════════════
  // Internal: serial communication
  // ═══════════════════════════════════════════════════════

  private send(data: Buffer): void {
    if (!this.port?.isOpen) throw new Error('Port not open');
    this.port.write(data);
  }

  private sendAndWait(data: Buffer, expectedResponseCmd: number, timeoutMs: number): Promise<NiimbotPacket> {
    return new Promise((resolve, reject) => {
      // Set up response listener
      this.responsePromise = { resolve, reject };

      const timer = setTimeout(() => {
        this.responsePromise = null;
        reject(new Error(`Timeout waiting for response 0x${expectedResponseCmd.toString(16)}`));
      }, timeoutMs);

      // Wrap resolve to clear timer
      const originalResolve = resolve;
      this.responsePromise.resolve = (pkt: NiimbotPacket) => {
        clearTimeout(timer);
        this.responsePromise = null;
        originalResolve(pkt);
      };
      this.responsePromise.reject = (err: Error) => {
        clearTimeout(timer);
        this.responsePromise = null;
        reject(err);
      };

      this.send(data);
    });
  }

  private processReceivedData(): void {
    const { packets, remainder } = decodePackets(this.rxBuffer);
    this.rxBuffer = Buffer.from(remainder);

    for (const pkt of packets) {
      if (this.responsePromise) {
        this.responsePromise.resolve(pkt);
      } else {
        // Unsolicited packet (e.g. status update)
        console.log(`[Niimbot] Unsolicited packet: cmd=0x${pkt.command.toString(16)}, data=${pkt.data.toString('hex')}`);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════
// Simple bitmap text rendering (no external deps)
// ═══════════════════════════════════════════════════════

interface SimpleBitmap {
  data: Buffer;
  width: number;
  height: number;
  bytesPerRow: number;
}

/** Set a single bit (black pixel) in a packed 1-bit bitmap */
function setBit(bitmap: Buffer, bytesPerRow: number, row: number, col: number): void {
  const byteIdx = row * bytesPerRow + Math.floor(col / 8);
  const bitIdx = 7 - (col % 8); // MSB first
  if (byteIdx < bitmap.length) {
    bitmap[byteIdx] |= (1 << bitIdx);
  }
}

/**
 * Render text as a simple bitmap using a built-in 5×7 pixel font.
 * Returns a packed 1-bit bitmap.
 */
function renderTextSimple(text: string, scale = 1): SimpleBitmap {
  const charW = 6 * scale; // 5 pixels + 1 gap, scaled
  const charH = 8 * scale; // 7 pixels + 1 gap, scaled
  const width = text.length * charW;
  const height = charH;
  const bytesPerRow = Math.ceil(width / 8);
  const data = Buffer.alloc(bytesPerRow * height, 0x00);

  for (let i = 0; i < text.length; i++) {
    const glyph = FONT_5X7[text.charCodeAt(i)] || FONT_5X7[0x3f]; // '?' for unknown
    if (!glyph) continue;

    for (let gy = 0; gy < 7; gy++) {
      for (let gx = 0; gx < 5; gx++) {
        if (glyph[gy] & (1 << (4 - gx))) {
          // Scale the pixel
          for (let sy = 0; sy < scale; sy++) {
            for (let sx = 0; sx < scale; sx++) {
              const px = i * charW + gx * scale + sx;
              const py = gy * scale + sy;
              setBit(data, bytesPerRow, py, px);
            }
          }
        }
      }
    }
  }

  return { data, width, height, bytesPerRow };
}

/** Overlay a small bitmap onto a larger one at position (ox, oy) */
function overlayBitmap(
  target: Buffer, targetBytesPerRow: number,
  src: SimpleBitmap, ox: number, oy: number,
): void {
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const srcByteIdx = y * src.bytesPerRow + Math.floor(x / 8);
      const srcBitIdx = 7 - (x % 8);
      if (src.data[srcByteIdx] & (1 << srcBitIdx)) {
        setBit(target, targetBytesPerRow, oy + y, ox + x);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════
// 5×7 bitmap font (ASCII 32–126)
// Each glyph: 7 rows, each row encodes 5 pixels in bits 4..0
// ═══════════════════════════════════════════════════════

const FONT_5X7: Record<number, number[]> = {
  0x20: [0x00,0x00,0x00,0x00,0x00,0x00,0x00], // space
  0x21: [0x04,0x04,0x04,0x04,0x04,0x00,0x04], // !
  0x22: [0x0a,0x0a,0x00,0x00,0x00,0x00,0x00], // "
  0x23: [0x0a,0x1f,0x0a,0x0a,0x1f,0x0a,0x00], // #
  0x27: [0x04,0x04,0x00,0x00,0x00,0x00,0x00], // '
  0x28: [0x02,0x04,0x08,0x08,0x08,0x04,0x02], // (
  0x29: [0x08,0x04,0x02,0x02,0x02,0x04,0x08], // )
  0x2a: [0x00,0x0a,0x04,0x1f,0x04,0x0a,0x00], // *
  0x2b: [0x00,0x04,0x04,0x1f,0x04,0x04,0x00], // +
  0x2c: [0x00,0x00,0x00,0x00,0x00,0x04,0x08], // ,
  0x2d: [0x00,0x00,0x00,0x1f,0x00,0x00,0x00], // -
  0x2e: [0x00,0x00,0x00,0x00,0x00,0x00,0x04], // .
  0x2f: [0x01,0x02,0x04,0x04,0x08,0x10,0x00], // /
  0x30: [0x0e,0x11,0x13,0x15,0x19,0x11,0x0e], // 0
  0x31: [0x04,0x0c,0x04,0x04,0x04,0x04,0x0e], // 1
  0x32: [0x0e,0x11,0x01,0x06,0x08,0x10,0x1f], // 2
  0x33: [0x0e,0x11,0x01,0x06,0x01,0x11,0x0e], // 3
  0x34: [0x02,0x06,0x0a,0x12,0x1f,0x02,0x02], // 4
  0x35: [0x1f,0x10,0x1e,0x01,0x01,0x11,0x0e], // 5
  0x36: [0x06,0x08,0x10,0x1e,0x11,0x11,0x0e], // 6
  0x37: [0x1f,0x01,0x02,0x04,0x08,0x08,0x08], // 7
  0x38: [0x0e,0x11,0x11,0x0e,0x11,0x11,0x0e], // 8
  0x39: [0x0e,0x11,0x11,0x0f,0x01,0x02,0x0c], // 9
  0x3a: [0x00,0x00,0x04,0x00,0x04,0x00,0x00], // :
  0x3f: [0x0e,0x11,0x01,0x02,0x04,0x00,0x04], // ?
  0x40: [0x0e,0x11,0x17,0x15,0x17,0x10,0x0e], // @
  // Uppercase letters
  0x41: [0x0e,0x11,0x11,0x1f,0x11,0x11,0x11], // A
  0x42: [0x1e,0x11,0x11,0x1e,0x11,0x11,0x1e], // B
  0x43: [0x0e,0x11,0x10,0x10,0x10,0x11,0x0e], // C
  0x44: [0x1e,0x11,0x11,0x11,0x11,0x11,0x1e], // D
  0x45: [0x1f,0x10,0x10,0x1e,0x10,0x10,0x1f], // E
  0x46: [0x1f,0x10,0x10,0x1e,0x10,0x10,0x10], // F
  0x47: [0x0e,0x11,0x10,0x17,0x11,0x11,0x0e], // G
  0x48: [0x11,0x11,0x11,0x1f,0x11,0x11,0x11], // H
  0x49: [0x0e,0x04,0x04,0x04,0x04,0x04,0x0e], // I
  0x4a: [0x07,0x02,0x02,0x02,0x02,0x12,0x0c], // J
  0x4b: [0x11,0x12,0x14,0x18,0x14,0x12,0x11], // K
  0x4c: [0x10,0x10,0x10,0x10,0x10,0x10,0x1f], // L
  0x4d: [0x11,0x1b,0x15,0x11,0x11,0x11,0x11], // M
  0x4e: [0x11,0x19,0x15,0x13,0x11,0x11,0x11], // N
  0x4f: [0x0e,0x11,0x11,0x11,0x11,0x11,0x0e], // O
  0x50: [0x1e,0x11,0x11,0x1e,0x10,0x10,0x10], // P
  0x51: [0x0e,0x11,0x11,0x11,0x15,0x12,0x0d], // Q
  0x52: [0x1e,0x11,0x11,0x1e,0x14,0x12,0x11], // R
  0x53: [0x0e,0x11,0x10,0x0e,0x01,0x11,0x0e], // S
  0x54: [0x1f,0x04,0x04,0x04,0x04,0x04,0x04], // T
  0x55: [0x11,0x11,0x11,0x11,0x11,0x11,0x0e], // U
  0x56: [0x11,0x11,0x11,0x0a,0x0a,0x04,0x04], // V
  0x57: [0x11,0x11,0x11,0x15,0x15,0x1b,0x11], // W
  0x58: [0x11,0x11,0x0a,0x04,0x0a,0x11,0x11], // X
  0x59: [0x11,0x11,0x0a,0x04,0x04,0x04,0x04], // Y
  0x5a: [0x1f,0x01,0x02,0x04,0x08,0x10,0x1f], // Z
  // Lowercase letters
  0x61: [0x00,0x00,0x0e,0x01,0x0f,0x11,0x0f], // a
  0x62: [0x10,0x10,0x1e,0x11,0x11,0x11,0x1e], // b
  0x63: [0x00,0x00,0x0e,0x11,0x10,0x11,0x0e], // c
  0x64: [0x01,0x01,0x0f,0x11,0x11,0x11,0x0f], // d
  0x65: [0x00,0x00,0x0e,0x11,0x1f,0x10,0x0e], // e
  0x66: [0x06,0x09,0x08,0x1e,0x08,0x08,0x08], // f
  0x67: [0x00,0x00,0x0f,0x11,0x0f,0x01,0x0e], // g
  0x68: [0x10,0x10,0x16,0x19,0x11,0x11,0x11], // h
  0x69: [0x04,0x00,0x0c,0x04,0x04,0x04,0x0e], // i
  0x6a: [0x02,0x00,0x06,0x02,0x02,0x12,0x0c], // j
  0x6b: [0x10,0x10,0x12,0x14,0x18,0x14,0x12], // k
  0x6c: [0x0c,0x04,0x04,0x04,0x04,0x04,0x0e], // l
  0x6d: [0x00,0x00,0x1a,0x15,0x15,0x11,0x11], // m
  0x6e: [0x00,0x00,0x16,0x19,0x11,0x11,0x11], // n
  0x6f: [0x00,0x00,0x0e,0x11,0x11,0x11,0x0e], // o
  0x70: [0x00,0x00,0x1e,0x11,0x1e,0x10,0x10], // p
  0x71: [0x00,0x00,0x0f,0x11,0x0f,0x01,0x01], // q
  0x72: [0x00,0x00,0x16,0x19,0x10,0x10,0x10], // r
  0x73: [0x00,0x00,0x0e,0x10,0x0e,0x01,0x1e], // s
  0x74: [0x08,0x08,0x1e,0x08,0x08,0x09,0x06], // t
  0x75: [0x00,0x00,0x11,0x11,0x11,0x13,0x0d], // u
  0x76: [0x00,0x00,0x11,0x11,0x0a,0x0a,0x04], // v
  0x77: [0x00,0x00,0x11,0x11,0x15,0x15,0x0a], // w
  0x78: [0x00,0x00,0x11,0x0a,0x04,0x0a,0x11], // x
  0x79: [0x00,0x00,0x11,0x11,0x0f,0x01,0x0e], // y
  0x7a: [0x00,0x00,0x1f,0x02,0x04,0x08,0x1f], // z
};
