// 视图切换
const navItems = document.querySelectorAll('.nav-item');
const views = document.querySelectorAll('.view');
const pageTitle = document.getElementById('page-title');

const viewTitles = {
  collector: '关键词采集',
  history: '采集历史',
  numbers: '号码管理',
  settings: '设置'
};

navItems.forEach(item => {
  item.addEventListener('click', () => {
    const viewId = item.dataset.view;
    navItems.forEach(n => n.classList.remove('active'));
    views.forEach(v => v.classList.remove('active'));
    item.classList.add('active');
    document.getElementById(`view-${viewId}`).classList.add('active');
    pageTitle.textContent = viewTitles[viewId];
  });
});

// 时钟
function updateClock() {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('zh-CN', { hour12: false });
  document.getElementById('clock').textContent = timeStr;
}
setInterval(updateClock, 1000);
updateClock();

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
  return `<a href="${escapeHtml(website)}" target="_blank" rel="noopener">链接</a>`;
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
      showStatus('请先在「设置」中配置 API Key', true);
      return;
    }
    if (!keywords) {
      showStatus('请输入关键词', true);
      return;
    }

    showStatus('正在提交采集任务...');

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
      showStatus(`任务已提交，ID: ${currentRunSlug}，等待执行中...`);
      claimResultView('run');
      clearCurrentResultPresentation();
      startPolling(gen, currentRunSlug);
    } else {
      claimResultView('none');
      showStatus(`提交失败: ${result.error}`, true);
    }
  }));

document.getElementById('btn-check-status').addEventListener('click', safeAsync(async () => {
    if (!currentRunSlug) {
      showStatus('没有进行中的任务', true);
      return;
    }
    if (pollTimerId !== null || pollInFlight) return;
    pollFailureCount = 0;
    claimResultView('run');
    startPolling(runGeneration, currentRunSlug);
  }));

function evaluatePollOutcome(status) {
  if (!status || status.success !== true) {
    return { outcome: 'transport-error', error: (status && status.error) || '未知错误' };
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
      showStatus(`轮询异常: ${msg}`, true);
      reportError(msg, { handler: 'scheduleNextPoll', gen, slug });
    });
  }, POLL_RETRY_DELAY_MS);
}

async function pollRunStatus(gen, slug) {
  if (!isCurrentRun(gen, slug)) return;

  pollInFlight = true;
  try {
    showStatus(`正在查询任务状态... (${slug})`);

    const status = await window.appAPI.collection.getStatus(slug);

    if (!isCurrentRun(gen, slug)) return;

    const res = evaluatePollOutcome(status);

    if (res.outcome === 'transport-error') {
      pollFailureCount += 1;
      if (pollFailureCount >= MAX_CONSECUTIVE_POLL_FAILURES) {
        showStatus(`查询失败: ${res.error}`, true);
        return;
      }
      showStatus(`查询失败: ${res.error}，稍后自动重试 (${pollFailureCount}/${MAX_CONSECUTIVE_POLL_FAILURES})`, true);
      scheduleNextPoll(gen, slug);
      return;
    }

    if (res.outcome === 'terminal-success') {
      loadRunResult(slug, gen);
      return;
    }

    if (res.outcome === 'terminal-failure') {
      showStatus(`采集失败: ${res.error || '未知错误'}`, true);
      return;
    }

    if (res.outcome === 'missing-state') {
      pollFailureCount += 1;
      if (pollFailureCount >= MAX_CONSECUTIVE_POLL_FAILURES) {
        showStatus('任务状态未知，已停止自动查询，可点击「检查状态」重试', true);
        return;
      }
      showStatus(`任务状态未知，稍后自动刷新 (${pollFailureCount}/${MAX_CONSECUTIVE_POLL_FAILURES})`);
      scheduleNextPoll(gen, slug);
      return;
    }

    pollFailureCount = 0;
    showStatus(`任务状态: ${res.state}，稍后自动刷新...`);
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
      showStatus('采集完成，本次结果未加载');
      return;
    }
    const seq = claimResultView('run');

    showStatus('采集完成，正在获取结果...');

    const result = await fetchAllRunResults(currentRunSlug);

    if (!isCurrentRun(gen, currentRunSlug)) return;
    if (!isViewClaimCurrent(seq)) {
      if (viewClaimKind === 'history') showStatus('采集完成，本次结果未加载');
      return;
    }

    if (!result.success) {
      showStatus(`获取结果失败: ${result.error}`, true);
      return;
    }

    const items = result.data?.list || [];
    showStatus(`采集完成，已加载 ${items.length} 条结果`);
    window.__collectResults = items;
    currentResultsRunSlug = currentRunSlug;
    const mobileOnly = document.getElementById('collect-mobile-only').checked;
    if (mobileOnly) {
      const filtered = items.filter(item => isMobileNumber(item.phone));
      renderCollectResults(filtered, true);
      toast(`筛选出 ${filtered.length} 个手机号（已加载 ${items.length} 条）`, 'success');
      window.__filteredResults = filtered;
    } else {
      renderCollectResults(items);
      window.__filteredResults = null;
    }
  } catch (err) {
    const msg = err?.message || String(err);
    showStatus(`加载结果异常: ${msg}`, true);
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
    if (st.mode === 'json-fallback') parts.push('存储已降级为 JSON 备用存储，号码数据可能不完整');
    if (st.quarantine) parts.push('检测到无法读取的数据库文件，已保留：' + st.quarantine);
    else if (st.reason === 'corrupt-open') parts.push('检测到无法读取的数据库文件');
    if (st.dataMayBeIncomplete) parts.push('当前列表可能缺少此前的记录');
    el.textContent = parts.join('；');
    el.style.display = 'block';
  } catch (err) {
    el.style.display = 'none';
  }
}

function renderPagination(containerId, totalPages, currentPage, onPageChange) {
  const container = document.getElementById(containerId);
  if (totalPages <= 1) { container.innerHTML = ''; return; }
  let html = '';
  if (currentPage > 1) html += `<button data-page="${currentPage - 1}">上一页</button>`;
  for (let i = 1; i <= totalPages; i++) {
    if (totalPages > 7 && Math.abs(i - currentPage) > 2 && i !== 1 && i !== totalPages) {
      if (html.slice(-3) !== '...') html += '<span style="color:var(--text-secondary);padding:0 4px;">...</span>';
      continue;
    }
    html += `<button data-page="${i}" class="${i === currentPage ? 'active' : ''}">${i}</button>`;
  }
  if (currentPage < totalPages) html += `<button data-page="${currentPage + 1}">下一页</button>`;
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
      toast(result.error || '获取采集历史失败', 'error');
      return;
    }

    const list = result.data?.list || [];
    if (!list.length && targetPage > 1) {
      return loadHistory(targetPage - 1);
    }
    historyPage = targetPage;

    const tbody = document.getElementById('history-table-body');

    tbody.innerHTML = list.map(item => {
      const startTime = item.started_at ? new Date(item.started_at * 1000).toLocaleString('zh-CN') : '-';
      const statusClass = item.status === 'succeeded' ? 'color:var(--accent)' : item.status === 'failed' ? 'color:var(--danger)' : 'color:var(--warning)';
      const statusText = item.status === 'succeeded' ? '成功' : item.status === 'failed' ? '失败' : item.status === 'running' ? '运行中' : item.status;
      return `<tr>
        <td>${escapeHtml(item.scraper_title || '-')}</td>
        <td style="${statusClass}">${escapeHtml(statusText)}</td>
        <td>${escapeHtml(item.results || 0)}</td>
        <td>${escapeHtml(item.usage || '0')}</td>
        <td>${escapeHtml(item.duration ? item.duration + 's' : '-')}</td>
        <td>${escapeHtml(item.origin || '-')}</td>
        <td>${startTime}</td>
        <td><button class="btn btn-sm" data-slug="${escapeHtml(item.slug)}">查看结果</button></td>
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
      // 切到采集页显示结果
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      document.querySelector('[data-view="collector"]').classList.add('active');
      document.getElementById('view-collector').classList.add('active');
      document.getElementById('page-title').textContent = '关键词采集';
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
      toast(result.error || '获取结果失败', 'error');
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
    apiInput.placeholder = settings.hasApiKey ? '已保存（留空保持不变）' : 'Enter API key';
    taskInput.value = '';
    taskInput.placeholder = settings.hasTaskKey ? '已保存（留空保持不变）' : '如: 01KWA7xxxx';
    document.getElementById('btn-clear-apikey').disabled = !settings.hasApiKey;
    document.getElementById('btn-clear-taskkey').disabled = !settings.hasTaskKey;
    proxyInput.value = settings.proxyUrl || '';
  } catch (err) {
    const msg = err?.message || String(err);
    toast(msg, 'error');
    reportError(msg, { handler: 'loadSettings' });
  }
}

function settingsSaveFeedback(result) {
  if (result && result.success === true) {
    if (result.proxyApplied) {
      return { message: '设置已保存', type: 'success' };
    }
    return { message: '设置已保存，但代理设置未能生效', type: 'info' };
  }
  return { message: '保存设置失败，请检查设置内容', type: 'error' };
}

document.getElementById('btn-save-settings').addEventListener('click', safeAsync(async () => {
    const settings = {
      apiKey: document.getElementById('settings-apikey').value.trim(),
      taskKey: document.getElementById('settings-task-key').value.trim(),
      proxyUrl: document.getElementById('settings-proxy-url').value.trim()
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

document.getElementById('btn-detect-proxy').addEventListener('click', safeAsync(async () => {
    toast('正在检测系统代理...', 'info');
    const result = await window.appAPI.proxy.detect();
    if (result && result.proxyUrl) {
      document.getElementById('settings-proxy-url').value = result.proxyUrl;
      if (result.whatsappReachable === false) {
        toast(`已检测到代理，但 WhatsApp 连通性测试未通过: ${result.proxyUrl} (${result.source})`, 'info');
      } else if (result.whatsappReachable === true) {
        toast(`检测到代理，WhatsApp 连通性测试通过: ${result.proxyUrl} (${result.source})`, 'success');
      } else {
        toast(`检测到代理: ${result.proxyUrl} (${result.source})`, 'success');
      }
    } else {
      toast('未检测到可用代理', 'error');
    }
  }));

document.getElementById('btn-export-logs').addEventListener('click', safeAsync(async () => {
    toast('正在导出日志...', 'info');
    const logs = await window.appAPI.logs.exportLogs();
    if (logs) {
      const blob = new Blob([logs], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `app-logs-${Date.now()}.txt`;
      a.click();
      URL.revokeObjectURL(url);
      toast('日志已导出', 'success');
    } else {
      toast('暂无日志', 'error');
    }
  }));

document.getElementById('btn-test-apikey').addEventListener('click', safeAsync(async () => {
    const apiKey = document.getElementById('settings-apikey').value.trim();
    if (!apiKey) {
      toast('正在测试已保存的 API Key...', 'info');
      const stored = await window.appAPI.provider.testConnection(undefined, undefined, undefined, true);
      if (stored && stored.success && stored.apiKeyValid) {
        toast('API Key 连接成功', 'success');
      } else {
        toast((stored && stored.error) || 'API Key 连接失败', 'error');
      }
      return;
    }
    toast('正在测试 API Key...', 'info');
    const result = await window.appAPI.provider.testConnection(apiKey, '');
    if (result.success && result.apiKeyValid) {
      toast('API Key 连接成功', 'success');
    } else {
      toast('API Key 连接失败', 'error');
    }
  }));

document.getElementById('btn-test-taskkey').addEventListener('click', safeAsync(async () => {
    const apiKey = document.getElementById('settings-apikey').value.trim();
    const taskKey = document.getElementById('settings-task-key').value.trim();
    if (!apiKey && !taskKey) {
      toast('正在测试已保存的任务流 Key...', 'info');
      const stored = await window.appAPI.provider.testConnection(undefined, undefined, undefined, true);
      if (stored && stored.success && stored.taskKeyValid) {
        toast('任务流 Key 验证成功', 'success');
      } else {
        toast((stored && stored.error) || '任务流 Key 验证失败', 'error');
      }
      return;
    }
    if (!apiKey) { toast('请先填写 API Key', 'error'); return; }
    if (!taskKey) { toast('请输入任务流 Key', 'error'); return; }
    toast('正在测试任务流 Key...', 'info');
    const result = await window.appAPI.provider.testConnection(apiKey, taskKey);
    if (result.success && result.taskKeyValid) {
      toast('任务流 Key 验证成功', 'success');
    } else {
      toast('任务流 Key 验证失败', 'error');
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
      showStatus('请先勾选要保存的结果', true);
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
      result = await window.appAPI.collector.addNumbers(numbers);
    } catch (err) {
      showStatus(err?.message || '保存失败', true);
      return;
    }
    showStatus(`已保存 ${result.added || numbers.length} 个号码，跳过 ${result.duplicates || 0} 个重复`);
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
      showStatus('请先勾选要导出的结果', true);
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
  document.querySelectorAll('.number-check').forEach(cb => { cb.checked = e.target.checked; });
});

// === 号码管理 ===
let numbersPage = 1;
let numbersSort = '';
let numbersOrder = 'asc';
let numbersLoadSeq = 0;
let numbersSearchTimer = null;
const NUMBERS_PER_PAGE = 50;
const NUMBERS_SEARCH_DEBOUNCE_MS = 300;

// Sortable columns by th cellIndex (checkbox, Website and Status excluded).
const NUMBERS_SORTABLE_COLUMNS = [
  { index: 1, sort: 'phone', label: 'Phone' },
  { index: 2, sort: 'title', label: 'Title' },
  { index: 4, sort: 'source', label: 'Source' },
  { index: 5, sort: 'keyword', label: 'Keywords' },
  { index: 7, sort: 'collectedAt', label: '采集Time' }
];

function numbersQueryPayload() {
  const query = { limit: NUMBERS_PER_PAGE, offset: (numbersPage - 1) * NUMBERS_PER_PAGE };
  const search = document.getElementById('number-search').value.trim();
  if (search) query.search = search;
  const filterStatus = document.getElementById('number-filter-status').value;
  if (filterStatus !== 'all') query.filters = { status: filterStatus };
  if (numbersSort) {
    query.sort = numbersSort;
    query.order = numbersOrder;
  }
  return query;
}

function updateNumbersSortHeaders() {
  document.querySelectorAll('#view-numbers .data-table thead th').forEach((th) => {
    const col = NUMBERS_SORTABLE_COLUMNS.find((c) => c.index === th.cellIndex);
    if (!col) return;
    th.textContent = numbersSort === col.sort
      ? col.label + (numbersOrder === 'asc' ? ' ▲' : ' ▼')
      : col.label;
  });
}

async function renderNumbers() {
  try {
    const seq = ++numbersLoadSeq;
    const result = await window.appAPI.collector.getNumbers(numbersQueryPayload());
    if (seq !== numbersLoadSeq) return;
    const rows = result && Array.isArray(result.rows) ? result.rows : [];
    const total = result && Number.isInteger(result.total) ? result.total : rows.length;
    const totalPages = Math.ceil(total / NUMBERS_PER_PAGE) || 1;
    if (numbersPage > totalPages) {
      numbersPage = totalPages;
      return renderNumbers();
    }

    const tbody = document.getElementById('numbers-table-body');
    tbody.innerHTML = rows.map(n => `<tr>
    <td><input type="checkbox" class="number-check" data-id="${escapeHtml(n.id)}"></td>
    <td>${escapeHtml(n.phone)}</td>
    <td>${escapeHtml(n.title || '-')}</td>
    <td>${escapeHtml(n.website || '-')}</td>
    <td>${escapeHtml(n.source || '-')}</td>
    <td>${escapeHtml(n.keyword || '-')}</td>
    <td>${escapeHtml(n.status || 'pending')}</td>
    <td>${n.collectedAt ? new Date(n.collectedAt).toLocaleString('zh-CN') : '-'}</td>
  </tr>`).join('');

    renderPagination('numbers-pagination', totalPages, numbersPage, (p) => { numbersPage = p; renderNumbers(); });
    updateNumbersSortHeaders();
  } catch (err) {
    const msg = err?.message || String(err);
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

document.querySelector('#view-numbers .data-table thead').addEventListener('click', safeAsync((e) => {
  const th = e.target.closest('th');
  if (!th) return;
  const col = NUMBERS_SORTABLE_COLUMNS.find((c) => c.index === th.cellIndex);
  if (!col) return;
  if (numbersSort === col.sort) {
    numbersOrder = numbersOrder === 'asc' ? 'desc' : 'asc';
  } else {
    numbersSort = col.sort;
    numbersOrder = 'asc';
  }
  numbersPage = 1;
  renderNumbers();
}));

document.getElementById('btn-delete-selected').addEventListener('click', safeAsync(async () => {
    const ids = [...document.querySelectorAll('.number-check:checked')].map(cb => cb.dataset.id);
    if (!ids.length) return;
    try {
      await window.appAPI.collector.deleteNumbers(ids);
    } catch (err) {
      toast(err?.message || '删除失败', 'error');
      return;
    }
    loadNumbers();
  }));

document.getElementById('btn-export-csv').addEventListener('click', safeAsync(async () => {
    let csv;
    try {
      csv = await window.appAPI.collector.exportNumbers('csv');
    } catch (err) {
      toast(err?.message || '导出失败', 'error');
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
        toast(invalid > 0 ? `文件中没有有效号码（已跳过 ${invalid} 行无效内容）` : '文件中没有有效号码', 'error');
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
        toast(err?.message || '导入失败', 'error');
        return;
      }
      toast(
        `已导入 ${result.added || numbers.length} 个号码，跳过 ${result.duplicates || 0} 个重复` +
          (invalid > 0 ? `，忽略 ${invalid} 行无效` : ''),
        invalid > 0 ? 'info' : 'success'
      );
      loadNumbers();
    }));
    input.click();
  });

// === 视图切换时加载数据 ===
navItems.forEach(item => {
  item.addEventListener('click', () => {
    const viewId = item.dataset.view;
    if (viewId === 'numbers') {
      loadNumbers();
      checkStorageStatus();
    }
    if (viewId === 'history') loadHistory();
  });
});

// 初始化补充
loadNumbers();
checkStorageStatus();
