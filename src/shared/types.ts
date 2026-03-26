// Shared types used by both main and renderer processes

export type PrintJobType = 'product_label' | 'order_summary' | 'invoice' | 'shipping_label' | 'packing_slip';
export type PrintJobStatus = 'pending' | 'sent' | 'printed' | 'failed' | 'cancelled';
export type PrintLabelFormat = 'zpl' | 'pdf' | 'escpos' | 'png' | 'niimbot';
export type PrintLabelSize = '57x32' | '40x30' | '50x30' | '50x25' | '100x50' | '100x100' | '100x150' | (string & {});

export const LABEL_SIZE_OPTIONS: { value: PrintLabelSize; label: string }[] = [
  { value: '57x32',   label: '57 × 32 mm — Standard' },
  { value: '40x30',   label: '40 × 30 mm — Petit (bijoux)' },
  { value: '50x30',   label: '50 × 30 mm — Niimbot standard' },
  { value: '50x25',   label: '50 × 25 mm — Compact' },
  { value: '100x50',  label: '100 × 50 mm — Moyen' },
  { value: '100x100', label: '100 × 100 mm — Grand carré' },
  { value: '100x150', label: '100 × 150 mm — Expédition (6×4")' },
];

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
  productLabelSize: PrintLabelSize;
  brandName: string | null;
}

export interface Workspace {
  id: string;
  name: string;
  type: string;
  avatarUrl: string | null;
  plan: string;
  hasShop?: boolean;
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
  type: 'thermal' | 'receipt' | 'standard' | 'niimbot' | 'unknown';
}

export interface PrinterAssignments {
  product_label: string | null;
  order_summary: string | null;
  invoice: string | null;
  shipping_label: string | null;
  packing_slip: string | null;
  [key: string]: string | null;
}

export type ConnectionStatus = 'connected' | 'disconnected' | 'no-workspace' | 'error';

export interface AppState {
  authenticated: boolean;
  connected: boolean;
  connectionStatus: ConnectionStatus;
  workspaces: WorkspaceState[];
  printers: PrinterInfo[];
  printerAssignments: PrinterAssignments;
  printerLabelFormats: Record<string, { widthMm: number; heightMm: number }>;
  pendingJobsCount: number;
  printedTodayCount: number;
  lastError: string | null;
  env: 'production' | 'development';
  apiUrl: string;
  appUrl: string;
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
  WORKSPACE_UPDATE_CONFIG: 'workspace:update-config',

  // Printers
  PRINTER_LIST: 'printer:list',
  PRINTER_ASSIGN: 'printer:assign',
  PRINTER_TEST: 'printer:test',
  PRINTER_PROBE: 'printer:probe',
  PRINTER_DETECT: 'printer:detect',
  PRINTER_PREVIEW: 'printer:preview',

  // Print queue
  QUEUE_STATS: 'queue:stats',
  QUEUE_RETRY_ALL: 'queue:retry-all',

  // App
  APP_QUIT: 'app:quit',
  APP_MINIMIZE: 'app:minimize',
  OPEN_EXTERNAL: 'app:open-external',
  SET_ENV: 'app:set-env',
  NOTIFICATION: 'app:notification',
} as const;
