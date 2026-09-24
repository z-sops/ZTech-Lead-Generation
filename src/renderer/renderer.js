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

// CoreClaw 采集
let currentRunSlug = null;

document.getElementById('btn-start-collect').addEventListener('click', async () => {
  const settings = await window.appAPI.settings.load();
  const apiKey = settings.apiKey;
  const keywords = document.getElementById('collect-keywords').value.trim();
  const region = document.getElementById('collect-region').value.trim();
  const lang = document.getElementById('collect-lang').value;
  const maxResults = parseInt(document.getElementById('collect-max').value) || 20;

  if (!apiKey) {
    showStatus('请先在「设置」中配置 API Key', true);
    return;
  }
  if (!keywords) {
    showStatus('请输入关键词', true);
    return;
  }

  await window.appAPI.coreclaw.setApiKey(apiKey);
  showStatus('正在提交采集任务...');

  const result = await window.appAPI.coreclaw.runGoogleMaps({
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

  if (result.success) {
    currentRunSlug = result.data.run_slug;
    showStatus(`任务已提交，ID: ${currentRunSlug}，等待执行中...`);
    pollRunStatus();
  } else {
    showStatus(`提交失败: ${result.error}`, true);
  }
});

document.getElementById('btn-check-status').addEventListener('click', async () => {
  if (!currentRunSlug) {
    showStatus('没有进行中的任务', true);
    return;
  }
  pollRunStatus();
});

async function pollRunStatus() {
  if (!currentRunSlug) return;

  showStatus(`正在查询任务状态... (${currentRunSlug})`);

  const status = await window.appAPI.coreclaw.getRunStatus(currentRunSlug);

  if (!status.success) {
    showStatus(`查询失败: ${status.error}`, true);
    return;
  }

  const state = status.data?.status || status.data?.state;

  if (state === 'succeeded' || state === 'completed' || state === 'success') {
    showStatus('采集完成，正在获取结果...');
    loadRunResult();
  } else if (state === 'failed' || state === 'error') {
    showStatus(`采集失败: ${status.data?.error || '未知错误'}`, true);
  } else {
    showStatus(`任务状态: ${state}，稍后自动刷新...`);
    setTimeout(pollRunStatus, 5000);
  }
}

async function loadRunResult() {
  const result = await window.appAPI.coreclaw.getRunResult(currentRunSlug);

  if (!result.success) {
    showStatus(`获取结果失败: ${result.error}`, true);
    return;
  }

  const items = result.data?.list || [];
  showStatus(`采集完成，共 ${items.length} 条结果`);
  window.__collectResults = items;
  const mobileOnly = document.getElementById('collect-mobile-only').checked;
  if (mobileOnly) {
    const filtered = items.filter(item => isMobileNumber(item.phone));
    renderCollectResults(filtered, true);
    toast(`筛选出 ${filtered.length} 个手机号（原共 ${items.length} 条）`, 'success');
    window.__filteredResults = filtered;
  } else {
    renderCollectResults(items);
    window.__filteredResults = null;
  }
}

function renderCollectResults(items, preserveOriginal = false) {
  const card = document.getElementById('collect-result-card');
  const tbody = document.getElementById('collect-result-body');
  card.style.display = 'block';

  tbody.innerHTML = items.map((item, i) => `<tr>
    <td><input type="checkbox" data-index="${i}" class="result-check"></td>
    <td>${item.title || ''}</td>
    <td>${item.phone || ''}</td>
    <td>${item.address || ''}</td>
    <td>${item.website ? `<a href="${item.website}" target="_blank">链接</a>` : ''}</td>
    <td>${item.email_1 || item.all_emails || ''}</td>
  </tr>`).join('');

  if (!preserveOriginal) {
    window.__collectResults = items;
  }
  document.getElementById('stat-collected').textContent = items.length;
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
document.getElementById('btn-refresh-history').addEventListener('click', loadHistory);

async function loadHistory() {
  const settings = await window.appAPI.settings.load();
  if (!settings.apiKey) return;
  await window.appAPI.coreclaw.setApiKey(settings.apiKey);

  const result = await window.appAPI.coreclaw.getHistory(20, 0);
  if (!result.success) return;

  const list = result.data?.list || [];
  const tbody = document.getElementById('history-table-body');

  tbody.innerHTML = list.map(item => {
    const startTime = item.started_at ? new Date(item.started_at * 1000).toLocaleString('zh-CN') : '-';
    const statusClass = item.status === 'succeeded' ? 'color:var(--accent)' : item.status === 'failed' ? 'color:var(--danger)' : 'color:var(--warning)';
    const statusText = item.status === 'succeeded' ? '成功' : item.status === 'failed' ? '失败' : item.status === 'running' ? '运行中' : item.status;
    return `<tr>
      <td>${item.scraper_title || '-'}</td>
      <td style="${statusClass}">${statusText}</td>
      <td>${item.results || 0}</td>
      <td>${item.usage || '0'}</td>
      <td>${item.duration ? item.duration + 's' : '-'}</td>
      <td>${item.origin || '-'}</td>
      <td>${startTime}</td>
      <td><button class="btn btn-sm" onclick="viewRunResult('${item.slug}')">查看结果</button></td>
    </tr>`;
  }).join('');
}

window.viewRunResult = async (slug) => {
  const settings = await window.appAPI.settings.load();
  if (!settings.apiKey) return;
  await window.appAPI.coreclaw.setApiKey(settings.apiKey);

  const result = await window.appAPI.coreclaw.getRunResult(slug);
  if (result.success) {
    const items = result.data?.list || [];
    // 切到采集页显示结果
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.querySelector('[data-view="collector"]').classList.add('active');
    document.getElementById('view-collector').classList.add('active');
    document.getElementById('page-title').textContent = '关键词采集';
    window.__collectResults = items;
    const mobileOnly = document.getElementById('collect-mobile-only').checked;
    if (mobileOnly) {
      const filtered = items.filter(item => isMobileNumber(item.phone));
      renderCollectResults(filtered, true);
      window.__filteredResults = filtered;
    } else {
      renderCollectResults(items);
      window.__filteredResults = null;
    }
  }
};

// 初始化
loadSettings();

// 设置管理
async function loadSettings() {
  const settings = await window.appAPI.settings.load();
  if (settings.apiKey) document.getElementById('settings-apikey').value = settings.apiKey;
  if (settings.taskKey) document.getElementById('settings-task-key').value = settings.taskKey;
  if (settings.proxyUrl) document.getElementById('settings-proxy-url').value = settings.proxyUrl;
}

document.getElementById('btn-save-settings').addEventListener('click', async () => {
  const settings = {
    apiKey: document.getElementById('settings-apikey').value.trim(),
    taskKey: document.getElementById('settings-task-key').value.trim(),
    proxyUrl: document.getElementById('settings-proxy-url').value.trim()
  };
  const result = await window.appAPI.settings.save(settings);
  if (result.success) toast('设置已保存', 'success');
});

document.getElementById('btn-detect-proxy').addEventListener('click', async () => {
  toast('正在检测系统代理...', 'info');
  const result = await window.appAPI.proxy.detect();
  if (result.proxyUrl) {
    document.getElementById('settings-proxy-url').value = result.proxyUrl;
    toast(`检测到代理: ${result.proxyUrl} (${result.source})`, 'success');
  } else {
    toast('未检测到可用代理', 'error');
  }
});

document.getElementById('btn-export-logs').addEventListener('click', async () => {
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
});

document.getElementById('btn-test-apikey').addEventListener('click', async () => {
  const apiKey = document.getElementById('settings-apikey').value.trim();
  if (!apiKey) { toast('请输入 API Key', 'error'); return; }
  toast('正在测试 CoreClaw API Key...', 'info');
  const result = await window.appAPI.coreclaw.testConnection(apiKey, '');
  if (result.success && result.apiKeyValid) {
    toast('CoreClaw API Key 连接成功', 'success');
  } else {
    toast('CoreClaw API Key 连接失败', 'error');
  }
});

document.getElementById('btn-test-taskkey').addEventListener('click', async () => {
  const apiKey = document.getElementById('settings-apikey').value.trim();
  const taskKey = document.getElementById('settings-task-key').value.trim();
  if (!apiKey) { toast('请先填写 API Key', 'error'); return; }
  if (!taskKey) { toast('请输入任务流 Key', 'error'); return; }
  toast('正在测试任务流 Key...', 'info');
  const result = await window.appAPI.coreclaw.testConnection(apiKey, taskKey);
  if (result.success && result.taskKeyValid) {
    toast('任务流 Key 验证成功', 'success');
  } else {
    toast('任务流 Key 验证失败', 'error');
  }
});

// === 保存采集结果到号码库 ===
document.getElementById('btn-save-numbers').addEventListener('click', async () => {
  const source = window.__filteredResults || window.__collectResults;
  if (!source || !source.length) return;
  const numbers = source.map((item, i) => ({
    id: `num-${Date.now()}-${i}`,
    phone: item.phone || '',
    source: item.title || '',
    keyword: item.source_keyword || '',
    status: 'pending',
    collectedAt: new Date().toISOString()
  })).filter(n => n.phone);
  const result = await window.appAPI.collector.addNumbers(numbers);
  showStatus(`已保存 ${result.added || numbers.length} 个号码，跳过 ${result.duplicates || 0} 个重复`);
});

// === 采集结果导出 CSV ===
document.getElementById('btn-export-results').addEventListener('click', () => {
  if (!window.__collectResults || !window.__collectResults.length) return;
  const header = 'title,phone,address,website,email\n';
  const rows = window.__collectResults.map(item =>
    `"${item.title || ''}","${item.phone || ''}","${item.address || ''}","${item.website || ''}","${item.email_1 || ''}"`
  ).join('\n');
  const blob = new Blob([header + rows], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `collect-results-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

// === 全选 checkbox ===
document.getElementById('select-all-results').addEventListener('change', (e) => {
  document.querySelectorAll('.result-check').forEach(cb => { cb.checked = e.target.checked; });
});
document.getElementById('select-all-numbers').addEventListener('change', (e) => {
  document.querySelectorAll('.number-check').forEach(cb => { cb.checked = e.target.checked; });
});

// === 号码管理 ===
let allNumbers = [];
let numbersPage = 1;
const NUMBERS_PER_PAGE = 50;

async function loadNumbers() {
  allNumbers = await window.appAPI.collector.getNumbers();
  numbersPage = 1;
  renderNumbers();
}

function renderNumbers() {
  const search = document.getElementById('number-search').value.toLowerCase();
  const filterStatus = document.getElementById('number-filter-status').value;
  let filtered = allNumbers;
  if (search) filtered = filtered.filter(n => n.phone.includes(search));
  if (filterStatus !== 'all') filtered = filtered.filter(n => n.status === filterStatus);

  const totalPages = Math.ceil(filtered.length / NUMBERS_PER_PAGE) || 1;
  if (numbersPage > totalPages) numbersPage = totalPages;
  const start = (numbersPage - 1) * NUMBERS_PER_PAGE;
  const pageData = filtered.slice(start, start + NUMBERS_PER_PAGE);

  const tbody = document.getElementById('numbers-table-body');
  tbody.innerHTML = pageData.map(n => `<tr>
    <td><input type="checkbox" class="number-check" data-id="${n.id}"></td>
    <td>${n.phone}</td>
    <td>${n.source || '-'}</td>
    <td>${n.keyword || '-'}</td>
    <td>${n.status || 'pending'}</td>
    <td>${n.collectedAt ? new Date(n.collectedAt).toLocaleString('zh-CN') : '-'}</td>
  </tr>`).join('');

  renderPagination('numbers-pagination', totalPages, numbersPage, (p) => { numbersPage = p; renderNumbers(); });
}

document.getElementById('number-search').addEventListener('input', renderNumbers);
document.getElementById('number-filter-status').addEventListener('change', renderNumbers);

document.getElementById('btn-delete-selected').addEventListener('click', async () => {
  const ids = [...document.querySelectorAll('.number-check:checked')].map(cb => cb.dataset.id);
  if (!ids.length) return;
  await window.appAPI.collector.deleteNumbers(ids);
  loadNumbers();
});

document.getElementById('btn-export-csv').addEventListener('click', async () => {
  const csv = await window.appAPI.collector.exportNumbers('csv');
  if (csv) {
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `numbers-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }
});

document.getElementById('btn-import-numbers').addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.txt,.csv';
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    const text = await file.text();
    const numbers = text
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line)
      .map((phone, i) => ({
        id: 'num-' + Date.now() + '-' + i,
        phone,
        source: '手动导入',
        keyword: '',
        status: 'pending',
        collectedAt: new Date().toISOString()
      }));
    if (!numbers.length) { toast('文件中没有有效号码', 'error'); return; }
    const result = await window.appAPI.collector.addNumbers(numbers);
    toast(`已导入 ${result.added || numbers.length} 个号码，跳过 ${result.duplicates || 0} 个重复`);
    loadNumbers();
  });
  input.click();
});

// === 视图切换时加载数据 ===
navItems.forEach(item => {
  item.addEventListener('click', () => {
    const viewId = item.dataset.view;
    if (viewId === 'numbers') loadNumbers();
    if (viewId === 'history') loadHistory();
  });
});

// 初始化补充
loadNumbers();
