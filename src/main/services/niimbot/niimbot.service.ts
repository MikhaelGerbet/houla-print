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
  NIIMBOT_MODELS,
  DEFAULT_MODEL,
  NiimbotModelSpec,
  encodePacket,
  decodePackets,
  buildConnect,
  buildGetInfo,
  buildGetRfid,
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
  buildGetPrintStatus,
} from './niimbot-protocol';

export interface NiimbotDeviceInfo {
  port: string;        // e.g. "COM3"
  manufacturer?: string;
  serialNumber?: string;
  vendorId?: string;
  productId?: string;
  friendlyName?: string;
  modelName?: string;   // e.g. "Niimbot B1" — resolved after probing
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

  /** Mutex: true while a probe, connect, or print is actively using a serial port */
  private busy = false;
  /** Ports known to be dead (e.g. BT incoming port that always fails on write) */
  private deadPorts = new Set<string>();

  /**
   * List all serial ports that could be Niimbot printers.
   * For Bluetooth serial ports with no identifying name, actively probes
   * with a quick CONNECT handshake to detect Niimbot devices.
   */
  async discover(): Promise<NiimbotDeviceInfo[]> {
    const ports = await SerialPort.list();
    const candidates: NiimbotDeviceInfo[] = [];
    const bluetoothToProbe: NiimbotDeviceInfo[] = [];

    console.log(`[Niimbot] Serial ports found: ${ports.length}`);
    for (const p of ports) {
      const portAny = p as any;
      const friendly = portAny.friendlyName || '';
      const combined = `${p.path} ${p.manufacturer || ''} ${friendly} ${p.pnpId || ''}`;
      const matchesPattern = NIIMBOT_PORT_PATTERNS.some(pattern => pattern.test(combined));
      const matchesVid = !!(p.vendorId && p.vendorId.toLowerCase() === '3513');
      const isNiimbot = matchesPattern || matchesVid;
      const isBluetooth = /bluetooth/i.test(friendly) || /bluetooth/i.test(p.manufacturer || '');

      console.log(`[Niimbot]   ${p.path}: manufacturer=${p.manufacturer || '?'}, vid=${p.vendorId || '?'}, friendly=${friendly || '?'}, match=${isNiimbot}, bt=${isBluetooth}`);

      const info: NiimbotDeviceInfo = {
        port: p.path,
        manufacturer: p.manufacturer,
        serialNumber: p.serialNumber,
        vendorId: p.vendorId,
        productId: p.productId,
        friendlyName: friendly,
      };

      if (isNiimbot) {
        candidates.push(info);
      } else if (isBluetooth) {
        bluetoothToProbe.push(info);
      }
    }

    // Actively probe unrecognized Bluetooth serial ports with a quick handshake
    if (bluetoothToProbe.length > 0) {
      // Skip probing if we're already busy (e.g. a print job is running)
      if (this.busy) {
        console.log(`[Niimbot] Skipping BT probe — serial port busy`);
      } else {
        console.log(`[Niimbot] Probing ${bluetoothToProbe.length} Bluetooth port(s)...`);
        for (const bt of bluetoothToProbe) {
          // Skip ports that previously failed with unrecoverable errors
          if (this.deadPorts.has(bt.port)) {
            console.log(`[Niimbot]   ${bt.port}: skipped (known dead port)`);
            continue;
          }
          const probeResult = await this.quickProbe(bt.port);
          if (probeResult) {
            bt.modelName = probeResult;
            candidates.push(bt);
            console.log(`[Niimbot]   ${bt.port}: Niimbot detected (${probeResult})`);
          } else {
            console.log(`[Niimbot]   ${bt.port}: no Niimbot response`);
          }
        }
      }
    }

    console.log(`[Niimbot] Discovered ${candidates.length} Niimbot candidate(s): ${candidates.map(c => c.port).join(', ') || 'none'}`);
    return candidates;
  }

  /**
   * Quick probe: try opening a serial port and sending CONNECT to check if
   * a Niimbot printer is on the other end. Returns model name or null.
   * Uses a short timeout and a temporary port instance to avoid
   * interfering with the main connection.
   *
   * For Bluetooth SPP ports, the virtual COM port opens instantly but the
   * underlying BT link may take 500ms+ to become writable — we retry
   * the CONNECT write if the first attempt fails with "Operation aborted".
   */
  private async quickProbe(portPath: string): Promise<string | null> {
    if (this.busy) return null;
    this.busy = true;
    let probePort: SerialPort | null = null;
    let writeAborted = false;

    try {
      probePort = new SerialPort({
        path: portPath,
        baudRate: 115200,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        autoOpen: false,
      });

      // Capture errors so they don't become uncaught exceptions
      probePort.on('error', (err) => {
        if (/operation aborted/i.test(err.message)) writeAborted = true;
        console.log(`[Niimbot]   ${portPath}: port error during probe (${err.message})`);
      });

      // Open the port
      await new Promise<void>((resolve, reject) => {
        probePort!.open((err) => err ? reject(err) : resolve());
      });

      // Wait for the BT SPP link to fully establish (2s minimum)
      console.log(`[Niimbot]   ${portPath}: port opened, waiting 2s for BT link...`);
      await new Promise(r => setTimeout(r, 2000));

      if (writeAborted || !probePort?.isOpen) {
        // This is the incoming BT port — mark as dead
        this.deadPorts.add(portPath);
        console.log(`[Niimbot]   ${portPath}: marked as dead (incoming BT port)`);
        return null;
      }

      // Send CONNECT packet
      const connectPkt = buildConnect();
      console.log(`[Niimbot]   ${portPath}: sending CONNECT (${connectPkt.toString('hex')})`);
      let rxBuf = Buffer.alloc(0);

      const gotAck = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          probePort?.removeListener('data', onData);
          resolve(false);
        }, 5000);

        const onData = (chunk: Buffer) => {
          console.log(`[Niimbot]   ${portPath}: RX ${chunk.toString('hex')}`);
          rxBuf = Buffer.concat([rxBuf, chunk]);
          const { packets } = decodePackets(rxBuf);
          for (const pkt of packets) {
            if (pkt.command === NiimbotResponse.CONNECT_ACK) {
              clearTimeout(timer);
              probePort?.removeListener('data', onData);
              resolve(true);
              return;
            }
          }
        };
        probePort!.on('data', onData);

        probePort!.write(connectPkt, (writeErr) => {
          if (writeErr) {
            console.log(`[Niimbot]   ${portPath}: write error (${writeErr.message})`);
            clearTimeout(timer);
            probePort?.removeListener('data', onData);
            resolve(false);
            return;
          }
          // Flush the OS buffer — critical for BT SPP
          probePort!.drain((drainErr) => {
            if (drainErr) console.log(`[Niimbot]   ${portPath}: drain error (${drainErr.message})`);
            else console.log(`[Niimbot]   ${portPath}: data flushed, waiting for response...`);
          });
        });
      });

      if (writeAborted) {
        this.deadPorts.add(portPath);
        console.log(`[Niimbot]   ${portPath}: marked as dead (write aborted)`);
        return null;
      }

      if (!gotAck) return null;

      console.log(`[Niimbot]   ${portPath}: ACK received!`);

      // Try to read area width to identify model
      let modelName = 'Niimbot';
      try {
        const infoPkt = buildGetInfo(InfoCommand.AREA_WIDTH);
        rxBuf = Buffer.alloc(0);

        const width = await new Promise<number>((resolve) => {
          const timer = setTimeout(() => resolve(0), 2000);
          const onData = (chunk: Buffer) => {
            rxBuf = Buffer.concat([rxBuf, chunk]);
            const { packets } = decodePackets(rxBuf);
            for (const pkt of packets) {
              if (pkt.command === NiimbotResponse.GET_INFO_ACK && pkt.data.length >= 2) {
                clearTimeout(timer);
                probePort?.removeListener('data', onData);
                resolve((pkt.data[0] << 8) | pkt.data[1]);
                return;
              }
            }
          };
          probePort!.on('data', onData);
          probePort!.write(infoPkt, () => probePort!.drain(() => {}));
        });

        if (width > 0) {
          for (const [, spec] of Object.entries(NIIMBOT_MODELS)) {
            if (spec.printWidthDots === width) {
              modelName = spec.name;
              break;
            }
          }
          if (modelName === 'Niimbot') modelName = `Niimbot (${width}dots)`;
        }
      } catch { /* ignore info read failure */ }

      return modelName;
    } catch (err) {
      console.log(`[Niimbot]   ${portPath}: probe failed (${(err as Error).message})`);
      return null;
    } finally {
      this.busy = false;
      if (probePort?.isOpen) {
        await new Promise<void>(resolve => probePort!.close(() => resolve()));
      }
    }
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
        console.log(`[Niimbot] RX: ${chunk.toString('hex')}`);
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

      this.busy = true;
      this.port.open(async (err) => {
        if (err) {
          this.busy = false;
          reject(new Error(`Cannot open port ${portPath}: ${err.message}`));
          return;
        }

        console.log(`[Niimbot] Port ${portPath} opened.`);

        try {
          // Wait for the BT SPP link to fully establish.
          // USB is near-instant, but Bluetooth virtual COM takes 2-3s.
          await new Promise(r => setTimeout(r, 2000));

          const connectPkt = buildConnect();
          console.log(`[Niimbot] Sending CONNECT: ${connectPkt.toString('hex')}`);

          // Send CONNECT command and wait for ACK
          await this.sendAndWait(connectPkt, NiimbotResponse.CONNECT_ACK, 5000);
          this.connected = true;
          console.log('[Niimbot] Connected to printer.');
          resolve();
        } catch (connErr: any) {
          this.busy = false;
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
    this.busy = false;
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
   * Get the print head width in dots. Helps identify the model.
   */
  async getAreaWidth(): Promise<number> {
    try {
      const pkt = await this.sendAndWait(buildGetInfo(InfoCommand.AREA_WIDTH), NiimbotResponse.GET_INFO_ACK, 3000);
      if (pkt.data.length >= 2) {
        return pkt.data.readUInt16BE(0);
      }
      return pkt.data.length > 0 ? pkt.data[0] : -1;
    } catch {
      return -1;
    }
  }

  /**
   * Probe the connected printer to identify its model.
   * Connects briefly, reads area width, and matches to known models.
   */
  async probeModel(portPath: string): Promise<{
    modelName: string;
    widthDots: number;
    detectedLabel?: { widthMm: number; heightMm: number; remaining: number };
  }> {
    const wasConnected = this.isConnected();
    try {
      if (!wasConnected) {
        await this.connect(portPath);
      }
      const widthDots = await this.getAreaWidth();
      let modelName = 'Niimbot';

      if (widthDots > 0) {
        // Match width to known models
        for (const [, spec] of Object.entries(NIIMBOT_MODELS)) {
          if (spec.printWidthDots === widthDots) {
            modelName = spec.name;
            break;
          }
        }
        if (modelName === 'Niimbot') {
          modelName = `Niimbot (${widthDots}dots)`;
        }
      }

      // Try RFID label detection
      const detectedLabel = await this.readRfidLabel() ?? undefined;

      return { modelName, widthDots, detectedLabel };
    } catch {
      return { modelName: 'Niimbot', widthDots: -1 };
    } finally {
      if (!wasConnected) {
        await this.disconnect().catch(() => {});
      }
    }
  }

  /**
   * Read RFID data from the loaded label roll to detect label dimensions.
   * Returns null if no RFID data is available (non-RFID rolls or unsupported models).
   *
   * Niimbot RFID response format:
   *   [uuid... (variable)] [widthMm (1 byte)] [heightMm (1 byte)] [qty_hi] [qty_lo] [type (1 byte)]
   * The last 5 bytes contain: width, height, remaining quantity (u16BE), label type.
   */
  async readRfidLabel(): Promise<{ widthMm: number; heightMm: number; remaining: number } | null> {
    try {
      const pkt = await this.sendAndWait(
        buildGetRfid(),
        NiimbotResponse.GET_RFID_ACK,
        3000,
      );

      // Empty or too-short response means no RFID tag / no data
      if (!pkt.data || pkt.data.length < 5) return null;

      const d = pkt.data;
      const len = d.length;
      // Last 5 bytes: [widthMm, heightMm, qty_hi, qty_lo, labelType]
      const widthMm = d[len - 5];
      const heightMm = d[len - 4];
      const remaining = (d[len - 3] << 8) | d[len - 2];

      if (widthMm === 0 || heightMm === 0) return null;

      return { widthMm, heightMm, remaining };
    } catch {
      // Timeout or unsupported — not all models/rolls have RFID
      return null;
    }
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
      // Command order follows NiimBlue reference implementation for B1/B21
      // 1. Set label parameters
      await this.sendAndWait(buildSetLabelType(labelType), NiimbotResponse.SET_LABEL_TYPE_ACK, 3000);
      await this.sendAndWait(buildSetDensity(density), NiimbotResponse.SET_LABEL_DENSITY_ACK, 3000);

      // 2. Start print session
      await this.sendAndWait(buildStartPrint(), NiimbotResponse.START_PRINT_ACK, 5000);

      // 3. Start page FIRST — creates the page context
      await this.sendAndWait(buildStartPagePrint(), NiimbotResponse.START_PAGE_ACK, 3000);

      // 4. Set page dimensions and quantity INSIDE the page context (NiimBlue order)
      await this.sendAndWait(buildSetDimension(widthDots, heightDots), NiimbotResponse.SET_DIMENSION_ACK, 3000);
      await this.sendAndWait(buildSetQuantity(quantity), NiimbotResponse.SET_QUANTITY_ACK, 3000);

      // 5. Send image data row by row
      //    NiimBlue waits for ACK (0x86) on each row. Our previous fire-and-forget
      //    attempt failed because the printer needs flow control.
      //    Strategy: try sendAndWait on row 0; if ACK comes, use it for all rows.
      //    If timeout, fall back to fire-and-forget.
      console.log(`[Niimbot] Sending ${heightDots} image rows (${bytesPerRow}B each), dimension=${widthDots}w x ${heightDots}h`);
      const firstRowData = bitmap.subarray(0, bytesPerRow);
      console.log(`[Niimbot] Row 0 hex: ${firstRowData.toString('hex')}`);

      let useAck = true;
      try {
        await this.sendAndWait(buildImageRow(0, firstRowData), NiimbotResponse.IMAGE_DATA_ACK, 2000);
        console.log('[Niimbot] Row 0 ACK received — using ACK mode for all rows.');
      } catch {
        console.log('[Niimbot] Row 0 no ACK — falling back to fire-and-forget mode.');
        useAck = false;
      }

      for (let row = (useAck ? 1 : 1); row < heightDots; row++) {
        const rowStart = row * bytesPerRow;
        const rowData = bitmap.subarray(rowStart, rowStart + bytesPerRow);
        const paddedRow = rowData.length < bytesPerRow
          ? Buffer.concat([rowData, Buffer.alloc(bytesPerRow - rowData.length)])
          : rowData;

        if (useAck) {
          await this.sendAndWait(buildImageRow(row, paddedRow), NiimbotResponse.IMAGE_DATA_ACK, 2000);
        } else {
          await this.sendRow(buildImageRow(row, paddedRow));
        }
      }
      console.log(`[Niimbot] All ${heightDots} rows sent.`);

      // 6. End page — signals printer that all row data has been sent
      await this.sendAndWait(buildEndPagePrint(), NiimbotResponse.END_PAGE_ACK, 10000);

      // 7. Poll print status until printer confirms page is done
      //    (required by NiimBlue — printer won't finalize without polling)
      await this.waitForPrintComplete();

      // 8. End print session
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

    // Draw "Hou.la Print TEST" centered — compute max scale that fits the width
    const testText = 'Hou.la Print TEST';
    const maxScaleW = Math.floor((w - 20) / (testText.length * 6));  // 6px per char at scale 1
    const maxScaleH = Math.floor((h - 20) / 8);                     // 8px per char height at scale 1
    const scale = Math.max(1, Math.min(maxScaleW, maxScaleH));
    const testPattern = renderTextSimple(testText, scale);
    const textStartX = Math.floor((w - testPattern.width) / 2);
    const textStartY = Math.floor((h - testPattern.height) / 2);
    overlayBitmap(bitmap, bytesPerRow, testPattern, textStartX, textStartY);

    return this.printBitmap(bitmap, w, h);
  }

  // ═══════════════════════════════════════════════════════
  // Internal: serial communication
  // ═══════════════════════════════════════════════════════

  /**
   * Poll GET_PRINT_STATUS until the printer reports page completion.
   * NiimBlue reference: after END_PAGE, poll 0xA3 until status == 1 (done).
   * Status 0 = in progress, 1 = done, other = error/unknown.
   */
  private async waitForPrintComplete(timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let polls = 0;
    while (Date.now() < deadline) {
      polls++;
      try {
        const pkt = await this.sendAndWait(
          buildGetPrintStatus(),
          NiimbotResponse.PRINT_STATUS_ACK,
          3000,
        );
        const status = pkt.data.length > 0 ? pkt.data[0] : -1;
        console.log(`[Niimbot] Print status poll #${polls}: cmd=0x${pkt.command.toString(16)}, status=${status}, data=${pkt.data.toString('hex')}`);

        if (status === 1) {
          console.log('[Niimbot] Printer reports page complete.');
          return;
        }
        if (status === 0) {
          // Still printing — wait and poll again
          await new Promise(r => setTimeout(r, 100));
          continue;
        }
        // Unknown status — wait longer and retry
        await new Promise(r => setTimeout(r, 300));
      } catch (err: any) {
        console.warn(`[Niimbot] Print status poll error: ${err.message}`);
        // Timeout on individual poll — retry
        await new Promise(r => setTimeout(r, 200));
      }
    }
    console.warn(`[Niimbot] Print status poll timeout after ${polls} polls — continuing anyway`);
  }

  private send(data: Buffer): void {
    if (!this.port?.isOpen) throw new Error('Port not open');
    this.port.write(data);
    // Flush the OS buffer — critical for BT SPP where data can sit in buffer
    this.port.drain(() => {});
  }

  /**
   * Send image row data and await drain (no ACK expected).
   * Includes a small delay for printer buffer pacing.
   */
  private sendRow(data: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.port?.isOpen) { reject(new Error('Port not open')); return; }
      this.port.write(data, (writeErr) => {
        if (writeErr) { reject(writeErr); return; }
        this.port!.drain((drainErr) => {
          if (drainErr) { reject(drainErr); return; }
          // Small pacing delay to avoid overflowing the printer buffer
          setTimeout(resolve, 5);
        });
      });
    });
  }

  private sendAndWait(data: Buffer, expectedResponseCmd: number, timeoutMs: number): Promise<NiimbotPacket> {
    return new Promise((resolve, reject) => {
      const reqCmd = data[2]; // command byte from the sent packet

      const timer = setTimeout(() => {
        this.responsePromise = null;
        reject(new Error(`Timeout waiting for response (cmd=0x${reqCmd.toString(16)})`));
      }, timeoutMs);

      // Accept any valid response from the printer.
      // Niimbot B1 uses non-standard ACK codes (sometimes CMD+1, sometimes CMD+0x10,
      // sometimes 0x00, sometimes completely different like 0xDB). The protocol is
      // strictly request/response so the next packet is always the answer.
      this.responsePromise = {
        resolve: (pkt: NiimbotPacket) => {
          clearTimeout(timer);
          this.responsePromise = null;
          console.log(`[Niimbot] ACK cmd=0x${pkt.command.toString(16)} data=${pkt.data.toString('hex')} for TX 0x${reqCmd.toString(16)}`);
          resolve(pkt);
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          this.responsePromise = null;
          reject(err);
        },
      };

      console.log(`[Niimbot] TX cmd=0x${reqCmd.toString(16)} (${data.length}B)`);
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
