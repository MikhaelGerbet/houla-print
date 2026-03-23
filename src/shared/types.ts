// Shared types used by both main and renderer processes

export type PrintJobType = 'product_label' | 'order_summary' | 'invoice' | 'shipping_label' | 'packing_slip';
export type PrintJobStatus = 'pending' | 'sent' | 'printed' | 'failed' | 'cancelled';
export type PrintLabelFormat = 'zpl' | 'pdf' | 'escpos' | 'png';

export interface PrintJob {
  id: string;
  workspaceId: string;
  orderId: string | null;
  type: PrintJobType;
  status: PrintJobStatus;
  payload: Record<string, unknown>;
  labelFormat: PrintLabelFormat;
  labelData: string | null;
  labelUrl: string | null;
  attempts: number;
  lastError: string | null;
  printedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PrintConfig {
  id: string;
  workspaceId: string;
  enabled: boolean;
  autoProductLabels: boolean;
  autoOrderSummary: boolean;
  autoInvoice: boolean;
  autoInvoiceTrigger: 'paid' | 'processing';
  autoShippingLabel: boolean;
  autoPackingSlip: boolean;
  productLabelTemplate: 'standard' | 'minimal' | 'detailed';
  brandName: string | null;
}

export interface Workspace {
  id: string;
  name: string;
  type: string;
  avatarUrl: string | null;
  plan: string;
}

export interface WorkspaceState {
  workspace: Workspace;
  apiKey: string;
  enabled: boolean;
  config: PrintConfig | null;
}

export interface PrinterInfo {
  name: string;
  displayName: string;
  isDefault: boolean;
  status: number;
  description: string;
  /** Inferred printer type based on name/driver */
  type: 'thermal' | 'receipt' | 'standard' | 'unknown';
}

export interface PrinterAssignments {
  product_label: string | null;
  order_summary: string | null;
  invoice: string | null;
  shipping_label: string | null;
  packing_slip: string | null;
  [key: string]: string | null;
}

export interface AppState {
  authenticated: boolean;
  connected: boolean;
  workspaces: WorkspaceState[];
  printers: PrinterInfo[];
  printerAssignments: PrinterAssignments;
  pendingJobsCount: number;
  printedTodayCount: number;
  lastError: string | null;
}

/** IPC channel names for main ↔ renderer communication */
export const IPC = {
  // Auth
  AUTH_LOGIN: 'auth:login',
  AUTH_LOGOUT: 'auth:logout',
  AUTH_STATUS: 'auth:status',

  // State
  GET_STATE: 'state:get',
  STATE_UPDATED: 'state:updated',

  // Workspaces
  WORKSPACE_TOGGLE: 'workspace:toggle',
  WORKSPACE_REFRESH: 'workspace:refresh',

  // Printers
  PRINTER_LIST: 'printer:list',
  PRINTER_ASSIGN: 'printer:assign',
  PRINTER_TEST: 'printer:test',

  // Print queue
  QUEUE_STATS: 'queue:stats',
  QUEUE_RETRY_ALL: 'queue:retry-all',

  // App
  APP_QUIT: 'app:quit',
  APP_MINIMIZE: 'app:minimize',
  OPEN_EXTERNAL: 'app:open-external',
  NOTIFICATION: 'app:notification',
} as const;
