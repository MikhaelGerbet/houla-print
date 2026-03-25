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
            displayName: `Niimbot (${dev.port})${dev.friendlyName ? ' — ' + dev.friendlyName : ''}`,
            isDefault: false,
            status: 0,
            description: `Niimbot via ${dev.port}`,
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
            displayName: `${p.manufacturer || 'Serial'} (${p.port})`,
            isDefault: false,
            status: 0,
            description: `Serial port ${p.port} — ${p.manufacturer || 'unknown'}`,
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

    try {
      await this.niimbot.connect(portPath);
      this.connectedNiimbotPort = portPath;
      const result = await this.niimbot.testPrint();
      return result;
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  }

  /**
   * Get the Niimbot service instance (for advanced operations).
   */
  getNiimbotService(): NiimbotService {
    return this.niimbot;
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
