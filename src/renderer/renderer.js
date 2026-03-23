// @ts-check

/**
 * Hou.la Print — Renderer process (UI logic)
 * Communicates with main process via the `houlaPrint` bridge exposed by preload.
 */

/** @type {typeof window & { houlaPrint: any }} */
const win = /** @type {any} */ (window);
const api = win.houlaPrint;

// ═══════════════════════════════════════════════════════
// DOM references
// ═══════════════════════════════════════════════════════

const $viewLogin = document.getElementById('view-login');
const $viewDashboard = document.getElementById('view-dashboard');
const $statusDot = document.getElementById('status-dot');
const $statusText = document.getElementById('status-text');
const $statPending = document.getElementById('stat-pending');
const $statToday = document.getElementById('stat-today');
const $workspaceList = document.getElementById('workspace-list');
const $printerList = document.getElementById('printer-list');
const $assignmentList = document.getElementById('assignment-list');
const $errorBanner = document.getElementById('error-banner');
const $errorText = document.getElementById('error-text');
const $envBadge = document.getElementById('env-badge');
const $settingEnv = document.getElementById('setting-env');
const $settingApiUrl = document.getElementById('setting-api-url');

const JOB_TYPE_LABELS = {
  product_label: 'Étiquettes produits',
  order_summary: 'Récapitulatif commande',
  invoice: 'Facture',
  shipping_label: 'Étiquette expédition',
  packing_slip: 'Bordereau de livraison',
};

const PRINTER_TYPE_ICONS = {
  thermal: '🏷️',
  receipt: '🧾',
  standard: '🖨️',
  unknown: '❓',
};

// ═══════════════════════════════════════════════════════
// State management
// ═══════════════════════════════════════════════════════

let currentState = null;

function updateUI(state) {
  currentState = state;

  // Toggle views
  if (state.authenticated) {
    $viewLogin.classList.add('hidden');
    $viewDashboard.classList.remove('hidden');
  } else {
    $viewLogin.classList.remove('hidden');
    $viewDashboard.classList.add('hidden');
    return;
  }

  // Status bar
  if (state.connected) {
    $statusDot.classList.add('connected');
    $statusText.textContent = 'Connecté';
  } else {
    $statusDot.classList.remove('connected');
    $statusText.textContent = 'Déconnecté';
  }

  $statPending.textContent = `${state.pendingJobsCount} en attente`;
  $statToday.textContent = `${state.printedTodayCount} imprimé(s)`;

  // Environment badge
  if (state.env === 'development') {
    $envBadge.classList.remove('hidden');
  } else {
    $envBadge.classList.add('hidden');
  }
  $settingEnv.textContent = state.env || 'production';
  $settingApiUrl.textContent = state.apiUrl || '—';

  // Error banner
  if (state.lastError) {
    $errorBanner.classList.remove('hidden');
    $errorText.textContent = state.lastError;
  } else {
    $errorBanner.classList.add('hidden');
  }

  // Render lists
  renderWorkspaces(state.workspaces);
  renderPrinters(state.printers);
  renderAssignments(state.printerAssignments, state.printers);
}

// ═══════════════════════════════════════════════════════
// Workspace list
// ═══════════════════════════════════════════════════════

function renderWorkspaces(workspaces) {
  if (!workspaces || workspaces.length === 0) {
    $workspaceList.innerHTML = '<div class="empty-state">Aucune boutique trouvée</div>';
    return;
  }

  $workspaceList.innerHTML = workspaces.map(ws => `
    <div class="card">
      <div class="card-icon">🏪</div>
      <div class="card-body">
        <div class="card-title">${escapeHtml(ws.workspace.name)}</div>
        <div class="card-subtitle">${ws.config?.enabled ? 'Impression activée' : 'Impression désactivée'}</div>
      </div>
      <div class="card-action">
        <label class="toggle">
          <input type="checkbox" ${ws.enabled ? 'checked' : ''} data-workspace-id="${ws.workspace.id}">
          <span class="toggle-slider"></span>
        </label>
      </div>
    </div>
  `).join('');

  // Bind toggle events
  $workspaceList.querySelectorAll('input[type="checkbox"]').forEach(el => {
    el.addEventListener('change', (e) => {
      const wsId = e.target.dataset.workspaceId;
      api.toggleWorkspace(wsId, e.target.checked);
    });
  });
}

// ═══════════════════════════════════════════════════════
// Printer list
// ═══════════════════════════════════════════════════════

function renderPrinters(printers) {
  if (!printers || printers.length === 0) {
    $printerList.innerHTML = '<div class="empty-state">Aucune imprimante détectée</div>';
    return;
  }

  $printerList.innerHTML = printers.map(p => `
    <div class="card">
      <div class="card-icon">${PRINTER_TYPE_ICONS[p.type] || '🖨️'}</div>
      <div class="card-body">
        <div class="card-title">${escapeHtml(p.displayName)}</div>
        <div class="card-subtitle">${p.type} ${p.isDefault ? '• par défaut' : ''}</div>
      </div>
      <div class="card-action">
        <button class="btn btn-sm btn-ghost" data-test-printer="${escapeAttr(p.name)}">Test</button>
      </div>
    </div>
  `).join('');

  // Bind test buttons
  $printerList.querySelectorAll('[data-test-printer]').forEach(el => {
    el.addEventListener('click', async (e) => {
      const name = e.currentTarget.dataset.testPrinter;
      e.currentTarget.textContent = '...';
      const result = await api.testPrinter(name);
      e.currentTarget.textContent = result.success ? '✓' : '✕';
      setTimeout(() => { e.currentTarget.textContent = 'Test'; }, 2000);
    });
  });
}

// ═══════════════════════════════════════════════════════
// Printer assignments
// ═══════════════════════════════════════════════════════

function renderAssignments(assignments, printers) {
  const printerOptions = (printers || [])
    .map(p => `<option value="${escapeAttr(p.name)}">${escapeHtml(p.displayName)}</option>`)
    .join('');

  $assignmentList.innerHTML = Object.entries(JOB_TYPE_LABELS).map(([type, label]) => {
    const currentPrinter = assignments?.[type] || '';
    return `
      <div class="assignment-item">
        <span class="assignment-label">${label}</span>
        <select class="assignment-select" data-job-type="${type}">
          <option value="">Non assignée</option>
          ${printerOptions}
        </select>
      </div>
    `;
  }).join('');

  // Set current values
  $assignmentList.querySelectorAll('select').forEach(el => {
    const type = el.dataset.jobType;
    const current = assignments?.[type] || '';
    el.value = current;

    el.addEventListener('change', (e) => {
      api.assignPrinter(type, e.target.value || null);
    });
  });
}

// ═══════════════════════════════════════════════════════
// Tab navigation
// ═══════════════════════════════════════════════════════

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    // Remove active from all tabs
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));

    // Activate clicked tab
    tab.classList.add('active');
    const panel = document.getElementById(`panel-${tab.dataset.tab}`);
    if (panel) {
      panel.classList.remove('hidden');
      panel.classList.add('active');
    }
  });
});

// ═══════════════════════════════════════════════════════
// Button handlers
// ═══════════════════════════════════════════════════════

document.getElementById('btn-login').addEventListener('click', () => api.login());
document.getElementById('btn-logout').addEventListener('click', () => api.logout());
document.getElementById('btn-minimize').addEventListener('click', () => api.minimize());
document.getElementById('btn-close').addEventListener('click', () => api.minimize());
document.getElementById('btn-refresh-workspaces').addEventListener('click', () => api.refreshWorkspaces());
document.getElementById('btn-refresh-printers').addEventListener('click', () => api.listPrinters());
document.getElementById('btn-retry-all').addEventListener('click', () => api.retryAllFailed());
document.getElementById('btn-open-dashboard').addEventListener('click', () => api.openExternal('https://app.hou.la/manager'));

// ═══════════════════════════════════════════════════════
// IPC listener: state updates from main process
// ═══════════════════════════════════════════════════════

api.onStateUpdated((state) => updateUI(state));

// Initial state fetch
api.getState().then((state) => updateUI(state));

// ═══════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function escapeAttr(str) {
  return (str || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
