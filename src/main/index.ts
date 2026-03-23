import { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, Notification } from 'electron';
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

// Single instance lock — prevent multiple windows
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

// Register custom protocol for OAuth callback
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(APP_PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient(APP_PROTOCOL);
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
    icon: getTrayIcon(),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    // Don't show on startup — stay in tray
  });

  mainWindow.on('close', (e) => {
    // Minimize to tray instead of closing
    e.preventDefault();
    mainWindow?.hide();
  });
}

function getTrayIcon(): Electron.NativeImage {
  const iconPath = path.join(__dirname, '..', '..', 'assets', 'tray-icon.png');
  try {
    return nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  } catch {
    // Fallback: empty 16x16 icon
    return nativeImage.createEmpty();
  }
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
      click: () => shell.openExternal('https://app.hou.la/manager'),
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

function initServices(): void {
  store = new StoreService();
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
    await auth.login();
    await workspaces.refresh();
    socket.connectAll(workspaces.getActiveWorkspaces());
    broadcastState();
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
  initServices();
  createWindow();
  createTray();
  registerIpcHandlers();

  // Auto-detect printers
  await printer.detectPrinters();

  // If already authenticated, auto-connect
  if (auth.isAuthenticated()) {
    await workspaces.refresh();
    socket.connectAll(workspaces.getActiveWorkspaces());
    // Fetch pending jobs from API on startup
    await queue.fetchPendingFromApi(workspaces.getActiveWorkspaces());
  }

  broadcastState();

  // Periodic printer detection (every 30s)
  setInterval(async () => {
    await printer.detectPrinters();
  }, 30_000);
});

app.on('window-all-closed', () => {
  // Keep running in tray — don't quit
});

app.on('before-quit', () => {
  socket.disconnectAll();
  queue.close();
});
