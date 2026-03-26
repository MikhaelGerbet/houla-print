// @ts-check

/**
 * Hou.la Print — Renderer process (UI logic)
 * Communicates with main process via the `houlaPrint` bridge exposed by preload.
 */

/** @type {typeof window & { houlaPrint: any }} */
const win = /** @type {any} */ (window);
const api = win.houlaPrint;

console.log('[Renderer] houlaPrint bridge available:', !!api);
if (!api) {
  console.error('[Renderer] FATAL: houlaPrint bridge not found. Preload script may have failed.');
}

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
const $labelSizeList = document.getElementById('label-size-list');
const $labelPreviewSection = document.getElementById('section-label-preview');
const $labelPreviewImg = document.getElementById('label-preview-img');
const $errorBanner = document.getElementById('error-banner');
const $errorText = document.getElementById('error-text');
const $envBadge = document.getElementById('env-badge');
const $settingEnv = document.getElementById('setting-env');
const $settingApiUrl = document.getElementById('setting-api-url');

const JOB_TYPE_LABELS = {
  product_label: 'Étiquettes produits',
  order_summary: 'Récapitulatif commande',
  invoice: 'Facture',
  // shipping_label and packing_slip: disabled until shipping module is implemented
};

const PRINTER_TYPE_ICONS = {
  thermal: '🏷️',
  receipt: '🧾',
  standard: '🖨️',
  niimbot: '🔵',
  unknown: '❓',
};

const LABEL_SIZE_OPTIONS = [
  { value: '57x32',   label: '57 × 32 mm — Standard' },
  { value: '40x30',   label: '40 × 30 mm — Petit (bijoux)' },
  { value: '50x25',   label: '50 × 25 mm — Compact' },
  { value: '100x50',  label: '100 × 50 mm — Moyen' },
  { value: '100x100', label: '100 × 100 mm — Grand carré' },
  { value: '100x150', label: '100 × 150 mm — Expédition (6×4")' },
];

// ═══════════════════════════════════════════════════════
// State management
// ═══════════════════════════════════════════════════════

let currentState = null;
let testPrintInProgress = false;

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
  const statusMap = {
    'connected':    { dot: true,  text: 'Connecté' },
    'no-workspace': { dot: false, text: 'Activez une boutique' },
    'error':        { dot: false, text: 'Erreur connexion' },
    'disconnected': { dot: false, text: 'Déconnecté' },
  };
  const status = statusMap[state.connectionStatus] || statusMap['disconnected'];
  if (status.dot) {
    $statusDot.classList.add('connected');
  } else {
    $statusDot.classList.remove('connected');
  }
  $statusText.textContent = status.text;

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
    const isApiError = state.connectionStatus === 'error';
    $errorText.textContent = isApiError
      ? '⚠ ' + state.lastError
      : state.lastError;
  } else {
    $errorBanner.classList.add('hidden');
  }

  // Render lists
  renderWorkspaces(state.workspaces);
  if (!testPrintInProgress) {
    renderPrinters(state.printers);
  }
  renderAssignments(state.printerAssignments, state.printers);
  renderLabelSizes(state.workspaces);
}

// ═══════════════════════════════════════════════════════
// Workspace list
// ═══════════════════════════════════════════════════════

function renderWorkspaces(workspaces) {
  // Show all workspaces — user decides which to enable for printing
  const allWorkspaces = workspaces || [];

  if (allWorkspaces.length === 0) {
    $workspaceList.innerHTML = '<div class="empty-state">Aucune boutique trouvée</div>';
    return;
  }

  $workspaceList.innerHTML = allWorkspaces.map(ws => `
    <div class="card">
      <div class="card-icon">${ws.workspace.hasShop ? '🏪' : '📁'}</div>
      <div class="card-body">
        <div class="card-title">${escapeHtml(ws.workspace.name)}</div>
        <div class="card-subtitle">${ws.workspace.hasShop ? (ws.config?.enabled ? 'Impression activée' : 'Impression désactivée') : 'Pas de boutique'}</div>
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

  const typeLabels = {
    thermal: 'Thermique (ZPL)',
    receipt: 'Ticket (ESC/POS)',
    standard: 'Standard (PDF)',
    niimbot: 'Niimbot (étiquettes)',
    unknown: 'Inconnu',
  };

  $printerList.innerHTML = printers.map(p => `
    <div class="card">
      <div class="card-icon">${PRINTER_TYPE_ICONS[p.type] || '🖨️'}</div>
      <div class="card-body">
        <div class="card-title">${escapeHtml(p.displayName)}</div>
        <div class="card-subtitle">${typeLabels[p.type] || p.type}${p.description ? ' • ' + escapeHtml(p.description) : ''} ${p.isDefault ? '• par défaut' : ''}</div>
      </div>
      <div class="card-action">
        <button class="btn btn-sm btn-ghost btn-test" data-test-printer="${escapeAttr(p.name)}">
          <span class="btn-test-label">Test</span>
        </button>
      </div>
    </div>
  `).join('');

  // Bind test buttons
  $printerList.querySelectorAll('[data-test-printer]').forEach(el => {
    el.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const name = btn.dataset.testPrinter;
      const labelSpan = btn.querySelector('.btn-test-label');

      // Prevent re-render from wiping button state during print
      testPrintInProgress = true;

      // Disable button and show loading state
      btn.disabled = true;
      btn.classList.add('btn-test-loading');
      if (labelSpan) labelSpan.textContent = 'Impression…';

      try {
        const result = await api.testPrinter(name);
        btn.classList.remove('btn-test-loading');

        if (result.success) {
          btn.classList.add('btn-test-success');
          if (labelSpan) labelSpan.textContent = '✓ OK';
          // If RFID detected a label size, update the dropdown
          if (result.detectedLabel) {
            const dl = result.detectedLabel;
            const sizeStr = dl.widthMm + 'x' + dl.heightMm;
            updateDetectedLabelSize(sizeStr, dl);
          }
        } else {
          btn.classList.add('btn-test-error');
          if (labelSpan) labelSpan.textContent = '✕ ' + (result.error || 'Erreur');
        }
      } catch (err) {
        btn.classList.remove('btn-test-loading');
        btn.classList.add('btn-test-error');
        if (labelSpan) labelSpan.textContent = '✕ ' + (err.message || 'Erreur');
      }

      setTimeout(() => {
        testPrintInProgress = false;
        btn.disabled = false;
        btn.classList.remove('btn-test-success', 'btn-test-error');
        if (labelSpan) labelSpan.textContent = 'Test';
      }, 4000);
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

// ═══════════════════════════════════════════════════════
// Label size per workspace
// ═══════════════════════════════════════════════════════

function renderLabelSizes(workspaces) {
  const shopWorkspaces = (workspaces || []).filter(ws => ws.workspace.hasShop && ws.enabled);

  if (shopWorkspaces.length === 0) {
    $labelSizeList.innerHTML = '<div class="empty-state">Activez une boutique pour configurer le format</div>';
    return;
  }

  const sizeOptions = LABEL_SIZE_OPTIONS
    .map(o => `<option value="${escapeAttr(o.value)}">${escapeHtml(o.label)}</option>`)
    .join('');

  $labelSizeList.innerHTML = shopWorkspaces.map(ws => {
    const currentSize = ws.config?.productLabelSize || '57x32';
    return `
      <div class="assignment-item">
        <span class="assignment-label">${escapeHtml(ws.workspace.name)}</span>
        <select class="assignment-select" data-ws-label-size="${ws.workspace.id}">
          ${sizeOptions}
        </select>
      </div>
    `;
  }).join('');

  // Set current values and bind change events
  $labelSizeList.querySelectorAll('select').forEach(el => {
    const wsId = el.dataset.wsLabelSize;
    const ws = shopWorkspaces.find(w => w.workspace.id === wsId);
    el.value = ws?.config?.productLabelSize || '57x32';

    el.addEventListener('change', (e) => {
      api.updateWorkspaceConfig(wsId, { productLabelSize: e.target.value });
      loadLabelPreview(e.target.value);
    });
  });

  // Load initial preview with the first workspace's label size
  const firstSize = shopWorkspaces[0]?.config?.productLabelSize || '57x32';
  loadLabelPreview(firstSize);
}

/**
 * Load and display a label preview for the given label size.
 */
async function loadLabelPreview(labelSize) {
  if (!api || !$labelPreviewSection || !$labelPreviewImg) return;
  try {
    $labelPreviewSection.style.display = '';
    $labelPreviewImg.alt = 'Chargement...';
    const dataUri = await api.previewLabel(labelSize);
    if (dataUri) {
      $labelPreviewImg.src = dataUri;
      $labelPreviewImg.alt = 'Aperçu étiquette ' + labelSize;
    }
  } catch (err) {
    console.error('[Renderer] Preview error:', err);
    $labelPreviewImg.alt = 'Erreur de chargement';
  }
}

/**
 * Update the label size dropdown when RFID auto-detects a label.
 * If the detected size matches a known option, select it.
 * If not, add it as a custom option.
 */
function updateDetectedLabelSize(sizeStr, detectedLabel) {
  if (!$labelSizeList) return;
  const selects = $labelSizeList.querySelectorAll('select');
  selects.forEach(el => {
    // Check if the size exists in the dropdown
    const existing = Array.from(el.options).find(o => o.value === sizeStr);
    if (existing) {
      el.value = sizeStr;
    } else {
      // Add a custom option for the detected size
      const opt = document.createElement('option');
      opt.value = sizeStr;
      opt.textContent = detectedLabel.widthMm + ' × ' + detectedLabel.heightMm + ' mm — Détecté (RFID)';
      el.appendChild(opt);
      el.value = sizeStr;
    }
    // Persist to workspace config
    const wsId = el.dataset.wsLabelSize;
    if (wsId) {
      api.updateWorkspaceConfig(wsId, { productLabelSize: sizeStr });
    }
    loadLabelPreview(sizeStr);
  });
  console.log('[Renderer] Label size updated from RFID: ' + sizeStr);
}



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

function bindBtn(id, handler) {
  const el = document.getElementById(id);
  if (el) {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      console.log(`[Renderer] Button clicked: ${id}`);
      handler();
    });
  } else {
    console.warn(`[Renderer] Button not found: ${id}`);
  }
}

bindBtn('btn-login', () => api.login());
bindBtn('btn-logout', () => api.logout());
bindBtn('btn-minimize', () => api.minimize());
bindBtn('btn-close', () => api.minimize());
bindBtn('btn-refresh-workspaces', async () => {
  $workspaceList.innerHTML = '<div class="loading-state"><span class="spinner"></span> Chargement des boutiques…</div>';
  try {
    await api.refreshWorkspaces();
  } catch (err) {
    $workspaceList.innerHTML = '<div class="error-state">Erreur : ' + escapeHtml(err.message || 'Impossible de charger les boutiques') + '</div>';
  }
});
bindBtn('btn-refresh-printers', async () => {
  $printerList.innerHTML = '<div class="loading-state"><span class="spinner"></span> Détection des imprimantes…</div>';
  try {
    await api.listPrinters();
  } catch (err) {
    $printerList.innerHTML = '<div class="error-state">Erreur : ' + escapeHtml(err.message || 'Impossible de détecter les imprimantes') + '</div>';
  }
});
bindBtn('btn-retry-all', () => api.retryAllFailed());
bindBtn('btn-open-dashboard', () => {
  const appUrl = currentState?.appUrl || 'https://app.hou.la';
  api.openExternal(`${appUrl}/manager`);
});

// ═══════════════════════════════════════════════════════
// IPC listener: state updates from main process
// ═══════════════════════════════════════════════════════

api.onStateUpdated((state) => updateUI(state));

// Initial state fetch
api.getState().then((state) => {
  updateUI(state);
  // Auto-detect printers on startup if authenticated and list is empty
  if (state.authenticated && (!state.printers || state.printers.length === 0)) {
    $printerList.innerHTML = '<div class="loading-state"><span class="spinner"></span> Détection des imprimantes…</div>';
    api.listPrinters().catch(() => {});
  }
});

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
