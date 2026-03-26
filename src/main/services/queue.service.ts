import { Notification } from 'electron';
import { StoreService } from './store.service';
import { ApiService } from './api.service';
import { PrinterService } from './printer.service';
import { PrintJob, WorkspaceState } from '../../shared/types';
import { LabelContent } from './niimbot';

const MAX_RETRIES = 3;
const RETRY_DELAYS = [2000, 5000, 15000]; // ms

/** Build "1/3" from quantityIndex and quantity fields */
function buildQuantityFraction(idx: unknown, total: unknown): string | undefined {
  const i = typeof idx === 'number' ? idx : parseInt(idx as string, 10);
  const t = typeof total === 'number' ? total : parseInt(total as string, 10);
  if (isNaN(i) || isNaN(t) || t <= 1) return undefined;
  return `${i}/${t}`;
}

/**
 * Local print queue: receives jobs from WebSocket or API polling,
 * routes them to the correct printer, handles retries, and acks the API.
 */
export class QueueService {
  private pendingJobs: Map<string, { job: PrintJob; apiKey: string; retries: number }> = new Map();
  private lastError: string | null = null;
  private processing = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private store: StoreService,
    private api: ApiService,
    private printer: PrinterService,
  ) {
    // Process queue every 2 seconds
    this.timer = setInterval(() => this.processNext(), 2000);
  }

  /**
   * Add jobs received from WebSocket to the local queue.
   */
  enqueueJobs(jobs: PrintJob[], apiKey: string): void {
    for (const job of jobs) {
      if (!this.pendingJobs.has(job.id)) {
        this.pendingJobs.set(job.id, { job, apiKey, retries: 0 });
      }
    }

    if (jobs.length > 0) {
      new Notification({
        title: 'Hou.la Print',
        body: `${jobs.length} nouveau${jobs.length > 1 ? 'x' : ''} job${jobs.length > 1 ? 's' : ''} d'impression`,
      }).show();
    }
  }

  /**
   * Remove cancelled jobs from the local queue.
   */
  cancelJobs(jobIds: string[]): void {
    for (const id of jobIds) {
      this.pendingJobs.delete(id);
    }
  }

  /**
   * Fetch pending jobs from the API for all active workspaces (on startup/reconnect).
   */
  async fetchPendingFromApi(activeWorkspaces: WorkspaceState[]): Promise<void> {
    for (const ws of activeWorkspaces) {
      await this.fetchPendingForWorkspace(ws.workspace.id, ws.apiKey);
    }
  }

  /**
   * Fetch pending jobs for a single workspace.
   */
  async fetchPendingForWorkspace(workspaceId: string, apiKey: string): Promise<void> {
    try {
      const jobs = await this.api.getPendingJobs(apiKey);
      this.enqueueJobs(jobs, apiKey);
    } catch (err) {
      console.error(`Failed to fetch pending jobs for workspace ${workspaceId}:`, err);
    }
  }

  /**
   * Process the next pending job in the queue.
   */
  private async processNext(): Promise<void> {
    if (this.processing) return;
    if (this.pendingJobs.size === 0) return;

    // Get first pending job (FIFO)
    const [jobId, entry] = this.pendingJobs.entries().next().value as [string, { job: PrintJob; apiKey: string; retries: number }];
    const { job, apiKey } = entry;

    // Check if a printer is assigned for this job type
    const assignments = this.store.getPrinterAssignments();
    const printerName = assignments[job.type];
    if (!printerName) {
      // No printer assigned — skip for now, don't remove from queue
      return;
    }

    this.processing = true;

    try {
      await this.executePrint(job, printerName);

      // Success — ack the API and remove from queue
      await this.api.ackJob(apiKey, job.id, 'printed').catch(console.error);
      this.pendingJobs.delete(jobId);
      this.store.incrementPrintedToday();
      this.lastError = null;
    } catch (err: any) {
      const errorMsg = err.message || String(err);
      console.error(`Print failed for job ${jobId}:`, errorMsg);

      entry.retries++;
      if (entry.retries >= MAX_RETRIES) {
        // Max retries reached — mark as failed
        await this.api.ackJob(apiKey, job.id, 'failed', errorMsg).catch(console.error);
        this.pendingJobs.delete(jobId);
        this.lastError = `Job ${jobId.substring(0, 8)} échoué: ${errorMsg}`;

        new Notification({
          title: 'Hou.la Print — Erreur',
          body: `Impression échouée après ${MAX_RETRIES} tentatives`,
        }).show();
      } else {
        // Schedule retry with backoff
        const delay = RETRY_DELAYS[entry.retries - 1] || 15000;
        this.lastError = `Tentative ${entry.retries}/${MAX_RETRIES}: ${errorMsg}`;
        setTimeout(() => {
          // Job stays in queue, will be retried on next processNext cycle
        }, delay);
      }
    } finally {
      this.processing = false;
    }
  }

  /**
   * Execute the actual print operation based on label format and printer type.
   */
  private async executePrint(job: PrintJob, printerName: string): Promise<void> {
    // Check if printer is a Niimbot (serial) — route to Niimbot pipeline
    if (printerName.startsWith('niimbot:') || this.isNiimbotPrinter(printerName)) {
      await this.executeNiimbotPrint(job, printerName);
      return;
    }

    switch (job.labelFormat) {
      case 'zpl':
        if (!job.labelData) throw new Error('No label data for ZPL job');
        await this.printer.printZpl(printerName, job.labelData);
        break;

      case 'escpos':
        if (!job.labelData) throw new Error('No label data for ESC/POS job');
        await this.printer.printEscPos(printerName, job.labelData);
        break;

      case 'pdf':
        if (job.labelData) {
          // Inline PDF (base64)
          const buffer = Buffer.from(job.labelData, 'base64');
          await this.printer.printPdf(printerName, buffer);
        } else if (job.labelUrl) {
          // Download PDF from API then print
          const data = await this.api.getLabelData(
            this.getApiKeyForJob(job),
            job.id,
          );
          const buffer = Buffer.from(data, 'base64');
          await this.printer.printPdf(printerName, buffer);
        } else {
          throw new Error('No label data or URL for PDF job');
        }
        break;

      default:
        throw new Error(`Unsupported label format: ${job.labelFormat}`);
    }
  }

  /**
   * Execute a print job targeting a Niimbot printer.
   * Converts the job payload into a label bitmap and sends via NIIMBOT protocol.
   */
  private async executeNiimbotPrint(job: PrintJob, printerName: string): Promise<void> {
    const p = job.payload;

    // Format price from cents if only priceCents is provided
    const formatPrice = (cents: unknown, currency: unknown): string | undefined => {
      if (typeof cents !== 'number') return undefined;
      const cur = (currency as string) || 'EUR';
      const val = (cents / 100).toFixed(2).replace('.', ',');
      return cur === 'EUR' ? val + ' €' : val + ' ' + cur;
    };

    const content: LabelContent = {
      // Product
      productName: (p.productName as string) || (p.name as string) || 'Produit',
      variant: (p.variant as string) || (p.variants as string) || undefined,
      sku: (p.sku as string) || undefined,
      price: (p.price as string) || formatPrice(p.priceCents, p.currency),
      originalPrice: (p.originalPrice as string) || formatPrice(p.originalPriceCents, p.currency),
      barcode: (p.barcode as string) || undefined,

      // Order
      orderId: (p.orderNumber as string) || (p.orderId as string) || undefined,
      orderDate: (p.orderDate as string) || undefined,
      orderTotal: (p.orderTotal as string) || (p.orderTotalFormatted as string) || undefined,
      quantityFraction: buildQuantityFraction(p.quantityIndex, p.quantity),

      // Customer
      customerName: (p.customerName as string) || undefined,
      socialHandle: (p.socialHandle as string) || undefined,
      country: (p.country as string) || undefined,

      // QR & Brand
      qrCodeUrl: (p.qrCodeUrl as string) || undefined,
      brandName: (p.brandName as string) || undefined,
      websiteUrl: (p.websiteUrl as string) || undefined,
    };

    // Get label size: prefer printer's RFID-detected format, fallback to default
    const printerFormat = this.store.getPrinterLabelFormat(printerName);
    const labelSize = printerFormat
      ? `${printerFormat.widthMm}x${printerFormat.heightMm}`
      : '40x30';

    await this.printer.printNiimbot(printerName, content, labelSize as any);
  }

  /**
   * Check if a printer name corresponds to a detected Niimbot device.
   */
  private isNiimbotPrinter(printerName: string): boolean {
    const detected = this.printer.getLastDetected();
    const p = detected.find(d => d.name === printerName);
    return p?.type === 'niimbot';
  }

  /**
   * Find the API key for a job's workspace.
   */
  private getApiKeyForJob(job: PrintJob): string {
    const workspaces = this.store.getWorkspaces();
    return workspaces[job.workspaceId]?.apiKey || '';
  }

  /**
   * Retry all failed jobs (re-enqueue).
   */
  async retryAllFailed(): Promise<void> {
    // Failed jobs were already removed — this retries by re-fetching from API
    const workspaces = this.store.getWorkspaces();
    for (const [wsId, wsData] of Object.entries(workspaces)) {
      if (wsData.enabled && wsData.apiKey) {
        await this.fetchPendingForWorkspace(wsId, wsData.apiKey);
      }
    }
  }

  getPendingCount(): number {
    return this.pendingJobs.size;
  }

  getPrintedTodayCount(): number {
    return this.store.getPrintedTodayCount();
  }

  getLastError(): string | null {
    return this.lastError;
  }

  getStats(): { pending: number; printedToday: number; lastError: string | null } {
    return {
      pending: this.getPendingCount(),
      printedToday: this.getPrintedTodayCount(),
      lastError: this.lastError,
    };
  }

  close(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
