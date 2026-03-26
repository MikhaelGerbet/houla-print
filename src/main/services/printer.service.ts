import { BrowserWindow, Notification } from 'electron';
import { PrinterInfo } from '../../shared/types';
import { NiimbotService, NiimbotDeviceInfo, renderProductLabel, LabelContent } from './niimbot';
import { DEFAULT_MODEL, NIIMBOT_MODELS, NiimbotModelSpec } from './niimbot/niimbot-protocol';

// Zebra / thermal printer name patterns
const THERMAL_PATTERNS = [/zebra/i, /zd[24]\d{2}/i, /gk4\d{2}/i, /gx4\d{2}/i, /zt[24]\d{2}/i, /brother\s*ql/i, /dymo/i];
// Receipt printer patterns
const RECEIPT_PATTERNS = [/epson\s*tm/i, /star\s*(tsp|sp)/i, /bixolon/i, /citizen\s*ct/i, /pos[-\s]?58/i, /pos[-\s]?80/i];
// Niimbot patterns (matched against OS printer names)
const NIIMBOT_PATTERNS = [/niimbot/i, /niim/i];

/**
 * Detects system printers, classifies them, and handles raw printing.
 * Also manages Niimbot thermal label printers via serial port.
 */
export class PrinterService {
  private detectedPrinters: PrinterInfo[] = [];
  private niimbot: NiimbotService = new NiimbotService();
  private niimbotDevices: NiimbotDeviceInfo[] = [];
  private connectedNiimbotPort: string | null = null;

  /**
   * Detect all system printers via Electron's webContents API + Niimbot serial ports.
   */
  async detectPrinters(): Promise<PrinterInfo[]> {
    const win = BrowserWindow.getAllWindows()[0];
    const osPrinters: PrinterInfo[] = [];

    if (win) {
      const rawPrinters = await (win.webContents as any).getPrintersAsync() as Electron.PrinterInfo[];
      for (const p of rawPrinters) {
        osPrinters.push({
          name: p.name,
          displayName: p.displayName || p.name,
          isDefault: p.isDefault,
          status: p.status,
          description: p.description || '',
          type: this.classifyPrinter(p.name, p.description || ''),
        });
      }
    }

    // Discover Niimbot printers on serial ports
    try {
      this.niimbotDevices = await this.niimbot.discover();
      for (const dev of this.niimbotDevices) {
        // Avoid duplicates if already listed as OS printer
        const alreadyListed = osPrinters.some(p => p.name === dev.port);
        if (!alreadyListed) {
          osPrinters.push({
            name: `niimbot:${dev.port}`,
            displayName: dev.modelName || 'Niimbot',
            isDefault: false,
            status: 0,
            description: dev.port,
            type: 'niimbot',
          });
        }
      }
    } catch (err) {
      console.warn('[Printer] Niimbot discovery failed:', (err as Error).message);
    }

    // Also list all available serial ports as potential Niimbot devices
    try {
      const allPorts = await this.niimbot.listAllPorts();
      for (const p of allPorts) {
        const alreadyListed = osPrinters.some(pr =>
          pr.name === `niimbot:${p.port}` || pr.name === p.port);
        if (!alreadyListed && p.manufacturer) {
          // Show COM ports that have a manufacturer (likely real devices, not internal)
          osPrinters.push({
            name: `niimbot:${p.port}`,
            displayName: 'Niimbot',
            isDefault: false,
            status: 0,
            description: p.port,
            type: 'niimbot',
          });
        }
      }
    } catch { /* ignore serial listing errors */ }

    this.detectedPrinters = osPrinters;
    return this.detectedPrinters;
  }

  getLastDetected(): PrinterInfo[] {
    return this.detectedPrinters;
  }

  /**
   * Classify a printer by its name/description.
   */
  private classifyPrinter(name: string, description: string): PrinterInfo['type'] {
    const combined = `${name} ${description}`;
    if (NIIMBOT_PATTERNS.some(p => p.test(combined))) return 'niimbot';
    if (THERMAL_PATTERNS.some(p => p.test(combined))) return 'thermal';
    if (RECEIPT_PATTERNS.some(p => p.test(combined))) return 'receipt';
    return 'standard';
  }

  /**
   * Print ZPL data to a thermal printer via raw socket or PowerShell.
   */
  async printZpl(printerName: string, zplData: string): Promise<void> {
    if (process.platform === 'win32') {
      await this.printRawWindows(printerName, zplData);
    } else {
      await this.printRawUnix(printerName, zplData);
    }
  }

  /**
   * Print PDF file to a standard printer.
   */
  async printPdf(printerName: string, pdfBuffer: Buffer): Promise<void> {
    // Write PDF to temp file, then print via system command
    const fs = await import('fs/promises');
    const os = await import('os');
    const path = await import('path');
    const tmpFile = path.join(os.tmpdir(), `houla-print-${Date.now()}.pdf`);

    try {
      await fs.writeFile(tmpFile, pdfBuffer);

      if (process.platform === 'win32') {
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);
        // Use SumatraPDF or system default for silent printing
        await execAsync(
          `powershell -Command "Start-Process -FilePath '${tmpFile}' -Verb PrintTo -ArgumentList '${printerName}' -WindowStyle Hidden"`,
        );
      } else {
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);
        await execAsync(`lp -d "${printerName}" "${tmpFile}"`);
      }
    } finally {
      await fs.unlink(tmpFile).catch(() => {});
    }
  }

  /**
   * Print ESC/POS data to a receipt printer.
   */
  async printEscPos(printerName: string, escPosData: string): Promise<void> {
    // ESC/POS is essentially raw text — use the same raw printing pipeline
    if (process.platform === 'win32') {
      await this.printRawWindows(printerName, escPosData);
    } else {
      await this.printRawUnix(printerName, escPosData);
    }
  }

  /**
   * Send a test page to verify the printer works.
   */
  async testPrint(printerName: string): Promise<{ success: boolean; error?: string }> {
    const printer = this.detectedPrinters.find(p => p.name === printerName);
    if (!printer) return { success: false, error: 'Imprimante non trouvée' };

    try {
      if (printer.type === 'niimbot') {
        return await this.testPrintNiimbot(printerName);
      } else if (printer.type === 'thermal') {
        // ZPL test label
        const testZpl = `^XA
^FO20,20^A0N,40,40^FDHou.la Print^FS
^FO20,70^A0N,25,25^FDTest impression^FS
^FO20,100^A0N,20,20^FD${new Date().toLocaleString('fr-FR')}^FS
^FO20,140^BY2^BCN,60,Y,N,N^FD1234567890^FS
^XZ`;
        await this.printZpl(printerName, testZpl);
      } else if (printer.type === 'receipt') {
        // ESC/POS test receipt
        const testEscPos = [
          '================================',
          '       Hou.la Print',
          '    Test d\'impression',
          `    ${new Date().toLocaleString('fr-FR')}`,
          '================================',
          '',
          'Si vous voyez ce message,',
          'votre imprimante fonctionne !',
          '',
          '================================',
          '\n\n\n',
        ].join('\n');
        await this.printEscPos(printerName, testEscPos);
      } else {
        // For standard printers, we just notify — full PDF test is complex
        new Notification({
          title: 'Hou.la Print',
          body: `Imprimante "${printerName}" détectée. Le test PDF sera disponible prochainement.`,
        }).show();
      }
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  }

  // ═══════════════════════════════════════════════════════
  // Niimbot printing
  // ═══════════════════════════════════════════════════════

  /**
   * Print a product label on a Niimbot printer.
   * Connects, renders the label as a monochrome bitmap, sends it, and disconnects.
   */
  async printNiimbot(
    printerName: string,
    content: LabelContent,
    labelSize: import('../../shared/types').PrintLabelSize = '40x30',
    model: NiimbotModelSpec = DEFAULT_MODEL,
  ): Promise<void> {
    const portPath = this.extractNiimbotPort(printerName);

    try {
      if (!this.niimbot.isConnected() || this.connectedNiimbotPort !== portPath) {
        await this.niimbot.connect(portPath);
        this.connectedNiimbotPort = portPath;
      }

      const label = renderProductLabel(content, labelSize, model);
      const result = await this.niimbot.printBitmap(
        label.bitmap, label.widthDots, label.heightDots,
      );

      if (!result.success) {
        throw new Error(result.error || 'Niimbot print failed');
      }
    } finally {
      // Keep connection open for subsequent prints (disconnect on idle via timer)
    }
  }

  /**
   * Test print on a Niimbot printer.
   */
  private async testPrintNiimbot(printerName: string): Promise<{ success: boolean; error?: string }> {
    const portPath = this.extractNiimbotPort(printerName);
    console.log(`[Printer] testPrintNiimbot: port=${portPath}, printerName=${printerName}`);

    try {
      // Disconnect any existing connection first to avoid "Access denied"
      if (this.niimbot.isConnected()) {
        console.log('[Printer] Disconnecting previous Niimbot session...');
        await this.niimbot.disconnect();
      }

      await this.niimbot.connect(portPath);
      this.connectedNiimbotPort = portPath;
      console.log('[Printer] Niimbot connected, sending test print...');
      const result = await this.niimbot.testPrint();
      console.log(`[Printer] Test print result: success=${result.success}, error=${result.error || 'none'}`);
      return result;
    } catch (err: any) {
      console.error(`[Printer] testPrintNiimbot failed:`, err.message);
      return { success: false, error: err.message || String(err) };
    } finally {
      // Always disconnect after test print to release the port
      try { await this.niimbot.disconnect(); } catch { /* ignore */ }
      this.connectedNiimbotPort = null;
    }
  }

  /**
   * Get the Niimbot service instance (for advanced operations).
   */
  getNiimbotService(): NiimbotService {
    return this.niimbot;
  }

  /**
   * Probe a Niimbot printer to read its model name / print head width.
   */
  async probePrinter(printerName: string): Promise<{ modelName: string; widthDots: number } | null> {
    const portPath = this.extractNiimbotPort(printerName);
    try {
      return await this.niimbot.probeModel(portPath);
    } catch (err) {
      console.warn('[Printer] Probe failed for', printerName, (err as Error).message);
      return null;
    }
  }

  /**
   * Generate a label preview as a base64-encoded BMP string.
   * Renders a mock product label at the given size and returns a data URI.
   */
  generatePreviewBase64(labelSize: import('../../shared/types').PrintLabelSize): string {
    const mockContent: LabelContent = {
      productName: 'Exemple produit',
      price: '12,50 €',
      barcode: '3760001234567',
      brandName: 'Ma Boutique',
      sku: 'SKU-001',
      variant: 'Taille M / Bleu',
    };

    const label = renderProductLabel(mockContent, labelSize, DEFAULT_MODEL);
    return bitmapToBmpBase64(label.bitmap, label.widthDots, label.heightDots);
  }

  /**
   * Extract the serial port path from a niimbot printer name.
   * Format: "niimbot:COM3" → "COM3"
   */
  private extractNiimbotPort(printerName: string): string {
    if (printerName.startsWith('niimbot:')) {
      return printerName.substring('niimbot:'.length);
    }
    return printerName;
  }

  // ═══════════════════════════════════════════════════════
  // Raw printing — platform specific
  // ═══════════════════════════════════════════════════════

  /**
   * Windows: Send raw data to printer via PowerShell + Win32 spooler.
   */
  private async printRawWindows(printerName: string, data: string): Promise<void> {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const fs = await import('fs/promises');
    const os = await import('os');
    const path = await import('path');

    const execAsync = promisify(exec);
    const tmpFile = path.join(os.tmpdir(), `houla-raw-${Date.now()}.bin`);

    try {
      await fs.writeFile(tmpFile, data, 'utf-8');

      // Use COPY /B for raw printing to the Windows printer spooler
      // Printer name must be escaped for cmd
      const safePrinterName = printerName.replace(/"/g, '""');
      await execAsync(`copy /B "${tmpFile}" "\\\\localhost\\${safePrinterName}"`, {
        shell: 'cmd.exe',
      });
    } finally {
      await fs.unlink(tmpFile).catch(() => {});
    }
  }

  /**
   * macOS/Linux: Send raw data to printer via lp command.
   */
  private async printRawUnix(printerName: string, data: string): Promise<void> {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const fs = await import('fs/promises');
    const os = await import('os');
    const path = await import('path');

    const execAsync = promisify(exec);
    const tmpFile = path.join(os.tmpdir(), `houla-raw-${Date.now()}.bin`);

    try {
      await fs.writeFile(tmpFile, data, 'utf-8');
      await execAsync(`lp -d "${printerName}" -o raw "${tmpFile}"`);
    } finally {
      await fs.unlink(tmpFile).catch(() => {});
    }
  }
}

// ═══════════════════════════════════════════════════════
// BMP encoder — converts 1-bit packed bitmap to BMP base64 data URI
// ═══════════════════════════════════════════════════════

/**
 * Convert a 1-bit packed bitmap (MSB first) to a Windows BMP base64 data URI.
 * BMP stores rows bottom-to-top and pads each row to 4-byte boundary.
 */
function bitmapToBmpBase64(bitmap: Buffer, width: number, height: number): string {
  const srcBytesPerRow = Math.ceil(width / 8);
  const bmpBytesPerRow = Math.ceil(width / 8);
  const bmpPaddedRow = (bmpBytesPerRow + 3) & ~3; // pad to 4-byte boundary
  const pixelDataSize = bmpPaddedRow * height;

  // BMP file: 14 (file header) + 40 (info header) + 8 (color table: 2 entries) + pixel data
  const headerSize = 14 + 40 + 8;
  const fileSize = headerSize + pixelDataSize;
  const buf = Buffer.alloc(fileSize, 0);

  // -- File Header (14 bytes) --
  buf.write('BM', 0);                                   // signature
  buf.writeUInt32LE(fileSize, 2);                        // file size
  buf.writeUInt32LE(0, 6);                               // reserved
  buf.writeUInt32LE(headerSize, 10);                     // pixel data offset

  // -- Info Header (40 bytes, BITMAPINFOHEADER) --
  buf.writeUInt32LE(40, 14);                             // header size
  buf.writeInt32LE(width, 18);                           // width
  buf.writeInt32LE(height, 22);                          // height (positive = bottom-up)
  buf.writeUInt16LE(1, 26);                              // planes
  buf.writeUInt16LE(1, 28);                              // bits per pixel
  buf.writeUInt32LE(0, 30);                              // compression (none)
  buf.writeUInt32LE(pixelDataSize, 34);                  // image size
  buf.writeInt32LE(3937, 38);                            // X pixels/meter (~100 DPI)
  buf.writeInt32LE(3937, 42);                            // Y pixels/meter
  buf.writeUInt32LE(2, 46);                              // colors used
  buf.writeUInt32LE(2, 50);                              // important colors

  // -- Color table (2 entries × 4 bytes) --
  // Index 0 = white (background), Index 1 = black (foreground)
  // In BMP 1-bit: bit=0 → palette[0], bit=1 → palette[1]
  buf.writeUInt32LE(0x00FFFFFF, 54);                     // palette[0] = white (BGRA)
  buf.writeUInt32LE(0x00000000, 58);                     // palette[1] = black (BGRA)

  // -- Pixel data (bottom-up) --
  for (let y = 0; y < height; y++) {
    const srcRow = (height - 1 - y); // BMP is bottom-up
    const srcOffset = srcRow * srcBytesPerRow;
    const dstOffset = headerSize + y * bmpPaddedRow;
    bitmap.copy(buf, dstOffset, srcOffset, srcOffset + srcBytesPerRow);
  }

  return 'data:image/bmp;base64,' + buf.toString('base64');
}
