import Store from 'electron-store';
import { PrinterAssignments, WorkspaceState } from '../../shared/types';

interface StoreSchema {
  // Auth
  accessToken: string | null;
  refreshToken: string | null;

  // Workspaces with API keys
  workspaces: Record<string, {
    apiKey: string;
    enabled: boolean;
    workspaceName: string;
  }>;

  // Printer assignments: jobType → printerName
  printerAssignments: PrinterAssignments;

  // Queue stats
  printedTodayCount: number;
  printedTodayDate: string; // YYYY-MM-DD — reset daily

  // App settings
  apiUrl: string;
  appUrl: string;
  env: 'production' | 'development';
}

const DEFAULT_PRINTER_ASSIGNMENTS: PrinterAssignments = {
  product_label: null,
  order_summary: null,
  invoice: null,
  shipping_label: null,
  packing_slip: null,
};

export class StoreService {
  private store: Store<StoreSchema>;

  constructor() {
    this.store = new Store<StoreSchema>({
      name: 'houla-print-config',
      encryptionKey: 'houla-print-v1',
      defaults: {
        accessToken: null,
        refreshToken: null,
        workspaces: {},
        printerAssignments: DEFAULT_PRINTER_ASSIGNMENTS,
        printedTodayCount: 0,
        printedTodayDate: new Date().toISOString().split('T')[0],
        apiUrl: 'https://hou.la',
        appUrl: 'https://app.hou.la',
        env: 'production',
      },
    });
  }

  // ═══════════════════════════════════════════════════════
  // Auth
  // ═══════════════════════════════════════════════════════

  getAccessToken(): string | null {
    return this.store.get('accessToken');
  }

  setAccessToken(token: string | null): void {
    this.store.set('accessToken', token);
  }

  getRefreshToken(): string | null {
    return this.store.get('refreshToken');
  }

  setRefreshToken(token: string | null): void {
    this.store.set('refreshToken', token);
  }

  clearAuth(): void {
    this.store.set('accessToken', null);
    this.store.set('refreshToken', null);
    this.store.set('workspaces', {});
  }

  // ═══════════════════════════════════════════════════════
  // Workspaces
  // ═══════════════════════════════════════════════════════

  getWorkspaces(): Record<string, { apiKey: string; enabled: boolean; workspaceName: string }> {
    return this.store.get('workspaces');
  }

  setWorkspace(workspaceId: string, data: { apiKey: string; enabled: boolean; workspaceName: string }): void {
    const all = this.getWorkspaces();
    all[workspaceId] = data;
    this.store.set('workspaces', all);
  }

  removeWorkspace(workspaceId: string): void {
    const all = this.getWorkspaces();
    delete all[workspaceId];
    this.store.set('workspaces', all);
  }

  setWorkspaceEnabled(workspaceId: string, enabled: boolean): void {
    const all = this.getWorkspaces();
    if (all[workspaceId]) {
      all[workspaceId].enabled = enabled;
      this.store.set('workspaces', all);
    }
  }

  // ═══════════════════════════════════════════════════════
  // Printers
  // ═══════════════════════════════════════════════════════

  getPrinterAssignments(): PrinterAssignments {
    return this.store.get('printerAssignments');
  }

  setPrinterAssignment(jobType: string, printerName: string | null): void {
    const assignments = this.getPrinterAssignments();
    if (jobType in assignments) {
      assignments[jobType] = printerName;
      this.store.set('printerAssignments', assignments);
    }
  }

  // ═══════════════════════════════════════════════════════
  // Stats
  // ═══════════════════════════════════════════════════════

  incrementPrintedToday(): number {
    const today = new Date().toISOString().split('T')[0];
    const storedDate = this.store.get('printedTodayDate');
    if (storedDate !== today) {
      this.store.set('printedTodayDate', today);
      this.store.set('printedTodayCount', 0);
    }
    const count = this.store.get('printedTodayCount') + 1;
    this.store.set('printedTodayCount', count);
    return count;
  }

  getPrintedTodayCount(): number {
    const today = new Date().toISOString().split('T')[0];
    if (this.store.get('printedTodayDate') !== today) {
      return 0;
    }
    return this.store.get('printedTodayCount');
  }

  // ═══════════════════════════════════════════════════════
  // API config
  // ═══════════════════════════════════════════════════════

  getApiUrl(): string {
    return this.store.get('apiUrl');
  }

  getAppUrl(): string {
    return this.store.get('appUrl');
  }

  getEnv(): 'production' | 'development' {
    return this.store.get('env');
  }

  setEnv(env: 'production' | 'development'): void {
    this.store.set('env', env);
    if (env === 'development') {
      this.store.set('apiUrl', 'http://localhost:53001');
      this.store.set('appUrl', 'https://localhost:59223');
    } else {
      this.store.set('apiUrl', 'https://hou.la');
      this.store.set('appUrl', 'https://app.hou.la');
    }
  }
}
