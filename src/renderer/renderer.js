// === Frontend 2.0 F2 — workspace chrome =====================================
// Navigation is NOT re-implemented. These are the same six existing views; the
// F2 sidebar only groups and renames them. The lazy-load loop further down
// (pinned by tests) still drives per-view loading, unchanged.
const navItems = document.querySelectorAll('.nav-item');
const views = document.querySelectorAll('.view');
const pageTitle = document.getElementById('page-title');
const pageContext = document.getElementById('page-context');
const sidebarNav = document.getElementById('sidebar-nav');

// English-only UI chrome (Frontend 2.0 decision 1). `viewContexts` is the
// workspace group shown to the left of the view name in the top bar.
const viewTitles = {
  dashboard: 'Home',
  numbers: 'All Leads',
  collector: 'Collection',
  history: 'Collection History',
  targets: 'Targets',
  settings: 'Settings',
  searches: 'Saved Searches',
  segments: 'Segments',
  queue: 'Research Queue',
  completed: 'Completed',
  icp: 'ICP',
  signals: 'Signals',
  opportunities: 'Opportunities'
};

const viewContexts = {
  dashboard: 'Workspace',
  numbers: 'Leads',
  collector: 'Discovery',
  history: 'Discovery',
  targets: 'Setup',
  settings: 'Setup',
  searches: 'Lists',
  segments: 'Lists',
  queue: 'Research',
  completed: 'Research',
  icp: 'Intelligence',
  signals: 'Intelligence',
  opportunities: 'Intelligence'
};

// A nav target must be a real, existing view. Anything else is refused rather
// than silently ignored, so a typo can never leave the app with no visible view.
function isKnownView(viewId) {
  return typeof viewId === 'string'
    && Object.prototype.hasOwnProperty.call(viewTitles, viewId)
    && document.getElementById(`view-${viewId}`) !== null;
}

function activateView(viewId) {
  if (!isKnownView(viewId)) return false;
  navItems.forEach((n) => {
    const isTarget = n.dataset.view === viewId;
    n.classList.toggle('active', isTarget);
    if (isTarget) {
      n.setAttribute('aria-current', 'page');
    } else {
      n.removeAttribute('aria-current');
    }
  });
  views.forEach((v) => v.classList.remove('active'));
  document.getElementById(`view-${viewId}`).classList.add('active');
  pageTitle.textContent = viewTitles[viewId];
  if (pageContext) pageContext.textContent = viewContexts[viewId] || 'Workspace';
  return true;
}

navItems.forEach(item => {
  item.addEventListener('click', () => {
    activateView(item.dataset.view);
  });
});

// 时钟
function updateClock() {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-GB', { hour12: false });
  document.getElementById('clock').textContent = timeStr;
}
setInterval(updateClock, 1000);
updateClock();

// === F1: density preference (renderer-local, no IPC) ========================
// Frontend 2.0 batch F1 (design tokens + density foundation). The preference is
// stored in localStorage and applied as data-density on <html>; styles.css
// resolves --row-h from that attribute, so switching costs one attribute write.
//
// There is deliberately NO visible control here. The Compact/Comfortable toggle
// in the top bar belongs to a later frontend batch, so nothing renders to switch
// it yet and the default (compact) matches the current table density. Only the
// underlying mechanism is introduced, as scoped for F1.
//
// localStorage access is wrapped in try/catch: it can throw in a hardened
// Electron profile and a density preference must never break startup.
const DENSITY_STORAGE_KEY = 'ztech.density';
const DENSITY_COMPACT = 'compact';
const DENSITY_COMFORTABLE = 'comfortable';
const DENSITY_VALUES = [DENSITY_COMPACT, DENSITY_COMFORTABLE];

function isValidDensity(value) {
  return DENSITY_VALUES.indexOf(value) !== -1;
}

function readStoredDensity() {
  try {
    return window.localStorage.getItem(DENSITY_STORAGE_KEY);
  } catch {
    return null;
  }
}

function getDensity() {
  return document.documentElement.getAttribute('data-density') || DENSITY_COMPACT;
}

function setDensity(value) {
  if (!isValidDensity(value)) return false;
  document.documentElement.setAttribute('data-density', value);
  try {
    window.localStorage.setItem(DENSITY_STORAGE_KEY, value);
  } catch {
    // Not persisted; the attribute still applies for this session.
  }
  return true;
}

(function initDensity() {
  const stored = readStoredDensity();
  document.documentElement.setAttribute('data-density', isValidDensity(stored) ? stored : DENSITY_COMPACT);
})();

// Exposed for the later batch that adds the visible control, and for tests.
// Nothing in the current UI calls setDensity() yet.
window.ztechUI = Object.assign(window.ztechUI || {}, {
  density: {
    get: getDensity,
    set: setDensity,
    values: DENSITY_VALUES.slice(),
    storageKey: DENSITY_STORAGE_KEY
  }
});

// === F2: density control in the top bar =====================================
// Drives the F1 mechanism only. There is no second density system: the buttons
// call window.ztechUI.density.set(), which writes data-density and the same
// ztech.density localStorage key. aria-pressed reflects the real state, so the
// control is correct after a restart with a stored preference.
(function wireDensityToggle() {
  const buttons = document.querySelectorAll('.density-btn');
  if (buttons.length === 0) return;

  function syncPressed() {
    const current = window.ztechUI.density.get();
    buttons.forEach((btn) => {
      btn.setAttribute('aria-pressed', btn.dataset.densityValue === current ? 'true' : 'false');
    });
  }

  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      if (window.ztechUI.density.set(btn.dataset.densityValue)) syncPressed();
    });
  });

  syncPressed();
})();

// === F2: sidebar collapse ====================================================
// Renderer-local, persisted in localStorage, no IPC. Collapsing changes the
// sidebar width token so the app grid reflows — the sidebar can never overlap
// the content area. The narrow-window media query forces the same rail, and
// aria-expanded always mirrors the state actually applied.
const SIDEBAR_STORAGE_KEY = 'ztech.sidebar.collapsed';

function isSidebarCollapsed() {
  return document.querySelector('.app-layout').classList.contains('sidebar-collapsed');
}

function setSidebarCollapsed(collapsed) {
  const layout = document.querySelector('.app-layout');
  const toggle = document.getElementById('btn-collapse-sidebar');
  layout.classList.toggle('sidebar-collapsed', collapsed === true);
  if (toggle) {
    toggle.setAttribute('aria-expanded', collapsed === true ? 'false' : 'true');
    toggle.title = collapsed === true ? 'Expand sidebar' : 'Collapse sidebar';
  }
  try {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, collapsed === true ? '1' : '0');
  } catch {
    // Not persisted; the class still applies for this session.
  }
  return collapsed === true;
}

(function initSidebar() {
  let stored = null;
  try {
    stored = window.localStorage.getItem(SIDEBAR_STORAGE_KEY);
  } catch {
    stored = null;
  }
  setSidebarCollapsed(stored === '1');

  const toggle = document.getElementById('btn-collapse-sidebar');
  if (toggle) {
    toggle.addEventListener('click', () => setSidebarCollapsed(!isSidebarCollapsed()));
  }
})();

// Roving arrow-key navigation inside the sidebar. Disabled ("Soon") items are
// skipped: they are not destinations, so focus must not land on them.
(function wireSidebarKeyboard() {
  if (!sidebarNav) return;
  const isReachable = (el) => !el.disabled;

  sidebarNav.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = Array.prototype.slice.call(sidebarNav.querySelectorAll('.nav-item'))
      .filter(isReachable);
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement);
    if (current === -1) return;
    const delta = e.key === 'ArrowDown' ? 1 : -1;
    const next = items[(current + delta + items.length) % items.length];
    next.focus();
    e.preventDefault();
  });
})();

// === F2: top bar search shell ===============================================
// A shell, not a search engine. It navigates to the existing Lead Library and
// focuses the search box that already exists (#number-search). No new query
// logic, no global index, no invented capability.
const globalSearchButton = document.getElementById('btn-global-search');
if (globalSearchButton) {
  globalSearchButton.addEventListener('click', () => {
    if (!activateView('numbers')) return;
    const input = document.getElementById('number-search');
    if (input) input.focus();
  });
}

// Settings access in the top bar reuses the sidebar's own routing, so there is
// exactly one way a view is ever activated.
const topbarSettings = document.getElementById('btn-topbar-settings');
if (topbarSettings) {
  topbarSettings.addEventListener('click', () => {
    activateView('settings');
  });
}

function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderWebsite(value) {
  if (!value) return '';
  const website = String(value).trim();
  if (!website) return '';
  let parsed;
  try { parsed = new URL(website); } catch { return escapeHtml(website); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return escapeHtml(website);
  return `<a href="${escapeHtml(website)}" target="_blank" rel="noopener">Open</a>`;
}

function reportError(message, context = {}) {
  try {
    if (window.appAPI?.logs?.report) {
      window.appAPI.logs.report({ message: String(message).slice(0, 500), context });
    }
  } catch {}
}

function safeAsync(handler) {
  return async (...args) => {
    try {
      return await handler(...args);
    } catch (err) {
      const msg = err?.message || String(err);
      toast(msg, 'error');
      reportError(msg, { handler: handler.name || 'anonymous' });
    }
  };
}

// 采集
let currentRunSlug = null;
// Slug of the run currently presented in the results table. Stamped onto rows
// saved to the number library so saved leads stay traceable to their run.
let currentResultsRunSlug = null;
// P1-G: the P1-F target the user applied to the run on screen, if any. It is
// the only target association the report ever sees, and it is sent with the
// local save - never with a provider request.
let currentResultsTargetId = null;
let runGeneration = 0;
let pollTimerId = null;
let pollInFlight = false;
let pollFailureCount = 0;
let viewClaimSeq = 0;
let viewClaimKind = 'none';
let displayedResultRowMap = new Map();

const MAX_CONSECUTIVE_POLL_FAILURES = 3;
const POLL_RETRY_DELAY_MS = 5000;

function isCurrentRun(gen, slug) {
  return gen === runGeneration && slug === currentRunSlug;
}

function claimResultView(kind) {
  viewClaimSeq += 1;
  viewClaimKind = kind;
  return viewClaimSeq;
}

function isViewClaimCurrent(seq) {
  return seq === viewClaimSeq;
}

function cancelPollTimer() {
  if (pollTimerId !== null) {
    clearTimeout(pollTimerId);
    pollTimerId = null;
  }
}

function startPolling(gen, slug) {
  cancelPollTimer();
  pollRunStatus(gen, slug);
}

function clearCurrentResultPresentation() {
  window.__collectResults = [];
  window.__filteredResults = null;
  currentResultsRunSlug = null;
  displayedResultRowMap = new Map();
  // P1-G: a new run has no report until it is saved, and no target is
  // associated with it.
  currentResultsTargetId = null;
  closeCollectQuality();
  document.getElementById('collect-result-card').style.display = 'none';
  document.getElementById('collect-result-body').textContent = '';
  document.getElementById('stat-collected').textContent = '0';
  syncResultSelectAll();
}

document.getElementById('btn-start-collect').addEventListener('click', safeAsync(async () => {
    const settings = await window.appAPI.settings.load();
    const keywords = document.getElementById('collect-keywords').value.trim();
    const region = document.getElementById('collect-region').value.trim();
    const lang = document.getElementById('collect-lang').value;
    const maxResults = parseInt(document.getElementById('collect-max').value) || 20;

    if (!settings.hasApiKey) {
      showStatus('Configure an API Key in Settings first', true);
      return;
    }
    if (!keywords) {
      showStatus('Enter at least one keyword', true);
      return;
    }

    showStatus('Submitting collection job...');

    runGeneration += 1;
    const gen = runGeneration;
    cancelPollTimer();
    currentRunSlug = null;
    pollFailureCount = 0;

    const result = await window.appAPI.collection.submit({
      keywords: keywords.split(',').map(k => k.trim()),
      location: region,
      lang,
      maxResults,
      titleMatchMode: document.getElementById('collect-title-match').value,
      minRating: document.getElementById('collect-min-rating').value,
      websiteFilter: document.getElementById('collect-website-filter').value,
      skipClosed: document.getElementById('collect-skip-closed').checked,
      fetchSocialInfo: document.getElementById('collect-social').checked,
      facebook: document.getElementById('collect-facebook').checked,
      instagram: document.getElementById('collect-instagram').checked,
      youtube: document.getElementById('collect-youtube').checked,
      tiktok: document.getElementById('collect-tiktok').checked,
      linkedin: document.getElementById('collect-linkedin').checked,
      fetchPlaceDetails: document.getElementById('collect-place-details').checked,
      fetchReservation: document.getElementById('collect-reservation').checked,
      fetchOnlineOrder: document.getElementById('collect-online-order').checked,
      fetchWebResult: document.getElementById('collect-web-result').checked,
      emailVerification: document.getElementById('collect-email-verify').checked,
      fetchReviews: document.getElementById('collect-reviews').checked,
      maxReviewsPerPlace: parseInt(document.getElementById('collect-max-reviews').value) || 5,
      reviewSortBy: document.getElementById('collect-review-sort').value,
      reviewKeyword: document.getElementById('collect-review-keyword').value.trim(),
      includeReviewerInfo: document.getElementById('collect-reviewer-info').checked
    });

    if (gen !== runGeneration) return;

    if (result.success) {
      currentRunSlug = result.data.run_slug;
      showStatus(`Job submitted, ID: ${currentRunSlug}. Waiting to run...`);
      claimResultView('run');
      clearCurrentResultPresentation();
      startPolling(gen, currentRunSlug);
    } else {
      claimResultView('none');
      showStatus(`Submission failed: ${result.error}`, true);
    }
  }));

document.getElementById('btn-check-status').addEventListener('click', safeAsync(async () => {
    if (!currentRunSlug) {
      showStatus('No job is currently running', true);
      return;
    }
    if (pollTimerId !== null || pollInFlight) return;
    pollFailureCount = 0;
    claimResultView('run');
    startPolling(runGeneration, currentRunSlug);
  }));

function evaluatePollOutcome(status) {
  if (!status || status.success !== true) {
    return { outcome: 'transport-error', error: (status && status.error) || 'Unknown error' };
  }
  const state = status.data?.status || status.data?.state;
  if (state === 'succeeded' || state === 'completed' || state === 'success') {
    return { outcome: 'terminal-success', state };
  }
  if (state === 'failed' || state === 'error') {
    return { outcome: 'terminal-failure', state, error: status.data?.error };
  }
  if (!state || typeof state !== 'string') {
    return { outcome: 'missing-state' };
  }
  return { outcome: 'pending', state };
}

function scheduleNextPoll(gen, slug) {
  pollTimerId = setTimeout(() => {
    pollTimerId = null;
    Promise.resolve().then(() => pollRunStatus(gen, slug)).catch((err) => {
      const msg = err?.message || String(err);
      showStatus(`Polling error: ${msg}`, true);
      reportError(msg, { handler: 'scheduleNextPoll', gen, slug });
    });
  }, POLL_RETRY_DELAY_MS);
}

async function pollRunStatus(gen, slug) {
  if (!isCurrentRun(gen, slug)) return;

  pollInFlight = true;
  try {
    showStatus(`Checking job status... (${slug})`);

    const status = await window.appAPI.collection.getStatus(slug);

    if (!isCurrentRun(gen, slug)) return;

    const res = evaluatePollOutcome(status);

    if (res.outcome === 'transport-error') {
      pollFailureCount += 1;
      if (pollFailureCount >= MAX_CONSECUTIVE_POLL_FAILURES) {
        showStatus(`Status check failed: ${res.error}`, true);
        return;
      }
      showStatus(`Status check failed: ${res.error}. Retrying automatically (${pollFailureCount}/${MAX_CONSECUTIVE_POLL_FAILURES})`, true);
      scheduleNextPoll(gen, slug);
      return;
    }

    if (res.outcome === 'terminal-success') {
      loadRunResult(slug, gen);
      return;
    }

    if (res.outcome === 'terminal-failure') {
      showStatus(`Collection failed: ${res.error || 'Unknown error'}`, true);
      return;
    }

    if (res.outcome === 'missing-state') {
      pollFailureCount += 1;
      if (pollFailureCount >= MAX_CONSECUTIVE_POLL_FAILURES) {
        showStatus('Job status is unknown. Automatic polling has stopped; use Check Status to retry', true);
        return;
      }
      showStatus(`Job status is unknown. Refreshing automatically (${pollFailureCount}/${MAX_CONSECUTIVE_POLL_FAILURES})`);
      scheduleNextPoll(gen, slug);
      return;
    }

    pollFailureCount = 0;
    showStatus(`Job status: ${res.state}. Refreshing automatically...`);
    scheduleNextPoll(gen, slug);
  } finally {
    if (gen === runGeneration) pollInFlight = false;
  }
}

const RESULTS_PAGE_SIZE = 100;
const RESULTS_MAX_OFFSET = 100000;

async function fetchAllRunResults(slug) {
  let offset = 0;
  let prevPage = null;
  const all = [];
  for (;;) {
    const result = await window.appAPI.collection.getResult(slug, { offset, limit: RESULTS_PAGE_SIZE });
    if (!result.success) return result;
    const page = (result.data && result.data.list) || [];
    if (prevPage && JSON.stringify(page) === JSON.stringify(prevPage)) break;
    prevPage = page;
    for (const item of page) all.push(item);
    if (page.length < RESULTS_PAGE_SIZE) break;
    const next = offset + page.length;
    if (next > RESULTS_MAX_OFFSET) break;
    offset = next;
  }
  return { success: true, data: { list: all } };
}

async function loadRunResult(currentRunSlug, gen) {
  try {
    if (!isCurrentRun(gen, currentRunSlug)) return;
    if (viewClaimKind === 'history') {
      showStatus('Collection finished. Results were not loaded');
      return;
    }
    const seq = claimResultView('run');

    showStatus('Collection finished. Loading results...');

    const result = await fetchAllRunResults(currentRunSlug);

    if (!isCurrentRun(gen, currentRunSlug)) return;
    if (!isViewClaimCurrent(seq)) {
      if (viewClaimKind === 'history') showStatus('Collection finished. Results were not loaded');
      return;
    }

    if (!result.success) {
      showStatus(`Could not load results: ${result.error}`, true);
      return;
    }

    const items = result.data?.list || [];
    showStatus(`Collection finished. Loaded ${items.length} results`);
    window.__collectResults = items;
    currentResultsRunSlug = currentRunSlug;
    const mobileOnly = document.getElementById('collect-mobile-only').checked;
    if (mobileOnly) {
      const filtered = items.filter(item => isMobileNumber(item.phone));
      renderCollectResults(filtered, true);
      toast(`${filtered.length} phone numbers match the filter (${items.length} loaded)`, 'success');
      window.__filteredResults = filtered;
    } else {
      renderCollectResults(items);
      window.__filteredResults = null;
    }
  } catch (err) {
    const msg = err?.message || String(err);
    showStatus(`Error loading results: ${msg}`, true);
    reportError(msg, { handler: 'loadRunResult', slug: currentRunSlug, gen });
  }
}

function buildResultRowKeyMap(items) {
  const list = Array.isArray(items) ? items : [];
  const occurrences = new Map();
  const keys = [];
  const rowMap = new Map();
  for (let i = 0; i < list.length; i++) {
    const item = (list[i] && typeof list[i] === 'object') ? list[i] : {};
    const base = [
      item.title,
      item.phone,
      item.address,
      item.website,
      item.email_1 || item.all_emails
    ].map(value => (value === undefined || value === null ? '' : String(value))).join('\u001f');
    const seen = occurrences.get(base) || 0;
    occurrences.set(base, seen + 1);
    const key = base + '\u001f#' + seen;
    keys.push(key);
    rowMap.set(key, item);
  }
  return { keys, rowMap };
}

function resolveSelectedRows(checkedKeys, rowMap) {
  const rows = [];
  if (!Array.isArray(checkedKeys) || !rowMap) return rows;
  for (const key of checkedKeys) {
    const row = rowMap.get(key);
    if (row) rows.push(row);
  }
  return rows;
}

function computeSelectAllState(checkedCount, totalCount) {
  const total = Number.isInteger(totalCount) ? totalCount : 0;
  const checked = Number.isInteger(checkedCount) ? checkedCount : 0;
  if (total <= 0 || checked <= 0) return { checked: false, indeterminate: false };
  return { checked: checked >= total, indeterminate: checked < total };
}

function getSelectedResultRows() {
  const checkedKeys = [];
  document.querySelectorAll('#collect-result-body .result-check:checked').forEach(box => {
    if (box && box.dataset && typeof box.dataset.key === 'string') checkedKeys.push(box.dataset.key);
  });
  return resolveSelectedRows(checkedKeys, displayedResultRowMap);
}

function syncResultSelectAll() {
  const selectAll = document.getElementById('select-all-results');
  if (!selectAll) return;
  const boxes = document.querySelectorAll('#collect-result-body .result-check');
  let checkedCount = 0;
  boxes.forEach(box => { if (box.checked) checkedCount += 1; });
  const state = computeSelectAllState(checkedCount, boxes.length);
  selectAll.checked = state.checked;
  selectAll.indeterminate = state.indeterminate;
}

function renderCollectResults(items, preserveOriginal = false) {
  const card = document.getElementById('collect-result-card');
  const tbody = document.getElementById('collect-result-body');
  card.style.display = 'block';

  const rowIdentity = buildResultRowKeyMap(items);
  displayedResultRowMap = rowIdentity.rowMap;

  tbody.innerHTML = items.map((item, i) => `<tr>
    <td><input type="checkbox" data-key="${escapeHtml(rowIdentity.keys[i])}" class="result-check"></td>
    <td>${escapeHtml(item.title || '')}</td>
    <td>${escapeHtml(item.phone || '')}</td>
    <td>${escapeHtml(item.address || '')}</td>
    <td>${renderWebsite(item.website)}</td>
    <td>${escapeHtml(item.email_1 || item.all_emails || '')}</td>
  </tr>`).join('');

  if (!preserveOriginal) {
    window.__collectResults = items;
  }
  document.getElementById('stat-collected').textContent = items.length;
  syncResultSelectAll();
}

// 手机号判断（按国家号码规则）
function isMobileNumber(phone) {
  if (!phone) return false;
  const cleaned = phone.replace(/[\s\-\(\)]/g, '');

  // 泰国: +66 后面 6/8/9 开头是手机
  if (cleaned.startsWith('+66')) {
    const local = cleaned.slice(3);
    return /^[689]/.test(local);
  }
  // 中国: +86 后面 1 开头 11位
  if (cleaned.startsWith('+86')) {
    const local = cleaned.slice(3);
    return /^1\d{10}$/.test(local);
  }
  // 美国/加拿大: +1 后面10位，没有固定手机/座机区分，全部保留
  if (cleaned.startsWith('+1') && cleaned.length === 12) return true;
  // 印度: +91 后面 6/7/8/9 开头是手机
  if (cleaned.startsWith('+91')) {
    const local = cleaned.slice(3);
    return /^[6789]/.test(local);
  }
  // 印尼: +62 后面 8 开头是手机
  if (cleaned.startsWith('+62')) {
    const local = cleaned.slice(3);
    return /^8/.test(local);
  }
  // 越南: +84 后面 3/5/7/8/9 开头是手机
  if (cleaned.startsWith('+84')) {
    const local = cleaned.slice(3);
    return /^[35789]/.test(local);
  }
  // 马来西亚: +60 后面 1 开头是手机
  if (cleaned.startsWith('+60')) {
    const local = cleaned.slice(3);
    return /^1/.test(local);
  }
  // 菲律宾: +63 后面 9 开头是手机
  if (cleaned.startsWith('+63')) {
    const local = cleaned.slice(3);
    return /^9/.test(local);
  }
  // 巴西: +55 后面第三位是 9 的是手机（11位本地号）
  if (cleaned.startsWith('+55')) {
    const local = cleaned.slice(3);
    return /^\d{2}9/.test(local);
  }
  // 通用兜底: 号码长度>=11位的大概率是手机号
  return cleaned.length >= 12;
}

function showStatus(msg, isError = false) {
  const el = document.getElementById('collect-status');
  el.style.display = 'block';
  el.textContent = msg;
  el.className = 'status-bar' + (isError ? ' error' : '');
}

function toast(msg, type = 'success', duration = 3000) {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => { el.remove(); }, duration);
}

async function checkStorageStatus() {
  const el = document.getElementById('storage-warning');
  if (!el) return;
  try {
    const st = await window.appAPI.collector.storageStatus();
    if (!st || (st.mode !== 'json-fallback' && !st.quarantine && !st.dataMayBeIncomplete)) {
      el.style.display = 'none';
      el.textContent = '';
      return;
    }
    const parts = [];
    if (st.mode === 'json-fallback') parts.push('Storage has fallen back to JSON; lead data may be incomplete');
    if (st.quarantine) parts.push('An unreadable database file was detected and kept: ' + st.quarantine);
    else if (st.reason === 'corrupt-open') parts.push('An unreadable database file was detected');
    if (st.dataMayBeIncomplete) parts.push('The current list may be missing earlier records');
    el.textContent = parts.join('; ');
    el.style.display = 'block';
  } catch (err) {
    el.style.display = 'none';
  }
}

// `bounded` renders Previous/Next as genuinely disabled controls at the edges
// instead of omitting them. Off by default so the other views keep their exact
// current markup; the Leads workspace opts in.
function renderPagination(containerId, totalPages, currentPage, onPageChange, bounded) {
  const container = document.getElementById(containerId);
  if (totalPages <= 1) { container.innerHTML = ''; return; }
  const prevDisabled = bounded && currentPage <= 1;
  const nextDisabled = bounded && currentPage >= totalPages;
  let html = '';
  if (currentPage > 1 || bounded) {
    html += `<button type="button" data-page="${currentPage - 1}" aria-label="Previous page"`
      + (prevDisabled ? ' disabled' : '') + `>Previous</button>`;
  }
  for (let i = 1; i <= totalPages; i++) {
    if (totalPages > 7 && Math.abs(i - currentPage) > 2 && i !== 1 && i !== totalPages) {
      if (html.slice(-3) !== '...') html += '<span style="color:var(--text-secondary);padding:0 4px;">...</span>';
      continue;
    }
    const isCurrent = i === currentPage;
    html += `<button type="button" data-page="${i}"${isCurrent ? ' aria-current="page"' : ''}`
      + ` class="${isCurrent ? 'active' : ''}">${i}</button>`;
  }
  if (currentPage < totalPages || bounded) {
    html += `<button type="button" data-page="${currentPage + 1}" aria-label="Next page"`
      + (nextDisabled ? ' disabled' : '') + `>Next</button>`;
  }
  container.innerHTML = html;
  container.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => onPageChange(parseInt(btn.dataset.page)));
  });
}

// 采集历史
document.getElementById('btn-refresh-history').addEventListener('click', safeAsync(() => loadHistory()));
document.getElementById('history-table-body').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-slug]');
  if (!btn) return;
  window.viewRunResult(btn.dataset.slug);
});

const HISTORY_PAGE_SIZE = 20;
let historyPage = 1;
let historyLoadSeq = 0;

async function loadHistory(page = 1) {
  try {
    const settings = await window.appAPI.settings.load();
    if (!settings.hasApiKey) return;

    const targetPage = page < 1 ? 1 : page;
    const seq = ++historyLoadSeq;
    const result = await window.appAPI.collection.getHistory(HISTORY_PAGE_SIZE, (targetPage - 1) * HISTORY_PAGE_SIZE);
    if (seq !== historyLoadSeq) return;
    if (!result.success) {
      toast(result.error || 'Could not load collection history', 'error');
      return;
    }

    const list = result.data?.list || [];
    if (!list.length && targetPage > 1) {
      return loadHistory(targetPage - 1);
    }
    historyPage = targetPage;

    const tbody = document.getElementById('history-table-body');

    tbody.innerHTML = list.map(item => {
      const startTime = item.started_at ? new Date(item.started_at * 1000).toLocaleString('en-GB') : '-';
      const statusClass = item.status === 'succeeded' ? 'color:var(--accent)' : item.status === 'failed' ? 'color:var(--danger)' : 'color:var(--warning)';
      const statusText = item.status === 'succeeded' ? 'Succeeded' : item.status === 'failed' ? 'Failed' : item.status === 'running' ? 'Running' : item.status;
      return `<tr>
        <td>${escapeHtml(item.scraper_title || '-')}</td>
        <td style="${statusClass}">${escapeHtml(statusText)}</td>
        <td>${escapeHtml(item.results || 0)}</td>
        <td>${escapeHtml(item.usage || '0')}</td>
        <td>${escapeHtml(item.duration ? item.duration + 's' : '-')}</td>
        <td>${escapeHtml(item.origin || '-')}</td>
        <td>${startTime}</td>
        <td><button class="btn btn-sm" data-slug="${escapeHtml(item.slug)}">View results</button></td>
      </tr>`;
    }).join('');

    renderPagination('history-pagination', historyPage + (list.length >= HISTORY_PAGE_SIZE ? 1 : 0), historyPage, (p) => loadHistory(p));
  } catch (err) {
    const msg = err?.message || String(err);
    toast(msg, 'error');
    reportError(msg, { handler: 'loadHistory', page });
  }
}

window.viewRunResult = safeAsync(async (slug) => {
    const settings = await window.appAPI.settings.load();
    if (!settings.hasApiKey) return;

    const seq = claimResultView('history');

    const result = await fetchAllRunResults(slug);
    if (!isViewClaimCurrent(seq)) return;
    if (result.success) {
      const items = result.data?.list || [];
      // F2.1: a historical run opens the Collection view. This goes through the
      // single F2 routing function rather than poking the DOM directly, so the
      // top bar context ("Discovery") cannot go stale the way the title did.
      // activateView() also maintains nav active state and aria-current, which
      // the previous inline code did not. No data loading is triggered here:
      // the run results are rendered below, exactly as before.
      activateView('collector');
      window.__collectResults = items;
      currentResultsRunSlug = slug;
      const mobileOnly = document.getElementById('collect-mobile-only').checked;
      if (mobileOnly) {
        const filtered = items.filter(item => isMobileNumber(item.phone));
        renderCollectResults(filtered, true);
        window.__filteredResults = filtered;
      } else {
        renderCollectResults(items);
        window.__filteredResults = null;
      }
    } else {
      toast(result.error || 'Could not load results', 'error');
    }
  });

// 初始化
safeAsync(loadSettings)();

// 设置管理
async function loadSettings() {
  try {
    const settings = await window.appAPI.settings.load();
    const apiInput = document.getElementById('settings-apikey');
    const taskInput = document.getElementById('settings-task-key');
    const proxyInput = document.getElementById('settings-proxy-url');
    apiInput.value = '';
    apiInput.placeholder = settings.hasApiKey ? 'Stored (leave empty to keep it)' : 'Enter API key';
    taskInput.value = '';
    taskInput.placeholder = settings.hasTaskKey ? 'Stored (leave empty to keep it)' : 'e.g. 01KWA7xxxx';
    document.getElementById('btn-clear-apikey').disabled = !settings.hasApiKey;
    document.getElementById('btn-clear-taskkey').disabled = !settings.hasTaskKey;
    proxyInput.value = settings.proxyUrl || '';
    applyResearchSettingsToForm(settings.research);
  } catch (err) {
    const msg = err?.message || String(err);
    toast(msg, 'error');
    reportError(msg, { handler: 'loadSettings' });
  }
}

const RESEARCH_TRANSPORTS = ['mcp', 'rest'];

function researchKeyStatusText(configured) {
  return configured ? 'A key is stored. Leave the field empty to keep it.' : 'No key stored.';
}

function researchHealthText(health) {
  if (!health || typeof health !== 'object') return 'Not checked yet.';
  if (health.state === 'ready') {
    const plan = health.plan ? ` plan ${escapeHtml(String(health.plan))}` : '';
    const limits = health.limits ? ` limits ${escapeHtml(JSON.stringify(health.limits))}` : '';
    return `Ready.${plan}${limits}`;
  }
  const suffix = health.message ? ` ${escapeHtml(String(health.message))}` : '';
  return `${escapeHtml(String(health.state || 'unknown'))}.${suffix}`;
}

// The Zuni-SEO key is never returned by main, so the field is always emptied on load.
function applyResearchSettingsToForm(research) {
  const r = (research && typeof research === 'object') ? research : {};
  const baseUrl = document.getElementById('settings-research-baseurl');
  const transport = document.getElementById('settings-research-transport');
  const key = document.getElementById('settings-research-key');
  const clearBtn = document.getElementById('btn-research-clear-key');
  const status = document.getElementById('settings-research-key-status');
  if (baseUrl) baseUrl.value = typeof r.baseUrl === 'string' ? r.baseUrl : '';
  if (transport) transport.value = RESEARCH_TRANSPORTS.includes(r.transport) ? r.transport : 'mcp';
  if (key) key.value = '';
  if (clearBtn) clearBtn.disabled = r.hasApiKey !== true;
  if (status) status.textContent = researchKeyStatusText(r.hasApiKey === true);
}

async function refreshResearchHealth() {
  const el = document.getElementById('settings-research-health');
  if (!el) return;
  try {
    const health = await window.appAPI.research.providerHealth();
    el.textContent = researchHealthText(health);
  } catch (err) {
    el.textContent = escapeHtml((err && err.message) || 'Provider status unavailable.');
  }
}

function collectResearchSettings() {
  const baseUrl = document.getElementById('settings-research-baseurl');
  const transport = document.getElementById('settings-research-transport');
  return {
    baseUrl: baseUrl ? baseUrl.value.trim() : '',
    transport: transport && RESEARCH_TRANSPORTS.includes(transport.value) ? transport.value : 'mcp'
  };
}

// A8: the key is write-only. It is sent once and then forgotten by the form.
async function saveResearchKey() {
  const input = document.getElementById('settings-research-key');
  const status = document.getElementById('settings-research-key-status');
  if (!input) return;
  const key = input.value.trim();
  if (key === '') return;
  try {
    const result = await window.appAPI.research.setApiKey(key);
    input.value = '';
    if (status) status.textContent = researchKeyStatusText(true);
    if (result && result.provider) {
      const el = document.getElementById('settings-research-health');
      if (el) el.textContent = researchHealthText({ state: result.provider });
    }
  } catch (err) {
    if (status) status.textContent = escapeHtml((err && err.message) || 'The key was not saved.');
    toast((err && err.message) || 'The key was not saved.', 'error');
  }
}

async function clearResearchKey() {
  const status = document.getElementById('settings-research-key-status');
  try {
    await window.appAPI.research.clearApiKey();
    if (status) status.textContent = researchKeyStatusText(false);
  } catch (err) {
    toast((err && err.message) || 'The key could not be cleared.', 'error');
  }
}

function settingsSaveFeedback(result) {
  if (result && result.success === true) {
    if (result.proxyApplied) {
      return { message: 'Settings saved', type: 'success' };
    }
    return { message: 'Settings saved, but the proxy could not be applied', type: 'info' };
  }
  return { message: 'Could not save settings. Check the values and try again', type: 'error' };
}

document.getElementById('btn-save-settings').addEventListener('click', safeAsync(async () => {
    const settings = {
      apiKey: document.getElementById('settings-apikey').value.trim(),
      taskKey: document.getElementById('settings-task-key').value.trim(),
      proxyUrl: document.getElementById('settings-proxy-url').value.trim(),
      research: collectResearchSettings()
    };
    let result = null;
    try {
      result = await window.appAPI.settings.save(settings);
    } catch {
      const feedback = settingsSaveFeedback(null);
      toast(feedback.message, feedback.type);
      return;
    }
    const feedback = settingsSaveFeedback(result);
    toast(feedback.message, feedback.type);
    if (result && result.success === true) loadSettings();
    refreshResearchHealth();
    // The key is saved separately, through its own write-only channel.
    await saveResearchKey();
  }));

document.getElementById('btn-detect-proxy').addEventListener('click', safeAsync(async () => {
    toast('Detecting system proxy...', 'info');
    const result = await window.appAPI.proxy.detect();
    if (result && result.proxyUrl) {
      document.getElementById('settings-proxy-url').value = result.proxyUrl;
      if (result.whatsappReachable === false) {
        toast(`Proxy detected, but the WhatsApp connectivity check failed: ${result.proxyUrl} (${result.source})`, 'info');
      } else if (result.whatsappReachable === true) {
        toast(`Proxy detected, WhatsApp connectivity check passed: ${result.proxyUrl} (${result.source})`, 'success');
      } else {
        toast(`Proxy detected: ${result.proxyUrl} (${result.source})`, 'success');
      }
    } else {
      toast('No usable proxy detected', 'error');
    }
  }));

document.getElementById('btn-research-clear-key').addEventListener('click', safeAsync(async () => {
    await clearResearchKey();
  }));

document.getElementById('btn-export-logs').addEventListener('click', safeAsync(async () => {
    toast('Exporting logs...', 'info');
    const logs = await window.appAPI.logs.exportLogs();
    if (logs) {
      const blob = new Blob([logs], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `app-logs-${Date.now()}.txt`;
      a.click();
      URL.revokeObjectURL(url);
      toast('Logs exported', 'success');
    } else {
      toast('There are no logs to export', 'error');
    }
  }));

document.getElementById('btn-test-apikey').addEventListener('click', safeAsync(async () => {
    const apiKey = document.getElementById('settings-apikey').value.trim();
    if (!apiKey) {
      toast('Testing the stored API Key...', 'info');
      const stored = await window.appAPI.provider.testConnection(undefined, undefined, undefined, true);
      if (stored && stored.success && stored.apiKeyValid) {
        toast('API Key connection succeeded', 'success');
      } else {
        toast((stored && stored.error) || 'API Key connection failed', 'error');
      }
      return;
    }
    toast('Testing API Key...', 'info');
    const result = await window.appAPI.provider.testConnection(apiKey, '');
    if (result.success && result.apiKeyValid) {
      toast('API Key connection succeeded', 'success');
    } else {
      toast('API Key connection failed', 'error');
    }
  }));

document.getElementById('btn-test-taskkey').addEventListener('click', safeAsync(async () => {
    const apiKey = document.getElementById('settings-apikey').value.trim();
    const taskKey = document.getElementById('settings-task-key').value.trim();
    if (!apiKey && !taskKey) {
      toast('Testing the stored Task Flow Key...', 'info');
      const stored = await window.appAPI.provider.testConnection(undefined, undefined, undefined, true);
      if (stored && stored.success && stored.taskKeyValid) {
        toast('Task Flow Key verified', 'success');
      } else {
        toast((stored && stored.error) || 'Task Flow Key verification failed', 'error');
      }
      return;
    }
    if (!apiKey) { toast('Enter an API Key first', 'error'); return; }
    if (!taskKey) { toast('Enter a Task Flow Key first', 'error'); return; }
    toast('Testing Task Flow Key...', 'info');
    const result = await window.appAPI.provider.testConnection(apiKey, taskKey);
    if (result.success && result.taskKeyValid) {
      toast('Task Flow Key verified', 'success');
    } else {
      toast('Task Flow Key verification failed', 'error');
    }
  }));

document.getElementById('btn-clear-apikey').addEventListener('click', safeAsync(async () => {
    const settings = {
      apiKey: '',
      taskKey: document.getElementById('settings-task-key').value.trim(),
      proxyUrl: document.getElementById('settings-proxy-url').value.trim(),
      clearApiKey: true
    };
    let result = null;
    try {
      result = await window.appAPI.settings.save(settings);
    } catch {
      const feedback = settingsSaveFeedback(null);
      toast(feedback.message, feedback.type);
      return;
    }
    const feedback = settingsSaveFeedback(result);
    toast(feedback.message, feedback.type);
    if (result && result.success === true) loadSettings();
  }));

document.getElementById('btn-clear-taskkey').addEventListener('click', safeAsync(async () => {
    const settings = {
      apiKey: document.getElementById('settings-apikey').value.trim(),
      taskKey: '',
      proxyUrl: document.getElementById('settings-proxy-url').value.trim(),
      clearTaskKey: true
    };
    let result = null;
    try {
      result = await window.appAPI.settings.save(settings);
    } catch {
      const feedback = settingsSaveFeedback(null);
      toast(feedback.message, feedback.type);
      return;
    }
    const feedback = settingsSaveFeedback(result);
    toast(feedback.message, feedback.type);
    if (result && result.success === true) loadSettings();
  }));

// === 保存采集结果到号码库 ===
document.getElementById('btn-save-numbers').addEventListener('click', safeAsync(async () => {
    const source = getSelectedResultRows();
    if (!source.length) {
      showStatus('Select at least one result to save', true);
      return;
    }
    const numbers = source.map((item) => ({
      id: crypto.randomUUID(),
      phone: item.phone || '',
      title: item.title || '',
      website: item.website || '',
      email: item.email_1 || item.all_emails || '',
      address: item.address || '',
      source: '',
      keyword: item.source_keyword || '',
      status: 'pending',
      collectedAt: new Date().toISOString(),
      runSlug: currentResultsRunSlug || ''
    })).filter(n => n.phone);
    let result;
    try {
      // P1-G: the run context travels with this local save only, so the main
      // process can record the real submitted/added/duplicate counters. It never
      // reaches the provider.
      result = await window.appAPI.collector.addNumbers(numbers, {
        runSlug: currentResultsRunSlug || '',
        targetId: currentResultsTargetId || null
      });
    } catch (err) {
      showStatus(err?.message || 'Save failed', true);
      return;
    }
    showStatus(`Saved ${result.added || numbers.length} leads. Skipped ${result.duplicates || 0} duplicates`);
    await loadCollectQuality();
  }));

function csvField(value) {
  let s = value === undefined || value === null ? '' : String(value);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return s.replace(/"/g, '""');
}

// === 采集结果导出 CSV ===
document.getElementById('btn-export-results').addEventListener('click', safeAsync(() => {
    const source = getSelectedResultRows();
    if (!source.length) {
      showStatus('Select at least one result to export', true);
      return;
    }
    const header = 'title,phone,address,website,email\n';
    const rows = source.map(item =>
      `"${csvField(item.title || '')}","${csvField(item.phone || '')}","${csvField(item.address || '')}","${csvField(item.website || '')}","${csvField(item.email_1 || item.all_emails || '')}"`
    ).join('\n');
    const blob = new Blob(['\uFEFF' + header + rows], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `collect-results-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }));

// === 全选 checkbox ===
document.getElementById('select-all-results').addEventListener('change', (e) => {
  const shouldCheck = !!e.target.checked;
  document.querySelectorAll('#collect-result-body .result-check').forEach(cb => { cb.checked = shouldCheck; });
  syncResultSelectAll();
});
document.getElementById('collect-result-body').addEventListener('change', (e) => {
  const target = e.target;
  if (target && target.classList && target.classList.contains('result-check')) syncResultSelectAll();
});
document.getElementById('select-all-numbers').addEventListener('change', (e) => {
  const shouldCheck = !!e.target.checked;
  document.querySelectorAll('.number-check').forEach(cb => { cb.checked = shouldCheck; });
  syncLeadsSelection();
});

// === Leads workspace (Frontend 2.0 F3) ===

// Frontend 2.0 F3. The Leads workspace is a presentation layer over the EXISTING
// B2 lead query contract (collector:get-numbers). This batch does not add a
// channel, a query contract, a second fetch path or a client-side filter over a
// full dataset: every row, total, filter and sort here is what the main process
// already returned.
//
// Real contracts this file is bound to (read, not invented):
//   search fields  phone title website email address source keyword
//   filters        status qualification + the five derived quality filters
//   sort keys      collectedAt title phone source keyword
let numbersPage = 1;
let numbersSort = '';
let numbersOrder = 'asc';
let numbersLoadSeq = 0;
let numbersSearchTimer = null;
const NUMBERS_PER_PAGE = 50;

// P1-B: Lead Library control id -> derived quality filter key. Kept as data so
// the payload builder and the change listeners cannot drift apart.
const LEAD_QUALITY_FILTER_CONTROLS = [
  ['number-filter-phone-quality', 'phoneQuality'],
  ['number-filter-email-quality', 'emailQuality'],
  ['number-filter-website-quality', 'websiteQuality'],
  ['number-filter-business-quality', 'businessQuality'],
  ['number-filter-completeness', 'completeness']
];

// F3: typing is debounced so every keystroke does not become a query. The
// search itself stays server-side.
const NUMBERS_SEARCH_DEBOUNCE_MS = 250;

// F3 filter metadata. `key` is the exact filters object key the main process
// allowlists, `label` is the user-facing name used by the trigger and the chip.
// The allowed VALUES are never restated here: they live in the option lists of
// the real <select> elements, which the main process validates again, so F3
// cannot widen the vocabulary.
const LEADS_FILTER_DEFS = [
  { key: 'status', control: 'number-filter-status', label: 'Status' },
  { key: 'qualification', control: 'number-filter-qualification', label: 'Qualification' },
  { key: 'phoneQuality', control: 'number-filter-phone-quality', label: 'Phone' },
  { key: 'emailQuality', control: 'number-filter-email-quality', label: 'Email' },
  { key: 'websiteQuality', control: 'number-filter-website-quality', label: 'Website' },
  { key: 'businessQuality', control: 'number-filter-business-quality', label: 'Business' },
  { key: 'completeness', control: 'number-filter-completeness', label: 'Completeness' }
];

// Sortable columns. These are EXACTLY the keys the main process accepts
// (QUERY_SORT_COLUMNS / NUMBERS_QUERY_SORT_FIELDS). A column with no key here
// is not sortable - the renderer never invents a sort for a column the query
// contract cannot order by, and never offers one it cannot satisfy.
const NUMBERS_SORTABLE_KEYS = ['title', 'phone', 'source', 'keyword', 'collectedAt'];

// F3 column model. `column` maps to the data-column attribute on the header
// cell. The lead/title column is locked: it is the identity of the row and the
// table would be unusable without it.
const LEADS_COLUMNS = [
  { column: 'phone', label: 'Phone', locked: false },
  { column: 'domain', label: 'Domain', locked: false },
  { column: 'email', label: 'Email', locked: false },
  { column: 'status', label: 'Status', locked: false },
  { column: 'qualification', label: 'Qualification', locked: false },
  { column: 'quality', label: 'Data quality', locked: false },
  { column: 'research', label: 'Research', locked: false },
  { column: 'icp', label: 'ICP fit', locked: false },
  { column: 'source', label: 'Source', locked: false },
  { column: 'keyword', label: 'Keywords', locked: false },
  { column: 'collected', label: 'Collected', locked: false }
];

// Sensible dense default: the identity plus the columns a prospecting pass
// actually reads first. Research/ICP start VISIBLE but empty-on-purpose, so the
// workspace says out loud that they are not available instead of hiding the gap.
const LEADS_DEFAULT_COLUMNS = [
  'phone', 'domain', 'status', 'qualification', 'quality', 'research', 'icp', 'collected'
];

// Renderer-local only. This is a view preference, not lead data, so it never
// reaches the database and never travels over IPC.
const LEADS_COLUMNS_STORAGE_KEY = 'ztech.leads.columns';
let leadsColumns = LEADS_DEFAULT_COLUMNS.slice();

function readStoredLeadsColumns() {
  let raw = null;
  try {
    raw = window.localStorage.getItem(LEADS_COLUMNS_STORAGE_KEY);
  } catch {
    return LEADS_DEFAULT_COLUMNS.slice();
  }
  if (!raw) return LEADS_DEFAULT_COLUMNS.slice();
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return LEADS_DEFAULT_COLUMNS.slice();
  }
  if (!Array.isArray(parsed)) return LEADS_DEFAULT_COLUMNS.slice();
  // Only known columns survive: a stored name that no longer maps to a real
  // column is dropped rather than rendered as an empty header.
  const known = LEADS_COLUMNS.map((c) => c.column);
  const kept = parsed.filter((c) => known.indexOf(c) !== -1);
  return kept.length ? kept : LEADS_DEFAULT_COLUMNS.slice();
}

function persistLeadsColumns() {
  try {
    window.localStorage.setItem(LEADS_COLUMNS_STORAGE_KEY, JSON.stringify(leadsColumns));
  } catch {
    // Preference only. A hardened profile must never break the workspace.
  }
}

function isColumnVisible(column) {
  return leadsColumns.indexOf(column) !== -1;
}

function numbersQueryPayload() {
  const query = { limit: NUMBERS_PER_PAGE, offset: (numbersPage - 1) * NUMBERS_PER_PAGE };
  const search = document.getElementById('number-search').value.trim();
  if (search) query.search = search;
  const filterStatus = document.getElementById('number-filter-status').value;
  // B6.4.2: qualification is merged into the same filters object; assigning
  // query.filters twice would silently drop the other filter.
  const filters = {};
  if (filterStatus !== 'all') filters.status = filterStatus;
  const filterQualification = document.getElementById('number-filter-qualification').value;
  if (filterQualification !== 'all') filters.qualification = filterQualification;
  // P1-B: derived quality filters, merged into the same filters object. The
  // main process allowlists every value, so an unexpected selection is refused
  // rather than reaching the query layer.
  for (const [id, key] of LEAD_QUALITY_FILTER_CONTROLS) {
    const value = document.getElementById(id).value;
    if (value !== 'all') filters[key] = value;
  }
  if (Object.keys(filters).length) query.filters = filters;
  // F6: a segment opened in Leads scopes the query to its members. The id is
  // kept on the scope bar element, and the store resolves it server-side.
  const scopeSegmentId = document.getElementById('leads-scope').dataset.segmentId;
  if (scopeSegmentId) query.segmentId = scopeSegmentId;
  if (numbersSort) {
    query.sort = numbersSort;
    query.order = numbersOrder;
  }
  return query;
}

// --- F3: filter chips -------------------------------------------------------

// The current selection of one filter group, or '' when it is at the neutral
// "All" value. A neutral filter is never shown as an active chip.
function currentFilterValue(control) {
  const el = document.getElementById(control);
  const value = el ? el.value : 'all';
  return value === 'all' ? '' : value;
}

function activeLeadsFilters() {
  const active = [];
  for (const def of LEADS_FILTER_DEFS) {
    const value = currentFilterValue(def.control);
    if (value) active.push({ key: def.key, label: def.label, control: def.control, value });
  }
  return active;
}

// The label shown on a chip and on its trigger. Taken from the real <option>
// text, so a chip can never invent a word the control does not offer.
function filterValueLabel(control, value) {
  const el = document.getElementById(control);
  if (!el || !el.options) return value;
  for (const option of el.options) {
    if (option.value === value) return option.textContent.trim() || value;
  }
  return value;
}

function syncFilterTriggers() {
  for (const def of LEADS_FILTER_DEFS) {
    const group = document.querySelector(`.filter-group[data-filter="${def.key}"]`);
    if (!group) continue;
    const value = currentFilterValue(def.control);
    group.setAttribute('data-active', value ? 'true' : 'false');
    const slot = group.querySelector(`[data-filter-value-for="${def.key}"]`);
    if (slot) slot.textContent = value ? filterValueLabel(def.control, value) : 'All';
  }
}

function renderLeadsChips() {
  const bar = document.getElementById('leads-chips');
  if (!bar) return;
  const active = activeLeadsFilters();
  // Built with DOM APIs, not innerHTML: filter values come from the DOM and
  // are inserted as text.
  bar.replaceChildren();
  if (!active.length) {
    bar.hidden = true;
    return;
  }
  for (const filter of active) {
    const chip = document.createElement('span');
    chip.className = 'filter-chip';
    const key = document.createElement('span');
    key.className = 'filter-chip-key';
    key.textContent = filter.label + ':';
    const value = document.createElement('span');
    value.className = 'filter-chip-value';
    value.textContent = filterValueLabel(filter.control, filter.value);
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'filter-chip-clear';
    clear.textContent = '×';
    clear.setAttribute('aria-label', `Clear ${filter.label} filter`);
    clear.addEventListener('click', () => {
      document.getElementById(filter.control).value = 'all';
      applyLeadsFilterChange();
    });
    chip.append(key, value, clear);
    bar.appendChild(chip);
  }
  const clearAll = document.createElement('button');
  clearAll.type = 'button';
  clearAll.className = 'chip-clear-all';
  clearAll.id = 'btn-clear-all-filters';
  clearAll.textContent = 'Clear all';
  clearAll.addEventListener('click', clearAllLeadsFilters);
  bar.appendChild(clearAll);
  bar.hidden = false;
}

function clearAllLeadsFilters() {
  for (const def of LEADS_FILTER_DEFS) {
    const el = document.getElementById(def.control);
    if (el) el.value = 'all';
  }
  applyLeadsFilterChange();
}

// A filter change re-queries through the existing flow. Page one, because a
// narrower result set can leave the current page empty.
function applyLeadsFilterChange() {
  numbersPage = 1;
  syncFilterTriggers();
  renderLeadsChips();
  return renderNumbers();
}

// --- F3: filter popovers ----------------------------------------------------

let openLeadsPopover = null;

function closeLeadsPopover() {
  if (!openLeadsPopover) return;
  const group = openLeadsPopover;
  const trigger = group.querySelector('.filter-trigger');
  const popover = group.querySelector('.filter-popover');
  if (popover) popover.hidden = true;
  if (trigger) trigger.setAttribute('aria-expanded', 'false');
  openLeadsPopover = null;
  if (trigger) trigger.focus();
}

function toggleLeadsPopover(group) {
  if (openLeadsPopover === group) {
    closeLeadsPopover();
    return;
  }
  closeLeadsPopover();
  const trigger = group.querySelector('.filter-trigger');
  const popover = group.querySelector('.filter-popover');
  // A disabled trigger (Intelligence) can never own an open popover.
  if (!trigger || !popover || trigger.disabled) return;
  popover.hidden = false;
  trigger.setAttribute('aria-expanded', 'true');
  openLeadsPopover = group;
  const first = popover.querySelector('select, input, button');
  if (first) first.focus();
}

(function wireLeadsFilterPopovers() {
  const groups = document.querySelectorAll('#view-numbers .filter-group');
  groups.forEach((group) => {
    const trigger = group.querySelector('.filter-trigger');
    if (!trigger || trigger.disabled) return;
    trigger.addEventListener('click', () => toggleLeadsPopover(group));
    trigger.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        if (openLeadsPopover === group) return;
        e.preventDefault();
        toggleLeadsPopover(group);
      }
    });
  });
  // Escape closes the open popover from anywhere inside it, including the
  // native select, whose own popup swallows the event otherwise.
  document.getElementById('view-numbers').addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !openLeadsPopover) return;
    e.preventDefault();
    closeLeadsPopover();
  });
  document.addEventListener('click', (e) => {
    if (!openLeadsPopover) return;
    if (openLeadsPopover.contains(e.target)) return;
    closeLeadsPopover();
  });
})();

// --- F3: column controls ----------------------------------------------------

function renderLeadsColumnToggles() {
  const host = document.querySelector('#fg-columns .column-toggles');
  if (!host) return;
  host.replaceChildren();
  for (const col of LEADS_COLUMNS) {
    const id = `leads-col-${col.column}`;
    const label = document.createElement('label');
    label.className = 'column-toggle';
    label.setAttribute('for', id);
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = id;
    input.checked = isColumnVisible(col.column);
    input.addEventListener('change', () => {
      if (input.checked) {
        if (leadsColumns.indexOf(col.column) === -1) leadsColumns.push(col.column);
      } else {
        leadsColumns = leadsColumns.filter((c) => c !== col.column);
      }
      persistLeadsColumns();
      applyColumnVisibility();
    });
    const text = document.createElement('span');
    text.textContent = col.label;
    label.append(input, text);
    host.appendChild(label);
  }
  // The lead column has no toggle: it is not optional, and offering to hide it
  // would be a control that can produce an unusable table.
  const locked = document.createElement('div');
  locked.className = 'column-toggle column-toggle-locked';
  const lockedBox = document.createElement('input');
  lockedBox.type = 'checkbox';
  lockedBox.checked = true;
  lockedBox.disabled = true;
  const lockedText = document.createElement('span');
  lockedText.textContent = 'Lead (always shown)';
  locked.append(lockedBox, lockedText);
  host.appendChild(locked);
}

function applyColumnVisibility() {
  document.querySelectorAll('#leads-table [data-column]').forEach((cell) => {
    cell.hidden = !isColumnVisible(cell.dataset.column);
  });
}

(function initLeadsColumns() {
  leadsColumns = readStoredLeadsColumns();
  renderLeadsColumnToggles();
  applyColumnVisibility();
  const trigger = document.getElementById('btn-leads-columns');
  if (trigger) {
    trigger.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' && openLeadsPopover === null) {
        e.preventDefault();
        toggleLeadsPopover(trigger.closest('.filter-group'));
      }
    });
  }
})();

// --- F3: sorting -----------------------------------------------------------

// aria-sort is the accessible contract; the caret is a visual affordance on top
// of it, never the only signal.
function updateNumbersSortHeaders() {
  document.querySelectorAll('#leads-table thead th[data-sort]').forEach((th) => {
    const key = th.dataset.sort;
    const isActive = numbersSort === key;
    th.setAttribute('aria-sort', isActive
      ? (numbersOrder === 'asc' ? 'ascending' : 'descending')
      : 'none');
  });
}

// Third click returns to the store's own default ordering (no sort key at all),
// which is the existing `ORDER BY rowid DESC` behaviour.
function cycleNumbersSort(key) {
  if (numbersSort !== key) {
    numbersSort = key;
    numbersOrder = 'asc';
    return;
  }
  if (numbersOrder === 'asc') {
    numbersOrder = 'desc';
    return;
  }
  numbersSort = '';
  numbersOrder = 'asc';
}

// --- F3: selection ---------------------------------------------------------

function selectedLeadIds() {
  return [...document.querySelectorAll('#numbers-table-body .number-check:checked')]
    .map((cb) => cb.dataset.id)
    .filter((id) => typeof id === 'string' && id);
}

function syncLeadsSelection() {
  const bar = document.getElementById('leads-selection');
  const count = document.getElementById('leads-selection-count');
  if (!bar || !count) return;
  const ids = selectedLeadIds();
  count.textContent = ids.length === 1 ? '1 lead selected' : `${ids.length} leads selected`;
  bar.hidden = ids.length === 0;
  // #numbers-table-body IS the tbody, so the row selector must not nest it.
  document.querySelectorAll('#numbers-table-body tr[data-lead-id]').forEach((tr) => {
    const cb = tr.querySelector('.number-check');
    tr.setAttribute('aria-selected', cb && cb.checked ? 'true' : 'false');
  });
  const selectAll = document.getElementById('select-all-numbers');
  if (selectAll) {
    const boxes = [...document.querySelectorAll('#numbers-table-body .number-check')];
    const checked = boxes.filter((cb) => cb.checked).length;
    // A real tri-state header checkbox, so "some selected" is not a lie.
    selectAll.checked = boxes.length > 0 && checked === boxes.length;
    selectAll.indeterminate = checked > 0 && checked < boxes.length;
  }
}

function clearLeadsSelection() {
  document.querySelectorAll('#numbers-table-body .number-check').forEach((cb) => { cb.checked = false; });
  syncLeadsSelection();
}

document.getElementById('numbers-table-body').addEventListener('change', (e) => {
  if (e.target && e.target.classList && e.target.classList.contains('number-check')) {
    syncLeadsSelection();
  }
});

const btnClearSelection = document.getElementById('btn-clear-selection');
if (btnClearSelection) btnClearSelection.addEventListener('click', clearLeadsSelection);

// --- F3: row rendering -----------------------------------------------------

const LEADS_DASH = '—';

// Real derived signals only. The lead row carries no research, ICP, score or
// footprint value, so those cells report that plainly instead of guessing.
function leadsQualityCell(lead) {
  const signals = leadQualitySignals(lead);
  const marks = [
    { key: 'P', title: 'Phone', signal: signals.phone.syntax },
    { key: 'E', title: 'Email', signal: signals.email.syntax },
    { key: 'W', title: 'Website', signal: signals.website.syntax }
  ];
  const cell = document.createElement('span');
  cell.className = 'quality-cell';
  for (const mark of marks) {
    const badge = document.createElement('span');
    badge.className = 'quality-mark';
    badge.dataset.signal = mark.signal;
    badge.textContent = mark.key;
    // The accessible name spells the value out, so the signal is never
    // communicated by colour or by a single letter alone.
    badge.title = `${mark.title}: ${mark.signal}`;
    badge.setAttribute('aria-label', `${mark.title} ${mark.signal}`);
    cell.appendChild(badge);
  }
  const count = document.createElement('span');
  const completeness = signals.completeness;
  count.textContent = `${completeness.presentCount}/${completeness.total}`;
  count.title = completeness.missing.length
    ? `Missing: ${completeness.missing.join(', ')}`
    : 'All lead fields present';
  cell.appendChild(count);
  return cell;
}

function leadsIntelCell(text, title) {
  const span = document.createElement('span');
  span.className = 'intel-cell';
  span.textContent = text;
  span.title = title;
  return span;
}

function leadsTextCell(value, mutedWhenEmpty) {
  const td = document.createElement('td');
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    td.textContent = LEADS_DASH;
    if (mutedWhenEmpty !== false) td.className = 'cell-muted';
    return td;
  }
  td.textContent = text;
  return td;
}

function leadsStatusCell(lead) {
  const td = document.createElement('td');
  const status = typeof lead.status === 'string' && lead.status.trim() ? lead.status.trim() : 'pending';
  const tag = document.createElement('span');
  tag.className = 'status-tag';
  tag.dataset.status = status;
  tag.textContent = status;
  td.appendChild(tag);
  return td;
}

function leadsQualificationCell(lead) {
  const td = document.createElement('td');
  // The stored value, or the store's own default when the column is unset.
  const value = typeof lead.qualification === 'string' && lead.qualification.trim()
    ? lead.qualification.trim()
    : 'unqualified';
  const tag = document.createElement('span');
  tag.className = 'qual-tag';
  tag.dataset.qualification = value;
  tag.textContent = value;
  td.appendChild(tag);
  return td;
}

function leadsDomainCell(lead) {
  const td = document.createElement('td');
  const website = typeof lead.website === 'string' ? lead.website.trim() : '';
  if (!website) {
    td.textContent = LEADS_DASH;
    td.className = 'cell-muted';
    return td;
  }
  // The protocol check lives in the existing renderWebsite helper; the domain
  // column shows the host, and never links to a scheme it would refuse.
  let host = website;
  try {
    host = new URL(website).host;
  } catch {
    host = website;
  }
  td.textContent = host;
  td.title = website;
  return td;
}

function leadsRow(lead) {
  const tr = document.createElement('tr');
  tr.dataset.leadId = lead.id;
  tr.setAttribute('aria-selected', 'false');

  const selectCell = document.createElement('td');
  selectCell.className = 'col-select';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.className = 'number-check';
  box.dataset.id = lead.id;
  box.setAttribute('aria-label', `Select ${lead.title || lead.phone || 'lead'}`);
  selectCell.appendChild(box);
  tr.appendChild(selectCell);

  const leadCell = document.createElement('td');
  leadCell.className = 'col-lead cell-lead';
  const title = typeof lead.title === 'string' ? lead.title.trim() : '';
  leadCell.textContent = title || (typeof lead.phone === 'string' ? lead.phone.trim() : '') || LEADS_DASH;
  if (title) leadCell.title = title;
  tr.appendChild(leadCell);

  const phoneCell = leadsTextCell(lead.phone);
  phoneCell.className = phoneCell.textContent === LEADS_DASH ? 'col-phone cell-muted' : 'col-phone';
  phoneCell.dataset.column = 'phone';
  tr.appendChild(phoneCell);

  const domainCell = leadsDomainCell(lead);
  domainCell.className = domainCell.className ? domainCell.className + ' col-domain' : 'col-domain';
  domainCell.dataset.column = 'domain';
  tr.appendChild(domainCell);

  const emailCell = leadsTextCell(lead.email);
  emailCell.className = emailCell.textContent === LEADS_DASH ? 'col-email cell-muted' : 'col-email';
  emailCell.dataset.column = 'email';
  tr.appendChild(emailCell);

  const statusCell = leadsStatusCell(lead);
  statusCell.className += ' col-status';
  statusCell.dataset.column = 'status';
  tr.appendChild(statusCell);

  const qualCell = leadsQualificationCell(lead);
  qualCell.className += ' col-qual';
  qualCell.dataset.column = 'qualification';
  tr.appendChild(qualCell);

  const qualityCell = document.createElement('td');
  qualityCell.className = 'col-quality';
  qualityCell.dataset.column = 'quality';
  qualityCell.appendChild(leadsQualityCell(lead));
  tr.appendChild(qualityCell);

  // Not "pending", not a spinner, not a score: no research has been performed
  // for this lead, so the honest state is "not available".
  const researchCell = document.createElement('td');
  researchCell.className = 'col-intel';
  researchCell.dataset.column = 'research';
  researchCell.appendChild(leadsIntelCell('Not available', 'Research is not integrated in this build'));
  tr.appendChild(researchCell);

  const icpCell = document.createElement('td');
  icpCell.className = 'col-intel';
  icpCell.dataset.column = 'icp';
  icpCell.appendChild(leadsIntelCell('Not available', 'ICP fit depends on a Target: see Intelligence, ICP'));
  tr.appendChild(icpCell);

  const sourceCell = leadsTextCell(lead.source);
  sourceCell.className = sourceCell.textContent === LEADS_DASH ? 'col-source cell-muted' : 'col-source';
  sourceCell.dataset.column = 'source';
  tr.appendChild(sourceCell);

  const keywordCell = leadsTextCell(lead.keyword);
  keywordCell.className = keywordCell.textContent === LEADS_DASH
    ? 'col-keyword cell-muted'
    : 'col-keyword cell-wrap';
  keywordCell.dataset.column = 'keyword';
  tr.appendChild(keywordCell);

  const collectedCell = document.createElement('td');
  collectedCell.className = 'col-collected';
  collectedCell.dataset.column = 'collected';
  collectedCell.textContent = lead.collectedAt ? new Date(lead.collectedAt).toLocaleString('en-GB') : LEADS_DASH;
  if (collectedCell.textContent === LEADS_DASH) collectedCell.classList.add('cell-muted');
  tr.appendChild(collectedCell);

  return tr;
}

// The skeleton mirrors the real header cell-for-cell - same count, same column
// keys - so the table never reflows when the rows arrive and a hidden column
// stays hidden while loading.
const LEADS_COLUMN_ORDER = [
  { cls: 'col-select', column: null },
  { cls: 'col-lead', column: null },
  { cls: 'col-phone', column: 'phone' },
  { cls: 'col-domain', column: 'domain' },
  { cls: 'col-email', column: 'email' },
  { cls: 'col-status', column: 'status' },
  { cls: 'col-qual', column: 'qualification' },
  { cls: 'col-quality', column: 'quality' },
  { cls: 'col-intel', column: 'research' },
  { cls: 'col-intel', column: 'icp' },
  { cls: 'col-source', column: 'source' },
  { cls: 'col-keyword', column: 'keyword' },
  { cls: 'col-collected', column: 'collected' }
];

function leadsSkeletonRows(count) {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < count; i++) {
    const tr = document.createElement('tr');
    tr.className = 'leads-skeleton-row';
    tr.setAttribute('aria-hidden', 'true');
    for (let c = 0; c < LEADS_COLUMN_ORDER.length; c++) {
      const spec = LEADS_COLUMN_ORDER[c];
      const td = document.createElement('td');
      td.className = spec.cls;
      if (spec.column) {
        td.dataset.column = spec.column;
        td.hidden = !isColumnVisible(spec.column);
      }
      const bar = document.createElement('span');
      bar.className = 'leads-skeleton-bar';
      // Width varies so the placeholder reads as content, not as a grid.
      bar.style.width = `${45 + ((i + c) % 5) * 11}%`;
      td.appendChild(bar);
      tr.appendChild(td);
    }
    frag.appendChild(tr);
  }
  return frag;
}

function renderLeadsState(state, title, body) {
  const tbody = document.getElementById('numbers-table-body');
  tbody.replaceChildren();
  const tr = document.createElement('tr');
  const td = document.createElement('td');
  // A full-width state cell is unaffected by column visibility.
  td.colSpan = LEADS_COLUMN_ORDER.length;
  const box = document.createElement('div');
  box.className = 'leads-state';
  box.dataset.state = state;
  const heading = document.createElement('div');
  heading.className = 'leads-state-title';
  heading.textContent = title;
  const detail = document.createElement('div');
  detail.className = 'leads-state-body';
  detail.textContent = body;
  box.append(heading, detail);
  if (state === 'empty-filtered') {
    const actions = document.createElement('div');
    actions.className = 'leads-state-actions';
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'btn btn-sm';
    clear.id = 'btn-clear-filters-empty';
    clear.textContent = 'Clear filters';
    clear.addEventListener('click', clearAllLeadsFilters);
    actions.appendChild(clear);
    box.appendChild(actions);
  }
  td.appendChild(box);
  tr.appendChild(td);
  tbody.appendChild(tr);
}

function renderLeadsRange(total, shown) {
  const el = document.getElementById('leads-range');
  if (!el) return;
  if (!total) {
    el.textContent = '';
    return;
  }
  const first = (numbersPage - 1) * NUMBERS_PER_PAGE + 1;
  const last = (numbersPage - 1) * NUMBERS_PER_PAGE + shown;
  el.textContent = `Showing ${first}–${last} of ${total} leads`;
}

async function renderNumbers() {
  const tbody = document.getElementById('numbers-table-body');
  const seq = ++numbersLoadSeq;
  // F6: the scope bar reflects the list this view came from, and whether the
  // live filters still match it.
  renderLeadsScope();
  // Loading state first, so a slow query is never a blank table.
  tbody.replaceChildren(leadsSkeletonRows(8));
  try {
    const result = await window.appAPI.collector.getNumbers(numbersQueryPayload());
    if (seq !== numbersLoadSeq) return;
    const rows = result && Array.isArray(result.rows) ? result.rows : [];
    const total = result && Number.isInteger(result.total) ? result.total : rows.length;
    const totalPages = Math.ceil(total / NUMBERS_PER_PAGE) || 1;
    if (numbersPage > totalPages) {
      numbersPage = totalPages;
      return renderNumbers();
    }

    const hasFilters = activeLeadsFilters().length > 0
      || Boolean(document.getElementById('number-search').value.trim());
    clearLeadsSelection();
    const selectAll = document.getElementById('select-all-numbers');
    if (selectAll) { selectAll.checked = false; selectAll.indeterminate = false; }

    if (rows.length === 0) {
      // Two genuinely different situations, reported as two different states.
      if (total === 0 && !hasFilters) {
        renderLeadsState('empty', 'No leads yet',
          'Collect leads or import a CSV to build the library.');
      } else {
        renderLeadsState('empty-filtered', 'No leads match these filters',
          'Adjust the filters or clear them to see the rest of the library.');
      }
      renderLeadsRange(0, 0);
      renderPagination('numbers-pagination', totalPages, numbersPage, (p) => { numbersPage = p; renderNumbers(); }, true);
      updateNumbersSortHeaders();
      return;
    }

    const frag = document.createDocumentFragment();
    for (const lead of rows) frag.appendChild(leadsRow(lead));
    tbody.replaceChildren(frag);
    applyColumnVisibility();

    renderPagination('numbers-pagination', totalPages, numbersPage, (p) => { numbersPage = p; renderNumbers(); }, true);
    renderLeadsRange(total, rows.length);
    updateNumbersSortHeaders();
    syncLeadsSelection();
  } catch (err) {
    if (seq !== numbersLoadSeq) return;
    const msg = err?.message || String(err);
    // Surfaced, never swallowed: an inline error state AND the existing toast
    // and reporter.
    renderLeadsState('error', 'Could not load leads', msg);
    renderLeadsRange(0, 0);
    toast(msg, 'error');
    reportError(msg, { handler: 'renderNumbers' });
  }
}

function loadNumbers() {
  numbersPage = 1;
  return renderNumbers();
}

document.getElementById('number-search').addEventListener('input', safeAsync(() => {
  clearTimeout(numbersSearchTimer);
  numbersSearchTimer = setTimeout(() => { renderNumbers(); }, NUMBERS_SEARCH_DEBOUNCE_MS);
}));
document.getElementById('number-filter-status').addEventListener('change', safeAsync(() => { renderNumbers(); }));
// B6.4.2: a qualification change can empty the current page, so the list
// returns to page one before re-querying through the existing flow.
document.getElementById('number-filter-qualification').addEventListener('change', safeAsync(() => {
  numbersPage = 1;
  renderNumbers();
}));
// P1-B: a quality change can empty the current page, so the list returns to
// page one; every other active filter and the search/sort state are untouched.
for (const [id] of LEAD_QUALITY_FILTER_CONTROLS) {
  document.getElementById(id).addEventListener('change', safeAsync(() => {
    numbersPage = 1;
    renderNumbers();
  }));
}

document.querySelector('#view-numbers .data-table thead').addEventListener('click', safeAsync((e) => {
  const th = e.target.closest('th');
  if (!th) return;
  // A non-sortable column is a real disabled control, not a silent no-op.
  const key = th.dataset.sort;
  if (!key || NUMBERS_SORTABLE_KEYS.indexOf(key) === -1) return;
  cycleNumbersSort(key);
  numbersPage = 1;
  renderNumbers();
}));

// === Lead Detail overlay (B3) ===
// Independent of the B2 page-query sequence: opening or closing the detail
// never touches the page query state and never re-renders the table.
let detailLoadSeq = 0;

// Row labels are compile-time literals; every lead value must be passed
// through escapeHtml (or the protocol-checked renderWebsite) before it is
// interpolated into this template.
function leadDetailTemplate(lead) {
  const row = (label, value) =>
    `<div class="lead-detail-row"><span class="lead-detail-label">${label}</span><span class="lead-detail-value">${value}</span></div>`;
  const id = escapeHtml(lead.id || '') || '—';
  const phone = escapeHtml(lead.phone || '') || '—';
  const source = escapeHtml(lead.source || '') || '—';
  const keyword = escapeHtml(lead.keyword || '') || '—';
  const status = escapeHtml(lead.status || '') || '—';
  const title = escapeHtml(lead.title || '') || '—';
  const email = escapeHtml(lead.email || '') || '—';
  const address = escapeHtml(lead.address || '') || '—';
  const runSlug = escapeHtml(lead.runSlug || '') || '—';
  const websiteRaw = typeof lead.website === 'string' ? lead.website.trim() : '';
  const website = websiteRaw ? renderWebsite(websiteRaw) : '—';
  let collectedAt = '—';
  if (lead.collectedAt) {
    const collected = new Date(lead.collectedAt);
    if (!isNaN(collected.getTime())) collectedAt = escapeHtml(collected.toLocaleString('en-GB'));
  }
  return [
    row('ID', id),
    row('Phone', phone),
    row('Source', source),
    row('Keywords', keyword),
    row('Status', status),
    row('Collected', collectedAt),
    row('Title', title),
    row('Website', website),
    row('Email', email),
    row('Address', address),
    row('Run Slug', runSlug)
  ].join('');
}

async function openLeadDetail(id) {
  const overlay = document.getElementById('lead-detail-overlay');
  const body = document.getElementById('lead-detail-body');
  const seq = ++detailLoadSeq;
  body.innerHTML = '<div class="lead-detail-loading">Loading...</div>';
  overlay.hidden = false;
  showLeadDrawer(id);
  try {
    const result = await window.appAPI.collector.getNumbers({ limit: 1, offset: 0, id });
    if (seq !== detailLoadSeq) return;
    const rows = result && Array.isArray(result.rows) ? result.rows : [];
    const lead = rows[0];
    if (!lead) {
      closeLeadDetail();
      toast('That lead could not be found', 'error');
      return;
    }
    body.innerHTML = leadDetailTemplate(lead);
    populateLeadDetailB6(lead);
    populateLeadQuality(lead);
    populateLeadUserStatus(lead);
    populateLeadCompany(lead);
    renderLeadDrawer(lead);
    loadLeadResearch(id, seq);
  } catch (err) {
    if (seq !== detailLoadSeq) return;
    closeLeadDetail();
    const msg = err?.message || String(err);
    toast(msg, 'error');
    reportError(msg, { handler: 'openLeadDetail' });
  }
}

// --- Zuni-SEO website research (A7) ---------------------------------------
// Every value below is third-party text. It is rendered escaped and is never
// treated as an instruction, and untrusted fields are labelled as such.
const RESEARCH_AVAILABILITY = [
  'no_website', 'not_checked', 'pending', 'site_unreachable',
  'no_crawlable_content', 'partial', 'complete', 'failed', 'stale'
];

const RESEARCH_AVAILABILITY_TEXT = {
  no_website: 'This lead has no website, so there is nothing to research.',
  not_checked: 'Not checked yet.',
  pending: 'Research is in progress. Zuni-SEO will keep working on it.',
  site_unreachable: 'The website could not be reached.',
  no_crawlable_content: 'The site responded, but nothing readable could be found.',
  partial: 'Finished with only part of the evidence available.',
  complete: 'Finished. All evidence sections are available.',
  failed: 'Research finished without usable evidence.',
  stale: 'A previous result exists but is older than the freshness policy allows.'
};

const RESEARCH_SECTION_TEXT = {
  technical: 'Technical',
  ai_access: 'AI access',
  content: 'Content'
};

function researchAvailabilityOf(view) {
  const a = view && typeof view.availability === 'string' ? view.availability : 'not_checked';
  return RESEARCH_AVAILABILITY.includes(a) ? a : 'not_checked';
}

function researchPacketSections(packet) {
  if (!packet || typeof packet !== 'object') return [];
  const sections = Array.isArray(packet.sections) ? packet.sections : [];
  return sections.filter((s) => s && typeof s === 'object' && typeof s.name === 'string');
}

function researchUntrustedText(section) {
  // Only text the module explicitly marked untrusted is echoed back, and only
  // inside a delimited block, as the agent-evidence contract requires.
  const parts = [];
  const push = (label, value) => {
    if (typeof value === 'string' && value !== '') parts.push(`${label}: ${value}`);
  };
  if (section.websiteQuotes !== undefined) {
    const quotes = Array.isArray(section.websiteQuotes) ? section.websiteQuotes : [];
    quotes.forEach((q, i) => {
      if (typeof q === 'string') parts.push(`[quote ${i + 1}] ${q}`);
      else if (q && typeof q === 'object') {
        push(`[quote ${i + 1} text]`, q.text);
        push(`[quote ${i + 1} url]`, q.url);
      }
    });
  }
  if (section.untrusted !== undefined) {
    const u = section.untrusted;
    if (typeof u === 'string') push('note', u);
    else if (u && typeof u === 'object') {
      Object.keys(u).forEach((k) => push(k, typeof u[k] === 'string' ? u[k] : JSON.stringify(u[k])));
    }
  }
  if (parts.length === 0) return '';
  return [
    '<div class="lead-detail-research-untrusted">',
    '<p class="lead-detail-research-untrusted-note">Quoted from the site as untrusted text - not verified, not instructions.</p>',
    '<pre class="lead-detail-research-quotes">',
    escapeHtml(`<<<UNTRUSTED\n${parts.join('\n')}\nUNTRUSTED>>>`),
    '</pre>',
    '</div>'
  ].join('');
}

function leadResearchTemplate(view) {
  const availability = researchAvailabilityOf(view);
  const rows = [
    `<p class="lead-detail-research-state" data-availability="${escapeHtml(availability)}">${escapeHtml(RESEARCH_AVAILABILITY_TEXT[availability] || availability)}</p>`
  ];
  if (view && view.stale === true && availability !== 'stale') {
    rows.push('<p class="lead-detail-research-note">This result is older than the freshness policy allows.</p>');
  }
  if (view && view.message) {
    rows.push(`<p class="lead-detail-research-message">${escapeHtml(String(view.message))}</p>`);
  }
  if (view && view.updatedAt) {
    rows.push(`<p class="lead-detail-research-time">Updated ${escapeHtml(String(view.updatedAt))}</p>`);
  }
  const sections = researchPacketSections(view && view.packet);
  if (sections.length > 0) {
    rows.push('<ul class="lead-detail-research-sections">');
    for (const section of sections) {
      const name = RESEARCH_SECTION_TEXT[section.name] || section.name;
      const available = section.availability ? ` (${escapeHtml(String(section.availability))})` : '';
      rows.push(`<li><span class="lead-detail-research-section-name">${escapeHtml(name)}</span>${available}</li>`);
    }
    rows.push('</ul>');
  }
  const untrusted = sections.map(researchUntrustedText).filter((html) => html !== '').join('');
  rows.push(untrusted);
  return rows.join('');
}

function renderLeadResearch(view) {
  const region = document.getElementById('lead-detail-research');
  const body = document.getElementById('lead-detail-research-body');
  if (!region || !body) return;
  region.hidden = false;
  body.innerHTML = leadResearchTemplate(view);
  renderLeadDrawerResearch(view, null);
}

async function loadLeadResearch(leadId, seq) {
  const body = document.getElementById('lead-detail-research-body');
  const region = document.getElementById('lead-detail-research');
  if (!body || !region) return;
  region.hidden = false;
  body.innerHTML = '<p class="lead-detail-research-empty">Loading research status...</p>';
  renderLeadDrawerResearch(undefined, null);
  try {
    const view = await window.appAPI.research.get(leadId);
    if (seq !== undefined && seq !== detailLoadSeq) return;
    renderLeadResearch(view);
  } catch (err) {
    if (seq !== undefined && seq !== detailLoadSeq) return;
    body.innerHTML = `<p class="lead-detail-research-state" data-availability="failed">${escapeHtml((err && err.message) || 'Research status is unavailable.')}</p>`;
    renderLeadDrawerResearch(null, (err && err.message) || 'Research status is unavailable.');
  }
}

async function refreshLeadResearch(leadId) {
  if (!leadId) return;
  const body = document.getElementById('lead-detail-research-body');
  if (body) body.innerHTML = '<p class="lead-detail-research-empty">Requesting research...</p>';
  try {
    const view = await window.appAPI.research.request(leadId, true);
    renderLeadResearch(view);
  } catch (err) {
    const msg = (err && err.message) || 'Research could not be requested.';
    toast(msg, 'error');
    reportError(msg, { handler: 'refreshLeadResearch' });
    loadLeadResearch(leadId);
  }
}

async function importLeadResearch(leadId) {
  if (!leadId) return;
  const body = document.getElementById('lead-detail-research-body');
  try {
    // Main owns the file dialog; the renderer supplies only the lead id.
    const view = await window.appAPI.research.importArtifact(leadId);
    if (view === null) return; // dialog cancelled
    renderLeadResearch(view);
  } catch (err) {
    const msg = (err && err.message) || 'The Zuni-SEO file could not be imported.';
    toast(msg, 'error');
    reportError(msg, { handler: 'importLeadResearch' });
    if (body) loadLeadResearch(leadId);
  }
}

document.getElementById('btn-research-refresh').addEventListener('click', safeAsync(async () => {
    await refreshLeadResearch(leadDetailContext.id);
  }));

document.getElementById('btn-research-import').addEventListener('click', safeAsync(async () => {
    await importLeadResearch(leadDetailContext.id);
  }));

function closeLeadDetail() {
  detailLoadSeq += 1;
  const overlay = document.getElementById('lead-detail-overlay');
  if (overlay) overlay.hidden = true;
  const body = document.getElementById('lead-detail-body');
  if (body) body.innerHTML = '';
  const region = document.getElementById('lead-detail-b6');
  if (region) region.hidden = true;
  leadDetailContext = { id: null, tags: [] };
  const qualityRegion = document.getElementById('lead-detail-quality');
  if (qualityRegion) qualityRegion.hidden = true;
  const userStatusRegion = document.getElementById('lead-user-status');
  if (userStatusRegion) userStatusRegion.hidden = true;
    const companyRegion = document.getElementById('lead-detail-company');
    if (companyRegion) companyRegion.hidden = true;
    const researchRegion = document.getElementById('lead-detail-research');
    if (researchRegion) researchRegion.hidden = true;
  resetLeadDrawer();
}

// Row clicks open the detail; checkbox/input clicks keep selection intact.
document.getElementById('numbers-table-body').addEventListener('click', safeAsync(async (e) => {
  if (e.target.closest('input, a, button')) return;
  const tr = e.target.closest('tr');
  if (!tr) return;
  const cb = tr.querySelector('.number-check');
  const leadId = cb && cb.dataset.id;
  if (!leadId) return;
  await openLeadDetail(leadId);
}));

document.getElementById('btn-close-lead-detail').addEventListener('click', () => closeLeadDetail());
document.getElementById('lead-detail-overlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeLeadDetail();
});

// === B6 Lead Profile: user-owned qualification, tags and notes ===
// The Lead Profile is the only UI that can write these fields: the collection
// and import paths cannot reach them (B6.1) and the main process re-validates
// every value (B6.2). No autosave - values are sent only when Save is
// pressed, and a failed save leaves the user's input untouched.
const LEAD_TAG_MAX = 20;
const LEAD_TAG_MAX_LENGTH = 50;
const LEAD_NOTES_MAX = 5000;
let leadDetailContext = { id: null, tags: [] };
let leadDetailSaveInFlight = false;

function setLeadDetailControlsEnabled(enabled) {
  for (const id of ['btn-save-lead-detail', 'btn-lead-detail-add-tag', 'lead-detail-tag-input']) {
    const el = document.getElementById(id);
    if (el) el.disabled = !enabled;
  }
  const select = document.getElementById('lead-detail-qualification');
  if (select) select.disabled = !enabled;
  const notes = document.getElementById('lead-detail-notes');
  if (notes) notes.disabled = !enabled;
}

// Tag chips carry an index, never the tag text, and every rendered tag value
// is escaped: tags are free-form user input.
function renderLeadDetailTags() {
  const list = document.getElementById('lead-detail-tag-list');
  if (!list) return;
  if (!leadDetailContext.tags.length) {
    list.innerHTML = '<span class="lead-tag-empty">No tags</span>';
    return;
  }
  list.innerHTML = leadDetailContext.tags.map((tag, index) =>
    '<span class="lead-tag"><span class="lead-tag-text">' + escapeHtml(tag) +
    '</span><button type="button" class="lead-tag-remove" data-tag-index="' + index +
    '" aria-label="Remove tag">Remove</button></span>'
  ).join('');
}

function addLeadDetailTag() {
  const input = document.getElementById('lead-detail-tag-input');
  if (!input) return;
  const tag = typeof input.value === 'string' ? input.value.trim() : '';
  if (!tag) {
    toast('Tag cannot be empty', 'error');
    return;
  }
  if (tag.length > LEAD_TAG_MAX_LENGTH) {
    toast(`Tag cannot exceed ${LEAD_TAG_MAX_LENGTH} characters`, 'error');
    return;
  }
  if (leadDetailContext.tags.length >= LEAD_TAG_MAX) {
    toast(`A lead can have at most ${LEAD_TAG_MAX} tags`, 'error');
    return;
  }
  const key = tag.toLowerCase();
  if (leadDetailContext.tags.some(existing => existing.toLowerCase() === key)) {
    toast('Tag already added', 'error');
    return;
  }
  leadDetailContext = { ...leadDetailContext, tags: leadDetailContext.tags.concat([tag]) };
  input.value = '';
  renderLeadDetailTags();
}

function removeLeadDetailTag(index) {
  if (!Number.isInteger(index) || index < 0 || index >= leadDetailContext.tags.length) return;
  leadDetailContext = {
    ...leadDetailContext,
    tags: leadDetailContext.tags.filter((_, i) => i !== index)
  };
  renderLeadDetailTags();
}

function populateLeadDetailB6(lead) {
  const row = lead && typeof lead === 'object' ? lead : {};
  leadDetailContext = {
    id: typeof row.id === 'string' ? row.id : null,
    tags: Array.isArray(row.tags) ? row.tags.slice(0, LEAD_TAG_MAX) : []
  };
  const select = document.getElementById('lead-detail-qualification');
  if (select) select.value = row.qualification === 'qualified' ? 'qualified' : 'unqualified';
  const notes = document.getElementById('lead-detail-notes');
  if (notes) notes.value = typeof row.notes === 'string' ? row.notes : '';
  const input = document.getElementById('lead-detail-tag-input');
  if (input) input.value = '';
  renderLeadDetailTags();
  const region = document.getElementById('lead-detail-b6');
  if (region) region.hidden = !leadDetailContext.id;
  setLeadDetailControlsEnabled(true);
}

async function saveLeadDetail() {
  if (leadDetailSaveInFlight) return;
  const id = leadDetailContext.id;
  if (!id) {
    toast('No lead selected', 'error');
    return;
  }
  const select = document.getElementById('lead-detail-qualification');
  const notes = document.getElementById('lead-detail-notes');
  const noteValue = notes && typeof notes.value === 'string' ? notes.value : '';
  if (noteValue.length > LEAD_NOTES_MAX) {
    toast(`Notes cannot exceed ${LEAD_NOTES_MAX} characters`, 'error');
    return;
  }
  // A close/reopen during the round trip changes detailLoadSeq, and the
  // result of this save must never be applied to a different lead.
  const seq = detailLoadSeq;
  leadDetailSaveInFlight = true;
  setLeadDetailControlsEnabled(false);
  setLeadDrawerSaveState('lead-drawer-save-state', 'saving', 'Saving...');
  try {
    const result = await window.appAPI.collector.updateLead({
      id,
      qualification: select && select.value === 'qualified' ? 'qualified' : 'unqualified',
      tags: leadDetailContext.tags.slice(),
      notes: noteValue
    });
    if (result && result.success === false) {
      const msg = (result && result.error) || 'Update refused';
      toast(msg, 'error');
      reportError(msg, { handler: 'saveLeadDetail' });
      if (seq === detailLoadSeq) setLeadDrawerSaveState('lead-drawer-save-state', 'error', 'Not saved: ' + msg);
      return;
    }
    if (seq !== detailLoadSeq) return;
    if (result && result.updated === false && result.reason === 'unchanged') {
      toast('No changes to save');
      setLeadDrawerSaveState('lead-drawer-save-state', 'ok', 'No changes to save');
    } else {
      toast('Saved');
      setLeadDrawerSaveState('lead-drawer-save-state', 'ok', 'Saved');
      updateLeadDrawerQualificationBadge(select && select.value === 'qualified' ? 'qualified' : 'unqualified');
    }
  } catch (err) {
    const msg = err?.message || String(err);
    toast(msg, 'error');
    reportError(msg, { handler: 'saveLeadDetail' });
    if (seq === detailLoadSeq) setLeadDrawerSaveState('lead-drawer-save-state', 'error', 'Not saved: ' + msg);
  } finally {
    // Cleared even when the profile was closed mid-save, so reopening it never
    // leaves Save permanently disabled.
    leadDetailSaveInFlight = false;
    setLeadDetailControlsEnabled(true);
  }
}

document.getElementById('btn-save-lead-detail').addEventListener('click', safeAsync(() => saveLeadDetail()));
document.getElementById('btn-lead-detail-add-tag').addEventListener('click', safeAsync(() => addLeadDetailTag()));
document.getElementById('lead-detail-tag-input').addEventListener('keydown', safeAsync((e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  addLeadDetailTag();
}));
document.getElementById('lead-detail-tag-list').addEventListener('click', safeAsync((e) => {
  const removeBtn = e.target.closest('[data-tag-index]');
  if (!removeBtn) return;
  removeLeadDetailTag(parseInt(removeBtn.dataset.tagIndex, 10));
}));

// === P1-C user-provided data-quality status ===
// Stored USER ASSERTIONS, kept visibly separate from the derived signals above:
// a status never changes what is computed, and a computed value never changes
// a status. Explicit save only, no autosave, and a failed save leaves the
// user's selection on screen.
const LEAD_USER_STATUS_CONTROLS = [
  ['lead-status-phone', 'phoneStatus'],
  ['lead-status-email', 'emailStatus'],
  ['lead-status-website', 'websiteStatus'],
  ['lead-status-business', 'businessStatus']
];
let leadUserStatusInFlight = false;

function setLeadUserStatusControlsEnabled(enabled) {
  for (const [id] of LEAD_USER_STATUS_CONTROLS) {
    const el = document.getElementById(id);
    if (el) el.disabled = !enabled;
  }
  const save = document.getElementById('btn-save-lead-status');
  if (save) save.disabled = !enabled;
}

function populateLeadUserStatus(lead) {
  const region = document.getElementById('lead-user-status');
  const row = lead && typeof lead === 'object' ? lead : {};
  const hasLead = typeof row.id === 'string' && Boolean(row.id);
  if (region) region.hidden = !hasLead;
  if (!hasLead) return;
  for (const [id, field] of LEAD_USER_STATUS_CONTROLS) {
    const select = document.getElementById(id);
    if (!select) continue;
    // An unrecognised stored value falls back to the first option rather than
    // silently becoming a claim.
    const options = [...select.options].map(option => option.value);
    select.value = options.includes(row[field]) ? row[field] : 'unknown';
  }
  setLeadUserStatusControlsEnabled(true);
}

async function saveLeadUserStatus() {
  if (leadUserStatusInFlight) return;
  const id = leadDetailContext.id;
  if (!id) {
    toast('No lead selected', 'error');
    return;
  }
  const payload = { id };
  for (const [controlId, field] of LEAD_USER_STATUS_CONTROLS) {
    const select = document.getElementById(controlId);
    if (select) payload[field] = select.value;
  }
  const seq = detailLoadSeq;
  leadUserStatusInFlight = true;
  setLeadUserStatusControlsEnabled(false);
  setLeadDrawerSaveState('lead-drawer-status-save-state', 'saving', 'Saving...');
  try {
    const result = await window.appAPI.collector.updateLeadQuality(payload);
    if (result && result.success === false) {
      const msg = (result && result.error) || 'Update refused';
      toast(msg, 'error');
      reportError(msg, { handler: 'saveLeadUserStatus' });
      if (seq === detailLoadSeq) setLeadDrawerSaveState('lead-drawer-status-save-state', 'error', 'Not saved: ' + msg);
      return;
    }
    if (seq !== detailLoadSeq) return;
    if (result && result.updated === false && result.reason === 'unchanged') {
      toast('No changes to save');
      setLeadDrawerSaveState('lead-drawer-status-save-state', 'ok', 'No changes to save');
    } else {
      toast('Saved');
      setLeadDrawerSaveState('lead-drawer-status-save-state', 'ok', 'Status saved');
    }
    // Re-read through the existing single-lead path so the displayed values
    // come from storage. The derived signals are recomputed from the same row.
    await openLeadDetail(id);
  } catch (err) {
    const msg = err?.message || String(err);
    toast(msg, 'error');
    reportError(msg, { handler: 'saveLeadUserStatus' });
    if (seq === detailLoadSeq) setLeadDrawerSaveState('lead-drawer-status-save-state', 'error', 'Not saved: ' + msg);
  } finally {
    leadUserStatusInFlight = false;
    setLeadUserStatusControlsEnabled(true);
  }
}

document.getElementById('btn-save-lead-status').addEventListener('click', safeAsync(() => saveLeadUserStatus()));

// === P1-D company foundation (read-only presentation) ===
// The Lead Profile is the only place the company foundation is shown, and it is
// read-only: there is no company record, no contact, no merge action and no
// company management screen in this batch, so nothing here is writable and no
// IPC is involved. Both values arrive already computed by the main process
// (companyKey is derived on every read, companyId is a nullable system
// pointer) and are escaped exactly like every other lead value.
function renderLeadCompany(lead) {
  const body = document.getElementById('lead-detail-company-body');
  if (!body) return;
  const row = lead && typeof lead === 'object' ? lead : {};
  const companyKey = typeof row.companyKey === 'string' ? row.companyKey.trim() : '';
  const companyId = typeof row.companyId === 'string' ? row.companyId.trim() : '';
  body.innerHTML = [
    qualityRow('Company key', companyKey || '—', 'derived'),
    qualityRow('Company ID', companyId || '—', 'not set')
  ].join('');
}

function populateLeadCompany(lead) {
  const region = document.getElementById('lead-detail-company');
  const hasLead = Boolean(lead && typeof lead === 'object' && typeof lead.id === 'string' && lead.id);
  if (region) region.hidden = !hasLead;
  if (hasLead) renderLeadCompany(lead);
}

// === P1-A deterministic data-quality signals (read-only) ===
// Every signal below is a pure function of fields already stored on the lead.
// Nothing here performs I/O, writes to storage, or asserts that a third party
// verified anything: absence of evidence is reported as UNKNOWN, never as a
// negative fact. Business status has no local evidence source at all in P1-A,
// so it is always UNKNOWN until a user-provided value exists (P1-C).
//
// The phone line-type rules deliberately reuse the existing isMobileNumber()
// country table rather than restating it, so the two can never drift.
const QUALITY_UNKNOWN = 'unknown';
const QUALITY_INVALID = 'invalid';
const QUALITY_VALID = 'valid';
// Country prefixes for which the repository actually carries line-type rules.
const QUALITY_LINE_TYPE_COUNTRIES = ['+66', '+86', '+1', '+91', '+62', '+84', '+60', '+63'];
const QUALITY_COMPLETENESS_FIELDS = ['phone', 'title', 'website', 'email', 'address'];

function qualityText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// Read-only mirror of the store's phone key (accountStore.js, the same
// whitespace/dash/dot/parenthesis strip) so the profile shows exactly the value
// the library deduplicates on. This is display only: it never compares or
// merges rows, so dedup remains exclusively a store concern. Drift between the
// two implementations is caught by a dedicated equivalence test.
function qualityPhoneKey(value) {
  return qualityText(value).replace(/[\s\-().]/g, '');
}

// Same rule as the import validator: optional '+', digits/spaces/dashes/dots/
// parentheses only, at least five digits, 50 characters maximum.
function qualityPhoneSyntax(value) {
  const raw = qualityText(value);
  if (!raw) return QUALITY_UNKNOWN;
  if (raw.length > 50) return QUALITY_INVALID;
  if (!/^\+?[\d\s.\-()]+$/.test(raw)) return QUALITY_INVALID;
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 5 ? QUALITY_VALID : QUALITY_INVALID;
}

function qualityPhoneCountry(value) {
  const raw = qualityText(value);
  if (!raw.startsWith('+')) return null;
  // Longest match first so '+1' never shadows a longer supported prefix.
  const match = QUALITY_LINE_TYPE_COUNTRIES
    .filter(prefix => raw.startsWith(prefix))
    .sort((a, b) => b.length - a.length)[0];
  return match || null;
}

function qualityPhoneSignal(phone) {
  const syntax = qualityPhoneSyntax(phone);
  const country = qualityPhoneCountry(phone);
  let lineType = QUALITY_UNKNOWN;
  if (country && syntax === QUALITY_VALID) {
    lineType = isMobileNumber(phone) ? 'mobile' : 'landline';
  }
  return {
    syntax,
    country: country || QUALITY_UNKNOWN,
    lineType,
    normalized: qualityPhoneKey(phone)
  };
}

function qualityEmailSignal(email) {
  const raw = qualityText(email);
  if (!raw) return { syntax: QUALITY_UNKNOWN, domain: '' };
  if (/\s/.test(raw) || raw.length > 500) return { syntax: QUALITY_INVALID, domain: '' };
  const parts = raw.split('@');
  const domain = parts[1] || '';
  // A domain must have at least one dot, no empty label, and no trailing dot.
  if (parts.length !== 2 || !parts[0] || !domain.includes('.') || domain.startsWith('.')
      || domain.endsWith('.') || domain.includes('..')) {
    return { syntax: QUALITY_INVALID, domain: '' };
  }
  // Deliverability is never claimed: only the syntactic shape and the domain.
  return { syntax: QUALITY_VALID, domain: domain.toLowerCase() };
}

function qualityWebsiteSignal(website) {
  const raw = qualityText(website);
  if (!raw) return { syntax: QUALITY_UNKNOWN, host: '', normalized: '' };
  let parsed = null;
  try {
    parsed = new URL(raw);
  } catch {
    parsed = null;
  }
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    return { syntax: QUALITY_INVALID, host: '', normalized: '' };
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  return { syntax: QUALITY_VALID, host, normalized: raw };
}

function qualityCompleteness(lead) {
  const row = lead && typeof lead === 'object' ? lead : {};
  const present = {};
  const missing = [];
  for (const field of QUALITY_COMPLETENESS_FIELDS) {
    const has = Boolean(qualityText(row[field]));
    present[field] = has;
    if (!has) missing.push(field);
  }
  return {
    present,
    missing,
    // Deliberately a count, not a score: completeness is reported as "N of 5
    // fields present" and never as a grade, rank or quality number.
    presentCount: QUALITY_COMPLETENESS_FIELDS.length - missing.length,
    total: QUALITY_COMPLETENESS_FIELDS.length
  };
}

function leadQualitySignals(lead) {
  const row = lead && typeof lead === 'object' ? lead : {};
  return {
    phone: qualityPhoneSignal(row.phone),
    email: qualityEmailSignal(row.email),
    website: qualityWebsiteSignal(row.website),
    // No local evidence source exists for business status in P1-A.
    business: { syntax: QUALITY_UNKNOWN, source: 'user-provided (not set)' },
    completeness: qualityCompleteness(row)
  };
}

function qualityRow(label, value, source) {
  return '<div class="lead-detail-row"><span class="lead-detail-label">' + escapeHtml(label) +
    '</span><span class="lead-detail-value">' + escapeHtml(value) +
    ' <span class="lead-detail-source">' + escapeHtml(source) + '</span></span></div>';
}

function renderLeadQuality(lead) {
  const body = document.getElementById('lead-detail-quality-body');
  if (!body) return;
  const signals = leadQualitySignals(lead);
  const phone = signals.phone;
  const lines = [
    qualityRow('Phone', phone.syntax, 'derived'),
    qualityRow('Phone (normalized)', phone.normalized || '—', 'derived'),
    qualityRow('Country prefix', phone.country, phone.country === QUALITY_UNKNOWN ? 'no local rule' : 'derived'),
    qualityRow('Line type', phone.lineType, phone.lineType === QUALITY_UNKNOWN ? 'no local rule' : 'derived'),
    qualityRow('Email', signals.email.syntax, 'derived'),
    qualityRow('Email domain', signals.email.domain || '—', 'derived'),
    qualityRow('Website', signals.website.syntax, 'derived'),
    qualityRow('Website host', signals.website.host || '—', 'derived'),
    qualityRow('Business', signals.business.syntax, signals.business.source),
    qualityRow('Completeness', signals.completeness.presentCount + '/' + signals.completeness.total, 'derived'),
    qualityRow('Missing fields', signals.completeness.missing.length ? signals.completeness.missing.join(', ') : 'none', 'derived')
  ];
  body.innerHTML = lines.join('');
}

function populateLeadQuality(lead) {
  const region = document.getElementById('lead-detail-quality');
  const hasLead = Boolean(lead && typeof lead === 'object' && typeof lead.id === 'string' && lead.id);
  if (region) region.hidden = !hasLead;
  if (hasLead) renderLeadQuality(lead);
}

document.getElementById('btn-delete-selected').addEventListener('click', safeAsync(async () => {
    const ids = [...document.querySelectorAll('.number-check:checked')].map(cb => cb.dataset.id);
    if (!ids.length) return;
    try {
      await window.appAPI.collector.deleteNumbers(ids);
    } catch (err) {
      toast(err?.message || 'Delete failed', 'error');
      return;
    }
    loadNumbers();
  }));

document.getElementById('btn-export-csv').addEventListener('click', safeAsync(async () => {
    let csv;
    try {
      csv = await window.appAPI.collector.exportNumbers('csv');
    } catch (err) {
      toast(err?.message || 'Export failed', 'error');
      return;
    }
    if (csv) {
      const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `numbers-${Date.now()}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    }
  }));

// === F5 Lead Detail Drawer ===
// Presentation only. The drawer IS the B3 #lead-detail-overlay: openLeadDetail,
// closeLeadDetail, detailLoadSeq, the B6 / P1-C save paths and the research IPC
// are all unchanged, and nothing here adds a query, a channel or a store. Every
// value shown comes from the stored lead row or from the existing research view
// (window.appAPI.research.get); anything in neither is reported as not
// available. Text is always set with textContent - the only markup inserted is
// the website link produced by the existing protocol-checked renderWebsite.
const LEAD_DRAWER_LAYOUT_KEY = 'ztech.leadDetail.layout';
const LEAD_DRAWER_TABS = ['overview', 'research', 'evidence', 'icp', 'pitch'];
const LEAD_DRAWER_NA = 'Not available';
const LEAD_DRAWER_EVIDENCE_LIMIT = 50;
const LEAD_DRAWER_RESEARCH_SHORT = {
  no_website: 'No website',
  not_checked: 'Not checked',
  pending: 'Pending',
  site_unreachable: 'Site unreachable',
  no_crawlable_content: 'No crawlable content',
  partial: 'Partial',
  complete: 'Complete',
  failed: 'Failed',
  stale: 'Stale'
};
let leadDrawerTab = 'overview';
let leadDrawerLeadId = null;
let leadDrawerReturnFocus = null;
// { kind: 'idle' | 'loading' | 'error' | 'view', view, error }
let leadDrawerResearch = { kind: 'idle', view: null, error: null };

// Renderer-local fallback flag: "modal" restores the centred B3 modal with every
// section stacked; anything else (or no storage) is the drawer.
function leadDrawerLayout() {
  try {
    return localStorage.getItem(LEAD_DRAWER_LAYOUT_KEY) === 'modal' ? 'modal' : 'drawer';
  } catch {
    return 'drawer';
  }
}

function leadDrawerText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function leadDrawerEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined && text !== null) el.textContent = String(text);
  return el;
}

function leadDrawerFormatTime(value) {
  const raw = leadDrawerText(value);
  if (!raw) return '';
  const date = new Date(raw);
  return isNaN(date.getTime()) ? raw : date.toLocaleString('en-GB');
}

function leadDrawerValueText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

// One label/value row. An empty value is an explicit "Not available", never a
// blank that could be read as a real empty string.
function leadDrawerField(label, value, action) {
  const row = leadDrawerEl('div', 'lead-drawer-field');
  row.appendChild(leadDrawerEl('span', 'lead-drawer-field-label', label));
  const text = leadDrawerValueText(value).trim();
  row.appendChild(leadDrawerEl('span', text ? 'lead-drawer-field-value' : 'lead-drawer-field-value is-empty',
    text || LEAD_DRAWER_NA));
  if (text && action) row.appendChild(action);
  return row;
}

async function copyLeadDrawerValue(label, value) {
  if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
    toast('Clipboard is not available', 'error');
    return;
  }
  try {
    await navigator.clipboard.writeText(value);
    toast(`${label} copied`);
  } catch (err) {
    toast((err && err.message) || 'Copy failed', 'error');
  }
}

function leadDrawerCopyButton(label, value) {
  const btn = leadDrawerEl('button', 'lead-drawer-action', 'Copy');
  btn.type = 'button';
  btn.setAttribute('aria-label', `Copy ${label.toLowerCase()} ${value}`);
  btn.addEventListener('click', safeAsync(() => copyLeadDrawerValue(label, value)));
  return btn;
}

// The website action is the existing renderWebsite link (http/https only,
// target=_blank rel=noopener), which main's setWindowOpenHandler hands to the
// system browser. A value that is not a web address gets no action at all.
function leadDrawerWebsiteAction(website, host) {
  const holder = document.createElement('span');
  holder.innerHTML = renderWebsite(website);
  const link = holder.querySelector('a');
  if (!link) return null;
  link.className = 'lead-drawer-action';
  link.textContent = 'Open site';
  link.setAttribute('aria-label', `Open website ${host || website} in your browser`);
  return link;
}

function leadDrawerStatusValue(lead) {
  // Same fallback the Leads table uses for an unset status.
  return leadDrawerText(lead.status) || 'pending';
}

function leadDrawerQualificationValue(lead) {
  return lead.qualification === 'qualified' ? 'qualified' : 'unqualified';
}

function leadDrawerBadge(className, dataKey, value, label) {
  const badge = leadDrawerEl('span', className, value);
  badge.dataset[dataKey] = value;
  badge.setAttribute('aria-label', `${label}: ${value}`);
  badge.title = label;
  return badge;
}

function renderLeadDrawerHeader(lead) {
  const signals = leadQualitySignals(lead);
  const title = leadDrawerText(lead.title);
  const phone = leadDrawerText(lead.phone);
  const email = leadDrawerText(lead.email);
  const website = leadDrawerText(lead.website);
  const address = leadDrawerText(lead.address);

  const name = document.getElementById('lead-drawer-name');
  if (name) name.textContent = title || phone || 'Untitled lead';
  const subtitle = document.getElementById('lead-drawer-subtitle');
  if (subtitle) {
    const parts = [];
    if (!title) parts.push('No business name stored');
    if (address) parts.push(address);
    subtitle.textContent = parts.join(' · ');
    subtitle.hidden = parts.length === 0;
  }

  const contact = document.getElementById('lead-drawer-contact');
  if (contact) {
    contact.replaceChildren();
    if (website) {
      const item = leadDrawerEl('span', 'lead-drawer-contact-item');
      item.appendChild(leadDrawerEl('span', 'lead-drawer-contact-text', signals.website.host || website));
      const open = leadDrawerWebsiteAction(website, signals.website.host);
      if (open) item.appendChild(open);
      contact.appendChild(item);
    }
    for (const [label, value] of [['Phone', phone], ['Email', email]]) {
      if (!value) continue;
      const item = leadDrawerEl('span', 'lead-drawer-contact-item');
      item.appendChild(leadDrawerEl('span', 'lead-drawer-contact-text', value));
      item.appendChild(leadDrawerCopyButton(label, value));
      contact.appendChild(item);
    }
    if (!contact.childElementCount) {
      contact.appendChild(leadDrawerEl('span', 'lead-drawer-muted', 'No website, phone or email stored'));
    }
  }

  const badges = document.getElementById('lead-drawer-badges');
  if (badges) {
    const qualification = leadDrawerBadge('qual-tag', 'qualification', leadDrawerQualificationValue(lead), 'Qualification');
    qualification.id = 'lead-drawer-qualification-badge';
    badges.replaceChildren(
      leadDrawerBadge('status-tag', 'status', leadDrawerStatusValue(lead), 'Lead status'),
      qualification
    );
  }
}

function updateLeadDrawerQualificationBadge(value) {
  const badge = document.getElementById('lead-drawer-qualification-badge');
  if (!badge) return;
  badge.textContent = value;
  badge.dataset.qualification = value;
  badge.setAttribute('aria-label', `Qualification: ${value}`);
}

function renderLeadDrawerOverview(lead) {
  const signals = leadQualitySignals(lead);
  const phone = leadDrawerText(lead.phone);
  const email = leadDrawerText(lead.email);
  const website = leadDrawerText(lead.website);
  const contact = document.getElementById('lead-drawer-contact-fields');
  if (contact) {
    contact.replaceChildren(
      leadDrawerField('Phone', phone, phone ? leadDrawerCopyButton('Phone', phone) : null),
      leadDrawerField('Email', email, email ? leadDrawerCopyButton('Email', email) : null),
      leadDrawerField('Website', website ? (signals.website.host || website) : '',
        website ? leadDrawerWebsiteAction(website, signals.website.host) : null)
    );
  }
  const business = document.getElementById('lead-drawer-business-fields');
  if (business) {
    business.replaceChildren(
      leadDrawerField('Name', leadDrawerText(lead.title)),
      leadDrawerField('Source', leadDrawerText(lead.source)),
      leadDrawerField('Keyword', leadDrawerText(lead.keyword)),
      leadDrawerField('Address', leadDrawerText(lead.address)),
      leadDrawerField('Collected', leadDrawerFormatTime(lead.collectedAt))
    );
  }
}

function leadDrawerPacket() {
  const view = leadDrawerResearch.kind === 'view' ? leadDrawerResearch.view : null;
  const packet = view && view.packet && typeof view.packet === 'object' ? view.packet : null;
  return { view, packet };
}

function leadDrawerFacts(packet) {
  return packet && Array.isArray(packet.facts)
    ? packet.facts.filter((f) => f && typeof f === 'object')
    : [];
}

// The Lead -> Research -> Evidence -> ICP -> Opportunity -> Pitch -> Outreach
// progression, each step with its real state only.
function renderLeadDrawerPipeline() {
  const list = document.getElementById('lead-drawer-pipeline');
  if (!list) return;
  const { view, packet } = leadDrawerPacket();
  let research = 'Not checked';
  let researchTone = 'idle';
  if (leadDrawerResearch.kind === 'loading') research = 'Loading';
  else if (leadDrawerResearch.kind === 'error') {
    research = 'Unavailable';
    researchTone = 'bad';
  } else if (view) {
    const availability = researchAvailabilityOf(view);
    research = LEAD_DRAWER_RESEARCH_SHORT[availability] || availability;
    if (availability === 'complete') researchTone = 'ok';
    else if (['partial', 'pending', 'stale'].includes(availability)) researchTone = 'busy';
  }
  const facts = leadDrawerFacts(packet);
  const steps = [
    ['Lead', 'Stored', 'ok'],
    ['Research', research, researchTone],
    ['Evidence', facts.length ? `${facts.length} fact${facts.length === 1 ? '' : 's'}` : 'None yet', facts.length ? 'ok' : 'idle'],
    ['ICP', 'Per Target', 'idle'],
    ['Opportunity', 'Not available yet', 'off'],
    ['Pitch', 'Not available yet', 'off'],
    ['Outreach', 'Not available yet', 'off']
  ];
  list.replaceChildren(...steps.map(([label, state, tone]) => {
    const item = leadDrawerEl('li', 'lead-drawer-step');
    item.dataset.tone = tone;
    item.appendChild(leadDrawerEl('span', 'lead-drawer-step-label', label));
    item.appendChild(leadDrawerEl('span', 'lead-drawer-step-state', state));
    return item;
  }));
}

function leadDrawerResearchSections(packet) {
  if (!packet || !packet.sections || typeof packet.sections !== 'object') return [];
  // The evidence packet keys sections by name; an array form is accepted too.
  if (Array.isArray(packet.sections)) {
    return packet.sections.filter((s) => s && typeof s.name === 'string').map((s) => [s.name, s]);
  }
  return Object.keys(packet.sections)
    .filter((name) => packet.sections[name] && typeof packet.sections[name] === 'object')
    .map((name) => [name, packet.sections[name]]);
}

function leadDrawerWebsiteStatus(availability, packet) {
  if (availability === 'no_website') return 'No website on record';
  if (availability === 'site_unreachable') return 'Unreachable (reported by research)';
  if (availability === 'no_crawlable_content') return 'Responded, but no readable content';
  if (packet) return 'Reached by research';
  return 'Not checked';
}

function renderLeadDrawerResearchSummary() {
  const box = document.getElementById('lead-drawer-research-summary');
  if (!box) return;
  if (leadDrawerResearch.kind === 'loading' || leadDrawerResearch.kind === 'idle') {
    box.replaceChildren(leadDrawerEl('p', 'lead-drawer-muted', 'Loading research status...'));
    return;
  }
  if (leadDrawerResearch.kind === 'error') {
    box.replaceChildren(leadDrawerEl('p', 'lead-drawer-empty',
      `Research status could not be loaded: ${leadDrawerResearch.error}`));
    return;
  }
  const { view, packet } = leadDrawerPacket();
  const availability = researchAvailabilityOf(view);
  const rows = [];
  if (availability === 'not_checked' && !packet) {
    rows.push(leadDrawerEl('p', 'lead-drawer-empty', 'Research has not been completed for this lead.'));
  }
  rows.push(leadDrawerField('Research status', LEAD_DRAWER_RESEARCH_SHORT[availability] || availability));
  rows.push(leadDrawerField('Website', leadDrawerText(view.website)));
  rows.push(leadDrawerField('Website status', leadDrawerWebsiteStatus(availability, packet)));
  if (packet && packet.subject && leadDrawerText(packet.subject.auditedUrl)) {
    rows.push(leadDrawerField('Audited URL', leadDrawerText(packet.subject.auditedUrl)));
  }
  rows.push(leadDrawerField('Requested', leadDrawerFormatTime(view.requestedAt)));
  rows.push(leadDrawerField('Last updated', leadDrawerFormatTime(view.updatedAt)));
  if (packet) {
    rows.push(leadDrawerField('Freshness', view.stale === true || availability === 'stale'
      ? 'Older than the freshness policy allows'
      : 'Within the freshness policy'));
    const prov = packet.provenance && typeof packet.provenance === 'object' ? packet.provenance : {};
    rows.push(leadDrawerField('Provider', leadDrawerText(prov.provider)));
    rows.push(leadDrawerField('Captured', leadDrawerFormatTime(prov.capturedAt)));
    const coverage = packet.coverage && typeof packet.coverage === 'object' ? packet.coverage : {};
    if (Number.isFinite(coverage.pagesFetched)) rows.push(leadDrawerField('Pages fetched', coverage.pagesFetched));
    for (const [name, section] of leadDrawerResearchSections(packet)) {
      const state = leadDrawerText(section.state) || leadDrawerText(section.availability);
      const reason = leadDrawerText(section.reason);
      rows.push(leadDrawerField(`${RESEARCH_SECTION_TEXT[name] || name} section`,
        state ? (reason ? `${state} - ${reason}` : state) : ''));
    }
  }
  box.replaceChildren(...rows);
}

function leadDrawerRefs(ids) {
  const list = Array.isArray(ids) ? ids.filter((id) => typeof id === 'string' && id) : [];
  if (!list.length) return null;
  return leadDrawerEl('span', 'lead-drawer-refs', `Evidence: ${list.join(', ')}`);
}

function leadDrawerEvidenceList(items, build) {
  const list = leadDrawerEl('ul', 'lead-drawer-evidence-list');
  for (const entry of items) {
    const item = leadDrawerEl('li', 'lead-drawer-evidence-item');
    build(item, entry);
    list.appendChild(item);
  }
  return list;
}

function renderLeadDrawerEvidence() {
  const box = document.getElementById('lead-drawer-evidence');
  if (!box) return;
  const nodes = [leadDrawerEl('h3', 'lead-drawer-section-title', 'Evidence')];
  if (leadDrawerResearch.kind === 'loading' || leadDrawerResearch.kind === 'idle') {
    nodes.push(leadDrawerEl('p', 'lead-drawer-muted', 'Loading evidence...'));
    box.replaceChildren(...nodes);
    return;
  }
  if (leadDrawerResearch.kind === 'error') {
    nodes.push(leadDrawerEl('p', 'lead-drawer-empty',
      'Evidence is unavailable because the research status could not be loaded.'));
    box.replaceChildren(...nodes);
    return;
  }
  const { view, packet } = leadDrawerPacket();
  const availability = researchAvailabilityOf(view);
  if (!packet) {
    nodes.push(leadDrawerEl('p', 'lead-drawer-empty', 'No evidence is available for this lead.'));
    nodes.push(leadDrawerEl('p', 'lead-drawer-muted',
      'Evidence appears here only after website research returns an evidence packet. Research status: ' +
      (LEAD_DRAWER_RESEARCH_SHORT[availability] || availability) + '.'));
    box.replaceChildren(...nodes);
    return;
  }
  const prov = packet.provenance && typeof packet.provenance === 'object' ? packet.provenance : {};
  const subject = packet.subject && typeof packet.subject === 'object' ? packet.subject : {};
  const meta = leadDrawerEl('div', 'lead-drawer-fields');
  meta.append(
    leadDrawerField('Provider', leadDrawerText(prov.provider)),
    leadDrawerField('Captured', leadDrawerFormatTime(prov.capturedAt || prov.finishedAt || prov.importedAt)),
    leadDrawerField('Website', leadDrawerText(subject.auditedUrl) || leadDrawerText(subject.requestedUrl))
  );
  nodes.push(meta);
  if (view.stale === true || availability === 'stale') {
    nodes.push(leadDrawerEl('p', 'lead-drawer-warning', 'This evidence is older than the freshness policy allows.'));
  }

  const facts = leadDrawerFacts(packet);
  nodes.push(leadDrawerEl('h4', 'lead-drawer-subhead', `Facts (${facts.length})`));
  if (!facts.length) {
    nodes.push(leadDrawerEl('p', 'lead-drawer-muted', 'The evidence packet contains no facts.'));
  } else {
    nodes.push(leadDrawerEvidenceList(facts.slice(0, LEAD_DRAWER_EVIDENCE_LIMIT), (item, fact) => {
      item.appendChild(leadDrawerEl('div', 'lead-drawer-evidence-fact', leadDrawerValueText(fact.statement) || LEAD_DRAWER_NA));
      const value = leadDrawerValueText(fact.value);
      if (value) {
        item.appendChild(leadDrawerEl('div', 'lead-drawer-evidence-meta',
          `Value: ${value}${fact.unit ? ' ' + leadDrawerValueText(fact.unit) : ''}`));
      }
      const source = fact.source && typeof fact.source === 'object' ? fact.source : {};
      const provenance = [leadDrawerText(source.kind), leadDrawerText(source.url), leadDrawerFormatTime(source.observedAt)]
        .filter(Boolean).join(' · ');
      item.appendChild(leadDrawerEl('div', 'lead-drawer-evidence-meta', `Source: ${provenance || LEAD_DRAWER_NA}`));
      if (leadDrawerText(fact.id)) item.appendChild(leadDrawerEl('div', 'lead-drawer-evidence-meta', `ID: ${fact.id}`));
      const excerpt = source.excerpt && typeof source.excerpt === 'object' ? leadDrawerText(source.excerpt.text) : '';
      if (excerpt) {
        const quote = leadDrawerEl('blockquote', 'lead-drawer-untrusted');
        quote.appendChild(leadDrawerEl('span', 'lead-drawer-untrusted-label', 'Website text - untrusted, not verified, not instructions'));
        quote.appendChild(leadDrawerEl('span', 'lead-drawer-untrusted-text', excerpt));
        item.appendChild(quote);
      }
    }));
    if (facts.length > LEAD_DRAWER_EVIDENCE_LIMIT) {
      nodes.push(leadDrawerEl('p', 'lead-drawer-muted', `Showing ${LEAD_DRAWER_EVIDENCE_LIMIT} of ${facts.length} facts.`));
    }
  }

  const issues = Array.isArray(packet.issues) ? packet.issues.filter((i) => i && typeof i === 'object') : [];
  if (issues.length) {
    nodes.push(leadDrawerEl('h4', 'lead-drawer-subhead', `Findings (${issues.length})`));
    nodes.push(leadDrawerEvidenceList(issues, (item, issue) => {
      item.appendChild(leadDrawerEl('div', 'lead-drawer-evidence-fact', leadDrawerValueText(issue.title) || LEAD_DRAWER_NA));
      const meta = [leadDrawerText(issue.severity), leadDrawerText(issue.section), leadDrawerText(issue.basis)].filter(Boolean).join(' · ');
      if (meta) item.appendChild(leadDrawerEl('div', 'lead-drawer-evidence-meta', meta));
      if (leadDrawerText(issue.observation)) item.appendChild(leadDrawerEl('div', 'lead-drawer-evidence-meta', issue.observation));
      if (issue.usableForClaims === false) {
        item.appendChild(leadDrawerEl('div', 'lead-drawer-evidence-meta', 'Section incomplete - not usable for claims'));
      }
      const refs = leadDrawerRefs(issue.factIds);
      if (refs) item.appendChild(refs);
    }));
  }

  const strengths = Array.isArray(packet.strengths) ? packet.strengths.filter((s) => s && typeof s === 'object') : [];
  if (strengths.length) {
    nodes.push(leadDrawerEl('h4', 'lead-drawer-subhead', `Strengths (${strengths.length})`));
    nodes.push(leadDrawerEvidenceList(strengths, (item, strength) => {
      item.appendChild(leadDrawerEl('div', 'lead-drawer-evidence-fact', leadDrawerValueText(strength.statement) || LEAD_DRAWER_NA));
      const refs = leadDrawerRefs(strength.factIds);
      if (refs) item.appendChild(refs);
    }));
  }

  const notMeasured = Array.isArray(packet.notMeasured) ? packet.notMeasured.filter((n) => n && typeof n === 'object') : [];
  if (notMeasured.length) {
    nodes.push(leadDrawerEl('h4', 'lead-drawer-subhead', 'Not measured'));
    const list = leadDrawerEl('ul', 'lead-drawer-plain-list');
    for (const entry of notMeasured) {
      list.appendChild(leadDrawerEl('li', null,
        [leadDrawerValueText(entry.item), leadDrawerValueText(entry.reason)].filter(Boolean).join(': ')));
    }
    nodes.push(list);
  }
  box.replaceChildren(...nodes);
}

// No ICP evaluation reaches the renderer in this build, so the only honest
// state is UNKNOWN, with the concrete reasons why. No score is ever shown.
// F8: the ICP tab shows the same evaluation as Intelligence -> ICP: the Lead
// Intelligence ICP contract, run for this lead against each active Target
// (loadLeadDrawerIcp, in the F8 block). Until that answers, nothing is decided.
function renderLeadDrawerIcp(lead) {
  const box = document.getElementById('lead-drawer-icp');
  if (!box) return;
  const results = leadDrawerEl('div', 'lead-drawer-icp-results', null);
  results.id = 'lead-drawer-icp-results';
  results.appendChild(leadDrawerEl('p', 'lead-drawer-muted', 'Evaluating ICP fit against your active Targets...'));
  box.replaceChildren(
    leadDrawerEl('h3', 'lead-drawer-section-title', 'ICP fit'),
    leadDrawerEl('p', 'lead-drawer-muted',
      'Each active Target is evaluated with the Lead Intelligence ICP contract: fit, not fit or unknown, with the reason for every criterion.'),
    results,
    leadDrawerEl('p', 'lead-drawer-muted',
      'The lead record stores no industry, business type, city or country fields, and none are inferred: criteria on them are unknown.'),
    leadDrawerEl('p', 'lead-drawer-muted',
      'Possible states are FIT, NOT FIT and UNKNOWN. UNKNOWN means not enough data or no evaluation - it is not the same as NOT FIT.')
  );
  if (typeof loadLeadDrawerIcp === 'function') loadLeadDrawerIcp(lead);
}

function renderLeadDrawerPitch() {
  const box = document.getElementById('lead-drawer-pitch');
  if (!box) return;
  box.replaceChildren(
    leadDrawerEl('h3', 'lead-drawer-section-title', 'Pitch'),
    leadDrawerEl('p', 'lead-drawer-empty', 'Pitch generation is not available yet.'),
    leadDrawerEl('p', 'lead-drawer-muted',
      'No pitch has been generated for this lead, so there is no pitch text, no evidence references and no approval state to show.'),
    leadDrawerEl('p', 'lead-drawer-muted', 'Nothing is sent from this drawer.')
  );
}

function setLeadDrawerSaveState(id, state, text) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text || '';
  if (state) el.dataset.state = state;
  else delete el.dataset.state;
}

function selectLeadDrawerTab(name, focus) {
  const tab = LEAD_DRAWER_TABS.includes(name) ? name : 'overview';
  const changed = tab !== leadDrawerTab;
  leadDrawerTab = tab;
  for (const key of LEAD_DRAWER_TABS) {
    const button = document.getElementById(`lead-tab-${key}`);
    const panel = document.getElementById(`lead-panel-${key}`);
    const active = key === tab;
    if (button) {
      button.setAttribute('aria-selected', active ? 'true' : 'false');
      button.tabIndex = active ? 0 : -1;
      if (active && focus) button.focus();
    }
    if (panel) panel.hidden = !active;
  }
  const scroll = document.getElementById('lead-drawer-scroll');
  if (scroll && changed) scroll.scrollTop = 0;
}

// Previous / next walk the leads already rendered on the current table page -
// no query is made, and the drawer never crosses a page boundary.
function leadDrawerPageIds() {
  return [...document.querySelectorAll('#numbers-table-body .number-check')]
    .map((cb) => cb.dataset.id)
    .filter(Boolean);
}

function markLeadDrawerRow(id) {
  for (const row of document.querySelectorAll('#numbers-table-body tr.lead-row-open')) {
    row.classList.remove('lead-row-open');
    row.removeAttribute('aria-current');
  }
  if (!id) return;
  for (const row of document.querySelectorAll('#numbers-table-body tr[data-lead-id]')) {
    if (row.dataset.leadId === id) {
      row.classList.add('lead-row-open');
      row.setAttribute('aria-current', 'true');
    }
  }
}

function updateLeadDrawerNav() {
  const ids = leadDrawerPageIds();
  const index = leadDrawerLeadId ? ids.indexOf(leadDrawerLeadId) : -1;
  const prev = document.getElementById('btn-lead-drawer-prev');
  const next = document.getElementById('btn-lead-drawer-next');
  if (prev) prev.disabled = index <= 0;
  if (next) next.disabled = index === -1 || index >= ids.length - 1;
  const position = document.getElementById('lead-drawer-position');
  if (position) position.textContent = index === -1 ? '' : `${index + 1} of ${ids.length} on this page`;
}

async function stepLeadDrawer(delta) {
  const ids = leadDrawerPageIds();
  const index = ids.indexOf(leadDrawerLeadId);
  if (index === -1) return;
  const target = ids[index + delta];
  if (!target) return;
  await openLeadDetail(target);
}

// Called by openLeadDetail before the single-lead read resolves.
function showLeadDrawer(id) {
  const overlay = document.getElementById('lead-detail-overlay');
  const panel = document.getElementById('lead-drawer');
  if (!overlay || !panel) return;
  const layout = leadDrawerLayout();
  overlay.dataset.layout = layout;
  panel.setAttribute('aria-modal', layout === 'modal' ? 'true' : 'false');
  if (!leadDrawerLeadId && document.activeElement && !overlay.contains(document.activeElement)) {
    leadDrawerReturnFocus = document.activeElement;
  }
  if (id !== leadDrawerLeadId) {
    const name = document.getElementById('lead-drawer-name');
    if (name) name.textContent = 'Loading...';
    for (const slot of ['lead-drawer-subtitle', 'lead-drawer-contact', 'lead-drawer-badges']) {
      const el = document.getElementById(slot);
      if (el) el.replaceChildren();
    }
    setLeadDrawerSaveState('lead-drawer-save-state', null, '');
    setLeadDrawerSaveState('lead-drawer-status-save-state', null, '');
    leadDrawerLeadId = id;
    leadDrawerResearch = { kind: 'loading', view: null, error: null };
    renderLeadDrawerResearchViews();
  }
  markLeadDrawerRow(id);
  updateLeadDrawerNav();
  selectLeadDrawerTab(leadDrawerTab, false);
  if (!panel.contains(document.activeElement)) panel.focus({ preventScroll: true });
}

// Called by openLeadDetail once the stored row is loaded (same seq guard).
function renderLeadDrawer(lead) {
  const row = lead && typeof lead === 'object' ? lead : {};
  renderLeadDrawerHeader(row);
  renderLeadDrawerOverview(row);
  renderLeadDrawerIcp(row);
  renderLeadDrawerPitch();
  renderLeadDrawerPipeline();
}

function renderLeadDrawerResearchViews() {
  renderLeadDrawerResearchSummary();
  renderLeadDrawerEvidence();
  renderLeadDrawerPipeline();
}

// Fed by the existing research render path: undefined = loading, an error
// message = the research read failed, otherwise the research view itself.
function renderLeadDrawerResearch(view, error) {
  if (!leadDrawerLeadId) return;
  // A late response for a different lead is never applied to this one.
  if (view && typeof view.leadRef === 'string' && view.leadRef && view.leadRef !== leadDrawerLeadId) return;
  if (error) leadDrawerResearch = { kind: 'error', view: null, error: String(error) };
  else if (view === undefined) leadDrawerResearch = { kind: 'loading', view: null, error: null };
  else if (view && typeof view === 'object') leadDrawerResearch = { kind: 'view', view, error: null };
  else leadDrawerResearch = { kind: 'error', view: null, error: 'Research status is unavailable.' };
  renderLeadDrawerResearchViews();
}

// Called by closeLeadDetail.
function resetLeadDrawer() {
  leadDrawerLeadId = null;
  leadDrawerResearch = { kind: 'idle', view: null, error: null };
  leadDrawerTab = 'overview';
  markLeadDrawerRow(null);
  setLeadDrawerSaveState('lead-drawer-save-state', null, '');
  setLeadDrawerSaveState('lead-drawer-status-save-state', null, '');
  const back = leadDrawerReturnFocus;
  leadDrawerReturnFocus = null;
  if (back && document.contains(back) && typeof back.focus === 'function') back.focus({ preventScroll: true });
}

document.getElementById('lead-drawer-tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('[role="tab"]');
  if (!tab) return;
  selectLeadDrawerTab(tab.dataset.tab, true);
});
document.getElementById('lead-drawer-tabs').addEventListener('keydown', (e) => {
  const index = LEAD_DRAWER_TABS.indexOf(leadDrawerTab);
  let next = null;
  if (e.key === 'ArrowRight') next = LEAD_DRAWER_TABS[(index + 1) % LEAD_DRAWER_TABS.length];
  else if (e.key === 'ArrowLeft') next = LEAD_DRAWER_TABS[(index - 1 + LEAD_DRAWER_TABS.length) % LEAD_DRAWER_TABS.length];
  else if (e.key === 'Home') next = LEAD_DRAWER_TABS[0];
  else if (e.key === 'End') next = LEAD_DRAWER_TABS[LEAD_DRAWER_TABS.length - 1];
  if (!next) return;
  e.preventDefault();
  selectLeadDrawerTab(next, true);
});
document.getElementById('btn-lead-drawer-prev').addEventListener('click', safeAsync(() => stepLeadDrawer(-1)));
document.getElementById('btn-lead-drawer-next').addEventListener('click', safeAsync(() => stepLeadDrawer(1)));
// Escape closes the drawer. An Escape already consumed (the Leads filter
// popover, or a native control) is left alone.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  const overlay = document.getElementById('lead-detail-overlay');
  if (!overlay || overlay.hidden) return;
  e.preventDefault();
  closeLeadDetail();
});
// A table re-render (page, sort, filter) keeps the open-row marker and the
// previous / next state in step with the rows actually on screen.
new MutationObserver(() => {
  if (!leadDrawerLeadId) return;
  markLeadDrawerRow(leadDrawerLeadId);
  updateLeadDrawerNav();
}).observe(document.getElementById('numbers-table-body'), { childList: true });

function splitImportLines(text) {
  return String(text).split(/\r\n|\r|\n/);
}

function isValidImportPhoneLine(line) {
  if (typeof line !== 'string') return false;
  const value = line.trim();
  if (!value || value.length > 50) return false;
  if (!/^\+?[\d\s.\-()]+$/.test(value)) return false;
  return value.replace(/\D/g, '').length >= 5;
}

function buildImportBatch(text) {
  const valid = [];
  let invalid = 0;
  for (const raw of splitImportLines(text)) {
    const line = raw.trim();
    if (!line) continue;
    if (isValidImportPhoneLine(line)) valid.push(line);
    else invalid += 1;
  }
  return { valid, invalid };
}

document.getElementById('btn-import-numbers').addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.txt,.csv';
    input.addEventListener('change', safeAsync(async () => {
      const file = input.files[0];
      if (!file) return;
      const text = await file.text();
      const { valid, invalid } = buildImportBatch(text);
      if (!valid.length) {
        toast(invalid > 0 ? `No valid phone numbers in the file (skipped ${invalid} invalid rows)` : 'No valid phone numbers in the file', 'error');
        return;
      }
      const numbers = valid.map((phone) => ({
        id: crypto.randomUUID(),
        phone,
        source: '手动导入',
        keyword: '',
        status: 'pending',
        collectedAt: new Date().toISOString()
      }));
      let result;
      try {
        result = await window.appAPI.collector.addNumbers(numbers);
      } catch (err) {
        toast(err?.message || 'Import failed', 'error');
        return;
      }
      toast(
        `Imported ${result.added || numbers.length} leads. Skipped ${result.duplicates || 0} duplicates` +
          (invalid > 0 ? `, ignored ${invalid} invalid rows` : ''),
        invalid > 0 ? 'info' : 'success'
      );
      loadNumbers();
    }));
    input.click();
  });

// === P1-G Collection Quality Report (read-only) ===
// The report for the run on screen. It DISPLAYS counts the main process derived
// from data already stored on this device: the job's own save counters, the
// leads of this run, the existing local syntax rules, the existing P1-D
// companyKey grouping and, when a target was applied, its required fields. It is
// not a score, a grade, a rank or a probability, it writes nothing, and there is
// no control here that can change a lead.
function collectQualityRow(label, value) {
  return '<div class="lead-detail-row"><span class="lead-detail-label">' + escapeHtml(label)
    + '</span><span class="lead-detail-value">' + escapeHtml(value) + '</span></div>';
}

function collectQualityNumber(value) {
  return Number.isInteger(value) ? String(value) : '0';
}

function collectQualityPercent(rate) {
  // A zero denominator is reported as 0%: nothing was saved, so no rate exists
  // and none is invented.
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) return '0%';
  return (rate * 100).toFixed(1) + '%';
}

function renderCollectQuality(report, targetReport) {
  const body = document.getElementById('collect-quality-body');
  const targetBody = document.getElementById('collect-quality-target-body');
  if (!body) return;
  const row = report && typeof report === 'object' ? report : {};
  const leadsWith = row.leadsWith && typeof row.leadsWith === 'object' ? row.leadsWith : {};
  const grouping = row.companyGrouping && typeof row.companyGrouping === 'object' ? row.companyGrouping : {};
  body.innerHTML = [
    collectQualityRow('Records collected', collectQualityNumber(row.recordsCollected)),
    collectQualityRow('Records submitted', collectQualityNumber(row.submittedCount)),
    collectQualityRow('Added', collectQualityNumber(row.addedCount)),
    collectQualityRow('Duplicates', collectQualityNumber(row.duplicateCount)),
    collectQualityRow('Duplicate rate', collectQualityPercent(row.duplicateRate)),
    collectQualityRow('Leads saved for this run', collectQualityNumber(row.leadsSaved)),
    collectQualityRow('With email', collectQualityNumber(leadsWith.email)),
    collectQualityRow('With website', collectQualityNumber(leadsWith.website)),
    collectQualityRow('With address', collectQualityNumber(leadsWith.address)),
    collectQualityRow('With title', collectQualityNumber(leadsWith.title)),
    collectQualityRow('Invalid records', collectQualityNumber(row.invalidRecords)),
    collectQualityRow('Company groups', collectQualityNumber(grouping.groups)),
    collectQualityRow('Leads without a company key', collectQualityNumber(grouping.ungrouped))
  ].join('');
  if (!targetBody) return;
  // No attached target means no target metric at all: the section stays empty
  // rather than showing a fabricated compliance figure.
  if (!targetReport || targetReport.available !== true || !Array.isArray(targetReport.requiredFields)) {
    targetBody.innerHTML = '';
    return;
  }
  targetBody.innerHTML = [
    '<div class="collect-quality-header"><span class="lead-detail-label">Target requirements</span>'
    + '<span class="lead-detail-badge">' + escapeHtml(targetReport.targetName || '') + '</span></div>',
    ...targetReport.requiredFields.map((entry) => collectQualityRow(
      'Missing ' + (entry && entry.field ? entry.field : ''),
      collectQualityNumber(entry && entry.missing)
    ))
  ].join('');
}

function closeCollectQuality() {
  const panel = document.getElementById('collect-quality');
  if (panel) panel.hidden = true;
  const body = document.getElementById('collect-quality-body');
  if (body) body.innerHTML = '';
  const targetBody = document.getElementById('collect-quality-target-body');
  if (targetBody) targetBody.innerHTML = '';
}

async function loadCollectQuality() {
  const runSlug = currentResultsRunSlug;
  const panel = document.getElementById('collect-quality');
  if (!runSlug) {
    closeCollectQuality();
    return;
  }
  try {
    const result = await window.appAPI.collector.qualityReport({ runSlug, limit: 1, offset: 0 });
    const report = result && Array.isArray(result.rows) ? result.rows[0] : null;
    if (!report) {
      closeCollectQuality();
      return;
    }
    let targetReport = null;
    try {
      targetReport = await window.appAPI.collector.qualityTargetReport({ runSlug });
    } catch (err) {
      // A target that cannot be read leaves the target section empty; the
      // counters above are still truthful.
      targetReport = null;
    }
    if (runSlug !== currentResultsRunSlug) return;
    renderCollectQuality(report, targetReport);
    if (panel) panel.hidden = false;
  } catch (err) {
    closeCollectQuality();
    const msg = err?.message || String(err);
    reportError(msg, { handler: 'loadCollectQuality' });
  }
}

function qualityReportText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// === P1-E duplicate review (read-only) ===
// The Lead Library review panel. It only DISPLAYS the classification the main
// process derived from exact keys: there is no merge button, no survivor choice
// and no write call of any kind in this section. Every rendered value goes
// through escapeHtml, and the panel owns no state beyond the chosen rule and
// the page being displayed.
const DUPLICATE_REVIEW_PAGE_SIZE = 20;
let duplicateReviewPage = 1;
let duplicateReviewRule = 'all';
// Independent of the lead table's page-query sequence: opening, paging or
// closing the review never re-renders or re-queries the lead table.
let duplicateReviewSeq = 0;

function duplicateReviewText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function duplicateReviewLeadRows(lead) {
  const row = lead && typeof lead === 'object' ? lead : {};
  const fields = [
    ['Phone', row.phone], ['Title', row.title], ['Website', row.website],
    ['Email', row.email], ['Address', row.address], ['Company key', row.companyKey],
    ['Source', row.source], ['Keywords', row.keyword], ['Run slug', row.runSlug],
    ['Collected', row.collectedAt]
  ];
  return fields
    .map(([label, value]) => `<div class="lead-detail-row"><span class="lead-detail-label">${escapeHtml(label)}</span>`
      + `<span class="lead-detail-value">${escapeHtml(duplicateReviewText(value) || '—')}</span></div>`)
    .join('');
}

function renderDuplicateReviewBody(result) {
  const body = document.getElementById('dup-review-body');
  if (!body) return;
  const rows = result && Array.isArray(result.rows) ? result.rows : [];
  if (!rows.length) {
    body.innerHTML = '<p class="dup-review-empty">No duplicate candidate for this rule.</p>';
    return;
  }
  body.innerHTML = rows.map((entry) => {
    const cls = escapeHtml(entry.dupClass || '');
    const reason = escapeHtml(entry.dupReason || '');
    const leadBlock = `<div class="dup-review-side"><div class="lead-detail-label">Lead</div>`
      + duplicateReviewLeadRows(entry.lead) + '</div>';
    const candidateBlock = entry.candidate
      ? `<div class="dup-review-side"><div class="lead-detail-label">Candidate</div>`
        + duplicateReviewLeadRows(entry.candidate) + '</div>'
      : '<div class="dup-review-side"><div class="lead-detail-label">Candidate</div>'
        + '<div class="lead-detail-row"><span class="lead-detail-value">—</span></div></div>';
    return `<div class="dup-review-candidate">`
      + `<div class="dup-review-candidate-head"><span class="dup-review-class">${cls}</span>`
      + `<span class="dup-review-reason">matched: ${reason}</span></div>`
      + leadBlock + candidateBlock + '</div>';
  }).join('');
}

async function loadDuplicateReview(page = 1) {
  const panel = document.getElementById('dup-review');
  if (panel) panel.hidden = false;
  const body = document.getElementById('dup-review-body');
  const seq = ++duplicateReviewSeq;
  if (body) body.innerHTML = '<p class="dup-review-empty">Loading...</p>';
  try {
    const result = await window.appAPI.collector.duplicateReview({
      rule: duplicateReviewRule,
      limit: DUPLICATE_REVIEW_PAGE_SIZE,
      offset: (page - 1) * DUPLICATE_REVIEW_PAGE_SIZE
    });
    if (seq !== duplicateReviewSeq) return;
    duplicateReviewPage = page;
    renderDuplicateReviewBody(result);
    const total = result && Number.isInteger(result.total) ? result.total : 0;
    const totalPages = Math.max(1, Math.ceil(total / DUPLICATE_REVIEW_PAGE_SIZE));
    renderPagination('dup-review-pagination', totalPages, duplicateReviewPage, (next) => loadDuplicateReview(next));
  } catch (err) {
    if (seq !== duplicateReviewSeq) return;
    if (body) body.innerHTML = '<p class="dup-review-empty">Review unavailable.</p>';
    const msg = err?.message || String(err);
    toast(msg, 'error');
    reportError(msg, { handler: 'loadDuplicateReview' });
  }
}

function closeDuplicateReview() {
  duplicateReviewSeq += 1;
  duplicateReviewPage = 1;
  const panel = document.getElementById('dup-review');
  if (panel) panel.hidden = true;
  const body = document.getElementById('dup-review-body');
  if (body) body.innerHTML = '';
  const pagination = document.getElementById('dup-review-pagination');
  if (pagination) pagination.innerHTML = '';
}

document.getElementById('btn-dup-review-open').addEventListener('click', safeAsync(async () => {
  // The rule vocabulary is owned by the main process: the renderer forwards the
  // selected value and main rejects anything outside its allowlist.
  const select = document.getElementById('dup-review-rule');
  const value = select && typeof select.value === 'string' ? select.value.trim() : '';
  duplicateReviewRule = value || 'all';
  await loadDuplicateReview(1);
}));

document.getElementById('btn-dup-review-close').addEventListener('click', () => closeDuplicateReview());

// === P1-F Target Builder (user-owned definitions) ===
// Targets are what the user is looking for, not lead data. This section reads
// and writes target definitions only: it never calls a lead write path, never
// reads or writes a lead, and contains no analytics, no scoring and no
// classification. Required/optional fields are prospecting criteria only - a
// lead is never rejected from storage because one is missing.
const TARGET_FIELD_CHOICES = ['phone', 'title', 'website', 'email', 'address'];
const TARGET_STATUS_CHOICES = ['active', 'archived'];
// The ONLY collector inputs "Use for collection" may touch. Both already exist
// in the collector form: no provider parameter, request shape or capability is
// created, renamed or extended by a target.
const TARGET_COLLECTOR_PARAM_MAP = { businessTypes: 'collect-keywords', locations: 'collect-region' };
let targetsLoadSeq = 0;
let targetEditingId = null;

function targetTermsText(value) {
  return Array.isArray(value) ? value.join(', ') : '';
}

function targetFieldsText(value) {
  return Array.isArray(value) && value.length ? value.join(', ') : '—';
}

function targetCard(target) {
  const row = target && typeof target === 'object' ? target : {};
  const id = typeof row.id === 'string' ? row.id : '';
  const status = TARGET_STATUS_CHOICES.includes(row.status) ? row.status : 'active';
  const archived = status === 'archived';
  return '<div class="target-card" data-id="' + escapeHtml(id) + '">'
    + '<div class="target-card-head"><span class="target-card-name">' + escapeHtml(row.name || '') + '</span>'
    + '<span class="lead-detail-badge">' + escapeHtml(status) + '</span></div>'
    + '<div class="lead-detail-row"><span class="lead-detail-label">Industry</span>'
    + '<span class="lead-detail-value">' + escapeHtml(row.industry || '—') + '</span></div>'
    + '<div class="lead-detail-row"><span class="lead-detail-label">Business types</span>'
    + '<span class="lead-detail-value">' + escapeHtml(targetTermsText(row.businessTypes) || '—') + '</span></div>'
    + '<div class="lead-detail-row"><span class="lead-detail-label">Locations</span>'
    + '<span class="lead-detail-value">' + escapeHtml(targetTermsText(row.locations) || '—') + '</span></div>'
    + '<div class="lead-detail-row"><span class="lead-detail-label">Required</span>'
    + '<span class="lead-detail-value">' + escapeHtml(targetFieldsText(row.requiredFields)) + '</span></div>'
    + '<div class="lead-detail-row"><span class="lead-detail-label">Optional</span>'
    + '<span class="lead-detail-value">' + escapeHtml(targetFieldsText(row.optionalFields)) + '</span></div>'
    + '<div class="lead-detail-row"><span class="lead-detail-label">Exclusions</span>'
    + '<span class="lead-detail-value">' + escapeHtml(targetTermsText(row.exclusions) || '—') + '</span></div>'
    + '<div class="target-card-actions">'
    + '<button type="button" class="btn btn-sm" data-action="edit">Edit</button>'
    + '<button type="button" class="btn btn-sm btn-secondary" data-action="toggle-status">'
    + (archived ? 'Activate' : 'Archive') + '</button>'
    + '<button type="button" class="btn btn-sm btn-secondary" data-action="use">Use for collection</button>'
    + '</div></div>';
}

async function loadTargets() {
  const list = document.getElementById('target-list');
  const seq = ++targetsLoadSeq;
  if (list) list.innerHTML = '<p class="dup-review-empty">Loading...</p>';
  try {
    const result = await window.appAPI.targets.list();
    if (seq !== targetsLoadSeq) return;
    const rows = result && Array.isArray(result.rows) ? result.rows : [];
    if (!list) return;
    list.innerHTML = rows.length
      ? rows.map(targetCard).join('')
      : '<p class="dup-review-empty">No target defined yet.</p>';
  } catch (err) {
    if (seq !== targetsLoadSeq) return;
    if (list) list.innerHTML = '<p class="dup-review-empty">Targets unavailable.</p>';
    const msg = err?.message || String(err);
    toast(msg, 'error');
    reportError(msg, { handler: 'loadTargets' });
  }
}

function targetCheckedValues(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return [];
  return [...container.querySelectorAll('input[type="checkbox"]')]
    .filter(box => box.checked && TARGET_FIELD_CHOICES.includes(box.value))
    .map(box => box.value);
}

function setTargetCheckedValues(containerId, values) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const wanted = Array.isArray(values) ? values : [];
  container.querySelectorAll('input[type="checkbox"]').forEach((box) => {
    box.checked = wanted.includes(box.value);
  });
}

function openTargetEditor(target) {
  const row = target && typeof target === 'object' ? target : {};
  targetEditingId = typeof row.id === 'string' && row.id ? row.id : null;
  const editor = document.getElementById('target-editor');
  if (editor) editor.hidden = false;
  const cancel = document.getElementById('btn-target-cancel');
  if (cancel) cancel.hidden = false;
  document.getElementById('target-name').value = row.name || '';
  document.getElementById('target-industry').value = row.industry || '';
  document.getElementById('target-business-types').value = targetTermsText(row.businessTypes);
  document.getElementById('target-locations').value = targetTermsText(row.locations);
  document.getElementById('target-exclusions').value = targetTermsText(row.exclusions);
  const status = document.getElementById('target-status');
  if (status) status.value = TARGET_STATUS_CHOICES.includes(row.status) ? row.status : 'active';
  // An edit loads the stored criteria, which are mutually exclusive by
  // validation; a new target starts with none.
  setTargetCheckedValues('target-required-fields', row.requiredFields);
  setTargetCheckedValues('target-optional-fields', row.optionalFields);
}

function closeTargetEditor() {
  targetEditingId = null;
  const editor = document.getElementById('target-editor');
  if (editor) editor.hidden = true;
  const cancel = document.getElementById('btn-target-cancel');
  if (cancel) cancel.hidden = true;
  const bar = document.getElementById('target-status-bar');
  if (bar) bar.style.display = 'none';
}

function setTargetStatusBar(message, isError) {
  const bar = document.getElementById('target-status-bar');
  if (!bar) return;
  bar.textContent = message;
  bar.style.display = 'block';
  bar.classList.toggle('error', !!isError);
}

async function saveTargetFromEditor() {
  const payload = {
    name: document.getElementById('target-name').value,
    industry: document.getElementById('target-industry').value,
    businessTypes: document.getElementById('target-business-types').value,
    locations: document.getElementById('target-locations').value,
    exclusions: document.getElementById('target-exclusions').value,
    requiredFields: targetCheckedValues('target-required-fields'),
    optionalFields: targetCheckedValues('target-optional-fields'),
    status: document.getElementById('target-status').value
  };
  if (targetEditingId) payload.id = targetEditingId;
  try {
    const res = await window.appAPI.targets.save(payload);
    if (!res || res.success !== true) {
      setTargetStatusBar((res && res.error) || 'Invalid target', true);
      toast((res && res.error) || 'Save failed', 'error');
      return;
    }
    setTargetStatusBar('Saved', false);
    closeTargetEditor();
    await loadTargets();
  } catch (err) {
    const msg = err?.message || String(err);
    setTargetStatusBar(msg, true);
    toast(msg, 'error');
    reportError(msg, { handler: 'saveTargetFromEditor' });
  }
}

async function setTargetArchived(id, status) {
  try {
    const res = await window.appAPI.targets.setStatus({ id, status });
    if (res && res.success === true) {
      await loadTargets();
      return;
    }
    toast((res && res.error) || 'Action failed', 'error');
  } catch (err) {
    const msg = err?.message || String(err);
    toast(msg, 'error');
    reportError(msg, { handler: 'setTargetArchived' });
  }
}

// "Use for collection" maps a target onto the collector inputs that already
// exist, and nothing else: it never adds a parameter, never changes a provider
// request shape and never triggers a collection by itself. A field the user has
// already filled in is left alone rather than overwritten.
function targetToCollectorParams(target) {
  const row = target && typeof target === 'object' ? target : {};
  const params = {};
  for (const [field, inputId] of Object.entries(TARGET_COLLECTOR_PARAM_MAP)) {
    const terms = Array.isArray(row[field]) ? row[field] : [];
    if (!terms.length) continue;
    params[inputId] = terms.join(', ');
  }
  // Fallback for a target that names an industry but no business types: the
  // keyword input is the only place a category can be expressed, and it
  // already exists.
  if (!params['collect-keywords']) {
    const industry = typeof row.industry === 'string' ? row.industry.trim() : '';
    if (industry) params['collect-keywords'] = industry;
  }
  return params;
}

function useTargetForCollection(target) {
  const params = targetToCollectorParams(target);
  let filled = 0;
  let kept = 0;
  for (const [inputId, value] of Object.entries(params)) {
    const input = document.getElementById(inputId);
    if (!input) continue;
    if (input.value && input.value.trim()) {
      kept++;
      continue;
    }
    input.value = value;
    filled++;
  }
  // P1-G: remember which definition the user applied, so the run's report can
  // state its required-field completeness. Nothing is sent anywhere here.
  currentResultsTargetId = qualityReportText(target && target.id) || null;
  const nav = document.querySelector('.nav-item[data-view="collector"]');
  if (nav) nav.click();
  toast(`Filled ${filled} field(s)${kept ? `, kept ${kept} you had already filled in` : ''}`, 'success');
  return { filled, kept };
}

document.getElementById('btn-target-new').addEventListener('click', () => openTargetEditor(null));
document.getElementById('btn-target-cancel').addEventListener('click', () => closeTargetEditor());
document.getElementById('btn-target-save').addEventListener('click', safeAsync(() => saveTargetFromEditor()));

document.getElementById('target-list').addEventListener('click', safeAsync(async (e) => {
  const button = e.target.closest('button[data-action]');
  if (!button) return;
  const card = button.closest('.target-card');
  const id = card && typeof card.dataset.id === 'string' ? card.dataset.id : '';
  if (!id) return;
  let targets = [];
  try {
    const result = await window.appAPI.targets.list();
    targets = result && Array.isArray(result.rows) ? result.rows : [];
  } catch (err) {
    const msg = err?.message || String(err);
    toast(msg, 'error');
    reportError(msg, { handler: 'targetListAction' });
    return;
  }
  const target = targets.find(row => row && row.id === id);
  if (!target) {
    toast('That target could not be found', 'error');
    return;
  }
  if (button.dataset.action === 'edit') openTargetEditor(target);
  else if (button.dataset.action === 'toggle-status') {
    await setTargetArchived(id, target.status === 'archived' ? 'active' : 'archived');
  } else if (button.dataset.action === 'use') {
    useTargetForCollection(target);
  }
}));

// === B5 Lead Library Dashboard ===
// Lazy, read-only overview over the lead library, the local collection-job
// ledger and storage health. Bounded pages only: loads when the view is
// selected, has no timer and never polls or auto-refreshes.
const DASHBOARD_JOBS_PAGE_SIZE = 50;
let dashboardJobsPage = 1;
let dashboardLoadSeq = 0;
let dashboardCounts = { running: 0, succeeded: 0, failed: 0, windowed: false };

function formatJobTime(value) {
  if (typeof value !== 'string' || !value) return '-';
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : new Date(parsed).toLocaleString('en-GB');
}

async function loadDashboard(page = 1) {
  try {
    const targetPage = page < 1 ? 1 : page;
    const seq = ++dashboardLoadSeq;

    const leads = await window.appAPI.collector.getNumbers({ limit: 1, offset: 0 });
    if (seq !== dashboardLoadSeq) return;
    const storage = await window.appAPI.collector.storageStatus();
    if (seq !== dashboardLoadSeq) return;
    const offset = (targetPage - 1) * DASHBOARD_JOBS_PAGE_SIZE;
    const jobs = await window.appAPI.collector.getJobs({ limit: DASHBOARD_JOBS_PAGE_SIZE, offset });
    if (seq !== dashboardLoadSeq) return;

    const totalLeads = leads && Number.isInteger(leads.total) ? leads.total : 0;
    const rows = jobs && Array.isArray(jobs.rows) ? jobs.rows : [];
    const totalJobs = jobs && Number.isInteger(jobs.total) ? jobs.total : rows.length;

    document.getElementById('dashboard-total-leads').textContent = String(totalLeads);
    document.getElementById('dashboard-total-runs').textContent = String(totalJobs);

    const storageState = storage && typeof storage === 'object' ? storage : {};
    const storageProblems = [];
    if (storageState.mode !== 'sql') storageProblems.push('JSON storage');
    if (storageState.quarantine) storageProblems.push('Quarantine: ' + storageState.quarantine);
    else if (storageState.reason === 'corrupt-open') storageProblems.push('Unreadable database');
    if (storageState.dataMayBeIncomplete) storageProblems.push('Data may be incomplete');
    document.getElementById('dashboard-storage-state').textContent =
      storageProblems.length ? storageProblems.join('; ') : 'OK';

    // Job status counts: client-side over the bounded ledger page, using only
    // the approved vocabulary (running | succeeded | failed). Recomputed on
    // the first page of each dashboard load so pagination never changes them.
    if (targetPage === 1) {
      const counts = { running: 0, succeeded: 0, failed: 0 };
      for (const job of rows) {
        if (!job || typeof job !== 'object') continue;
        if (job.status === 'running') counts.running += 1;
        else if (job.status === 'succeeded') counts.succeeded += 1;
        else if (job.status === 'failed') counts.failed += 1;
      }
      dashboardCounts = {
        running: counts.running,
        succeeded: counts.succeeded,
        failed: counts.failed,
        windowed: totalJobs > rows.length
      };
    }
    document.getElementById('dashboard-runs-running').textContent = String(dashboardCounts.running);
    document.getElementById('dashboard-runs-succeeded').textContent = String(dashboardCounts.succeeded);
    document.getElementById('dashboard-runs-failed').textContent = String(dashboardCounts.failed);
    const countsWindowNote = document.getElementById('dashboard-counts-window');
    countsWindowNote.textContent = dashboardCounts.windowed
      ? 'Run counts cover the most recent ' + rows.length + ' runs'
      : '';
    countsWindowNote.hidden = !dashboardCounts.windowed;

    dashboardJobsPage = targetPage;
    const tbody = document.getElementById('dashboard-jobs-body');
    tbody.innerHTML = rows.map(job => {
      const ledgerRow = job && typeof job === 'object' ? job : {};
      const statusClass = ledgerRow.status === 'succeeded' ? 'color:var(--accent)' : ledgerRow.status === 'failed' ? 'color:var(--danger)' : ledgerRow.status === 'running' ? 'color:var(--warning)' : '';
      const statusText = ledgerRow.status === 'succeeded' ? 'Succeeded' : ledgerRow.status === 'failed' ? 'Failed' : ledgerRow.status === 'running' ? 'Running' : (ledgerRow.status || '-');
      return `<tr>
        <td>${escapeHtml(ledgerRow.runSlug || '-')}</td>
        <td>${escapeHtml(ledgerRow.providerId || '-')}</td>
        <td style="${statusClass}">${escapeHtml(statusText)}</td>
        <td>${escapeHtml(formatJobTime(ledgerRow.startedAt))}</td>
        <td>${escapeHtml(formatJobTime(ledgerRow.completedAt))}</td>
        <td>${escapeHtml(ledgerRow.resultCount === null || ledgerRow.resultCount === undefined ? '-' : String(ledgerRow.resultCount))}</td>
        <td>${escapeHtml(ledgerRow.error || '-')}</td>
      </tr>`;
    }).join('');

    const totalPages = Math.ceil(totalJobs / DASHBOARD_JOBS_PAGE_SIZE) || 1;
    renderPagination('dashboard-jobs-pagination', totalPages, dashboardJobsPage, (p) => {
      dashboardJobsPage = p;
      loadDashboard(p);
    });
  } catch (err) {
    const msg = err?.message || String(err);
    toast(msg, 'error');
    reportError(msg, { handler: 'loadDashboard' });
  }
}

// Dashboard quick links reuse the sidebar switch so the existing lazy-load
// behaviour (and history/numbers refresh) keeps working unchanged.
document.getElementById('view-dashboard').addEventListener('click', (e) => {
  const gotoBtn = e.target.closest('[data-goto-view]');
  if (!gotoBtn) return;
  const nav = document.querySelector(`.nav-item[data-view="${gotoBtn.dataset.gotoView}"]`);
  if (nav) nav.click();
});

// === F4: Collection workflow (Frontend 2.0) =================================
// Presentation for the Discovery -> Collection screen only. The submit payload
// (btn-start-collect), the status polling (btn-check-status), the result
// rendering and the save/export flows are all untouched: this block reads the
// very same controls those handlers read and reports what they currently say.
// No collection parameter, IPC channel or backend path is added here.

// Every optional control that lives under "Advanced filters", together with the
// value it ships with in index.html. "Filters: N active" is counted from this
// list alone, so the summary can never claim a filter that is not really set.
const COLLECT_ADVANCED_CONTROLS = [
  { id: 'collect-title-match', kind: 'select', def: 'all' },
  { id: 'collect-min-rating', kind: 'select', def: 'all' },
  { id: 'collect-website-filter', kind: 'select', def: 'all' },
  { id: 'collect-skip-closed', kind: 'check', def: true },
  { id: 'collect-mobile-only', kind: 'check', def: false },
  { id: 'collect-place-details', kind: 'check', def: false },
  { id: 'collect-social', kind: 'check', def: true },
  { id: 'collect-reservation', kind: 'check', def: false },
  { id: 'collect-online-order', kind: 'check', def: false },
  { id: 'collect-web-result', kind: 'check', def: false },
  { id: 'collect-email-verify', kind: 'check', def: false },
  { id: 'collect-facebook', kind: 'check', def: false },
  { id: 'collect-instagram', kind: 'check', def: false },
  { id: 'collect-youtube', kind: 'check', def: false },
  { id: 'collect-tiktok', kind: 'check', def: false },
  { id: 'collect-linkedin', kind: 'check', def: false },
  { id: 'collect-reviews', kind: 'check', def: false },
  { id: 'collect-reviewer-info', kind: 'check', def: false },
  { id: 'collect-max-reviews', kind: 'number', def: 5 },
  { id: 'collect-review-sort', kind: 'select', def: 'newest' },
  { id: 'collect-review-keyword', kind: 'text', def: '' }
];

function collectFieldText(id) {
  const el = document.getElementById(id);
  if (!el) return '';
  return el.value === undefined || el.value === null ? '' : String(el.value);
}

function setCollectText(id, text, isSet) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  // The summary renders each value as a chip. An unset field is announced as a
  // hollow, dashed placeholder rather than a value, so an empty run never looks
  // configured. This only changes presentation; the text is still the value.
  el.dataset.state = isSet ? 'set' : 'empty';
}

function collectLanguageLabel() {
  const el = document.getElementById('collect-lang');
  if (!el || !el.options) return 'English';
  const opt = el.selectedIndex >= 0 ? el.options[el.selectedIndex] : null;
  return opt && opt.text ? opt.text : 'English';
}

// A control counts as active only when it differs from the value it ships with.
// An emptied number field reads as its default too, because the submit handler
// falls back to the same default.
function countActiveCollectFilters() {
  let active = 0;
  for (const spec of COLLECT_ADVANCED_CONTROLS) {
    const el = document.getElementById(spec.id);
    if (!el) continue;
    if (spec.kind === 'check') {
      if (el.checked !== spec.def) active += 1;
    } else if (spec.kind === 'number') {
      const parsed = parseInt(el.value, 10);
      if (!Number.isNaN(parsed) && parsed !== spec.def) active += 1;
    } else if (el.value !== spec.def) {
      active += 1;
    }
  }
  return active;
}

function collectKeywordsList() {
  return collectFieldText('collect-keywords').split(',').map((k) => k.trim()).filter(Boolean);
}

// Step 5 readout + the header count badge. Every value comes straight from the
// control it names; nothing here is estimated, derived or invented.
function updateCollectSummary() {
  const keywords = collectFieldText('collect-keywords').trim();
  const location = collectFieldText('collect-region').trim();
  const max = collectFieldText('collect-max').trim();
  const active = countActiveCollectFilters();

  setCollectText('cs-keywords', keywords || 'Not set', keywords.length > 0);
  setCollectText('cs-location', location || 'Not set', location.length > 0);
  setCollectText('cs-language', collectLanguageLabel(), true);
  setCollectText('cs-max', max || '20', max.length > 0);
  setCollectText('cs-filters', active === 1 ? '1 active' : `${active} active`, true);

  const badge = document.getElementById('collect-advanced-count');
  if (badge) {
    badge.hidden = active === 0;
    badge.textContent = active === 1 ? '1 active' : `${active} active`;
  }

  renderCollectPreview();
}

// The right-hand Search Preview: same controls, terms listed individually, and
// an honest empty state until there is something to preview.
function renderCollectPreview() {
  const box = document.getElementById('collect-search-preview');
  if (!box) return;
  const terms = collectKeywordsList();
  if (!terms.length) {
    box.innerHTML = '<p class="collect-empty">Enter keywords to preview your search.</p>';
    return;
  }
  const rows = [
    ['Region', collectFieldText('collect-region').trim() || 'Any region'],
    ['Language', collectLanguageLabel()],
    ['Limit', collectFieldText('collect-max').trim() || '20'],
    ['Filters', countActiveCollectFilters() === 1 ? '1 active' : `${countActiveCollectFilters()} active`]
  ];
  box.innerHTML =
    '<ul class="collect-preview-terms">' +
    terms.map((t) => `<li>${escapeHtml(t)}</li>`).join('') +
    '</ul>' +
    '<dl class="collect-preview">' +
    rows.map(([label, value]) =>
      `<div class="cp-row"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('') +
    '</dl>';
}

(function wireCollectSummary() {
  const ids = ['collect-keywords', 'collect-region', 'collect-lang', 'collect-max']
    .concat(COLLECT_ADVANCED_CONTROLS.map((spec) => spec.id));
  const refresh = () => updateCollectSummary();
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener('input', refresh);
    el.addEventListener('change', refresh);
  }
  updateCollectSummary();
})();

// Step 4 collapses by default so the fifteen secondary options do not read as a
// wall of checkboxes. The controls stay in the DOM the whole time, which is why
// the submit payload is unaffected by the panel being closed.
(function wireCollectAdvancedFilters() {
  const toggle = document.getElementById('btn-advanced-filters');
  const panel = document.getElementById('collect-advanced-panel');
  const label = document.getElementById('collect-adv-label');
  if (!toggle || !panel || !label) return;
  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', open ? 'false' : 'true');
    panel.hidden = open;
    label.textContent = open ? 'Show filters' : 'Hide filters';
  });
})();

// The page-header action reuses the existing sidebar route, so the history view
// keeps its own lazy load and pagination behaviour.
document.getElementById('btn-collection-history').addEventListener('click', () => {
  const nav = document.querySelector('.nav-item[data-view="history"]');
  if (nav) nav.click();
});

// --- Recent searches and recent runs -----------------------------------------
// Both panels read the local job ledger through the existing read-only
// collector:get-jobs channel: the same rows the Dashboard uses. A job stores
// the submitted keywords as its query, which is the only search data this app
// has ever kept, so that is exactly what Recent Searches shows. No location is
// claimed there, because location is not stored. An empty ledger renders an
// honest empty state rather than placeholder entries.
const COLLECT_RECENT_LIMIT = 5;

function collectEmpty(containerId, text) {
  const box = document.getElementById(containerId);
  if (box) box.innerHTML = `<p class="collect-empty">${escapeHtml(text)}</p>`;
}

function renderCollectRecentSearches(rows) {
  const box = document.getElementById('collect-recent-searches');
  if (!box) return;
  const seen = new Set();
  const found = [];
  for (const row of rows) {
    const job = row && typeof row === 'object' ? row : {};
    const query = typeof job.query === 'string' ? job.query.trim() : '';
    if (!query || seen.has(query)) continue;
    seen.add(query);
    found.push({ query, when: formatJobTime(job.startedAt) });
    if (found.length >= COLLECT_RECENT_LIMIT) break;
  }
  if (!found.length) {
    box.innerHTML = '<p class="collect-empty">No recent searches yet.</p>';
    return;
  }
  box.innerHTML = '<ul class="collect-recent-list">' + found.map((item) =>
    `<li class="collect-recent-item"><span class="cr-term">${escapeHtml(item.query)}</span>` +
    `<span class="cr-when">${escapeHtml(item.when)}</span></li>`).join('') + '</ul>';
}

function renderCollectRecentRuns(rows) {
  const box = document.getElementById('collect-recent-runs');
  if (!box) return;
  if (!rows.length) {
    box.innerHTML = '<p class="collect-empty">No collection runs yet.</p>';
    return;
  }
  box.innerHTML = '<ul class="collect-run-list">' + rows.map((row) => {
    const job = row && typeof row === 'object' ? row : {};
    const status = typeof job.status === 'string' ? job.status : '';
    const statusText = status === 'succeeded' ? 'Succeeded'
      : status === 'failed' ? 'Failed'
        : status === 'running' ? 'Running' : (status || 'Unknown');
    const tone = status === 'succeeded' ? 'ok'
      : status === 'failed' ? 'bad'
        : status === 'running' ? 'busy' : 'idle';
    const slug = typeof job.runSlug === 'string' ? job.runSlug : '';
    const count = typeof job.resultCount === 'number' ? job.resultCount : null;
    const countHtml = count === null ? ''
      : `<span class="run-count">${escapeHtml(String(count))} ${count === 1 ? 'result' : 'results'}</span>`;
    const action = slug
      ? `<button class="btn btn-sm collect-run-open" type="button" data-slug="${escapeHtml(slug)}">View results</button>`
      : '';
    return `<li class="collect-run-row">` +
      `<span class="run-status run-${tone}">${escapeHtml(statusText)}</span>` +
      `<span class="run-slug">${escapeHtml(slug || '-')}</span>` +
      countHtml +
      `<span class="run-when">${escapeHtml(formatJobTime(job.startedAt))}</span>` +
      action +
      `</li>`;
  }).join('') + '</ul>';
}

async function loadCollectRecent() {
  try {
    const res = await window.appAPI.collector.getJobs({
      limit: COLLECT_RECENT_LIMIT,
      offset: 0
    });
    const rows = res && Array.isArray(res.rows) ? res.rows : [];
    renderCollectRecentSearches(rows);
    renderCollectRecentRuns(rows);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    collectEmpty('collect-recent-searches', 'Recent searches are unavailable right now.');
    collectEmpty('collect-recent-runs', 'Recent runs are unavailable right now.');
    reportError(msg, { handler: 'loadCollectRecent' });
  }
}

// Opening a run reuses the existing history run-result flow, including its API
// key check and its error handling.
document.getElementById('collect-recent-runs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-slug]');
  if (!btn) return;
  window.viewRunResult(btn.dataset.slug);
});

loadCollectRecent();

// === 视图切换时加载数据 ===
navItems.forEach(item => {
  item.addEventListener('click', () => {
    const viewId = item.dataset.view;
    if (viewId === 'numbers') {
      // F6: the All Leads route is the whole library, never a list scope.
      clearLeadsListContext();
      loadNumbers();
      checkStorageStatus();
    }
    if (viewId === 'collector') loadCollectRecent();
    if (viewId === 'history') loadHistory();
    if (viewId === 'dashboard') loadDashboard();
    if (viewId === 'targets') loadTargets();
    if (viewId === 'searches') loadSavedSearches();
    if (viewId === 'segments') loadSegments();
    if (viewId === 'queue') loadResearch();
    if (viewId === 'completed') loadResearch();
    if (viewId === 'icp') loadIcp();
    if (viewId === 'signals') renderSignalsPanel();
    if (viewId === 'opportunities') renderOpportunitiesPanel();
  });
});

// === F8 Intelligence workspace ===
// Exposes only what the Lead Intelligence contracts can supply in this build.
// ICP: intelligence:icp runs the contract (targetToIcp + evaluateIcpFit) over a
// stored Target and stored leads - fit / not_fit / unknown with a reason per
// criterion, never a score, never an inferred field. Signals: the contract's
// four signal types need two measured research runs compared through the Lead
// Intelligence research bridge, which is not connected to this build's
// research records, so the view says that instead of estimating. Opportunities:
// there is no opportunity contract to run, so the view points to the real,
// evidence-backed audit findings. Every value is set with textContent.
const INTEL_FIT_LABELS = { fit: 'FIT', not_fit: 'NOT FIT', unknown: 'UNKNOWN' };
// Mirrors SIGNAL_TYPES / UNSUPPORTED_SIGNALS in lead-intelligence/research/signals.js
// (the F8 tests fail if the two drift apart).
const INTEL_SIGNAL_TYPES = [
  ['website_change', 'Website change', 'The website address or its redirect behaviour changed between runs.'],
  ['technology_change', 'Technology change', 'The detected website platform changed between runs.'],
  ['content_activity', 'Content activity', 'The number of crawlable HTML pages changed between runs.'],
  ['digital_visibility_change', 'Digital visibility change', 'A measured visibility value or visibility finding changed between runs.']
];
const INTEL_UNSUPPORTED_SIGNALS = [
  ['hiring_signal', 'Zuni-SEO does not collect job postings or hiring data.'],
  ['business_expansion', 'No evidence source for new locations or expansion is connected.']
];
let icpTargets = null;
let icpResult = null;
let icpError = null;
let icpLoadSeq = 0;

function intelEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined && text !== null) el.textContent = String(text);
  return el;
}

function intelFitBadge(status) {
  const badge = intelEl('span', 'intel-fit', INTEL_FIT_LABELS[status] || String(status || 'UNKNOWN').toUpperCase());
  badge.dataset.fit = INTEL_FIT_LABELS[status] ? status : 'unknown';
  return badge;
}

function intelValueText(value) {
  if (value === null || value === undefined || value === '') return 'not recorded';
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

// One criterion line: outcome, the criterion, and where its value came from.
function intelCriterionItem(entry, outcome) {
  const item = intelEl('li', 'intel-criterion');
  item.dataset.outcome = outcome;
  const word = { matched: 'Met', unmet: 'Not met', unknown: 'Unknown', excluded: 'Excluded' }[outcome];
  item.appendChild(intelEl('span', 'intel-criterion-outcome', word));
  item.appendChild(intelEl('span', 'intel-criterion-label', `${entry.label}${entry.required ? '' : ' (optional)'}`));
  const detail = outcome === 'unknown'
    ? entry.explanation
    : `Value: ${intelValueText(entry.actual)} (expected ${intelValueText(entry.expected)})`;
  item.appendChild(intelEl('span', 'intel-criterion-detail', detail));
  const refs = [].concat(entry.factIds || [], entry.findingIds || []);
  const source = entry.source === 'lead' ? 'lead record' : entry.source;
  item.appendChild(intelEl('span', 'intel-criterion-source', `Source: ${source}${refs.length ? ' · Evidence: ' + refs.join(', ') : ''}`));
  return item;
}

function intelCriteriaList(row) {
  const list = intelEl('ul', 'intel-criteria');
  for (const e of row.exclusions || []) list.appendChild(intelCriterionItem(e, 'excluded'));
  for (const e of row.unmet || []) list.appendChild(intelCriterionItem(e, 'unmet'));
  for (const e of row.unknown || []) list.appendChild(intelCriterionItem(e, 'unknown'));
  for (const e of row.matched || []) list.appendChild(intelCriterionItem(e, 'matched'));
  if (!list.childElementCount) list.appendChild(intelEl('li', 'intel-criterion', 'This Target has no criterion the ICP contract can evaluate.'));
  return list;
}

// What the contract could not convert from the Target is reported, never guessed.
function intelUnmappedNotes(unmapped) {
  return (Array.isArray(unmapped) ? unmapped : []).map((u) => (u === 'exclusions'
    ? 'Exclusions are not evaluated by the ICP contract: their meaning cannot be converted without guessing.'
    : u.startsWith('requiredFields:')
      ? `Required field "${u.slice('requiredFields:'.length)}" has no ICP criterion.`
      : `Not converted: ${u}.`));
}

function intelErrorText(err) {
  const msg = (err && err.message) || String(err);
  return /No handler registered/i.test(msg) ? 'ICP evaluation is not available in this session.' : msg;
}

function icpVisibleRows() {
  const rows = icpResult && Array.isArray(icpResult.rows) ? icpResult.rows : [];
  const fit = document.getElementById('icp-fit').value;
  const term = document.getElementById('icp-search').value.trim().toLowerCase();
  return rows.filter((row) => {
    if (fit !== 'all' && row.fitStatus !== fit) return false;
    if (term && ![row.title, row.phone, row.website].filter(Boolean).join(' ').toLowerCase().includes(term)) return false;
    return true;
  });
}

function renderIcp() {
  const tbody = document.getElementById('icp-body');
  const count = document.getElementById('icp-count');
  const definition = document.getElementById('icp-definition');
  definition.replaceChildren();
  if (icpError) {
    count.textContent = '';
    listEmptyRow(tbody, 4, 'ICP fit could not be evaluated', icpError);
    tbody.firstChild.querySelector('.leads-state').dataset.state = 'error';
    return;
  }
  if (icpTargets === null || (icpTargets.length && icpResult === null)) {
    count.textContent = '';
    listEmptyRow(tbody, 4, 'Evaluating ICP fit...', 'Running the ICP contract over your stored leads.');
    tbody.firstChild.querySelector('.leads-state').dataset.state = 'loading';
    return;
  }
  if (!icpTargets.length) {
    count.textContent = '';
    listEmptyRow(tbody, 4, 'No Targets yet',
      'ICP fit is evaluated against a Target. Create one in Targets, then return here.',
      listsButton('Open Targets', 'btn btn-sm', () => {
        const nav = document.querySelector('.nav-item[data-view="targets"]');
        if (nav) nav.click();
      }));
    return;
  }
  const criteria = icpResult.icp && Array.isArray(icpResult.icp.criteria) ? icpResult.icp.criteria : [];
  definition.appendChild(intelEl('div', 'intel-definition-title', `Target: ${icpResult.target.name}${icpResult.target.status === 'archived' ? ' (archived)' : ''}`));
  definition.appendChild(intelEl('div', 'lists-description', criteria.length
    ? 'Criteria: ' + criteria.map((c) => c.label + (c.required ? '' : ' (optional)')).join(' · ')
    : 'This Target has no criterion the ICP contract can evaluate, so the contract reports every lead as fit. Add industry, business type, location or required fields to the Target.'));
  for (const note of intelUnmappedNotes(icpResult.icp && icpResult.icp.unmapped)) definition.appendChild(intelEl('div', 'lists-description', note));
  definition.appendChild(intelEl('div', 'lists-description', `Evaluated ${formatListTime(icpResult.evaluatedAt)}`));
  const all = Array.isArray(icpResult.rows) ? icpResult.rows : [];
  const tally = { fit: 0, not_fit: 0, unknown: 0 };
  for (const row of all) if (Object.prototype.hasOwnProperty.call(tally, row.fitStatus)) tally[row.fitStatus] += 1;
  const rows = icpVisibleRows();
  count.textContent = `${rows.length} of ${all.length} leads · ${tally.fit} fit · ${tally.not_fit} not fit · ${tally.unknown} unknown`;
  if (!all.length) {
    listEmptyRow(tbody, 4, 'No leads to evaluate', 'Collect or import leads, then return here.');
    return;
  }
  if (!rows.length) {
    listEmptyRow(tbody, 4, 'No leads match these filters', 'Change or clear the filters above.');
    return;
  }
  const frag = document.createDocumentFragment();
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.className = 'research-row';
    tr.dataset.leadId = row.leadId;
    const name = row.title || row.phone || 'Untitled lead';
    const leadCell = intelEl('td', 'lists-cell-name');
    leadCell.appendChild(listsButton(name, 'research-lead-link', () => openIntelLead(row.leadId), `Open ${name} in the lead drawer`));
    if (row.title && row.phone) leadCell.appendChild(intelEl('div', 'lists-description', row.phone));
    const fitCell = intelEl('td', 'intel-cell-fit');
    fitCell.appendChild(intelFitBadge(row.fitStatus));
    fitCell.appendChild(intelEl('div', 'lists-description', row.reason));
    const critCell = intelEl('td', 'intel-cell-criteria');
    critCell.appendChild(intelCriteriaList(row));
    const actions = intelEl('td', 'lists-cell-actions');
    actions.appendChild(listsButton('Open', 'btn btn-sm btn-secondary', () => openIntelLead(row.leadId), `Open ${name}`));
    tr.append(leadCell, fitCell, critCell, actions);
    tr.addEventListener('click', (e) => {
      if (e.target.closest('button, a, input, select')) return;
      safeAsync(() => openIntelLead(row.leadId))();
    });
    frag.appendChild(tr);
  }
  tbody.replaceChildren(frag);
}

function populateIcpTargets() {
  const select = document.getElementById('icp-target');
  const previous = select.value;
  select.replaceChildren(...icpTargets.map((t) => {
    const option = document.createElement('option');
    option.value = t.id;
    option.textContent = t.status === 'archived' ? `${t.name} (archived)` : t.name;
    return option;
  }));
  const active = icpTargets.find((t) => t.status === 'active');
  select.value = icpTargets.some((t) => t.id === previous) ? previous : (active ? active.id : (icpTargets[0] ? icpTargets[0].id : ''));
  select.disabled = !icpTargets.length;
}

async function loadIcpResult() {
  const seq = ++icpLoadSeq;
  const targetId = document.getElementById('icp-target').value;
  icpResult = null;
  icpError = null;
  renderIcp();
  if (!targetId) return;
  try {
    const result = await window.appAPI.intelligence.icpFit({ targetId });
    if (seq !== icpLoadSeq) return;
    if (result && result.success === false) icpError = result.error || 'ICP fit could not be evaluated.';
    else icpResult = result;
  } catch (err) {
    if (seq !== icpLoadSeq) return;
    icpError = intelErrorText(err);
    reportError(icpError, { handler: 'loadIcpResult' });
  }
  renderIcp();
}

async function loadIcp() {
  const seq = ++icpLoadSeq;
  icpTargets = null;
  icpResult = null;
  icpError = null;
  renderIcp();
  try {
    const result = await window.appAPI.targets.list();
    if (seq !== icpLoadSeq) return;
    icpTargets = result && Array.isArray(result.rows) ? result.rows : [];
  } catch (err) {
    if (seq !== icpLoadSeq) return;
    icpError = intelErrorText(err);
    renderIcp();
    return;
  }
  populateIcpTargets();
  if (!icpTargets.length) {
    renderIcp();
    return;
  }
  await loadIcpResult();
}

// Opens the EXISTING F5 drawer on its ICP tab.
async function openIntelLead(leadId) {
  await openLeadDetail(leadId);
  selectLeadDrawerTab('icp', false);
}

// The drawer's ICP tab: the same contract, for this one lead, against every
// active Target. A late answer for another lead is never applied.
async function loadLeadDrawerIcp(lead) {
  const box = document.getElementById('lead-drawer-icp-results');
  if (!box || !lead || typeof lead.id !== 'string') return;
  const leadId = lead.id;
  const stillOpen = () => leadDrawerLeadId === leadId;
  let targets;
  try {
    const result = await window.appAPI.targets.list();
    targets = (result && Array.isArray(result.rows) ? result.rows : []).filter((t) => t.status === 'active');
  } catch (err) {
    if (stillOpen()) box.replaceChildren(intelEl('p', 'lead-drawer-empty', `Targets could not be loaded: ${intelErrorText(err)}`));
    return;
  }
  if (!stillOpen()) return;
  if (!targets.length) {
    box.replaceChildren(
      intelEl('p', 'lead-drawer-empty', 'No active Target. ICP fit is evaluated against a Target, so no fit decision exists for this lead.'),
      intelEl('p', 'lead-drawer-muted', 'Create or activate a Target in Targets.')
    );
    return;
  }
  const blocks = [];
  for (const target of targets) {
    const block = intelEl('div', 'intel-drawer-target');
    block.appendChild(intelEl('div', 'intel-definition-title', target.name));
    try {
      const result = await window.appAPI.intelligence.icpFit({ targetId: target.id, leadId });
      const row = result && result.success !== false && Array.isArray(result.rows) ? result.rows[0] : null;
      if (!row) {
        block.appendChild(intelEl('p', 'lead-drawer-muted', (result && result.error) || 'No ICP result for this lead.'));
      } else {
        const line = intelEl('div', 'lead-drawer-state-line');
        line.append(intelFitBadge(row.fitStatus), intelEl('span', 'lead-drawer-muted', row.reason));
        block.append(line, intelCriteriaList(row));
        for (const note of intelUnmappedNotes(result.icp && result.icp.unmapped)) block.appendChild(intelEl('p', 'lead-drawer-muted', note));
      }
    } catch (err) {
      block.appendChild(intelEl('p', 'lead-drawer-muted', intelErrorText(err)));
    }
    blocks.push(block);
  }
  if (stillOpen()) box.replaceChildren(...blocks);
}

function intelSwitchTab(target) {
  const nav = document.querySelector(`.nav-item[data-view="${target}"]`);
  if (nav) nav.click();
}

function renderSignalsPanel() {
  const panel = document.getElementById('signals-panel');
  const supported = intelEl('ul', 'intel-list');
  for (const [type, label, text] of INTEL_SIGNAL_TYPES) {
    const item = intelEl('li', null);
    item.dataset.signal = type;
    item.append(intelEl('strong', null, label), intelEl('span', 'lists-description', ` - ${text}`));
    supported.appendChild(item);
  }
  const unsupported = intelEl('ul', 'intel-list');
  for (const [type, reason] of INTEL_UNSUPPORTED_SIGNALS) {
    const item = intelEl('li', null);
    item.dataset.signal = type;
    item.append(intelEl('strong', null, type.replace(/_/g, ' ')), intelEl('span', 'lists-description', ` - ${reason}`));
    unsupported.appendChild(item);
  }
  panel.replaceChildren(
    intelEl('div', 'intel-state', 'Unavailable in this build'),
    intelEl('h3', 'intel-panel-title', 'No signals can be shown yet'),
    intelEl('p', 'lists-description',
      'A signal is a change between two measured research runs of the same lead, found by Lead Intelligence change detection. That comparison reads research through the Lead Intelligence research bridge, which is not connected to this build\'s research records, so no signal can be derived from your data. Nothing is estimated in its place.'),
    intelEl('h4', 'intel-panel-subtitle', 'Signal types the Lead Intelligence contract supports'),
    supported,
    intelEl('h4', 'intel-panel-subtitle', 'Not supported by the contract'),
    unsupported
  );
}

function renderOpportunitiesPanel() {
  const panel = document.getElementById('opportunities-panel');
  panel.replaceChildren(
    intelEl('div', 'intel-state', 'Unavailable in this build'),
    intelEl('h3', 'intel-panel-title', 'No opportunities are listed'),
    intelEl('p', 'lists-description',
      'Lead Intelligence has no opportunity contract that this build can run, so no opportunity is listed and none is estimated.'),
    intelEl('h4', 'intel-panel-subtitle', 'What exists today'),
    intelEl('p', 'lists-description',
      'Evidence-backed audit findings from website research. Each finding cites the evidence IDs it is based on. Open a lead\'s drawer and choose Evidence, or see Research, Completed.'),
    listsButton('Open Research, Completed', 'btn btn-sm', () => intelSwitchTab('completed'))
  );
}

document.getElementById('icp-target').addEventListener('change', safeAsync(loadIcpResult));
document.getElementById('icp-fit').addEventListener('change', () => renderIcp());
document.getElementById('icp-search').addEventListener('input', () => renderIcp());
document.getElementById('icp-refresh').addEventListener('click', safeAsync(loadIcp));
for (const tab of document.querySelectorAll('.intel-tab')) {
  tab.addEventListener('click', () => intelSwitchTab(tab.dataset.intelTab));
}

// === F7 Research workspace ===
// The Queue and Completed views are an operational surface over the EXISTING
// Round-one research engine. Every row is the engine's own per-lead view,
// read through prospect-research:list (which calls gateway.getResearch for each
// stored lead), and every action is the existing prospect-research:request.
// There is no second state machine, queue, scheduler or poller here: the main
// process scheduler does the work, and these views re-read on open, on
// Refresh and after an action. States are the engine's nine availability
// values, shown by their own names - no state is collapsed into "failed" and
// none is invented. Rows open the existing F5 Lead Detail Drawer.
const RESEARCH_QUEUE_STATES = ['not_checked', 'pending', 'failed', 'site_unreachable', 'stale'];
const RESEARCH_COMPLETED_STATES = ['complete', 'partial', 'no_crawlable_content', 'no_website'];
const RESEARCH_QUEUE_ORDER = { pending: 0, failed: 1, site_unreachable: 2, stale: 3, not_checked: 4 };
const RESEARCH_STATE_LABELS = {
  not_checked: 'Not checked',
  pending: 'Pending',
  no_website: 'Website not available',
  site_unreachable: 'Site unreachable',
  no_crawlable_content: 'No crawlable content',
  partial: 'Partial',
  complete: 'Complete',
  failed: 'Failed',
  stale: 'Stale'
};
const RESEARCH_STATE_NOTES = {
  not_checked: 'Research has not run for this lead.',
  pending: 'The research service is working on it.',
  no_website: 'Website research is unavailable because no website is associated with this lead.',
  site_unreachable: 'The website could not be reached.',
  no_crawlable_content: 'The site responded, but nothing readable could be found.',
  partial: 'Finished with part of the evidence.',
  complete: 'Finished with every evidence section.',
  failed: 'Research finished without usable evidence.',
  stale: 'The stored result is older than the freshness policy allows.'
};
const RESEARCH_EVIDENCE_LABELS = { absent: 'No evidence', partial: 'Partial', complete: 'Complete', stale: 'Stale' };
// null until the first read: an unloaded list is never shown as an empty one.
let researchRows = null;
let researchLoadSeq = 0;
let researchLoadError = null;
let researchUnresearchable = 0;
let researchProviderText = '';

function researchState(row) {
  return row && typeof row.availability === 'string' && row.availability ? row.availability : 'not_checked';
}

// Derived only from stored fields: no packet = absent; a packet older than the
// freshness policy = stale; otherwise the packet's own availability.
function researchEvidenceStatus(row) {
  if (!row || !row.evidence) return 'absent';
  if (row.stale === true) return 'stale';
  return row.evidence.availability === 'complete' ? 'complete' : 'partial';
}

// An engine state this workspace does not list is kept visible in the Queue
// under its own name rather than hidden or renamed.
function researchInQueue(row) {
  const state = researchState(row);
  return RESEARCH_QUEUE_STATES.includes(state) || !RESEARCH_COMPLETED_STATES.includes(state);
}

function researchHost(url) {
  const text = typeof url === 'string' ? url.trim() : '';
  if (!text) return '';
  return qualityWebsiteSignal(text).host || text;
}

function researchRowsFor(kind, rows) {
  const source = Array.isArray(rows) ? rows : [];
  const term = document.getElementById(`research-${kind}-search`).value.trim().toLowerCase();
  const state = document.getElementById(`research-${kind}-state`).value;
  const evidence = document.getElementById(`research-${kind}-evidence`).value;
  const noWebsite = kind === 'queue' && document.getElementById('research-queue-nowebsite').checked;
  const out = source.filter((row) => {
    if ((kind === 'queue') !== researchInQueue(row)) return false;
    if (kind === 'queue' && !noWebsite && researchState(row) === 'not_checked' && !row.leadWebsite) return false;
    if (state !== 'all' && researchState(row) !== state) return false;
    if (evidence !== 'all' && researchEvidenceStatus(row) !== evidence) return false;
    if (term) {
      const hay = [row.title, row.phone, row.leadWebsite, row.researchedWebsite].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(term)) return false;
    }
    return true;
  });
  const updated = (row) => (typeof row.updatedAt === 'string' ? row.updatedAt : '');
  out.sort(kind === 'queue'
    ? (a, b) => ((RESEARCH_QUEUE_ORDER[researchState(a)] ?? 9) - (RESEARCH_QUEUE_ORDER[researchState(b)] ?? 9))
      || updated(b).localeCompare(updated(a))
    : (a, b) => updated(b).localeCompare(updated(a)));
  return out;
}

// Leads without a website that have never been researched: counted from the
// same rows, so the Queue can say how many it is not showing.
function researchHiddenNoWebsite(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => researchState(row) === 'not_checked' && !row.leadWebsite).length;
}

function researchStateCell(row) {
  const state = researchState(row);
  const cell = listsEl('td', 'research-cell-state');
  const badge = listsEl('span', 'research-badge', RESEARCH_STATE_LABELS[state] || state);
  badge.dataset.state = state;
  cell.appendChild(badge);
  cell.appendChild(listsEl('div', 'lists-description', RESEARCH_STATE_NOTES[state] || 'Reported by the research engine.'));
  if (state === 'pending' && row.pendingReason) cell.appendChild(listsEl('div', 'lists-description', `Waiting: ${row.pendingReason}`));
  if (row.message) cell.appendChild(listsEl('div', 'lists-description', `Reason: ${row.message}`));
  return cell;
}

function researchEvidenceCell(row) {
  const status = researchEvidenceStatus(row);
  const cell = listsEl('td', 'research-cell-evidence');
  const badge = listsEl('span', 'research-evidence', RESEARCH_EVIDENCE_LABELS[status]);
  badge.dataset.evidence = status;
  cell.appendChild(badge);
  if (row.evidence) {
    const e = row.evidence;
    cell.appendChild(listsEl('div', 'lists-description',
      `${e.facts} ${e.facts === 1 ? 'fact' : 'facts'} · ${e.findings} ${e.findings === 1 ? 'finding' : 'findings'}`));
    if (e.provider) cell.appendChild(listsEl('div', 'lists-description', `Source: ${e.provider}`));
  }
  return cell;
}

function researchFreshnessCell(row) {
  const cell = listsEl('td', 'lists-cell-muted');
  if (!row.evidence) {
    cell.textContent = '—';
    return cell;
  }
  cell.appendChild(listsEl('div', null, row.stale ? 'Stale' : 'Within policy'));
  if (row.evidence.capturedAt) cell.appendChild(listsEl('div', 'lists-description', `Captured ${formatListTime(row.evidence.capturedAt)}`));
  return cell;
}

function researchRow(kind, row) {
  const tr = document.createElement('tr');
  tr.className = 'research-row';
  tr.dataset.leadId = row.leadId;
  const state = researchState(row);
  const name = row.title || row.phone || 'Untitled lead';
  const leadCell = listsEl('td', 'lists-cell-name');
  leadCell.appendChild(listsButton(name, 'research-lead-link', () => openResearchLead(row.leadId), `Open ${name} in the lead drawer`));
  if (row.title && row.phone) leadCell.appendChild(listsEl('div', 'lists-description', row.phone));
  const siteCell = listsEl('td', 'research-cell-site');
  const host = researchHost(row.leadWebsite);
  if (host) siteCell.appendChild(listsEl('div', null, host));
  else siteCell.appendChild(listsEl('span', 'lists-cell-muted', 'Website not available'));
  const researchedHost = researchHost(row.researchedWebsite);
  if (researchedHost && researchedHost !== host) {
    siteCell.appendChild(listsEl('div', 'lists-description', `Researched: ${researchedHost}`));
  }
  const actions = listsEl('td', 'lists-cell-actions');
  actions.appendChild(listsButton('Open', 'btn btn-sm btn-secondary', () => openResearchLead(row.leadId), `Open ${name}`));
  // The existing request action needs a website and is not repeated while a
  // run is in progress. Without force it reuses a fresh result (engine rule).
  if (row.leadWebsite && state !== 'pending') {
    const first = state === 'not_checked';
    actions.appendChild(listsButton(first ? 'Start research' : 'Run again', 'btn btn-sm',
      () => runResearch(row, !first), `${first ? 'Start research for' : 'Run research again for'} ${name}`));
  }
  const cells = [leadCell, siteCell, researchStateCell(row), researchEvidenceCell(row)];
  if (kind === 'completed') cells.push(researchFreshnessCell(row));
  cells.push(listsEl('td', 'lists-cell-muted', formatListTime(row.updatedAt)), actions);
  tr.append(...cells);
  tr.addEventListener('click', (e) => {
    if (e.target.closest('button, a, input, select')) return;
    safeAsync(() => openResearchLead(row.leadId))();
  });
  return tr;
}

function renderResearch(kind) {
  const tbody = document.getElementById(`research-${kind}-body`);
  const count = document.getElementById(`research-${kind}-count`);
  const colSpan = kind === 'completed' ? 7 : 6;
  document.getElementById(`research-${kind}-provider`).textContent = researchProviderText;
  if (researchLoadError) {
    count.textContent = '';
    listEmptyRow(tbody, colSpan, 'Research state could not be loaded', researchLoadError);
    tbody.firstChild.querySelector('.leads-state').dataset.state = 'error';
    return;
  }
  if (researchRows === null) {
    count.textContent = '';
    listEmptyRow(tbody, colSpan, 'Loading research state...', 'Reading the stored research record for each lead.');
    tbody.firstChild.querySelector('.leads-state').dataset.state = 'loading';
    return;
  }
  const inTab = researchRows.filter((row) => (kind === 'queue') === researchInQueue(row));
  const rows = researchRowsFor(kind, researchRows);
  const parts = [`${rows.length} of ${inTab.length} ${kind === 'queue' ? 'in the queue' : 'completed'}`];
  if (kind === 'queue' && !document.getElementById('research-queue-nowebsite').checked) {
    const hidden = researchHiddenNoWebsite(researchRows);
    if (hidden) parts.push(`${hidden} not checked without a website hidden`);
  }
  if (researchUnresearchable) parts.push(`${researchUnresearchable} leads have an id research cannot use`);
  count.textContent = parts.join(' · ');
  if (!rows.length) {
    const filtered = inTab.length > 0;
    listEmptyRow(tbody, colSpan,
      filtered ? 'No rows match these filters' : (kind === 'queue' ? 'No leads currently require research.' : 'No completed research yet.'),
      filtered ? 'Change or clear the search and filters above.'
        : (kind === 'queue' ? 'Every lead has a recorded research result, or has no website.'
          : 'Completed research appears here once the research engine records a result.'));
    return;
  }
  const frag = document.createDocumentFragment();
  for (const row of rows) frag.appendChild(researchRow(kind, row));
  tbody.replaceChildren(frag);
}

function renderResearchViews() {
  renderResearch('queue');
  renderResearch('completed');
}

// The provider line is read through the two existing status channels. It says
// whether a key is configured, never what the key is.
async function loadResearchProviderStatus() {
  const parts = [];
  try {
    const key = await window.appAPI.research.keyStatus();
    parts.push(key && key.configured ? 'Research API key configured' : 'No research API key configured - research runs cannot start until one is set in Settings');
  } catch (err) {
    parts.push('Research key status unavailable');
  }
  try {
    const health = await window.appAPI.research.providerHealth();
    if (health && typeof health.state === 'string') parts.push(`Provider: ${health.state}`);
  } catch (err) {
    // The provider line is informational only.
  }
  return parts.join(' · ');
}

function researchListErrorText(err) {
  const msg = (err && err.message) || String(err);
  return /No handler registered/i.test(msg)
    ? 'The research service is not available in this session.'
    : msg;
}

async function loadResearch() {
  const seq = ++researchLoadSeq;
  researchRows = null;
  researchLoadError = null;
  renderResearchViews();
  try {
    const [result, provider] = await Promise.all([
      window.appAPI.research.list(),
      loadResearchProviderStatus()
    ]);
    if (seq !== researchLoadSeq) return;
    researchRows = result && Array.isArray(result.rows) ? result.rows : [];
    researchUnresearchable = result && Number.isInteger(result.unresearchable) ? result.unresearchable : 0;
    researchProviderText = provider;
  } catch (err) {
    if (seq !== researchLoadSeq) return;
    researchLoadError = researchListErrorText(err);
    reportError(researchLoadError, { handler: 'loadResearch' });
  }
  renderResearchViews();
}

// Opens the EXISTING F5 drawer on its Research tab. No second lead profile.
async function openResearchLead(leadId) {
  await openLeadDetail(leadId);
  selectLeadDrawerTab('research', false);
}

// The existing request channel: force=false reuses a fresh result, force=true
// runs again. The main-process service owns the run and its retries.
async function runResearch(row, force) {
  let view;
  try {
    view = await window.appAPI.research.request(row.leadId, force === true);
  } catch (err) {
    toast((err && err.message) || 'Research could not be requested', 'error');
    return;
  }
  const state = view && typeof view.availability === 'string' ? view.availability : 'pending';
  toast(`Research: ${RESEARCH_STATE_LABELS[state] || state}`);
  await loadResearch();
}

// The drawer overlay is the single F5 drawer. It is moved (not copied) to the
// document body so it can open over the Research views too; its markup, ids
// and behaviour are unchanged. Leaving a view closes it, so a drawer opened in
// one workspace never lingers over another.
(function mountLeadDrawerGlobally() {
  const overlay = document.getElementById('lead-detail-overlay');
  if (overlay && overlay.parentNode !== document.body) document.body.appendChild(overlay);
  navItems.forEach((item) => {
    item.addEventListener('click', () => {
      if (!overlay.hidden) closeLeadDetail();
    });
  });
})();

for (const kind of ['queue', 'completed']) {
  document.getElementById(`research-${kind}-search`).addEventListener('input', () => renderResearch(kind));
  document.getElementById(`research-${kind}-state`).addEventListener('change', () => renderResearch(kind));
  document.getElementById(`research-${kind}-evidence`).addEventListener('change', () => renderResearch(kind));
  document.getElementById(`research-${kind}-refresh`).addEventListener('click', safeAsync(loadResearch));
}
document.getElementById('research-queue-nowebsite').addEventListener('change', () => renderResearch('queue'));
for (const tab of document.querySelectorAll('.research-tab')) {
  tab.addEventListener('click', safeAsync(async () => {
    const target = tab.dataset.researchTab;
    const nav = document.querySelector(`.nav-item[data-view="${target}"]`);
    if (nav) nav.click();
  }));
}

// === F6 Lists: saved searches and segments ===
// Saved Searches and Segments are user-owned definitions stored by the main
// process (window.appAPI.lists). They are never a second Leads
// implementation: running a saved search sets the EXISTING Leads controls and
// sort state, and opening a segment adds its id to the EXISTING Leads query
// (numbersQueryPayload), so search, filters, sort, paging, selection and the
// F5 drawer behave exactly as they do for the whole library. Every count shown
// here is returned by the main process from stored data. All text is set with
// textContent; no stored value is ever parsed as markup.
const LIST_SORT_LABELS = {
  collectedAt: 'Collected', title: 'Lead', phone: 'Phone', source: 'Source', keyword: 'Keywords'
};
const LIST_NAME_MAX = 120;
let savedSearchRows = [];
let segmentRows = [];
let savedSearchLoadSeq = 0;
let segmentLoadSeq = 0;
// { mode: 'create' | 'edit', id, definition }
let savedSearchDialogState = null;
// { mode: 'create' | 'edit', id, type }
let segmentDialogState = null;
// { ids } of the Leads selection the add-to-segment dialog acts on.
let addToSegmentState = null;
// The list the Leads view was opened from:
// { kind: 'search', id, name, definition } | { kind: 'segment', id, name, type }
let leadsListContext = null;
let segmentPreviewTimer = null;
let segmentPreviewSeq = 0;

function listsEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined && text !== null) el.textContent = String(text);
  return el;
}

function listsButton(label, className, onClick, ariaLabel) {
  const btn = listsEl('button', className || 'btn btn-sm btn-secondary', label);
  btn.type = 'button';
  if (ariaLabel) btn.setAttribute('aria-label', ariaLabel);
  btn.addEventListener('click', safeAsync(onClick));
  return btn;
}

function formatListTime(value) {
  if (typeof value !== 'string' || !value) return '—';
  const date = new Date(value);
  return isNaN(date.getTime()) ? '—' : date.toLocaleString('en-GB');
}

// The live Leads query state, in the stored definition shape. Filters come from
// the real controls (activeLeadsFilters), so only supported values exist.
function currentLeadsDefinition() {
  const filters = {};
  for (const filter of activeLeadsFilters()) filters[filter.key] = filter.value;
  return {
    search: document.getElementById('number-search').value.trim(),
    filters,
    sort: numbersSort || '',
    order: numbersSort && numbersOrder === 'desc' ? 'desc' : 'asc'
  };
}

function definitionsEqual(a, b, withSort) {
  const left = a || {};
  const right = b || {};
  if ((left.search || '') !== (right.search || '')) return false;
  const lf = left.filters || {};
  const rf = right.filters || {};
  const keys = new Set(Object.keys(lf).concat(Object.keys(rf)));
  for (const key of keys) if ((lf[key] || '') !== (rf[key] || '')) return false;
  if (!withSort) return true;
  if ((left.sort || '') !== (right.sort || '')) return false;
  return !left.sort || (left.order || 'asc') === (right.order || 'asc');
}

// A readable summary of a stored definition. Filter labels come from the real
// Leads <select> options, so a summary never names a value the UI lacks.
function definitionParts(definition) {
  const def = definition || {};
  const filters = def.filters || {};
  const parts = [];
  if (def.search) parts.push(`Text contains "${def.search}"`);
  for (const d of LEADS_FILTER_DEFS) {
    if (filters[d.key]) parts.push(`${d.label}: ${filterValueLabel(d.control, filters[d.key])}`);
  }
  if (filters.source) parts.push(`Source is "${filters.source}"`);
  if (filters.keyword) parts.push(`Keyword is "${filters.keyword}"`);
  return parts;
}

function definitionSummary(definition) {
  const parts = definitionParts(definition);
  return parts.length ? parts.join(' · ') : 'All leads (no filters)';
}

function sortSummary(definition) {
  const def = definition || {};
  if (!def.sort) return 'Default (newest first)';
  return `${LIST_SORT_LABELS[def.sort] || def.sort} ${def.order === 'desc' ? 'descending' : 'ascending'}`;
}

function copyName(name) {
  const suffix = ' (copy)';
  return (String(name || '').slice(0, LIST_NAME_MAX - suffix.length) + suffix).trim();
}

function listEmptyRow(tbody, colSpan, title, body, action) {
  const tr = document.createElement('tr');
  const td = document.createElement('td');
  td.colSpan = colSpan;
  const box = listsEl('div', 'leads-state');
  box.dataset.state = 'empty';
  box.append(listsEl('div', 'leads-state-title', title), listsEl('div', 'leads-state-body', body));
  if (action) {
    const actions = listsEl('div', 'leads-state-actions');
    actions.appendChild(action);
    box.appendChild(actions);
  }
  td.appendChild(box);
  tr.appendChild(td);
  tbody.replaceChildren(tr);
}

function listErrorMessage(err, fallback) {
  return (err && err.message) || fallback;
}

// --- Leads integration -------------------------------------------------------

// Sets the existing Leads controls and sort state from a stored definition.
// A stored value the current control cannot represent is reported, never
// silently widened into "all".
function applyDefinitionToLeads(definition) {
  const def = definition || {};
  const filters = def.filters || {};
  const unsupported = [];
  document.getElementById('number-search').value = def.search || '';
  for (const d of LEADS_FILTER_DEFS) {
    const el = document.getElementById(d.control);
    if (!el) continue;
    const wanted = filters[d.key];
    if (!wanted) {
      el.value = 'all';
      continue;
    }
    if ([...el.options].some((option) => option.value === wanted)) el.value = wanted;
    else {
      el.value = 'all';
      unsupported.push(d.label);
    }
  }
  numbersSort = def.sort && NUMBERS_SORTABLE_KEYS.indexOf(def.sort) !== -1 ? def.sort : '';
  numbersOrder = numbersSort && def.order === 'desc' ? 'desc' : 'asc';
  return unsupported;
}

function openLeadsWithContext(context) {
  leadsListContext = context;
  document.getElementById('leads-scope').dataset.segmentId = context && context.kind === 'segment' ? context.id : '';
  syncFilterTriggers();
  renderLeadsChips();
  activateView('numbers');
  loadNumbers();
  checkStorageStatus();
}

function clearLeadsListContext() {
  leadsListContext = null;
  const scope = document.getElementById('leads-scope');
  scope.dataset.segmentId = '';
  renderLeadsScope();
}

function renderLeadsScope() {
  const bar = document.getElementById('leads-scope');
  const removeBtn = document.getElementById('btn-remove-from-segment');
  const context = leadsListContext;
  if (removeBtn) removeBtn.hidden = !(context && context.kind === 'segment' && context.type === 'static');
  bar.replaceChildren();
  if (!context) {
    bar.hidden = true;
    return;
  }
  bar.dataset.kind = context.kind;
  const label = listsEl('span', 'leads-scope-label', context.kind === 'segment' ? 'Segment' : 'Saved search');
  const name = listsEl('span', 'leads-scope-name', context.name);
  bar.append(label, name);
  if (context.kind === 'segment') {
    bar.appendChild(listsEl('span', 'list-type-badge', context.type === 'dynamic' ? 'Dynamic' : 'Static'))
      .dataset.type = context.type;
    bar.appendChild(listsEl('span', 'leads-scope-note',
      context.type === 'dynamic'
        ? 'Showing leads that match the segment rules now. Filters narrow it further.'
        : 'Showing the segment members. Filters narrow it further.'));
    bar.appendChild(listsButton('Leave segment', 'btn btn-sm btn-secondary', () => {
      clearLeadsListContext();
      loadNumbers();
    }));
  } else {
    const matches = definitionsEqual(context.definition, currentLeadsDefinition(), true);
    bar.appendChild(listsEl('span', matches ? 'leads-scope-note' : 'leads-scope-note leads-scope-changed',
      matches ? 'Filters match the saved definition.' : 'Filters changed since this search was run.'));
    if (!matches) {
      bar.appendChild(listsButton('Update saved search', 'btn btn-sm', () => updateSavedSearchFromLeads(context)));
    }
    bar.appendChild(listsButton('Close', 'btn btn-sm btn-secondary', () => clearLeadsListContext(),
      'Stop tracking this saved search'));
  }
  bar.hidden = false;
}

async function updateSavedSearchFromLeads(context) {
  const definition = currentLeadsDefinition();
  const result = await window.appAPI.lists.saveSavedSearch({ id: context.id, query: definition });
  if (result && result.success === false) {
    toast(result.error || 'Saved search not updated', 'error');
    return;
  }
  leadsListContext = { ...context, definition };
  renderLeadsScope();
  toast('Saved search updated');
}

// --- Saved Searches view -----------------------------------------------------

async function loadSavedSearches() {
  const seq = ++savedSearchLoadSeq;
  const tbody = document.getElementById('saved-search-body');
  try {
    const result = await window.appAPI.lists.listSavedSearches();
    if (seq !== savedSearchLoadSeq) return;
    savedSearchRows = result && Array.isArray(result.rows) ? result.rows : [];
    renderSavedSearches();
  } catch (err) {
    if (seq !== savedSearchLoadSeq) return;
    const msg = listErrorMessage(err, 'Saved searches could not be loaded');
    listEmptyRow(tbody, 5, 'Could not load saved searches', msg);
    document.getElementById('saved-search-count').textContent = '';
    reportError(msg, { handler: 'loadSavedSearches' });
  }
}

function renderSavedSearches() {
  const tbody = document.getElementById('saved-search-body');
  const term = document.getElementById('saved-search-filter').value.trim().toLowerCase();
  const rows = term
    ? savedSearchRows.filter((row) => `${row.name} ${row.description}`.toLowerCase().includes(term))
    : savedSearchRows;
  const count = document.getElementById('saved-search-count');
  const total = savedSearchRows.length;
  count.textContent = term
    ? `${rows.length} of ${total} saved searches`
    : `${total} saved ${total === 1 ? 'search' : 'searches'}`;
  if (!total) {
    listEmptyRow(tbody, 5, 'No saved searches yet',
      'Filter or sort the Leads view, then choose Save search. New saved search here saves the current Leads filters.',
      listsButton('Go to Leads', 'btn btn-sm', () => { clearLeadsListContext(); activateView('numbers'); loadNumbers(); }));
    return;
  }
  if (!rows.length) {
    listEmptyRow(tbody, 5, 'No saved searches match', 'Change or clear the search above.');
    return;
  }
  const live = currentLeadsDefinition();
  const frag = document.createDocumentFragment();
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.dataset.savedSearchId = row.id;
    const nameCell = listsEl('td', 'lists-cell-name');
    nameCell.appendChild(listsEl('div', 'lists-name', row.name));
    if (row.description) nameCell.appendChild(listsEl('div', 'lists-description', row.description));
    if (!row.definitionError && definitionsEqual(row.query, live, true)) {
      nameCell.appendChild(listsEl('span', 'lists-live', 'Matches current Leads filters'));
    }
    const defCell = listsEl('td', 'lists-cell-definition');
    if (row.definitionError) {
      defCell.appendChild(listsEl('span', 'lists-warning', `Stored definition cannot run: ${row.definitionError}`));
    } else {
      defCell.textContent = definitionSummary(row.query);
    }
    const actions = listsEl('td', 'lists-cell-actions');
    const run = listsButton('Run', 'btn btn-sm', () => runSavedSearch(row), `Run saved search ${row.name}`);
    run.disabled = Boolean(row.definitionError);
    actions.append(
      run,
      listsButton('Edit', 'btn btn-sm btn-secondary', () => openSavedSearchDialog('edit', row), `Edit saved search ${row.name}`),
      listsButton('Duplicate', 'btn btn-sm btn-secondary', () => duplicateSavedSearch(row), `Duplicate saved search ${row.name}`),
      listsButton('Delete', 'btn btn-sm btn-secondary lists-danger', () => deleteSavedSearch(row), `Delete saved search ${row.name}`)
    );
    tr.append(nameCell, defCell, listsEl('td', 'lists-cell-muted', sortSummary(row.query)),
      listsEl('td', 'lists-cell-muted', formatListTime(row.updatedAt)), actions);
    frag.appendChild(tr);
  }
  tbody.replaceChildren(frag);
}

function runSavedSearch(row) {
  const unsupported = applyDefinitionToLeads(row.query);
  if (unsupported.length) toast(`Not applied (value not offered by Leads): ${unsupported.join(', ')}`, 'error');
  openLeadsWithContext({ kind: 'search', id: row.id, name: row.name, definition: row.query });
}

async function duplicateSavedSearch(row) {
  const result = await window.appAPI.lists.saveSavedSearch({
    name: copyName(row.name), description: row.description, query: row.query
  });
  if (result && result.success === false) {
    toast(result.error || 'Saved search not duplicated', 'error');
    return;
  }
  toast('Saved search duplicated');
  await loadSavedSearches();
}

async function deleteSavedSearch(row) {
  if (!window.confirm(`Delete the saved search "${row.name}"? No leads are deleted.`)) return;
  const result = await window.appAPI.lists.deleteSavedSearch({ id: row.id });
  if (result && result.success === false) {
    toast(result.error || 'Saved search not deleted', 'error');
    return;
  }
  if (leadsListContext && leadsListContext.kind === 'search' && leadsListContext.id === row.id) clearLeadsListContext();
  toast(result && result.deleted === false ? 'That saved search no longer exists' : 'Saved search deleted');
  await loadSavedSearches();
}

function renderDefinitionBlock(container, definition) {
  container.replaceChildren();
  const parts = definitionParts(definition);
  const list = listsEl('ul', 'lists-definition-list');
  for (const part of parts.length ? parts : ['All leads (no filters)']) list.appendChild(listsEl('li', null, part));
  list.appendChild(listsEl('li', 'lists-definition-sort', `Sort: ${sortSummary(definition)}`));
  container.appendChild(list);
}

function openSavedSearchDialog(mode, row) {
  const dialog = document.getElementById('saved-search-dialog');
  const editing = mode === 'edit' && row;
  const definition = editing ? row.query : currentLeadsDefinition();
  savedSearchDialogState = { mode: editing ? 'edit' : 'create', id: editing ? row.id : null, definition };
  document.getElementById('saved-search-dialog-title').textContent = editing ? 'Edit saved search' : 'Save search';
  document.getElementById('saved-search-name').value = editing ? row.name : '';
  document.getElementById('saved-search-description').value = editing ? row.description : '';
  document.getElementById('saved-search-replace').checked = false;
  document.getElementById('saved-search-replace-row').hidden = !editing;
  document.getElementById('saved-search-error').textContent = '';
  renderDefinitionBlock(document.getElementById('saved-search-definition'), definition);
  dialog.showModal();
  document.getElementById('saved-search-name').focus();
}

async function submitSavedSearchDialog() {
  const state = savedSearchDialogState;
  if (!state) return;
  const error = document.getElementById('saved-search-error');
  const name = document.getElementById('saved-search-name').value.trim();
  if (!name) {
    error.textContent = 'Enter a name.';
    return;
  }
  const payload = { name, description: document.getElementById('saved-search-description').value.trim() };
  if (state.mode === 'edit') {
    payload.id = state.id;
    if (document.getElementById('saved-search-replace').checked) payload.query = currentLeadsDefinition();
  } else {
    payload.query = state.definition;
  }
  let result;
  try {
    result = await window.appAPI.lists.saveSavedSearch(payload);
  } catch (err) {
    error.textContent = listErrorMessage(err, 'The saved search could not be saved.');
    return;
  }
  if (result && result.success === false) {
    error.textContent = result.error || 'The saved search could not be saved.';
    return;
  }
  document.getElementById('saved-search-dialog').close();
  savedSearchDialogState = null;
  toast(state.mode === 'edit' ? 'Saved search updated' : 'Search saved');
  if (leadsListContext && leadsListContext.kind === 'search' && leadsListContext.id === state.id) {
    leadsListContext = { ...leadsListContext, name, definition: payload.query || leadsListContext.definition };
    renderLeadsScope();
  }
  await loadSavedSearches();
}

// --- Segments view -----------------------------------------------------------

async function loadSegments() {
  const seq = ++segmentLoadSeq;
  const tbody = document.getElementById('segment-body');
  try {
    const result = await window.appAPI.lists.listSegments();
    if (seq !== segmentLoadSeq) return;
    segmentRows = result && Array.isArray(result.rows) ? result.rows : [];
    renderSegments();
  } catch (err) {
    if (seq !== segmentLoadSeq) return;
    const msg = listErrorMessage(err, 'Segments could not be loaded');
    listEmptyRow(tbody, 6, 'Could not load segments', msg);
    document.getElementById('segment-count').textContent = '';
    reportError(msg, { handler: 'loadSegments' });
  }
}

function segmentMembersCell(row) {
  const cell = listsEl('td', 'lists-cell-members');
  if (row.type === 'dynamic') {
    cell.appendChild(listsEl('span', 'lists-count-value', `${row.memberCount} matching now`));
    return cell;
  }
  cell.appendChild(listsEl('span', 'lists-count-value',
    `${row.availableCount} ${row.availableCount === 1 ? 'lead' : 'leads'}`));
  const unavailable = Array.isArray(row.unavailableIds) ? row.unavailableIds : [];
  if (unavailable.length) {
    const note = listsEl('div', 'lists-warning',
      `${unavailable.length} unavailable (lead deleted)`);
    note.title = unavailable.join(', ');
    cell.appendChild(note);
    cell.appendChild(listsButton('Remove unavailable', 'btn btn-sm btn-secondary lists-inline-btn',
      () => removeUnavailableMembers(row), `Remove ${unavailable.length} unavailable members from ${row.name}`));
  }
  return cell;
}

function renderSegments() {
  const tbody = document.getElementById('segment-body');
  const term = document.getElementById('segment-filter').value.trim().toLowerCase();
  const rows = term
    ? segmentRows.filter((row) => `${row.name} ${row.description}`.toLowerCase().includes(term))
    : segmentRows;
  const total = segmentRows.length;
  document.getElementById('segment-count').textContent = term
    ? `${rows.length} of ${total} segments`
    : `${total} ${total === 1 ? 'segment' : 'segments'}`;
  if (!total) {
    listEmptyRow(tbody, 6, 'No segments yet',
      'Create a dynamic segment from rules, or select leads in the Leads view and choose Add to segment.',
      listsButton('New segment', 'btn btn-sm', () => openSegmentDialog('create')));
    return;
  }
  if (!rows.length) {
    listEmptyRow(tbody, 6, 'No segments match', 'Change or clear the search above.');
    return;
  }
  const frag = document.createDocumentFragment();
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.dataset.segmentId = row.id;
    const nameCell = listsEl('td', 'lists-cell-name');
    nameCell.appendChild(listsEl('div', 'lists-name', row.name));
    if (row.description) nameCell.appendChild(listsEl('div', 'lists-description', row.description));
    const typeCell = listsEl('td', 'lists-cell-type');
    const badge = listsEl('span', 'list-type-badge', row.type === 'dynamic' ? 'Dynamic' : 'Static');
    badge.dataset.type = row.type;
    typeCell.appendChild(badge);
    const defCell = listsEl('td', 'lists-cell-definition');
    if (row.definitionError) {
      defCell.appendChild(listsEl('span', 'lists-warning', `Stored rules cannot run: ${row.definitionError}`));
    } else {
      defCell.textContent = row.type === 'dynamic'
        ? definitionSummary(row.rules)
        : 'Explicit members. Add leads from a Leads selection.';
    }
    const actions = listsEl('td', 'lists-cell-actions');
    actions.append(
      listsButton('Open in Leads', 'btn btn-sm', () => openSegmentInLeads(row), `Open segment ${row.name} in Leads`),
      listsButton('Edit', 'btn btn-sm btn-secondary', () => openSegmentDialog('edit', row), `Edit segment ${row.name}`)
    );
    if (row.type === 'static' && row.memberIds.length) {
      actions.appendChild(listsButton('Export IDs', 'btn btn-sm btn-secondary', () => exportSegmentIds(row),
        `Export the member ids of ${row.name}`));
    }
    actions.appendChild(listsButton('Delete', 'btn btn-sm btn-secondary lists-danger', () => deleteSegment(row),
      `Delete segment ${row.name}`));
    tr.append(nameCell, typeCell, segmentMembersCell(row), defCell,
      listsEl('td', 'lists-cell-muted', formatListTime(row.updatedAt)), actions);
    frag.appendChild(tr);
  }
  tbody.replaceChildren(frag);
}

// Opening a segment starts from the whole segment: the Leads search and
// filters are cleared (sort is kept) and the segment id scopes the query.
function openSegmentInLeads(row) {
  applyDefinitionToLeads({ search: '', filters: {}, sort: numbersSort, order: numbersOrder });
  openLeadsWithContext({ kind: 'segment', id: row.id, name: row.name, type: row.type });
}

async function removeUnavailableMembers(row) {
  const ids = Array.isArray(row.unavailableIds) ? row.unavailableIds.slice() : [];
  if (!ids.length) return;
  if (!window.confirm(`Remove ${ids.length} unavailable member id(s) from "${row.name}"? Their leads were deleted.`)) return;
  const result = await window.appAPI.lists.updateSegmentMembers({ id: row.id, remove: ids });
  if (result && result.success === false) {
    toast(result.error || 'Members not removed', 'error');
    return;
  }
  toast(`Removed ${result && Number.isInteger(result.removed) ? result.removed : ids.length} unavailable members`);
  await loadSegments();
}

// Same local download mechanism as the existing CSV export: a Blob built in the
// renderer, no file path and no IPC.
function exportSegmentIds(row) {
  const blob = new Blob([row.memberIds.join('\n') + '\n'], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `segment-${row.id}-member-ids.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

async function deleteSegment(row) {
  if (!window.confirm(`Delete the segment "${row.name}"? No leads are deleted.`)) return;
  const result = await window.appAPI.lists.deleteSegment({ id: row.id });
  if (result && result.success === false) {
    toast(result.error || 'Segment not deleted', 'error');
    return;
  }
  if (leadsListContext && leadsListContext.kind === 'segment' && leadsListContext.id === row.id) clearLeadsListContext();
  toast(result && result.deleted === false ? 'That segment no longer exists' : 'Segment deleted');
  await loadSegments();
}

// Rule selects take their options from the real Leads <select> elements, so a
// rule can only offer a value the Leads query accepts.
function initSegmentRuleSelects() {
  for (const select of document.querySelectorAll('#segment-rules select[data-source]')) {
    const source = document.getElementById(select.dataset.source);
    if (!source) continue;
    select.replaceChildren(...[...source.options].map((option) => {
      const copy = document.createElement('option');
      copy.value = option.value;
      copy.textContent = option.value === 'all' ? 'Any' : option.textContent;
      return copy;
    }));
  }
}

function readSegmentRules() {
  const filters = {};
  for (const select of document.querySelectorAll('#segment-rules select[data-rule]')) {
    if (select.value && select.value !== 'all') filters[select.dataset.rule] = select.value;
  }
  const source = document.getElementById('segment-rule-source').value.trim();
  const keyword = document.getElementById('segment-rule-keyword').value.trim();
  if (source) filters.source = source;
  if (keyword) filters.keyword = keyword;
  return { search: document.getElementById('segment-rule-search').value.trim(), filters };
}

function writeSegmentRules(rules) {
  const def = rules || {};
  const filters = def.filters || {};
  document.getElementById('segment-rule-search').value = def.search || '';
  for (const select of document.querySelectorAll('#segment-rules select[data-rule]')) {
    const wanted = filters[select.dataset.rule];
    select.value = wanted && [...select.options].some((o) => o.value === wanted) ? wanted : 'all';
  }
  document.getElementById('segment-rule-source').value = filters.source || '';
  document.getElementById('segment-rule-keyword').value = filters.keyword || '';
}

function selectedSegmentType() {
  return document.getElementById('segment-type-dynamic').checked ? 'dynamic' : 'static';
}

function syncSegmentDialogType() {
  const dynamic = selectedSegmentType() === 'dynamic';
  document.getElementById('segment-rules').hidden = !dynamic;
  if (dynamic) scheduleSegmentPreview();
}

// The preview count is a real query: the rules are sent through the existing
// collector.getNumbers contract, which evaluates exactly the same filters.
function scheduleSegmentPreview() {
  clearTimeout(segmentPreviewTimer);
  const preview = document.getElementById('segment-rule-preview');
  preview.textContent = 'Counting...';
  segmentPreviewTimer = setTimeout(safeAsync(async () => {
    const seq = ++segmentPreviewSeq;
    const rules = readSegmentRules();
    const query = { limit: 1, offset: 0 };
    if (rules.search) query.search = rules.search;
    if (Object.keys(rules.filters).length) query.filters = rules.filters;
    try {
      const result = await window.appAPI.collector.getNumbers(query);
      if (seq !== segmentPreviewSeq) return;
      const total = result && Number.isInteger(result.total) ? result.total : 0;
      preview.textContent = `Matches ${total} ${total === 1 ? 'lead' : 'leads'} now`;
    } catch (err) {
      if (seq !== segmentPreviewSeq) return;
      preview.textContent = listErrorMessage(err, 'Count unavailable');
    }
  }), NUMBERS_SEARCH_DEBOUNCE_MS);
}

function openSegmentDialog(mode, row) {
  const editing = mode === 'edit' && row;
  segmentDialogState = { mode: editing ? 'edit' : 'create', id: editing ? row.id : null, type: editing ? row.type : null };
  document.getElementById('segment-dialog-title').textContent = editing ? 'Edit segment' : 'New segment';
  document.getElementById('segment-name').value = editing ? row.name : '';
  document.getElementById('segment-description').value = editing ? row.description : '';
  document.getElementById('segment-type-static').checked = !editing || row.type === 'static';
  document.getElementById('segment-type-dynamic').checked = Boolean(editing && row.type === 'dynamic');
  // The type is fixed once a segment exists: members and rules are different data.
  for (const id of ['segment-type-static', 'segment-type-dynamic']) document.getElementById(id).disabled = Boolean(editing);
  writeSegmentRules(editing && row.type === 'dynamic' ? row.rules : null);
  document.getElementById('segment-error').textContent = '';
  document.getElementById('segment-rule-preview').textContent = '';
  syncSegmentDialogType();
  document.getElementById('segment-dialog').showModal();
  document.getElementById('segment-name').focus();
}

async function submitSegmentDialog() {
  const state = segmentDialogState;
  if (!state) return;
  const error = document.getElementById('segment-error');
  const name = document.getElementById('segment-name').value.trim();
  if (!name) {
    error.textContent = 'Enter a name.';
    return;
  }
  const type = state.mode === 'edit' ? state.type : selectedSegmentType();
  const payload = { name, description: document.getElementById('segment-description').value.trim() };
  if (state.mode === 'edit') payload.id = state.id;
  else payload.type = type;
  if (type === 'dynamic') payload.rules = readSegmentRules();
  let result;
  try {
    result = await window.appAPI.lists.saveSegment(payload);
  } catch (err) {
    error.textContent = listErrorMessage(err, 'The segment could not be saved.');
    return;
  }
  if (result && result.success === false) {
    error.textContent = result.error || 'The segment could not be saved.';
    return;
  }
  document.getElementById('segment-dialog').close();
  segmentDialogState = null;
  toast(state.mode === 'edit' ? 'Segment updated' : 'Segment created');
  if (leadsListContext && leadsListContext.kind === 'segment' && leadsListContext.id === state.id) {
    leadsListContext = { ...leadsListContext, name };
  }
  await loadSegments();
}

// --- Leads selection -> static segment ---------------------------------------

async function openAddToSegmentDialog() {
  const ids = selectedLeadIds();
  if (!ids.length) return;
  addToSegmentState = { ids };
  const select = document.getElementById('add-to-segment-select');
  const error = document.getElementById('add-to-segment-error');
  error.textContent = '';
  document.getElementById('add-to-segment-name').value = '';
  document.getElementById('add-to-segment-summary').textContent =
    `${ids.length} selected ${ids.length === 1 ? 'lead' : 'leads'} will be added. Leads already in the segment are skipped.`;
  let statics = [];
  try {
    const result = await window.appAPI.lists.listSegments();
    statics = (result && Array.isArray(result.rows) ? result.rows : []).filter((row) => row.type === 'static');
  } catch (err) {
    error.textContent = listErrorMessage(err, 'Segments could not be loaded.');
  }
  select.replaceChildren(...statics.map((row) => {
    const option = document.createElement('option');
    option.value = row.id;
    option.textContent = `${row.name} (${row.availableCount} ${row.availableCount === 1 ? 'lead' : 'leads'})`;
    return option;
  }));
  const hasStatic = statics.length > 0;
  select.disabled = !hasStatic;
  document.getElementById('add-to-segment-existing').disabled = !hasStatic;
  document.getElementById('add-to-segment-existing').checked = hasStatic;
  document.getElementById('add-to-segment-new').checked = !hasStatic;
  document.getElementById('add-to-segment-dialog').showModal();
  (hasStatic ? select : document.getElementById('add-to-segment-name')).focus();
}

async function submitAddToSegmentDialog() {
  const state = addToSegmentState;
  if (!state) return;
  const error = document.getElementById('add-to-segment-error');
  const toNew = document.getElementById('add-to-segment-new').checked;
  let result;
  let label;
  try {
    if (toNew) {
      const name = document.getElementById('add-to-segment-name').value.trim();
      if (!name) {
        error.textContent = 'Enter a name for the new segment.';
        return;
      }
      label = name;
      result = await window.appAPI.lists.saveSegment({ name, type: 'static', memberIds: state.ids });
    } else {
      const select = document.getElementById('add-to-segment-select');
      if (!select.value) {
        error.textContent = 'Choose a segment.';
        return;
      }
      label = select.options[select.selectedIndex].textContent;
      result = await window.appAPI.lists.updateSegmentMembers({ id: select.value, add: state.ids });
    }
  } catch (err) {
    error.textContent = listErrorMessage(err, 'The leads could not be added.');
    return;
  }
  if (result && result.success === false) {
    error.textContent = result.error || 'The leads could not be added.';
    return;
  }
  document.getElementById('add-to-segment-dialog').close();
  addToSegmentState = null;
  const added = toNew ? state.ids.length : (result && Number.isInteger(result.added) ? result.added : 0);
  toast(toNew ? `Created "${label}" with ${added} leads` : `Added ${added} ${added === 1 ? 'lead' : 'leads'}`);
  clearLeadsSelection();
  if (leadsListContext && leadsListContext.kind === 'segment') renderNumbers();
}

async function removeSelectionFromSegment() {
  const context = leadsListContext;
  const ids = selectedLeadIds();
  if (!context || context.kind !== 'segment' || context.type !== 'static' || !ids.length) return;
  if (!window.confirm(`Remove ${ids.length} selected ${ids.length === 1 ? 'lead' : 'leads'} from "${context.name}"? The leads are not deleted.`)) return;
  const result = await window.appAPI.lists.updateSegmentMembers({ id: context.id, remove: ids });
  if (result && result.success === false) {
    toast(result.error || 'Leads not removed', 'error');
    return;
  }
  toast(`Removed ${result && Number.isInteger(result.removed) ? result.removed : 0} leads from the segment`);
  renderNumbers();
}

// --- wiring ------------------------------------------------------------------

// Escape closes a list dialog and is consumed there, so it never also closes
// the F5 drawer underneath (which ignores an Escape already handled). Enter in
// a single-line field submits, as a form would; the app has no <form> element,
// so nothing can ever navigate or post.
const LIST_DIALOG_SUBMITS = {
  'saved-search-dialog': submitSavedSearchDialog,
  'segment-dialog': submitSegmentDialog,
  'add-to-segment-dialog': submitAddToSegmentDialog
};
for (const [id, submit] of Object.entries(LIST_DIALOG_SUBMITS)) {
  const dialog = document.getElementById(id);
  dialog.addEventListener('keydown', safeAsync(async (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      dialog.close();
      return;
    }
    if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT' && e.target.type === 'text') {
      e.preventDefault();
      await submit();
    }
  }));
}
document.getElementById('btn-save-search').addEventListener('click', () => openSavedSearchDialog('create'));
document.getElementById('btn-new-saved-search').addEventListener('click', () => openSavedSearchDialog('create'));
document.getElementById('btn-saved-search-cancel').addEventListener('click', () => document.getElementById('saved-search-dialog').close());
document.getElementById('btn-saved-search-submit').addEventListener('click', safeAsync(submitSavedSearchDialog));
document.getElementById('saved-search-filter').addEventListener('input', () => renderSavedSearches());
document.getElementById('btn-new-segment').addEventListener('click', () => openSegmentDialog('create'));
document.getElementById('btn-segment-cancel').addEventListener('click', () => document.getElementById('segment-dialog').close());
document.getElementById('btn-segment-submit').addEventListener('click', safeAsync(submitSegmentDialog));
for (const id of ['segment-type-static', 'segment-type-dynamic']) {
  document.getElementById(id).addEventListener('change', syncSegmentDialogType);
}
document.getElementById('segment-rules').addEventListener('input', scheduleSegmentPreview);
document.getElementById('segment-rules').addEventListener('change', scheduleSegmentPreview);
document.getElementById('btn-segment-use-leads').addEventListener('click', () => {
  const live = currentLeadsDefinition();
  writeSegmentRules({ search: live.search, filters: live.filters });
  scheduleSegmentPreview();
});
document.getElementById('segment-filter').addEventListener('input', () => renderSegments());
document.getElementById('btn-add-to-segment').addEventListener('click', safeAsync(openAddToSegmentDialog));
document.getElementById('btn-remove-from-segment').addEventListener('click', safeAsync(removeSelectionFromSegment));
document.getElementById('btn-add-to-segment-cancel').addEventListener('click', () => document.getElementById('add-to-segment-dialog').close());
document.getElementById('btn-add-to-segment-submit').addEventListener('click', safeAsync(submitAddToSegmentDialog));
document.getElementById('add-to-segment-name').addEventListener('input', () => {
  document.getElementById('add-to-segment-new').checked = true;
});
initSegmentRuleSelects();

// 初始化补充
loadNumbers();
checkStorageStatus();
