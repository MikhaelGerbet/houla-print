import { BrowserWindow, Notification } from 'electron';
import { PrinterInfo } from '../../shared/types';

// Zebra / thermal printer name patterns
const THERMAL_PATTERNS = [/zebra/i, /zd[24]\d{2}/i, /gk4\d{2}/i, /gx4\d{2}/i, /zt[24]\d{2}/i, /brother\s*ql/i, /dymo/i];
// Receipt printer patterns
const RECEIPT_PATTERNS = [/epson\s*tm/i, /star\s*(tsp|sp)/i, /bixolon/i, /citizen\s*ct/i, /pos[-\s]?58/i, /pos[-\s]?80/i];

/**
 * Detects system printers, classifies them, and handles raw printing.
 */
export class PrinterService {
  private detectedPrinters: PrinterInfo[] = [];

  /**
   * Detect all system printers via Electron's webContents API.
   */
  async detectPrinters(): Promise<PrinterInfo[]> {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return this.detectedPrinters;

    const rawPrinters = await (win.webContents as any).getPrintersAsync() as Electron.PrinterInfo[];

    this.detectedPrinters = rawPrinters.map((p: Electron.PrinterInfo) => ({
      name: p.name,
      displayName: p.displayName || p.name,
      isDefault: p.isDefault,
      status: p.status,
      description: p.description || '',
      type: this.classifyPrinter(p.name, p.description || ''),
    }));

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
      if (printer.type === 'thermal') {
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
