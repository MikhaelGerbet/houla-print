// Shared configuration constants

export const APP_NAME = 'Hou.la Print';
export const APP_PROTOCOL = 'houla-print';

// API endpoints per environment
export const API_URLS = {
  production: 'https://hou.la',
  development: 'http://localhost:53001',
} as const;

export const APP_URLS = {
  production: 'https://app.hou.la',
  development: 'https://localhost:59223',
} as const;

export const WS_PATH = '/ws';

export const OAUTH_CLIENT_ID = 'houla-print-desktop';

// Job type → printer classification hint
export const JOB_TYPE_PRINTER_HINT: Record<string, 'thermal' | 'receipt' | 'standard'> = {
  product_label: 'thermal',
  order_summary: 'receipt',
  invoice: 'standard',
  shipping_label: 'thermal',
  packing_slip: 'standard',
};
