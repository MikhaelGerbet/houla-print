import { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, Notification } from 'electron';
import { autoUpdater } from 'electron-updater';
import * as path from 'path';
import { AuthService } from './services/auth.service';
import { SocketService } from './services/socket.service';
import { PrinterService } from './services/printer.service';
import { QueueService } from './services/queue.service';
import { StoreService } from './services/store.service';
import { WorkspaceService } from './services/workspace.service';
import { ApiService } from './services/api.service';
import { IPC, AppState } from '../shared/types';
import { APP_NAME, APP_PROTOCOL } from '../shared/config';

// Catch unhandled errors
process.on('uncaughtException', (err) => {
  console.error('[Main] Uncaught exception:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[Main] Unhandled rejection:', err);
});

console.log('[Main] Starting Hou.la Print...');

// Single instance lock — prevent multiple windows
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

// Disable GPU hardware acceleration to avoid Windows GPU cache errors
// ("GPU state invalid after WaitForGetOffsetInRange")
app.disableHardwareAcceleration();

// Set app name so OS protocol handler dialog shows "Hou.la Print" instead of "Electron"
if (process.platform === 'win32') {
  app.setAppUserModelId('com.houla.print');
}
app.setName(APP_NAME);

// Register custom protocol for OAuth callback
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(APP_PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient(APP_PROTOCOL);
}

// In dev mode, patch Windows registry so browser shows "Hou.la Print" instead of "Electron"
if (process.platform === 'win32' && process.defaultApp) {
  try {
    const { execSync } = require('child_process');
    const regBase = `HKCU\\Software\\Classes\\${APP_PROTOCOL}`;
    execSync(`reg add "${regBase}" /ve /d "URL:${APP_NAME}" /f`, { stdio: 'ignore' });
    execSync(`reg add "${regBase}\\shell\\open" /v "FriendlyAppName" /d "${APP_NAME}" /f`, { stdio: 'ignore' });
  } catch { /* non-critical */ }
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

// Services
let store: StoreService;
let auth: AuthService;
let api: ApiService;
let socket: SocketService;
let printer: PrinterService;
let queue: QueueService;
let workspaces: WorkspaceService;

function getAppIcon(): Electron.NativeImage {
  const pngPath = path.join(__dirname, '..', '..', 'assets', 'icon.png');
  try {
    const fs = require('fs');
    if (fs.existsSync(pngPath)) {
      return nativeImage.createFromPath(pngPath);
    }
  } catch {
    // Fallback
  }
  return nativeImage.createEmpty();
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 680,
    minWidth: 400,
    minHeight: 500,
    resizable: true,
    frame: false,
    titleBarStyle: 'hidden',
    show: false,
    skipTaskbar: false,
    icon: getAppIcon(),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // Required so preload can require() shared modules
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    console.log('[Main] Window ready-to-show.');
    // In dev mode, always show the window and open DevTools
    if (detectEnv() === 'development') {
      mainWindow?.show();
      mainWindow?.webContents.openDevTools({ mode: 'detach' });
    }
    // In production, stay hidden in tray
  });

  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[Main] Renderer crashed:', details.reason, details.exitCode);
  });

  mainWindow.webContents.on('did-fail-load', (_e, errorCode, errorDescription) => {
    console.error('[Main] Failed to load:', errorCode, errorDescription);
  });

  mainWindow.on('close', (e) => {
    // Minimize to tray instead of closing
    e.preventDefault();
    mainWindow?.hide();
  });
}

function getTrayIcon(): Electron.NativeImage {
  const pngPath = path.join(__dirname, '..', '..', 'assets', 'tray-icon.png');
  try {
    const fs = require('fs');
    if (fs.existsSync(pngPath)) {
      return nativeImage.createFromPath(pngPath).resize({ width: 16, height: 16 });
    }
  } catch {
    // Fallback
  }
  return nativeImage.createEmpty();
}

function createTray(): void {
  tray = new Tray(getTrayIcon());
  tray.setToolTip(APP_NAME);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Afficher',
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      },
    },
    { type: 'separator' },
    {
      label: 'Dashboard Hou.la',
      click: () => shell.openExternal(`${store.getAppUrl()}/manager/shop/settings`),
    },
    { type: 'separator' },
    {
      label: 'Quitter',
      click: () => {
        app.exit(0);
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    if (mainWindow?.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow?.show();
      mainWindow?.focus();
    }
  });
}

function detectEnv(): 'production' | 'development' {
  // CLI flag takes precedence
  if (process.argv.includes('--dev')) return 'development';
  // NODE_ENV from environment
  if (process.env.NODE_ENV === 'development') return 'development';
  // Electron: app.isPackaged is false when running via `electron .`
  if (!app.isPackaged) return 'development';
  return 'production';
}

function initServices(): void {
  store = new StoreService();
  store.setEnv(detectEnv());
  api = new ApiService(store);
  auth = new AuthService(store, api);
  printer = new PrinterService();
  queue = new QueueService(store, api, printer);
  workspaces = new WorkspaceService(store, api);
  socket = new SocketService(store, queue, workspaces, () => broadcastState());
}

function registerIpcHandlers(): void {
  // Auth
  ipcMain.handle(IPC.AUTH_LOGIN, async () => {
    // Only open browser — token exchange + workspace sync happens in handleDeepLink()
    await auth.login();
  });

  ipcMain.handle(IPC.AUTH_LOGOUT, async () => {
    socket.disconnectAll();
    auth.logout();
    broadcastState();
  });

  ipcMain.handle(IPC.AUTH_STATUS, () => auth.isAuthenticated());

  // State
  ipcMain.handle(IPC.GET_STATE, () => getAppState());

  // Workspaces
  ipcMain.handle(IPC.WORKSPACE_TOGGLE, async (_e, workspaceId: string, enabled: boolean) => {
    await workspaces.toggle(workspaceId, enabled);
    if (enabled) {
      socket.connect(workspaceId, workspaces.getApiKey(workspaceId));
    } else {
      socket.disconnect(workspaceId);
    }
    broadcastState();
  });

  ipcMain.handle(IPC.WORKSPACE_REFRESH, async () => {
    await workspaces.refresh();
    broadcastState();
  });

  // Printers
  ipcMain.handle(IPC.PRINTER_LIST, () => printer.detectPrinters());
  ipcMain.handle(IPC.PRINTER_ASSIGN, (_e, jobType: string, printerName: string | null) => {
    store.setPrinterAssignment(jobType, printerName);
    broadcastState();
  });
  ipcMain.handle(IPC.PRINTER_TEST, async (_e, printerName: string) => {
    return printer.testPrint(printerName);
  });

  // Queue
  ipcMain.handle(IPC.QUEUE_STATS, () => queue.getStats());
  ipcMain.handle(IPC.QUEUE_RETRY_ALL, async () => {
    await queue.retryAllFailed();
    broadcastState();
  });

  // Environment
  ipcMain.handle(IPC.SET_ENV, (_e, env: 'production' | 'development') => {
    store.setEnv(env);
    // Rebuild tray to reflect the new dashboard URL
    createTray();
    broadcastState();
  });

  // App
  ipcMain.on(IPC.APP_QUIT, () => app.exit(0));
  ipcMain.on(IPC.APP_MINIMIZE, () => mainWindow?.hide());
  ipcMain.on(IPC.OPEN_EXTERNAL, (_e, url: string) => {
    // Only allow https/http URLs to prevent arbitrary protocol execution
    if (url.startsWith('https://') || url.startsWith('http://')) {
      shell.openExternal(url);
    }
  });
}

function getAppState(): AppState {
  return {
    authenticated: auth.isAuthenticated(),
    connected: socket.isConnected(),
    workspaces: workspaces.getAll(),
    printers: printer.getLastDetected(),
    printerAssignments: store.getPrinterAssignments(),
    pendingJobsCount: queue.getPendingCount(),
    printedTodayCount: queue.getPrintedTodayCount(),
    lastError: queue.getLastError(),
    env: store.getEnv(),
    apiUrl: store.getApiUrl(),
    appUrl: store.getAppUrl(),
  };
}

function broadcastState(): void {
  mainWindow?.webContents.send(IPC.STATE_UPDATED, getAppState());
  updateTrayTooltip();
}

function updateTrayTooltip(): void {
  const pending = queue.getPendingCount();
  const status = socket.isConnected() ? 'Connecté' : 'Déconnecté';
  tray?.setToolTip(`${APP_NAME} — ${status} • ${pending} en attente`);
}

// Handle deep link (houla-print://callback?code=...)
function handleDeepLink(url: string): void {
  auth.handleOAuthCallback(url).then(async () => {
    await workspaces.refresh();
    socket.connectAll(workspaces.getActiveWorkspaces());
    broadcastState();
    mainWindow?.show();
    mainWindow?.focus();
  }).catch((err) => {
    console.error('OAuth callback error:', err);
    new Notification({
      title: APP_NAME,
      body: 'Erreur de connexion. Veuillez réessayer.',
    }).show();
  });
}

// ═══════════════════════════════════════════════════════
// App lifecycle
// ═══════════════════════════════════════════════════════

app.on('second-instance', (_e, argv) => {
  // Someone tried to run a second instance — focus ours instead
  mainWindow?.show();
  mainWindow?.focus();

  // Handle deep link from second instance (Windows)
  const deepLink = argv.find(arg => arg.startsWith(`${APP_PROTOCOL}://`));
  if (deepLink) handleDeepLink(deepLink);
});

app.on('open-url', (_e, url) => {
  // Handle deep link (macOS)
  handleDeepLink(url);
});

app.whenReady().then(async () => {
  console.log('[Main] App ready. Initializing...');
  try {
    initServices();
    console.log('[Main] Services initialized.');
  } catch (err) {
    console.error('[Main] initServices failed:', err);
    return;
  }
  try {
    createWindow();
    console.log('[Main] Window created.');
  } catch (err) {
    console.error('[Main] createWindow failed:', err);
    return;
  }
  try {
    createTray();
    console.log('[Main] Tray created.');
  } catch (err) {
    console.error('[Main] createTray failed:', err);
  }
  registerIpcHandlers();
  console.log('[Main] IPC handlers registered.');

  // Initialize auto updater
  try {
    autoUpdater.checkForUpdatesAndNotify();
  } catch (err) {
    console.error('Failed to check for updates', err);
  }

  // Auto-detect printers
  try {
    await printer.detectPrinters();
    console.log('[Main] Printers detected.');
  } catch (err) {
    console.error('[Main] detectPrinters failed:', err);
  }

  // If already authenticated, auto-connect
  try {
    if (auth.isAuthenticated()) {
      await workspaces.refresh();
      socket.connectAll(workspaces.getActiveWorkspaces());
      await queue.fetchPendingFromApi(workspaces.getActiveWorkspaces());
      console.log('[Main] Auto-reconnected.');
    }
  } catch (err) {
    console.error('[Main] Auto-reconnect failed:', err);
  }

  broadcastState();
  console.log('[Main] Init complete. App should stay running.');

  // Periodic printer detection (every 30s)
  setInterval(async () => {
    try { await printer.detectPrinters(); } catch { /* ignore */ }
  }, 30_000);
});

app.on('window-all-closed', () => {
  // Keep running in tray — don't quit
  console.log('[Main] window-all-closed event — ignoring, staying in tray.');
});

app.on('before-quit', () => {
  console.log('[Main] before-quit event.');
  socket.disconnectAll();
  queue.close();
});

process.on('exit', (code) => {
  console.log(`[Main] Process exiting with code: ${code}`);
});
