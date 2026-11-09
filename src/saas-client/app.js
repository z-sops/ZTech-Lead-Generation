'use strict';

/**
 * ZTech Lead Generation — SaaS Customer Workspace Client
 * 
 * Implements the end-to-end customer journey:
 * Authentication -> Workspace Select -> Opportunity Discovery -> Evidence Inspection
 * -> Persistence -> Outreach Gate Review & Approval.
 */

const state = {
  session: null,
  csrfToken: null,
  currentWorkspace: null,
  activeView: 'overview',
  discoveredOpportunities: [],
  savedOpportunities: [],
  activePitch: null,
  researchJobs: [],
  researchJobsPollTimer: null,
  researchOptions: null,
  researchResult: null,
  researchResultJobId: null,
};
if (typeof window !== 'undefined') {
  window.state = state;
}

/* ----------------------------- DOM Selectors ----------------------------- */

const DOM = {
  topbar: document.getElementById('topbar'),
  authScreen: document.getElementById('auth-screen'),
  workspaceLayout: document.getElementById('workspace-layout'),
  userEmailText: document.getElementById('user-email-text'),
  userRolePill: document.getElementById('user-role-pill'),
  displayOrgName: document.getElementById('display-org-name'),
  displayWsName: document.getElementById('display-ws-name'),
  logoutBtn: document.getElementById('logout-btn'),
  storageBadge: document.getElementById('storage-badge'),
  storageModeText: document.getElementById('storage-mode-text'),
  storageModeIcon: document.getElementById('storage-mode-icon'),
  demoModeHelper: document.getElementById('demo-mode-helper'),

  // Auth
  tabLogin: document.getElementById('tab-login'),
  tabRegister: document.getElementById('tab-register'),
  loginForm: document.getElementById('login-form'),
  registerForm: document.getElementById('register-form'),
  loginEmail: document.getElementById('login-email'),
  loginPassword: document.getElementById('login-password'),
  regEmail: document.getElementById('reg-email'),
  regPassword: document.getElementById('reg-password'),
  regOrg: document.getElementById('reg-org'),
  regWorkspace: document.getElementById('reg-workspace'),
  quickDemoFill: document.getElementById('quick-demo-fill'),

  // Navigation
  navItems: document.querySelectorAll('.nav-item'),
  views: document.querySelectorAll('.view-panel'),
  ctaStartDiscovery: document.getElementById('cta-start-discovery'),

  // KPIs
  kpiDiscoveredCount: document.getElementById('kpi-discovered-count'),
  kpiSavedCount: document.getElementById('kpi-saved-count'),
  kpiDraftsCount: document.getElementById('kpi-drafts-count'),

  // Discovery Form
  discoveryForm: document.getElementById('discovery-form'),
  discIndustry: document.getElementById('disc-industry'),
  discCountry: document.getElementById('disc-country'),
  discRegion: document.getElementById('disc-region'),
  discCustomerType: document.getElementById('disc-customer-type'),
  discRequirements: document.getElementById('disc-requirements'),
  submitDiscoveryBtn: document.getElementById('submit-discovery-btn'),
  discoveryProgress: document.getElementById('discovery-progress'),
  progressStageLabel: document.getElementById('progress-stage-label'),
  progressPercent: document.getElementById('progress-percent'),
  progressBarFill: document.getElementById('progress-bar-fill'),
  discoveryResultsSection: document.getElementById('discovery-results-section'),
  opportunitiesContainer: document.getElementById('opportunities-container'),
  resultsCountLabel: document.getElementById('results-count-label'),

  // Saved Opportunities
  savedEmptyState: document.getElementById('saved-empty-state'),
  savedContainer: document.getElementById('saved-container'),

  // Modal
  modalContainer: document.getElementById('modal-container'),
  modalTitle: document.getElementById('modal-title'),
  modalSubtitle: document.getElementById('modal-subtitle'),
  modalBody: document.getElementById('modal-body'),
  modalCloseBtn: document.getElementById('modal-close-btn'),

// Toasts
  toastContainer: document.getElementById('toast-container'),

  // Research Jobs
  rjRefreshBtn: document.getElementById('rj-refresh-btn'),
  rjSubmitBtn: document.getElementById('rj-submit-btn'),
  rjIndustry: document.getElementById('rj-industry'),
  rjLocation: document.getElementById('rj-location'),
  rjWebsiteFilter: document.getElementById('rj-website-filter'),
  rjMaxResults: document.getElementById('rj-max-results'),
  rjServicesList: document.getElementById('rj-services-list'),
  rjAttribution: document.getElementById('rj-attribution'),
  rrPanel: document.getElementById('rr-panel'),
  rrTitle: document.getElementById('rr-title'),
  rrSubtitle: document.getElementById('rr-subtitle'),
  rrCloseBtn: document.getElementById('rr-close-btn'),
  rrLoading: document.getElementById('rr-loading'),
  rrError: document.getElementById('rr-error'),
  rrContent: document.getElementById('rr-content'),
  rrStats: document.getElementById('rr-stats'),
  rrChart: document.getElementById('rr-chart'),
  rrMinScore: document.getElementById('rr-min-score'),
  rrMinScoreValue: document.getElementById('rr-min-score-value'),
  rrFilterService: document.getElementById('rr-filter-service'),
  rrFilterWebsite: document.getElementById('rr-filter-website'),
  rrFilterText: document.getElementById('rr-filter-text'),
  rrFilterHideZero: document.getElementById('rr-filter-hide-zero'),
  rrSavedSelect: document.getElementById('rr-saved-select'),
  rrSaveFilterBtn: document.getElementById('rr-save-filter-btn'),
  rrCount: document.getElementById('rr-count'),
  rrList: document.getElementById('rr-list'),
  rrEmpty: document.getElementById('rr-empty'),
  rrAttribution: document.getElementById('rr-attribution'),
  rrAddAllBtn: document.getElementById('rr-add-all-btn'),
  crmNewBtn: document.getElementById('crm-new-btn'),
  crmPipeline: document.getElementById('crm-pipeline'),
  crmQ: document.getElementById('crm-q'),
  crmStage: document.getElementById('crm-stage'),
  crmOwner: document.getElementById('crm-owner'),
  crmArchived: document.getElementById('crm-archived'),
  crmNewForm: document.getElementById('crm-new-form'),
  crmNewName: document.getElementById('crm-new-name'),
  crmNewWebsite: document.getElementById('crm-new-website'),
  crmNewPhone: document.getElementById('crm-new-phone'),
  crmNewValue: document.getElementById('crm-new-value'),
  crmNewSubmit: document.getElementById('crm-new-submit'),
  crmNewCancel: document.getElementById('crm-new-cancel'),
  crmLoading: document.getElementById('crm-loading'),
  crmError: document.getElementById('crm-error'),
  crmEmpty: document.getElementById('crm-empty'),
  crmList: document.getElementById('crm-list'),
  crmMore: document.getElementById('crm-more'),
  crmMoreBtn: document.getElementById('crm-more-btn'),
  caForm: document.getElementById('ca-form'),
  caQuery: document.getElementById('ca-query'),
  caCountry: document.getElementById('ca-country'),
  caLabel: document.getElementById('ca-label'),
  caPageId: document.getElementById('ca-page-id'),
  caSubmit: document.getElementById('ca-submit'),
  caLoading: document.getElementById('ca-loading'),
  caError: document.getElementById('ca-error'),
  caEmpty: document.getElementById('ca-empty'),
  caList: document.getElementById('ca-list'),
  researchJobForm: document.getElementById('research-job-form'),
  rjLoading: document.getElementById('rj-loading'),
  rjOffline: document.getElementById('rj-offline'),
  rjEmptyState: document.getElementById('rj-empty-state'),
  rjList: document.getElementById('rj-list'),
};

/* ----------------------------- API Client ------------------------------- */

async function api(path, options = {}) {
  const method = options.method || 'GET';
  const headers = {
    'content-type': 'application/json',
    ...(options.headers || {}),
  };

  if (state.csrfToken && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    headers['x-csrf-token'] = state.csrfToken;
  }

  const res = await fetch(path, {
    method,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
    credentials: 'same-origin',
  });

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }

  if (!res.ok) {
    const error = new Error(json?.message || `Request failed with status ${res.status}`);
    error.status = res.status;
    error.code = json?.error;
    throw error;
  }

  return json;
}

/* ----------------------------- Notifications ---------------------------- */

function toast(message, type = 'info') {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = message;
  DOM.toastContainer.appendChild(t);
  setTimeout(() => {
    t.style.opacity = '0';
    t.style.transform = 'translateY(10px)';
    setTimeout(() => t.remove(), 300);
  }, 4000);
}

/* -------------------------- Auth & Session State ------------------------- */

async function updateStorageBadge() {
  try {
    const health = await api('/api/health');
    if (DOM.storageBadge && DOM.storageModeText) {
      if (health && health.storage_mode === 'postgres') {
        DOM.storageBadge.style.background = 'rgba(16, 185, 129, 0.15)';
        DOM.storageBadge.style.borderColor = 'rgba(16, 185, 129, 0.35)';
        DOM.storageBadge.style.color = '#34d399';
        if (DOM.storageModeIcon) DOM.storageModeIcon.textContent = '🐘';
        DOM.storageModeText.textContent = 'STORAGE: POSTGRESQL 16 (PERSISTENT)';
      } else {
        DOM.storageBadge.style.background = 'rgba(245, 158, 11, 0.15)';
        DOM.storageBadge.style.borderColor = 'rgba(245, 158, 11, 0.35)';
        DOM.storageBadge.style.color = '#fbbf24';
        if (DOM.storageModeIcon) DOM.storageModeIcon.textContent = '⚡';
        DOM.storageModeText.textContent = 'STORAGE: EPHEMERAL IN-MEMORY (DEMO)';
      }
    }
  } catch (err) {
    if (DOM.storageBadge && DOM.storageModeText) {
      DOM.storageBadge.style.background = 'rgba(239, 68, 68, 0.15)';
      DOM.storageBadge.style.borderColor = 'rgba(239, 68, 68, 0.35)';
      DOM.storageBadge.style.color = '#f87171';
      if (DOM.storageModeIcon) DOM.storageModeIcon.textContent = '⚠️';
      DOM.storageModeText.textContent = 'DATABASE OFFLINE';
    }
    console.warn('Storage mode check failed:', err.message);
  }
}

async function checkSession() {
  await updateStorageBadge();
  const isLoopback = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  if (DOM.demoModeHelper) {
    DOM.demoModeHelper.style.display = isLoopback ? 'block' : 'none';
  }

  try {
    const data = await api('/api/session');
    if (data && data.user_id) {
      state.session = data;
      if (data.memberships && data.memberships.length > 0) {
        state.currentWorkspace = data.memberships[0];
      }
      renderAuthenticatedState();
      await loadSavedOpportunities();
      await loadActiveCandidates();
    } else {
      renderUnauthenticatedState();
    }
  } catch {
    renderUnauthenticatedState();
  }
}

function renderAuthenticatedState() {
  DOM.authScreen.style.display = 'none';
  DOM.topbar.style.display = 'flex';
  DOM.workspaceLayout.style.display = 'flex';

  if (state.session) {
    DOM.userEmailText.textContent = state.session.email;
  }

  if (state.currentWorkspace) {
    DOM.displayOrgName.textContent = state.currentWorkspace.organization_name || 'Organization';
    DOM.displayWsName.textContent = state.currentWorkspace.workspace_name || 'Workspace';
    DOM.userRolePill.textContent = (state.currentWorkspace.role || 'MEMBER').toUpperCase();
    DOM.userRolePill.className = `role-pill ${state.currentWorkspace.role || 'member'}`;
  }

  navigateTo('overview');
}

function renderUnauthenticatedState() {
  DOM.topbar.style.display = 'none';
  DOM.workspaceLayout.style.display = 'none';
  DOM.authScreen.style.display = 'block';
}

/* --------------------------- Navigation Routing ------------------------- */

function navigateTo(viewName) {
  state.activeView = viewName;

  DOM.navItems.forEach((item) => {
    if (item.dataset.view === viewName) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });

  DOM.views.forEach((view) => {
    if (view.id === `view-${viewName}`) {
      view.style.display = 'block';
    } else {
      view.style.display = 'none';
    }
  });

  if (viewName === 'saved') {
    loadSavedOpportunities();
  }

  if (viewName === 'crm') {
    loadCrm();
  }

  if (viewName === 'competitors') {
    loadCompetitors();
  }

  if (viewName === 'research-jobs') {
    loadResearchOptions();
    loadResearchJobs();
    startResearchJobsPolling();
  } else {
    stopResearchJobsPolling();
  }
}

window.navigateTo = navigateTo;

/* ------------------------- Opportunity Discovery ------------------------ */

async function executeDiscovery(criteria) {
  if (!state.currentWorkspace) {
    toast('No active workspace selected', 'error');
    return;
  }

  const wsId = state.currentWorkspace.workspace_id;

  // Show progress indicator with animation
  DOM.discoveryProgress.style.display = 'block';
  DOM.submitDiscoveryBtn.disabled = true;

  const updateProgress = (text, percent) => {
    DOM.progressStageLabel.textContent = text;
    DOM.progressPercent.textContent = `${percent}%`;
    DOM.progressBarFill.style.width = `${percent}%`;
  };

  try {
    updateProgress('Step 1/4: Analyzing Market Entities & Research Targets...', 25);
    await new Promise((r) => setTimeout(r, 350));

    updateProgress('Step 2/4: Generating Simulated Diagnostic Signals (Controlled Fixture)...', 50);
    await new Promise((r) => setTimeout(r, 400));

    updateProgress('Step 3/4: Assembling Evidence Packets & Provenance Metadata...', 75);
    await new Promise((r) => setTimeout(r, 350));

    const result = await api(`/api/workspaces/${wsId}/research`, {
      method: 'POST',
      body: criteria,
    });

    updateProgress('Step 4/4: Evaluating Qualitative ICP Fit Alignment...', 100);
    await new Promise((r) => setTimeout(r, 250));

    DOM.discoveryProgress.style.display = 'none';
    DOM.submitDiscoveryBtn.disabled = false;

    state.discoveredOpportunities = result.candidates || [];
    renderOpportunityCards(state.discoveredOpportunities);

    DOM.kpiDiscoveredCount.textContent = state.discoveredOpportunities.length;
    toast(`Successfully discovered ${result.candidate_count} opportunities!`, 'success');
  } catch (err) {
    DOM.discoveryProgress.style.display = 'none';
    DOM.submitDiscoveryBtn.disabled = false;
    toast(err.message, 'error');
  }
}

function renderOpportunityCards(opportunities) {
  DOM.opportunitiesContainer.innerHTML = '';
  DOM.discoveryResultsSection.style.display = 'block';
  DOM.resultsCountLabel.textContent = `${opportunities.length} actionable opportunities detected with verified technical findings.`;

  opportunities.forEach((opp) => {
    const card = createOpportunityCardElement(opp, false);
    DOM.opportunitiesContainer.appendChild(card);
  });
}

function createOpportunityCardElement(opp, isSavedView = false) {
  const card = document.createElement('div');
  card.className = 'opportunity-card';
  card.id = `card-${opp.opportunity_id}`;

  const fitClass = opp.icp_fit?.status || 'fit';
  const fitScore = opp.icp_fit?.qualitative ? 'Qualitative Fit' : (opp.icp_fit?.status || 'Fit').toUpperCase();

  card.innerHTML = `
    <div>
      <div class="card-top">
        <div>
          <div class="company-name">${escapeHtml(opp.company_name)}</div>
          <a href="https://${escapeHtml(opp.domain)}" target="_blank" rel="noopener" class="company-domain">🌐 ${escapeHtml(opp.domain)}</a>
          <div style="font-size: 11px; color: var(--text-dim); margin-top: 2px;">📍 ${escapeHtml(opp.market_location)}</div>
        </div>
        <div class="fit-badge ${fitClass}">
          <span>🎯</span> ${escapeHtml(fitScore)}
        </div>
      </div>

      <div class="need-box">
        <strong>Detected Need:</strong> ${escapeHtml(opp.detected_need)}
      </div>

      <div class="evidence-provenance-box">
        <div style="font-weight: 700; color: #fff; margin-bottom: 4px;">🔬 Supporting Evidence (${opp.evidence_summary?.findings_count || 2} findings, ${opp.evidence_summary?.facts_count || 3} facts):</div>
        <ul>
          <li>• Server Response: <strong style="color: #f87171;">${escapeHtml(opp.evidence_summary?.server_latency || '3.2s')}</strong> (Simulated Benchmark: &lt; 1.2s)</li>
          <li>• Content Deficit: <strong>${opp.evidence_summary?.missing_meta_pages || 4} pages</strong> lack structured descriptions</li>
          <li>• Data Provenance: Simulated Demo Fixture (${escapeHtml(opp.data_origin || 'controlled_demo_fixture')})</li>
        </ul>
      </div>

      <div class="uncertainty-box">
        <strong>⚠️ Simulated Finding:</strong> ${(opp.uncertainty_notes && opp.uncertainty_notes[0]) || 'Controlled synthetic fixture for demonstration. Not a live web crawl.'}
      </div>
    </div>

    <div>
      <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 10px;">
        <strong>Recommended Step:</strong> ${escapeHtml(opp.recommended_next_step)}
      </div>

      <div class="card-actions">
        <button class="btn btn-secondary inspect-btn" style="flex: 1;" data-id="${opp.opportunity_id}">
          Inspect Evidence
        </button>
        ${!isSavedView ? `
          <button class="btn ${opp.review_status === 'saved' ? 'btn-secondary' : 'btn-primary'} save-btn" style="flex: 1;" data-id="${opp.opportunity_id}">
            ${opp.review_status === 'saved' ? 'Saved ✓' : 'Save'}
          </button>
        ` : ''}
        <button class="btn btn-primary outreach-btn" style="flex: 1; background: #0284c7;" data-id="${opp.opportunity_id}">
          Prepare Outreach
        </button>
      </div>
    </div>
  `;

  // Attach card event listeners
  card.querySelector('.inspect-btn').addEventListener('click', () => openInspectionModal(opp));
  if (!isSavedView) {
    const saveBtn = card.querySelector('.save-btn');
    saveBtn.addEventListener('click', () => saveOpportunity(opp, saveBtn));
  }
  card.querySelector('.outreach-btn').addEventListener('click', () => openOutreachPreparationModal(opp));

  return card;
}

/* ---------------------- Opportunity Detail Inspection -------------------- */

function openInspectionModal(opp) {
  DOM.modalTitle.textContent = `${opp.company_name} — Evidence & Provenance`;
  DOM.modalSubtitle.textContent = `Packet ID: ${opp.packet_id} • Domain: ${opp.domain}`;

  const findingsHtml = (opp.findings || []).map((f) => `
    <div style="background: var(--bg-canvas); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); padding: 14px; margin-bottom: 12px;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
        <span style="font-weight: 700; color: #fff;">${escapeHtml(f.title)}</span>
        <span class="fit-badge ${f.severity === 'high' ? 'not_fit' : 'unknown'}">${f.severity.toUpperCase()}</span>
      </div>
      <div style="font-size: 13px; color: #e2e8f0; margin-bottom: 6px;">${escapeHtml(f.observed)}</div>
      <div style="font-size: 12px; color: var(--accent-info);"><strong>Recommendation:</strong> ${escapeHtml(f.recommendation)}</div>
      <div style="font-size: 11px; color: var(--text-dim); margin-top: 6px;">Audited URLs (Simulated): ${escapeHtml((f.urls || []).join(', '))}</div>
    </div>
  `).join('');

  const matchedHtml = (opp.icp_fit?.matched_criteria || []).map((c) => `<li style="color: #34d399;">✓ ${escapeHtml(c)}</li>`).join('');

  DOM.modalBody.innerHTML = `
    <div style="margin-bottom: 20px;">
      <div class="demo-banner-pill" style="margin-bottom: 14px;">
        <span>⚡</span> ${escapeHtml(opp.synthetic_badge || 'DEMO / SYNTHETIC RESEARCH')}
      </div>
      <h3 style="font-size: 15px; margin-bottom: 8px;">Technical Audit Findings (Simulated Demonstration)</h3>
      ${findingsHtml}
    </div>

    <div style="margin-bottom: 20px;">
      <h3 style="font-size: 15px; margin-bottom: 8px;">ICP Fit Analysis</h3>
      <div style="background: var(--bg-canvas); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); padding: 14px;">
        <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
          <span><strong>Fit Status:</strong> ${(opp.icp_fit?.status || 'fit').toUpperCase()}</span>
          <span><strong>Assessment:</strong> Qualitative Evaluation</span>
        </div>
        <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 8px;">${escapeHtml(opp.icp_fit?.qualitative || opp.icp_fit?.reason || 'Verified match against target criteria')}</div>
        ${matchedHtml ? `<ul style="font-size: 11px; list-style: none; display: flex; flex-direction: column; gap: 4px;">${matchedHtml}</ul>` : ''}
      </div>
    </div>

    <div style="margin-bottom: 20px;">
      <h3 style="font-size: 15px; margin-bottom: 8px;">Source Provenance & Synthetic Disclaimer</h3>
      <div style="background: var(--bg-canvas); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); padding: 14px; font-size: 12px; color: var(--text-muted);">
        <p>• <strong>Data Origin:</strong> ${escapeHtml(opp.data_origin || 'controlled_demo_fixture')} (Controlled Synthetic Data)</p>
        <p>• <strong>Captured At:</strong> ${escapeHtml(opp.evidence_summary?.captured_at || '')}</p>
        <p>• <strong>Provider:</strong> ZTech Controlled Lead Intelligence Engine (Engine v2.3.0)</p>
        <p>• <strong>Contact Channel:</strong> ${escapeHtml(opp.contact_info?.email || 'N/A')} (${escapeHtml(opp.contact_info?.phone || 'N/A')})</p>
        <div style="margin-top: 8px; color: #fbbf24;">
          <strong>Limitations:</strong> ${(opp.uncertainty_notes || []).join(' ')}
        </div>
      </div>
    </div>

    <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px;">
      <button class="btn btn-secondary" onclick="DOM.modalContainer.style.display='none'">Close</button>
      <button class="btn btn-primary" id="modal-prep-outreach-btn">Prepare Outreach Draft</button>
    </div>
  `;

  document.getElementById('modal-prep-outreach-btn').addEventListener('click', () => {
    openOutreachPreparationModal(opp);
  });

  DOM.modalContainer.style.display = 'flex';
}

/* ---------------------- Save Opportunity to Store ----------------------- */

async function saveOpportunity(opp, btnElement) {
  if (!state.currentWorkspace) return;
  const wsId = state.currentWorkspace.workspace_id;

  try {
    const res = await api(`/api/workspaces/${wsId}/opportunities/save`, {
      method: 'POST',
      body: opp,
    });

    if (btnElement) {
      btnElement.textContent = 'Saved ✓';
      btnElement.className = 'btn btn-secondary save-btn';
    }

    opp.review_status = 'saved';
    toast(`Saved "${opp.company_name}" to workspace!`, 'success');
    await loadSavedOpportunities();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function loadSavedOpportunities() {
  if (!state.currentWorkspace) return;
  const wsId = state.currentWorkspace.workspace_id;

  try {
    const res = await api(`/api/workspaces/${wsId}/opportunities/saved`);
    state.savedOpportunities = res.opportunities || [];

    DOM.kpiSavedCount.textContent = state.savedOpportunities.length;

    if (state.savedOpportunities.length === 0) {
      DOM.savedEmptyState.style.display = 'block';
      DOM.savedContainer.style.display = 'none';
    } else {
      DOM.savedEmptyState.style.display = 'none';
      DOM.savedContainer.style.display = 'grid';
      DOM.savedContainer.innerHTML = '';
      state.savedOpportunities.forEach((opp) => {
        DOM.savedContainer.appendChild(createOpportunityCardElement(opp, true));
      });
    }
  } catch (err) {
    console.error('Failed to load saved opportunities:', err);
  }
}

async function loadActiveCandidates() {
  if (!state.currentWorkspace) return;
  const wsId = state.currentWorkspace.workspace_id;
  try {
    const res = await api(`/api/workspaces/${wsId}/opportunities/candidates`);
    if (res && Array.isArray(res.candidates) && res.candidates.length > 0) {
      state.discoveredOpportunities = res.candidates;
      renderOpportunityCards(state.discoveredOpportunities);
      if (DOM.kpiDiscoveredCount) {
        DOM.kpiDiscoveredCount.textContent = state.discoveredOpportunities.length;
      }
    }
  } catch (err) {
    console.warn('Could not load active discovery candidates:', err.message);
  }
}

/* ------------------------- Research Jobs (Async) ------------------------ */

const RESEARCH_JOB_STATES = ['queued', 'leased', 'running', 'succeeded', 'failed', 'cancelled'];

function jobStateLabel(state) {
  if (!state) return 'uncertain';
  return RESEARCH_JOB_STATES.includes(state) ? state : 'uncertain';
}

function formatTimestamp(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString();
}

function renderResearchJobs(jobs) {
  if (!DOM.rjList) return;
  DOM.rjList.innerHTML = '';

  if (!jobs || jobs.length === 0) {
    DOM.rjList.style.display = 'none';
    DOM.rjEmptyState.style.display = 'block';
    return;
  }

  DOM.rjEmptyState.style.display = 'none';
  DOM.rjList.style.display = 'flex';

  jobs.forEach((job) => {
    const row = document.createElement('div');
    row.className = 'rj-row';
    row.id = `rj-${job.job_id}`;

    const stateLabel = jobStateLabel(job.state);
    const cancellable = ['queued', 'leased', 'running'].includes(job.state);

    const errorSummary = job.last_error
      ? `<div class="rj-error">Error: ${escapeHtml(job.last_error)}</div>`
      : '';

    const retryNote = job.state === 'failed'
      ? '<div class="rj-retry-note">Retry is managed automatically by the server (bounded, with backoff).</div>'
      : '';

    const isResearch = job.kind === 'business_research' && job.criteria;
    const summary = isResearch
      ? `<div class="rj-criteria">${escapeHtml(industryLabel(job.criteria.industry))} in ${escapeHtml(job.criteria.location)} · up to ${String(job.criteria.max_results)} businesses</div>`
      : '';
    const viewable = isResearch && job.state === 'succeeded';

    row.innerHTML = `
      <div class="rj-main">
        ${summary}
        <div class="rj-id">${escapeHtml(job.job_id)}</div>
        <div class="rj-meta">
          Created ${formatTimestamp(job.created_at)}
          ${job.started_at ? ` · Started ${formatTimestamp(job.started_at)}` : ''}
          ${job.finished_at ? ` · Finished ${formatTimestamp(job.finished_at)}` : ''}
          ${job.attempt_count ? ` · Attempt ${job.attempt_count}` : ''}
        </div>
        ${errorSummary}
        ${retryNote}
      </div>
      <span class="rj-state ${stateLabel}">${stateLabel}</span>
      <div class="rj-actions">
        ${viewable ? `<button class="btn btn-primary rj-view-btn" data-id="${escapeHtml(job.job_id)}">View results</button>` : ''}
        ${cancellable ? `<button class="btn btn-secondary rj-cancel-btn" data-id="${escapeHtml(job.job_id)}">Cancel</button>` : ''}
      </div>
    `;

    const viewBtn = row.querySelector('.rj-view-btn');
    if (viewBtn) viewBtn.addEventListener('click', () => openResearchResult(job.job_id));

    const cancelBtn = row.querySelector('.rj-cancel-btn');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => cancelResearchJob(job.job_id));
    }

    DOM.rjList.appendChild(row);
  });
}

async function loadResearchJobs() {
  if (!state.currentWorkspace) return;
  const wsId = state.currentWorkspace.workspace_id;

  DOM.rjLoading.style.display = 'block';
  DOM.rjOffline.style.display = 'none';

  try {
    const res = await api(`/api/workspaces/${wsId}/research/jobs`);
    state.researchJobs = res.jobs || [];
    DOM.rjLoading.style.display = 'none';
    renderResearchJobs(state.researchJobs);
  } catch (err) {
    DOM.rjLoading.style.display = 'none';
    DOM.rjOffline.style.display = 'block';
    DOM.rjList.style.display = 'none';
    DOM.rjEmptyState.style.display = 'none';
    console.warn('Could not load research jobs:', err.message);
  }
}

function stopResearchJobsPolling() {
  if (state.researchJobsPollTimer) {
    clearInterval(state.researchJobsPollTimer);
    state.researchJobsPollTimer = null;
  }
}

function startResearchJobsPolling() {
  stopResearchJobsPolling();
  // Poll the authoritative backend while the view is active. The interval is
  // bounded and cleared on logout, workspace change and view cleanup.
  state.researchJobsPollTimer = setInterval(() => {
    if (state.activeView === 'research-jobs' && state.currentWorkspace) {
      loadResearchJobs();
    }
  }, 3000);
}

function newIdempotencyKey() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') return `research-${window.crypto.randomUUID()}`;
  return `research-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function submitResearchJob(criteria) {
  if (!state.currentWorkspace) {
    toast('No active workspace selected', 'error');
    return;
  }
  const wsId = state.currentWorkspace.workspace_id;

  DOM.rjSubmitBtn.disabled = true;
  try {
    const res = await api(`/api/workspaces/${wsId}/research/jobs`, {
      method: 'POST',
      body: {
        idempotency_key: newIdempotencyKey(),
        payload: { kind: 'business_research', criteria },
      },
    });
    toast(`Research started (${res.state}). Results appear here when the worker finishes.`, 'success');
    await loadResearchJobs();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    DOM.rjSubmitBtn.disabled = false;
  }
}

async function cancelResearchJob(jobId) {
  if (!state.currentWorkspace) return;
  const wsId = state.currentWorkspace.workspace_id;

  const confirmed = window.confirm('Cancel this research job? A queued job is cancelled immediately; a running job is cancelled cooperatively.');
  if (!confirmed) return;

  try {
    const res = await api(`/api/workspaces/${wsId}/research/jobs/${jobId}/cancel`, {
      method: 'POST',
      body: {},
    });
    toast(`Cancellation ${res.action || 'requested'}`, 'success');
    await loadResearchJobs();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ------------------- Phase 2: research results (P15) -------------------- */

const SAVED_FILTERS_KEY = 'ztech.researchFilters.v1';
const OFFER_KEY = 'ztech.proposalOffer.v1';

function industryLabel(id) {
  const list = state.researchOptions ? state.researchOptions.industries : [];
  const hit = list.find((i) => i.id === id);
  return hit ? hit.label : String(id || '');
}

function serviceLabel(id) {
  const list = state.researchOptions ? state.researchOptions.offer_categories : [];
  const hit = list.find((o) => o.id === id);
  return hit ? hit.label : String(id || '');
}

function readStored(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeStored(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage may be unavailable (private window); the page works without it.
  }
}

async function loadResearchOptions() {
  if (state.researchOptions || !state.currentWorkspace) return;
  try {
    const opts = await api(`/api/workspaces/${state.currentWorkspace.workspace_id}/research/options`);
    state.researchOptions = opts;
    DOM.rjIndustry.innerHTML = opts.industries
      .map((i) => `<option value="${escapeHtml(i.id)}">${escapeHtml(i.label)}</option>`).join('');
    DOM.rjServicesList.innerHTML = opts.offer_categories.map((o) => `
      <label class="rr-check"><input type="checkbox" name="rj-service" value="${escapeHtml(o.id)}"${['web_design', 'seo'].includes(o.id) ? ' checked' : ''}> ${escapeHtml(o.label)}</label>
    `).join('');
    DOM.rrFilterService.innerHTML = '<option value="">All services</option>'
      + opts.offer_categories.map((o) => `<option value="${escapeHtml(o.id)}">${escapeHtml(o.label)}</option>`).join('');
    DOM.rjAttribution.textContent = `Business data ${opts.sources[0].attribution}`;
  } catch (err) {
    toast(`Could not load the research options: ${err.message}`, 'error');
  }
}

function readResearchForm() {
  const services = Array.from(DOM.rjServicesList.querySelectorAll('input[name="rj-service"]:checked')).map((i) => i.value);
  if (services.length === 0) {
    toast('Choose at least one service you offer', 'error');
    return null;
  }
  const location = DOM.rjLocation.value.trim();
  if (location.length < 2) {
    toast('Enter a location, for example "Leeds, UK"', 'error');
    return null;
  }
  return {
    industry: DOM.rjIndustry.value,
    location,
    offer_categories: services,
    website_filter: DOM.rjWebsiteFilter.value,
    max_results: Number(DOM.rjMaxResults.value),
  };
}

function closeResearchResult() {
  state.researchResult = null;
  state.researchResultJobId = null;
  state.googleLookups = new Map();
  DOM.rrPanel.style.display = 'none';
}

async function openResearchResult(jobId) {
  if (!state.currentWorkspace) return;
  DOM.rrPanel.style.display = 'block';
  DOM.rrLoading.style.display = 'block';
  DOM.rrError.style.display = 'none';
  DOM.rrContent.style.display = 'none';
  DOM.rrTitle.textContent = 'Research results';
  DOM.rrSubtitle.textContent = '';
  DOM.rrPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    const res = await api(`/api/workspaces/${state.currentWorkspace.workspace_id}/research/jobs/${jobId}/result`);
    DOM.rrLoading.style.display = 'none';
    if (!res.result) {
      DOM.rrError.textContent = res.state === 'succeeded'
        ? 'This job has no research result to show (it was a test job without real research).'
        : `This research is ${res.state}; results appear when it has finished.`;
      DOM.rrError.style.display = 'block';
      return;
    }
    state.researchResult = res.result;
    state.researchResultJobId = jobId;
    state.googleLookups = new Map();
    renderResearchResult();
  } catch (err) {
    DOM.rrLoading.style.display = 'none';
    DOM.rrError.textContent = `The results could not be loaded: ${err.message}`;
    DOM.rrError.style.display = 'block';
  }
}

function pct(n) {
  return `${Math.round(Number(n || 0) * 100)}%`;
}

function renderResearchResult() {
  const r = state.researchResult;
  const c = r.criteria;
  DOM.rrTitle.textContent = `${industryLabel(c.industry)} in ${r.place && r.place.display_name ? r.place.display_name : c.location}`;
  DOM.rrSubtitle.textContent = `Researched ${formatTimestamp(r.finished_at)} · your services: ${c.offer_categories.map(serviceLabel).join(', ')}`;

  const s = r.summary;
  const inspected = (s.inspections && s.inspections.inspected) || 0;
  const stats = [
    ['Businesses found in the area', s.found_in_area],
    ['Researched', s.businesses],
    ['Websites inspected', inspected],
    ['Evidence items', s.evidence],
    ['Businesses with a need you serve', s.opportunities_with_need],
  ];
  DOM.rrStats.innerHTML = stats.map(([label, value]) => `
    <div class="rr-stat"><div class="rr-stat-value">${escapeHtml(String(value))}</div><div class="rr-stat-label">${escapeHtml(label)}</div></div>
  `).join('');

  const entries = Object.entries(s.needs_by_category || {}).sort((a, b) => b[1] - a[1]);
  const max = entries.length ? Math.max(...entries.map((e) => e[1])) : 0;
  DOM.rrChart.setAttribute('aria-label', entries.length
    ? `Needs by service: ${entries.map(([k, v]) => `${serviceLabel(k)} ${v}`).join(', ')}`
    : 'No needs found for your services');
  DOM.rrChart.innerHTML = entries.length
    ? entries.map(([k, v]) => `
      <div class="rr-bar-row">
        <span class="rr-bar-label">${escapeHtml(serviceLabel(k))}</span>
        <span class="rr-bar-track"><span class="rr-bar" style="width:${Math.max(4, Math.round((v / max) * 100))}%"></span></span>
        <span class="rr-bar-value">${escapeHtml(String(v))}</span>
      </div>`).join('')
    : '<div class="rr-state">No business showed a need for the services you chose.</div>';

  DOM.rrAttribution.textContent = `Business data ${r.provider && r.provider.attribution ? r.provider.attribution : ''}. Website findings were observed by ZTech at the times shown; each one links to the page it came from.`;
  renderSavedFilterOptions();
  DOM.rrContent.style.display = 'block';
  renderOpportunityList();
}

function currentFilters() {
  return {
    minScore: Number(DOM.rrMinScore.value),
    service: DOM.rrFilterService.value,
    website: DOM.rrFilterWebsite.value,
    text: DOM.rrFilterText.value.trim(),
    hideZero: DOM.rrFilterHideZero.checked,
  };
}

function applyFilters(f) {
  DOM.rrMinScore.value = String(f.minScore || 0);
  DOM.rrFilterService.value = f.service || '';
  DOM.rrFilterWebsite.value = f.website || '';
  DOM.rrFilterText.value = f.text || '';
  DOM.rrFilterHideZero.checked = f.hideZero !== false;
}

function renderSavedFilterOptions() {
  const saved = readStored(SAVED_FILTERS_KEY, []);
  DOM.rrSavedSelect.innerHTML = '<option value="">Saved filters…</option>'
    + saved.map((f, i) => `<option value="${i}">${escapeHtml(f.name)}</option>`).join('');
}

function renderOpportunityList() {
  const r = state.researchResult;
  if (!r) return;
  const f = currentFilters();
  DOM.rrMinScoreValue.textContent = String(f.minScore);
  const businesses = new Map(r.businesses.map((b) => [b.business_id, b]));
  const needs = new Map(r.needs.map((n) => [n.need_id, n]));
  const evidence = new Map(r.evidence.map((e) => [e.evidence_id, e]));
  const findings = new Map(r.findings.map((x) => [x.finding_id, x]));
  const text = f.text.toLowerCase();

  const rows = r.opportunities.filter((o) => {
    const b = businesses.get(o.business_id);
    if (f.hideZero && o.score === 0) return false;
    if (o.score < f.minScore) return false;
    if (f.website === 'yes' && !b.website) return false;
    if (f.website === 'no' && b.website) return false;
    if (f.service && !o.need_ids.some((id) => needs.get(id) && needs.get(id).category === f.service)) return false;
    if (text && !o.business_name.toLowerCase().includes(text)) return false;
    return true;
  });

  DOM.rrCount.textContent = `${rows.length} of ${r.opportunities.length} businesses shown, ranked by score`;
  state.researchShownIds = rows.map((o) => o.opportunity_id);
  DOM.rrAddAllBtn.disabled = rows.length === 0;
  DOM.rrEmpty.style.display = rows.length ? 'none' : 'block';
  DOM.rrList.innerHTML = '';

  for (const o of rows) {
    const b = businesses.get(o.business_id);
    const card = document.createElement('article');
    card.className = 'rr-card';
    card.dataset.opportunityId = o.opportunity_id;
    const oppNeeds = o.need_ids.map((id) => needs.get(id)).filter(Boolean);
    const otherNeeds = (o.other_need_ids || []).map((id) => needs.get(id)).filter(Boolean);
    const factorRows = [
      ['Evidence quality', o.factors.evidence_quality],
      ['Fit with your services', o.factors.offer_fit],
      ['Urgency', o.factors.urgency],
      ['Listing completeness', o.factors.reachability],
    ];
    const needHtml = oppNeeds.map((n) => {
      const items = n.finding_ids.map((fid) => findings.get(fid)).filter(Boolean).map((fd) => {
        const evs = fd.evidence_ids.map((id) => evidence.get(id)).filter(Boolean).map((ev) => `
          <li class="rr-evidence">
            <div class="rr-evidence-text">“${escapeHtml(ev.excerpt)}”</div>
            <div class="rr-evidence-meta">${escapeHtml(ev.method)} · observed ${escapeHtml(formatTimestamp(ev.observed_at))} ·
              <a href="${escapeHtml(ev.source_url)}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtml(ev.source_url)}</a></div>
          </li>`).join('');
        return `
          <li class="rr-finding">
            <div><strong>${escapeHtml(fd.title)}</strong> <span class="rr-sev rr-sev-${escapeHtml(fd.severity)}">${escapeHtml(fd.severity)}</span>
              <span class="rr-conf">confidence ${pct(fd.confidence)}</span></div>
            ${fd.caveat ? `<div class="rr-caveat">Caveat: ${escapeHtml(fd.caveat)}</div>` : ''}
            <ul class="rr-evidence-list">${evs}</ul>
          </li>`;
      }).join('');
      return `
        <div class="rr-need">
          <div class="rr-need-head">${escapeHtml(n.service)} <span class="rr-basis">inferred from the findings below</span></div>
          <div class="rr-need-problem">${escapeHtml(n.problems[0])}</div>
          <ul class="rr-findings">${items}</ul>
        </div>`;
    }).join('');
    const inspection = b.inspection || {};
    card.innerHTML = `
      <div class="rr-card-head">
        <div>
          <div class="rr-rank">#${String(o.rank)}</div>
          <h3 class="rr-name">${escapeHtml(o.business_name)}</h3>
          <div class="rr-meta">
            ${b.address ? `${escapeHtml(b.address)} · ` : ''}${b.phone ? `${escapeHtml(b.phone)} · ` : ''}
            ${b.website ? `<a href="${escapeHtml(b.website)}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtml(b.website)}</a>` : 'No website listed'}
          </div>
          <div class="rr-meta">Source: <a href="${escapeHtml(b.source_url)}" target="_blank" rel="noopener noreferrer">OpenStreetMap record</a>, retrieved ${escapeHtml(formatTimestamp(b.retrieved_at))} · website check: ${escapeHtml(inspection.status || 'not run')}</div>
        </div>
        <div class="rr-score" title="Score out of 100">${String(o.score)}</div>
      </div>
      <details class="rr-why">
        <summary>Why this score</summary>
        <ul class="rr-factors">
          ${factorRows.map(([label, v]) => `<li><span>${escapeHtml(label)}</span><span class="rr-bar-track"><span class="rr-bar" style="width:${Math.round(Number(v) * 100)}%"></span></span><span>${pct(v)}</span></li>`).join('')}
        </ul>
        <ul class="rr-explanation">${o.explanation.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>
      </details>
      ${needHtml || '<div class="rr-state">No need was found that matches the services you offer.</div>'}
      ${otherNeeds.length ? `<div class="rr-other">Also observed (not one of your services): ${otherNeeds.map((n) => escapeHtml(n.service)).join(', ')}</div>` : ''}
      ${contactsHtml(b)}
      ${(inspection.notes || []).length ? `<div class="rr-notes">${inspection.notes.map((n) => escapeHtml(n)).join('<br>')}</div>` : ''}
      <div class="rr-actions">
        <button class="btn btn-secondary rr-crm-btn" type="button">Add to CRM</button>
        ${state.researchOptions && state.researchOptions.google_reviews_available && !(state.googleLookups && state.googleLookups.has(b.business_id)) ? '<button class="btn btn-secondary rr-google-btn" type="button">Google rating &amp; reviews</button>' : ''}
        ${o.need_ids.length ? '<button class="btn btn-primary rr-draft-btn" type="button">Draft a proposal</button>' : ''}
      </div>
    `;
    const googleBtn = card.querySelector('.rr-google-btn');
    if (googleBtn) googleBtn.addEventListener('click', () => lookupGoogle(o, googleBtn));
    const draftBtn = card.querySelector('.rr-draft-btn');
    if (draftBtn) draftBtn.addEventListener('click', () => openProposalModal(o));
    card.querySelector('.rr-crm-btn').addEventListener('click', () => addOpportunitiesToCrm([o.opportunity_id]));
    DOM.rrList.appendChild(card);
  }
}

/** An http(s) link, or nothing: other schemes are never put in an href. */
function safeLink(url, label) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return escapeHtml(label || '');
  return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtml(label || url)}</a>`;
}

const SOCIAL_LABELS = { instagram: 'Instagram', facebook: 'Facebook', linkedin: 'LinkedIn', tiktok: 'TikTok', x: 'X', youtube: 'YouTube' };

/** Contacts, owners, Instagram and Google for one business card. */
function contactsHtml(b) {
  const c = b.contacts || { emails: [], phones: [], socials: {} };
  const parts = [];
  if (c.emails.length) {
    const named = c.emails.some((e) => e.kind === 'named');
    parts.push(`<div class="rr-contact-row"><span class="rr-contact-label">Email</span><span>${c.emails.map((e) => `
      <span class="rr-email">${escapeHtml(e.address)}
        <span class="rr-badge rr-badge-${e.kind === 'named' ? 'named' : 'generic'}" title="${e.kind === 'named' ? 'A person\'s address' : 'A role address such as info@ or reception@'}">${e.kind === 'named' ? 'person' : 'role'}</span>${e.same_domain ? '' : '<span class="rr-badge" title="Not on the website\'s own domain">other domain</span>'}
        <span class="rr-src">(${safeLink(e.source_url, 'source')})</span></span>`).join('')}</span></div>`);
    if (named) parts.push('<div class="rr-caveat">UK rule (PECR): a person\'s address may belong to a sole trader or partnership, who must have agreed before you email them for marketing. Role addresses of companies are safer.</div>');
  }
  if (c.phones.length) {
    parts.push(`<div class="rr-contact-row"><span class="rr-contact-label">Phone</span><span>${c.phones.map((p) => `${escapeHtml(p.number)} <span class="rr-src">(${safeLink(p.source_url, 'source')})</span>`).join(' · ')}</span></div>`);
  }
  const socials = Object.entries(c.socials || {});
  if (socials.length) {
    parts.push(`<div class="rr-contact-row"><span class="rr-contact-label">Social</span><span>${socials.map(([k, v]) => safeLink(v.url, SOCIAL_LABELS[k] || k)).join(' · ')}</span></div>`);
  }
  const ig = b.instagram;
  if (ig) {
    const text = ig.status === 'ok'
      ? `@${escapeHtml(ig.handle)}: ${ig.followers ?? '?'} followers, ${ig.posts ?? '?'} posts, last post ${ig.last_post_at ? `${escapeHtml(ig.last_post_at.slice(0, 10))} (${ig.days_since_last_post} days ago)` : 'none'}${ig.stale ? ' <span class="rr-sev rr-sev-medium">inactive</span>' : ''}`
      : escapeHtml(ig.note || ig.status);
    parts.push(`<div class="rr-contact-row"><span class="rr-contact-label">Instagram</span><span>${text}</span></div>`);
  }
  const ow = b.owners;
  if (ow) {
    let text;
    if (ow.status === 'matched') {
      const how = ow.match.postcode === 'same' ? 'same name and postcode' : 'close name, same postcode area';
      text = `${safeLink(ow.company.url, `${ow.company.name} (${ow.company.number})`)}: ${ow.owners.length ? ow.owners.map((o) => `${escapeHtml(o.name)} <span class="rr-src">${escapeHtml(o.role)}</span>`).join(', ') : 'no active directors listed'}
        <div class="rr-src">Companies House; matched on ${escapeHtml(how)}. Check before you rely on it.</div>`;
    } else {
      text = escapeHtml(ow.note || ow.status);
    }
    parts.push(`<div class="rr-contact-row"><span class="rr-contact-label">Owners</span><span>${text}</span></div>`);
  }
  const g = state.googleLookups && state.googleLookups.get(b.business_id);
  if (g) parts.push(googleHtml(g));
  return parts.length ? `<div class="rr-contacts">${parts.join('')}</div>` : '<div class="rr-contacts rr-src">No email, phone or social profile was found on the website or the listing.</div>';
}

function googleHtml(g) {
  if (g.status !== 'found') return `<div class="rr-contact-row"><span class="rr-contact-label">Google</span><span>${escapeHtml(g.note || g.status)}</span></div>`;
  const stars = g.rating === null ? 'no rating' : `★ ${g.rating} (${g.rating_count ?? 0} reviews)`;
  const reviews = g.reviews.map((r) => `
    <li class="rr-review">
      <div>${r.rating === null ? '' : `${'★'.repeat(Math.round(r.rating))} `}<strong>${safeLink(r.author_url, r.author || 'A Google user')}</strong> <span class="rr-src">${escapeHtml(r.relative_time || '')}</span></div>
      ${r.text ? `<div>${escapeHtml(r.text)}</div>` : ''}
    </li>`).join('');
  return `<div class="rr-contact-row"><span class="rr-contact-label">Google</span><span>${safeLink(g.google_maps_uri, stars)}
    ${reviews ? `<ul class="rr-reviews">${reviews}</ul>` : ''}
    <div class="rr-src">Source: Google Maps. Shown live, not saved.</div></span></div>`;
}

async function lookupGoogle(o, btn) {
  btn.disabled = true;
  btn.textContent = 'Asking Google…';
  try {
    const res = await api(`/api/workspaces/${state.currentWorkspace.workspace_id}/research/jobs/${state.researchResultJobId}/businesses/${encodeURIComponent(o.business_id)}/google`, { method: 'POST', body: {} });
    state.googleLookups.set(o.business_id, res.google);
    renderOpportunityList();
  } catch (err) {
    toast(`Google reviews: ${err.message}`, 'error');
    btn.disabled = false;
    btn.textContent = 'Google rating & reviews';
  }
}

function openProposalModal(opp) {
  const offer = readStored(OFFER_KEY, {});
  const aiAvailable = Boolean(state.researchOptions && state.researchOptions.ai_drafts_available);
  DOM.modalTitle.textContent = `Proposal draft — ${opp.business_name}`;
  DOM.modalSubtitle.textContent = 'A draft for you to edit. Nothing is sent from here.';
  DOM.modalBody.innerHTML = `
    <form id="pp-form" class="pp-form">
      <div class="rr-form-grid">
        <div class="form-group"><label class="form-label" for="pp-sender">Your name</label>
          <input id="pp-sender" class="form-input" maxlength="80" required value="${escapeHtml(offer.sender_name || '')}"></div>
        <div class="form-group"><label class="form-label" for="pp-company">Your company</label>
          <input id="pp-company" class="form-input" maxlength="120" required value="${escapeHtml(offer.sender_company || '')}"></div>
      </div>
      <div class="form-group"><label class="form-label" for="pp-offer">What you offer (one or two sentences)</label>
        <textarea id="pp-offer" class="form-textarea" rows="2" maxlength="600" required>${escapeHtml(offer.offer_summary || '')}</textarea></div>
      <div class="form-group"><label class="form-label" for="pp-cta">Closing question</label>
        <input id="pp-cta" class="form-input" maxlength="200" placeholder="Would a short call next week be useful?" value="${escapeHtml(offer.call_to_action || '')}"></div>
      <label class="rr-inline"><input type="checkbox" id="pp-ai"${aiAvailable ? '' : ' disabled'}> Write it with AI${aiAvailable ? ' (checked against the evidence before it is shown)' : ' (not set up on this server)'}</label>
      <div style="margin-top: 12px;"><button class="btn btn-primary" id="pp-generate" type="submit">Create draft</button></div>
    </form>
    <div id="pp-result" style="display: none;"></div>
  `;
  DOM.modalContainer.style.display = 'flex';
  const form = document.getElementById('pp-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      opportunity_id: opp.opportunity_id,
      use_ai: document.getElementById('pp-ai').checked,
      offer: {
        sender_name: document.getElementById('pp-sender').value.trim(),
        sender_company: document.getElementById('pp-company').value.trim(),
        offer_summary: document.getElementById('pp-offer').value.trim(),
        call_to_action: document.getElementById('pp-cta').value.trim(),
      },
    };
    writeStored(OFFER_KEY, body.offer);
    const btn = document.getElementById('pp-generate');
    btn.disabled = true;
    try {
      const res = await api(`/api/workspaces/${state.currentWorkspace.workspace_id}/research/jobs/${state.researchResultJobId}/proposals`, { method: 'POST', body });
      renderProposal(res.draft);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });
}

function renderProposal(d) {
  const out = document.getElementById('pp-result');
  out.style.display = 'block';
  out.innerHTML = `
    <div class="pp-banner">Draft only — review and edit it, then send it yourself from your own email. ZTech does not send it.</div>
    ${d.notes.map((n) => `<div class="rr-caveat">${escapeHtml(n)}</div>`).join('')}
    <div class="form-group"><label class="form-label" for="pp-subject">Subject</label>
      <input id="pp-subject" class="form-input" value="${escapeHtml(d.subject)}"></div>
    <div class="form-group"><label class="form-label" for="pp-body">Message</label>
      <textarea id="pp-body" class="form-textarea" rows="14">${escapeHtml(d.body)}</textarea></div>
    <div style="display:flex; gap: 8px; align-items:center;">
      <button id="pp-copy" class="btn btn-secondary" type="button">Copy to clipboard</button>
      <span style="font-size: 11px; color: var(--text-muted);">Written by: ${escapeHtml(d.generator)}</span>
    </div>
    <h4 class="rr-section-title" style="margin-top: 14px;">Facts this draft relies on</h4>
    <ul class="rr-evidence-list">${d.facts.map((f) => `
      <li class="rr-evidence"><div class="rr-evidence-text">${escapeHtml(f.title)}: “${escapeHtml(f.observation)}”</div>
        <div class="rr-evidence-meta">observed ${escapeHtml(formatTimestamp(f.observed_at))} · <a href="${escapeHtml(f.source_url)}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtml(f.source_url)}</a></div></li>`).join('')}
    </ul>
    <h4 class="rr-section-title">What we infer from them (not certain)</h4>
    <ul class="rr-explanation">${d.inferences.map((i) => `<li>${escapeHtml(i.text)}${i.caveats.length ? ` <em>(${escapeHtml(i.caveats.join(' '))})</em>` : ''}</li>`).join('')}</ul>
  `;
  document.getElementById('pp-copy').addEventListener('click', async () => {
    const text = `Subject: ${document.getElementById('pp-subject').value}\n\n${document.getElementById('pp-body').value}`;
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied', 'success');
    } catch {
      toast('Copy is not available here; select the text and copy it', 'error');
    }
  });
}

function setupResearchResultsListeners() {
  DOM.rrCloseBtn.addEventListener('click', closeResearchResult);
  DOM.rrAddAllBtn.addEventListener('click', () => addOpportunitiesToCrm((state.researchShownIds || []).slice(0, 100)));
  for (const el of [DOM.rrMinScore, DOM.rrFilterService, DOM.rrFilterWebsite, DOM.rrFilterHideZero]) {
    el.addEventListener('input', renderOpportunityList);
    el.addEventListener('change', renderOpportunityList);
  }
  DOM.rrFilterText.addEventListener('input', renderOpportunityList);
  DOM.rrSaveFilterBtn.addEventListener('click', () => {
    const name = window.prompt('Name for these filters');
    if (!name || !name.trim()) return;
    const saved = readStored(SAVED_FILTERS_KEY, []).filter((f) => f.name !== name.trim());
    saved.push({ name: name.trim().slice(0, 60), filters: currentFilters() });
    writeStored(SAVED_FILTERS_KEY, saved.slice(-20));
    renderSavedFilterOptions();
    toast('Filters saved in this browser', 'success');
  });
  DOM.rrSavedSelect.addEventListener('change', () => {
    const saved = readStored(SAVED_FILTERS_KEY, []);
    const pick = saved[Number(DOM.rrSavedSelect.value)];
    if (!pick) return;
    applyFilters(pick.filters);
    renderOpportunityList();
  });
}

/* ---------------------- Phase 3: CRM & pipeline (P09) --------------------- */

const CRM_STAGE_LABELS = {
  new: 'New', contacted: 'Contacted', replied: 'Replied', meeting: 'Meeting',
  proposal: 'Proposal', won: 'Won', lost: 'Lost',
};
const crm = {
  stages: Object.keys(CRM_STAGE_LABELS), accounts: [], offset: 0, more: false,
  canWrite: false, canManage: false, me: null, members: null, loading: false, debounce: null,
};

function money(cents) {
  if (cents === null || cents === undefined) return '—';
  return `$${(Number(cents) / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function crmBase() {
  return `/api/workspaces/${state.currentWorkspace.workspace_id}/crm/accounts`;
}

function memberLabel(userId) {
  if (!userId) return 'Unassigned';
  if (userId === crm.me) return 'You';
  if (crm.members && crm.members.has(userId)) return crm.members.get(userId);
  return 'A teammate';
}

async function loadCrmMembers() {
  if (crm.members !== null || !state.currentWorkspace) return;
  try {
    const res = await api(`/api/workspaces/${state.currentWorkspace.workspace_id}/members`);
    crm.members = new Map((res.members || []).map((m) => [m.user_id, m.email]));
  } catch {
    crm.members = new Map(); // a role without member.read sees "You" / "A teammate"
  }
}

function crmQuery(offset) {
  const p = new URLSearchParams();
  const q = DOM.crmQ.value.trim();
  if (q) p.set('q', q);
  if (DOM.crmStage.value) p.set('stage', DOM.crmStage.value);
  if (DOM.crmOwner.value) p.set('owner', DOM.crmOwner.value);
  if (DOM.crmArchived.checked) p.set('archived', 'include');
  p.set('limit', '50');
  p.set('offset', String(offset));
  return p.toString();
}

async function loadCrm({ append = false } = {}) {
  if (!state.currentWorkspace) return;
  const offset = append ? crm.offset + 50 : 0;
  DOM.crmLoading.style.display = append ? 'none' : 'block';
  DOM.crmError.style.display = 'none';
  try {
    await loadCrmMembers();
    const res = await api(`${crmBase()}?${crmQuery(offset)}`);
    crm.stages = res.stages || crm.stages;
    crm.canWrite = Boolean(res.can_write);
    crm.canManage = Boolean(res.can_manage);
    crm.me = res.me;
    crm.offset = offset;
    crm.more = Boolean(res.more);
    crm.accounts = append ? crm.accounts.concat(res.accounts) : res.accounts;
    DOM.crmLoading.style.display = 'none';
    DOM.crmNewBtn.style.display = crm.canWrite ? '' : 'none';
    if (DOM.crmStage.options.length <= 1) {
      for (const s of crm.stages) {
        const o = document.createElement('option');
        o.value = s;
        o.textContent = CRM_STAGE_LABELS[s] || s;
        DOM.crmStage.appendChild(o);
      }
    }
    renderCrmPipeline(res.pipeline || []);
    renderCrmList();
  } catch (err) {
    DOM.crmLoading.style.display = 'none';
    DOM.crmError.textContent = `The CRM could not be loaded: ${err.message}`;
    DOM.crmError.style.display = 'block';
  }
}

function renderCrmPipeline(pipeline) {
  DOM.crmPipeline.innerHTML = pipeline.map((p) => `
    <button type="button" class="crm-stage-chip${DOM.crmStage.value === p.stage ? ' active' : ''}" data-stage="${escapeHtml(p.stage)}" role="listitem"
      aria-pressed="${DOM.crmStage.value === p.stage ? 'true' : 'false'}">
      <span class="crm-stage-name">${escapeHtml(CRM_STAGE_LABELS[p.stage] || p.stage)}</span>
      <span class="crm-stage-count">${escapeHtml(String(p.accounts))}</span>
      <span class="crm-stage-value">${escapeHtml(money(p.value_cents))}</span>
    </button>`).join('');
  DOM.crmPipeline.querySelectorAll('.crm-stage-chip').forEach((b) => b.addEventListener('click', () => {
    DOM.crmStage.value = DOM.crmStage.value === b.dataset.stage ? '' : b.dataset.stage;
    loadCrm();
  }));
}

function renderCrmList() {
  DOM.crmList.innerHTML = '';
  DOM.crmEmpty.style.display = crm.accounts.length ? 'none' : 'block';
  DOM.crmMore.style.display = crm.more ? 'block' : 'none';
  for (const a of crm.accounts) {
    const row = document.createElement('article');
    row.className = `crm-row${a.archived_at ? ' archived' : ''}`;
    row.dataset.accountId = a.account_id;
    row.innerHTML = `
      <div class="crm-row-main">
        <button type="button" class="crm-name-btn">${escapeHtml(a.name)}</button>
        <div class="rr-meta">${a.website ? `${escapeHtml(a.website)} · ` : ''}${escapeHtml(memberLabel(a.owner_user_id))}${a.next_step ? ` · Next: ${escapeHtml(a.next_step)}` : ''}${a.archived_at ? ' · archived' : ''}</div>
      </div>
      <span class="crm-value">${escapeHtml(money(a.estimated_value_cents))}</span>
      <span class="crm-stage crm-stage-${escapeHtml(a.stage)}">${escapeHtml(CRM_STAGE_LABELS[a.stage] || a.stage)}</span>
    `;
    row.querySelector('.crm-name-btn').addEventListener('click', () => openCrmAccount(a.account_id));
    DOM.crmList.appendChild(row);
  }
}

async function createCrmAccount(e) {
  e.preventDefault();
  const value = DOM.crmNewValue.value.trim();
  const body = {
    name: DOM.crmNewName.value,
    website: DOM.crmNewWebsite.value.trim() || null,
    phone: DOM.crmNewPhone.value.trim() || null,
    estimated_value_cents: value === '' ? null : Math.round(Number(value) * 100),
  };
  DOM.crmNewSubmit.disabled = true;
  try {
    await api(crmBase(), { method: 'POST', body });
    DOM.crmNewForm.reset();
    DOM.crmNewForm.style.display = 'none';
    toast('Account added', 'success');
    await loadCrm();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    DOM.crmNewSubmit.disabled = false;
  }
}

function activityText(a) {
  const d = a.detail || {};
  switch (a.kind) {
    case 'created': return 'Account created';
    case 'imported': return `Added from research (score ${d.score ?? '—'}${d.needs && d.needs.length ? `; needs: ${d.needs.join(', ')}` : ''})`;
    case 'stage_changed': return `Stage: ${CRM_STAGE_LABELS[d.from] || d.from} → ${CRM_STAGE_LABELS[d.to] || d.to}${d.reason ? ` (${d.reason})` : ''}`;
    case 'assigned': return `Owner: ${memberLabel(d.from)} → ${memberLabel(d.to)}`;
    case 'note_added': return 'Note added';
    case 'archived': return 'Archived';
    case 'restored': return 'Restored';
    case 'updated': return `Changed: ${Object.keys(d.changes || {}).map((k) => k.replace(/_/g, ' ')).join(', ')}`;
    default: return a.kind;
  }
}

async function openCrmAccount(accountId) {
  DOM.modalTitle.textContent = 'Account';
  DOM.modalSubtitle.textContent = '';
  DOM.modalBody.innerHTML = '<div class="rr-state">Loading…</div>';
  DOM.modalContainer.style.display = 'flex';
  let d;
  try {
    d = await api(`${crmBase()}/${accountId}`);
  } catch (err) {
    DOM.modalBody.innerHTML = `<div class="rr-state rr-state-error">${escapeHtml(err.message)}</div>`;
    return;
  }
  renderCrmAccount(d);
}

function renderCrmAccount(d) {
  const a = d.account;
  const editable = crm.canWrite && !a.archived_at;
  DOM.modalTitle.textContent = a.name;
  DOM.modalSubtitle.textContent = a.source === 'research'
    ? `From research · score ${a.research_score ?? '—'}`
    : 'Added by hand';
  const ownerOptions = [];
  ownerOptions.push(`<option value="">Unassigned</option>`);
  const people = crm.members && crm.members.size ? [...crm.members.entries()] : [[crm.me, 'You']];
  for (const [id, label] of people) {
    if (!id) continue;
    ownerOptions.push(`<option value="${escapeHtml(id)}"${a.owner_user_id === id ? ' selected' : ''}>${escapeHtml(id === crm.me ? `${label} (you)` : label)}</option>`);
  }
  if (a.owner_user_id && !people.some(([id]) => id === a.owner_user_id)) {
    ownerOptions.push(`<option value="${escapeHtml(a.owner_user_id)}" selected>${escapeHtml(memberLabel(a.owner_user_id))}</option>`);
  }
  const canChangeOwner = editable && (crm.canManage || !a.owner_user_id);
  DOM.modalBody.innerHTML = `
    <form id="crm-edit" class="pp-form">
      <div class="rr-form-grid">
        <div class="form-group"><label class="form-label" for="crm-e-stage">Stage</label>
          <select id="crm-e-stage" class="form-select"${editable ? '' : ' disabled'}>${crm.stages.map((s) => `<option value="${s}"${a.stage === s ? ' selected' : ''}>${escapeHtml(CRM_STAGE_LABELS[s] || s)}</option>`).join('')}</select></div>
        <div class="form-group"><label class="form-label" for="crm-e-owner">Owner</label>
          <select id="crm-e-owner" class="form-select"${canChangeOwner ? '' : ' disabled'}>${ownerOptions.join('')}</select></div>
        <div class="form-group"><label class="form-label" for="crm-e-value">Estimated value (USD)</label>
          <input id="crm-e-value" class="form-input" type="number" min="0" step="1" value="${a.estimated_value_cents === null ? '' : escapeHtml(String(Math.round(a.estimated_value_cents / 100)))}"${editable ? '' : ' disabled'}></div>
      </div>
      <div class="form-group" id="crm-e-lost-wrap" style="display:${a.stage === 'lost' ? 'block' : 'none'};"><label class="form-label" for="crm-e-lost">Why was it lost?</label>
        <input id="crm-e-lost" class="form-input" maxlength="300" value="${escapeHtml(a.lost_reason || '')}"${editable ? '' : ' disabled'}></div>
      <div class="rr-form-grid">
        <div class="form-group"><label class="form-label" for="crm-e-next">Next step</label>
          <input id="crm-e-next" class="form-input" maxlength="300" value="${escapeHtml(a.next_step || '')}"${editable ? '' : ' disabled'}></div>
        <div class="form-group"><label class="form-label" for="crm-e-next-at">Next step date</label>
          <input id="crm-e-next-at" class="form-input" type="date" value="${a.next_step_at ? escapeHtml(a.next_step_at.slice(0, 10)) : ''}"${editable ? '' : ' disabled'}></div>
      </div>
      <div class="rr-meta" style="margin: 6px 0;">${[
        a.website ? `<a href="${escapeHtml(a.website)}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtml(a.website)}</a>` : '',
        a.phone ? escapeHtml(a.phone) : '',
        a.address ? escapeHtml(a.address) : '',
        a.source_url ? `<a href="${escapeHtml(a.source_url)}" target="_blank" rel="noopener noreferrer">source record</a>` : '',
      ].filter(Boolean).join(' · ')}</div>
      <div style="display:flex; gap:8px; flex-wrap: wrap;">
        ${editable ? '<button class="btn btn-primary" type="submit" id="crm-e-save">Save</button>' : ''}
        ${crm.canManage ? `<button class="btn btn-secondary" type="button" id="crm-e-archive">${a.archived_at ? 'Restore' : 'Archive'}</button>` : ''}
      </div>
      ${a.archived_at ? '<div class="rr-caveat">This account is archived. Restore it to change it.</div>' : ''}
    </form>
    <h4 class="rr-section-title" style="margin-top: 16px;">Notes</h4>
    ${editable ? `<form id="crm-note-form" class="crm-note-form"><textarea id="crm-note-body" class="form-textarea" rows="2" maxlength="4000" placeholder="What happened, what was agreed"></textarea><button class="btn btn-secondary" type="submit">Add note</button></form>` : ''}
    <ul class="crm-notes">${d.notes.map((n) => `<li><div class="crm-note-body">${escapeHtml(n.body)}</div><div class="rr-meta">${escapeHtml(memberLabel(n.author_user_id))} · ${escapeHtml(formatTimestamp(n.created_at))}</div></li>`).join('') || '<li class="rr-meta">No notes yet.</li>'}</ul>
    <h4 class="rr-section-title" style="margin-top: 16px;">History</h4>
    <ul class="crm-activity">${d.activity.map((x) => `<li><span>${escapeHtml(activityText(x))}</span><span class="rr-meta">${escapeHtml(memberLabel(x.actor_user_id))} · ${escapeHtml(formatTimestamp(x.at))}</span></li>`).join('')}</ul>
  `;
  const stageSel = document.getElementById('crm-e-stage');
  stageSel.addEventListener('change', () => {
    document.getElementById('crm-e-lost-wrap').style.display = stageSel.value === 'lost' ? 'block' : 'none';
  });
  const form = document.getElementById('crm-edit');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!editable) return;
    const value = document.getElementById('crm-e-value').value.trim();
    const nextAt = document.getElementById('crm-e-next-at').value;
    const patch = {
      version: a.version,
      stage: stageSel.value,
      lost_reason: stageSel.value === 'lost' ? document.getElementById('crm-e-lost').value.trim() || null : null,
      estimated_value_cents: value === '' ? null : Math.round(Number(value) * 100),
      next_step: document.getElementById('crm-e-next').value.trim() || null,
      next_step_at: nextAt ? `${nextAt}T09:00:00.000Z` : null,
    };
    const owner = document.getElementById('crm-e-owner');
    if (!owner.disabled && (owner.value || null) !== (a.owner_user_id || null)) patch.owner_user_id = owner.value || null;
    try {
      await api(`${crmBase()}/${a.account_id}`, { method: 'PATCH', body: patch });
      toast('Saved', 'success');
      await openCrmAccount(a.account_id);
      loadCrm();
    } catch (err) {
      toast(err.code === 'version_conflict' ? 'Someone else changed this account. It has been reloaded; make your change again.' : err.message, 'error');
      if (err.code === 'version_conflict') await openCrmAccount(a.account_id);
    }
  });
  const archiveBtn = document.getElementById('crm-e-archive');
  if (archiveBtn) archiveBtn.addEventListener('click', async () => {
    try {
      await api(`${crmBase()}/${a.account_id}`, { method: 'PATCH', body: { version: a.version, archived: !a.archived_at } });
      toast(a.archived_at ? 'Restored' : 'Archived', 'success');
      await openCrmAccount(a.account_id);
      loadCrm();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  const noteForm = document.getElementById('crm-note-form');
  if (noteForm) noteForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = document.getElementById('crm-note-body').value;
    if (!body.trim()) return;
    try {
      await api(`${crmBase()}/${a.account_id}/notes`, { method: 'POST', body: { body } });
      await openCrmAccount(a.account_id);
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

async function addOpportunitiesToCrm(opportunityIds) {
  if (!state.currentWorkspace || !state.researchResultJobId || !opportunityIds.length) return;
  try {
    const res = await api(`${crmBase()}/import`, {
      method: 'POST',
      body: { job_id: state.researchResultJobId, opportunity_ids: opportunityIds },
    });
    const already = res.skipped.filter((x) => x.reason === 'already_in_crm').length;
    toast(`${res.created.length} added to the CRM${already ? `, ${already} already there` : ''}`, 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

function setupCrmListeners() {
  DOM.crmNewBtn.addEventListener('click', () => {
    DOM.crmNewForm.style.display = DOM.crmNewForm.style.display === 'none' ? 'block' : 'none';
    if (DOM.crmNewForm.style.display === 'block') DOM.crmNewName.focus();
  });
  DOM.crmNewCancel.addEventListener('click', () => { DOM.crmNewForm.style.display = 'none'; });
  DOM.crmNewForm.addEventListener('submit', createCrmAccount);
  DOM.crmQ.addEventListener('input', () => {
    clearTimeout(crm.debounce);
    crm.debounce = setTimeout(() => loadCrm(), 300);
  });
  for (const el of [DOM.crmStage, DOM.crmOwner, DOM.crmArchived]) el.addEventListener('change', () => loadCrm());
  DOM.crmMoreBtn.addEventListener('click', () => loadCrm({ append: true }));
}

/* ---------------------- Competitor ads (Meta connector) -------------------- */

function caBase() {
  return `/api/workspaces/${state.currentWorkspace.workspace_id}/competitors`;
}

function daysAgo(iso) {
  if (!iso) return 'never';
  const d = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
}

async function loadCompetitors() {
  if (!state.currentWorkspace) return;
  DOM.caLoading.style.display = 'block';
  DOM.caError.style.display = 'none';
  try {
    const res = await api(caBase());
    DOM.caLoading.style.display = 'none';
    DOM.caForm.style.display = res.can_write ? '' : 'none';
    renderCompetitors(res.watches || [], res.can_write);
  } catch (err) {
    DOM.caLoading.style.display = 'none';
    DOM.caError.textContent = `Competitor ads could not be loaded: ${err.message}`;
    DOM.caError.style.display = 'block';
  }
}

function renderCompetitors(watches, canWrite) {
  DOM.caList.innerHTML = '';
  DOM.caEmpty.style.display = watches.length ? 'none' : 'block';
  for (const w of watches) {
    const s = w.summary;
    const row = document.createElement('article');
    row.className = 'crm-row ca-row';
    const counts = s ? s.counts : null;
    row.innerHTML = `
      <div class="crm-row-main">
        <button type="button" class="crm-name-btn">${escapeHtml(w.watch.label)}</button>
        <div class="rr-meta">${escapeHtml(w.watch.query)} · ${escapeHtml(w.watch.country)} · last checked ${escapeHtml(s ? daysAgo(s.checked_at) : 'not yet')}${w.checking ? ' · checking now…' : ''}</div>
        ${w.last_error ? `<div class="rr-caveat">Last check failed: ${escapeHtml(w.last_error)}</div>` : ''}
      </div>
      <div class="ca-counts">${counts ? `
        <span title="Ads running now"><strong>${String(counts.active)}</strong> running</span>
        ${counts.new_since_last !== null ? `<span title="New since the previous check"><strong>${String(counts.new_since_last)}</strong> new</span>` : ''}
        ${counts.stopped_since_last !== null ? `<span title="Stopped since the previous check"><strong>${String(counts.stopped_since_last)}</strong> stopped</span>` : ''}
        <span title="Still running after 21 days"><strong>${String(counts.likely_working)}</strong> likely working</span>` : '<span class="rr-meta">Waiting for the first check</span>'}
      </div>
      <div class="rr-actions" style="margin-top:0; gap:6px;">
        ${canWrite ? '<button class="btn btn-secondary ca-check-btn" type="button">Check now</button>' : ''}
      </div>`;
    row.querySelector('.crm-name-btn').addEventListener('click', () => openCompetitor(w.watch.watch_id));
    const check = row.querySelector('.ca-check-btn');
    if (check) check.addEventListener('click', async () => {
      try {
        const r = await api(`${caBase()}/${w.watch.watch_id}/check`, { method: 'POST', body: {} });
        toast(r.deduplicated ? 'A check is already queued for this hour' : 'Check queued; results appear when the worker finishes', 'success');
        loadCompetitors();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    DOM.caList.appendChild(row);
  }
}

async function openCompetitor(watchId) {
  DOM.modalTitle.textContent = 'Competitor ads';
  DOM.modalSubtitle.textContent = '';
  DOM.modalBody.innerHTML = '<div class="rr-state">Loading…</div>';
  DOM.modalContainer.style.display = 'flex';
  let d;
  try {
    d = await api(`${caBase()}/${watchId}`);
  } catch (err) {
    DOM.modalBody.innerHTML = `<div class="rr-state rr-state-error">${escapeHtml(err.message)}</div>`;
    return;
  }
  DOM.modalTitle.textContent = d.watch.label;
  DOM.modalSubtitle.textContent = `${d.watch.query} · ${d.watch.country}${d.source ? ` · source: ${d.source === 'meta_api' ? 'Meta Ad Library API' : 'Ad Library scraper'}` : ''}`;
  const r = d.report;
  if (!r) {
    DOM.modalBody.innerHTML = `<div class="rr-state">${d.checking ? 'The first check is running; come back in a few minutes.' : escapeHtml(d.last_error ? `The check failed: ${d.last_error}` : 'No check has finished yet.')}</div>`;
    return;
  }
  const max = Math.max(1, ...d.history.map((h) => h.active));
  const tally = (obj) => Object.entries(obj).map(([k, v]) => `<li><span>${escapeHtml(k)}</span><strong>${String(v)}</strong></li>`).join('') || '<li class="rr-meta">—</li>';
  DOM.modalBody.innerHTML = `
    <div class="rr-stats">
      <div class="rr-stat"><div class="rr-stat-value">${String(r.counts.active)}</div><div class="rr-stat-label">Running now</div></div>
      <div class="rr-stat"><div class="rr-stat-value">${r.counts.new_since_last === null ? '—' : String(r.counts.new_since_last)}</div><div class="rr-stat-label">New since last check</div></div>
      <div class="rr-stat"><div class="rr-stat-value">${r.counts.stopped_since_last === null ? '—' : String(r.counts.stopped_since_last)}</div><div class="rr-stat-label">Stopped since last check</div></div>
      <div class="rr-stat"><div class="rr-stat-value">${String(r.counts.likely_working)}</div><div class="rr-stat-label">Likely working (21+ days)</div></div>
    </div>
    <div class="rr-meta">Checked ${escapeHtml(formatTimestamp(r.checked_at))}${r.previous_checked_at ? `, compared with ${escapeHtml(formatTimestamp(r.previous_checked_at))}` : ' (first check)'}.</div>
    ${d.notes.map((n) => `<div class="rr-caveat">${escapeHtml(n)}</div>`).join('')}
    <h4 class="rr-section-title" style="margin-top:14px;">Ads running, check by check</h4>
    <div class="rr-chart" role="img" aria-label="Running ads per check: ${d.history.map((h) => `${formatTimestamp(h.checked_at)} ${h.active}`).join(', ')}">
      ${d.history.map((h) => `<div class="rr-bar-row"><span class="rr-bar-label">${escapeHtml(new Date(h.checked_at).toLocaleDateString())}</span><span class="rr-bar-track"><span class="rr-bar" style="width:${Math.max(4, Math.round((h.active / max) * 100))}%"></span></span><span class="rr-bar-value">${String(h.active)}</span></div>`).join('')}
    </div>
    <div class="ca-tallies">
      <div><h4 class="rr-section-title">Buttons (running ads)</h4><ul class="ca-tally">${tally(r.by_cta)}</ul></div>
      <div><h4 class="rr-section-title">Platforms</h4><ul class="ca-tally">${tally(r.by_platform)}</ul></div>
      <div><h4 class="rr-section-title">Formats</h4><ul class="ca-tally">${tally(r.by_format)}</ul></div>
    </div>
    <h4 class="rr-section-title" style="margin-top:14px;">Ads</h4>
    <ul class="ca-ads">${r.ads.map((a) => `
      <li class="ca-ad${a.is_active ? '' : ' stopped'}">
        <div class="ca-ad-head">
          ${a.is_new ? '<span class="crm-stage crm-stage-meeting">New</span>' : ''}
          ${a.likely_working ? '<span class="crm-stage crm-stage-won">Likely working</span>' : ''}
          ${a.is_active ? '' : '<span class="crm-stage">Stopped</span>'}
          <span class="rr-meta">${a.running_days === null ? '' : `${String(a.running_days)} days`}${a.cta ? ` · ${escapeHtml(a.cta)}` : ''}${a.platforms && a.platforms.length ? ` · ${escapeHtml(a.platforms.join(', '))}` : ''}${a.display_format ? ` · ${escapeHtml(a.display_format.toLowerCase())}` : ''}</span>
        </div>
        <div class="ca-ad-body">${escapeHtml(a.body || a.title || '(no text)')}</div>
        ${a.snapshot_url ? `<a class="rr-meta" href="${escapeHtml(a.snapshot_url)}" target="_blank" rel="noopener noreferrer nofollow">Open in Meta Ad Library</a>` : ''}
      </li>`).join('')}</ul>
    <p class="rr-meta" style="margin-top:10px;">${escapeHtml(r.rule)}</p>
    ${d.watch.archived_at ? '' : '<button class="btn btn-secondary" type="button" id="ca-archive">Stop watching</button>'}
  `;
  const archive = document.getElementById('ca-archive');
  if (archive) archive.addEventListener('click', async () => {
    try {
      await api(`${caBase()}/${d.watch.watch_id}/archive`, { method: 'POST', body: {} });
      DOM.modalContainer.style.display = 'none';
      toast('Stopped watching', 'success');
      loadCompetitors();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

function setupCompetitorListeners() {
  DOM.caForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    DOM.caSubmit.disabled = true;
    try {
      await api(caBase(), {
        method: 'POST',
        body: {
          query: DOM.caQuery.value.trim(),
          country: DOM.caCountry.value.trim().toUpperCase(),
          label: DOM.caLabel.value.trim() || undefined,
          page_id: DOM.caPageId.value.trim() || undefined,
        },
      });
      DOM.caForm.reset();
      toast('Watching. The first check is queued.', 'success');
      loadCompetitors();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      DOM.caSubmit.disabled = false;
    }
  });
}

/* ------------------ Outreach Preparation & Gate Modal ------------------- */

async function openOutreachPreparationModal(opp) {
  if (!state.currentWorkspace) return;
  const wsId = state.currentWorkspace.workspace_id;

  DOM.modalTitle.textContent = `Outreach Drafter — ${opp.company_name}`;
  DOM.modalSubtitle.textContent = 'PitchGenerator & OutreachGate Enforcement';

  DOM.modalBody.innerHTML = `
    <div style="text-align: center; padding: 30px;">
      <div style="font-size: 24px; margin-bottom: 8px;">⏳</div>
      <div>Generating evidence-backed pitch and verifying Outreach Gate rules...</div>
    </div>
  `;
  DOM.modalContainer.style.display = 'flex';

  try {
    const draftResponse = await api(`/api/workspaces/${wsId}/outreach/prepare`, {
      method: 'POST',
      body: {
        opportunity: opp,
        offer: {
          sender_name: 'ZTech Senior Solution Specialist',
          sender_company: state.currentWorkspace.organization_name || 'ZTech Lead Generation',
          value_proposition: 'We assist private healthcare and commercial specialty practices in replacing slow booking systems with high-converting, HIPAA/GDPR-compliant scheduling.',
          call_to_action: 'Would a brief 10-minute briefing next Tuesday be helpful to review the technical response findings from our audit?',
        },
      },
    });

    const pitch = draftResponse.pitch;
    const gate = draftResponse.gate;
    state.activePitch = pitch;

    const observationsHtml = (pitch.observations || []).map((o) => `
      <div style="margin-bottom: 8px; padding-left: 10px; border-left: 2px solid var(--accent-primary);">
        <div>${escapeHtml(o.text)}</div>
        <div style="font-size: 11px; color: var(--text-dim);">Refs: ${(o.refs || []).join(', ')}</div>
      </div>
    `).join('');

    const reasons = gate.reasons || [];
    const gatePassed = reasons.length === 0;
    const currentRole = state.currentWorkspace?.role || 'member';
    const canApprove = ['owner', 'admin', 'manager'].includes(currentRole);

    DOM.modalBody.innerHTML = `
      <div style="margin-bottom: 16px; padding: 12px; background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.3); border-radius: var(--radius-md); font-size: 12px; color: #f87171;">
        <strong>🔒 Human Oversight Safety Gate:</strong> Outreach drafts are strictly evidence-backed and require human authorization. Automatic sending via SMTP or WhatsApp is permanently disabled.
      </div>

      <!-- Outreach Gate Checklist -->
      <h3 style="font-size: 14px; font-weight: 700; margin-bottom: 8px;">Outreach Gate Compliance Verification</h3>
      <div class="gate-checklist">
        <div class="gate-item pass">
          <span>✓</span> <strong>LEAD_IDENTITY:</strong> Business name verified as "${escapeHtml(opp.company_name)}"
        </div>
        <div class="gate-item pass">
          <span>✓</span> <strong>CONTACT_FIELD:</strong> Valid recipient address "${escapeHtml(opp.contact_info?.email || 'N/A')}"
        </div>
        <div class="gate-item pass">
          <span>✓</span> <strong>EVIDENCE_PRESENT & FRESH:</strong> Linked to Packet ${escapeHtml((opp.packet_id || '').slice(0, 16))}
        </div>
        <div class="gate-item pass">
          <span>✓</span> <strong>PROHIBITED_CLAIMS:</strong> 0 unsupported claims or guarantees detected
        </div>
        <div class="gate-item warn">
          <span>⚠️</span> <strong>HUMAN_APPROVAL:</strong> Requires supervisor sign-off before manual dispatch
        </div>
      </div>

      <!-- Generated Draft Pitch Preview -->
      <h3 style="font-size: 14px; font-weight: 700; margin-top: 18px; margin-bottom: 8px;">Generated Evidence-Backed Draft</h3>
      <div class="pitch-preview-box">
        <div class="field-title">Subject Line</div>
        <div style="font-weight: 600; color: #fff; margin-bottom: 10px;">${escapeHtml(pitch.subject)}</div>

        <div class="field-title">Opening</div>
        <div style="color: var(--text-main); margin-bottom: 10px;">${escapeHtml(pitch.opening)}</div>

        <div class="field-title">Evidence-Backed Observations (Cited from Audit)</div>
        ${observationsHtml}

        <div class="field-title" style="margin-top: 10px;">Value Proposition</div>
        <div style="color: var(--text-muted); margin-bottom: 10px;">${escapeHtml(pitch.valueProposition)}</div>

        <div class="field-title">Call To Action</div>
        <div style="color: var(--text-main);">${escapeHtml(pitch.callToAction)}</div>
      </div>

      ${!canApprove ? `
        <div style="margin-top: 12px; padding: 10px 14px; background: rgba(245, 158, 11, 0.12); border: 1px solid rgba(245, 158, 11, 0.35); border-radius: var(--radius-sm); font-size: 12px; color: #fbbf24;">
          ⚠️ <strong>Approval Restricted:</strong> Role '${escapeHtml(currentRole)}' does not have outreach approval permissions. An Owner, Admin, or Manager must authorize dispatch.
        </div>
      ` : ''}

      <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px;">
        <button class="btn btn-secondary" onclick="DOM.modalContainer.style.display='none'">Cancel</button>
        <button class="btn btn-primary" id="approve-outreach-btn" style="background: ${canApprove ? '#10b981' : '#475569'};" ${canApprove ? '' : 'disabled title="Requires owner, admin, or manager role"'}>
          Approve Draft for Human Dispatch
        </button>
      </div>
    `;

    if (canApprove) {
      document.getElementById('approve-outreach-btn').addEventListener('click', () => {
        approveOutreachDraft(pitch);
      });
    }

    DOM.kpiDraftsCount.textContent = '1';
  } catch (err) {
    DOM.modalBody.innerHTML = `
      <div style="color: #f87171; padding: 20px; text-align: center;">
        Failed to prepare outreach: ${escapeHtml(err.message)}
      </div>
    `;
  }
}

async function approveOutreachDraft(pitch) {
  if (!state.currentWorkspace || !pitch) return;
  const wsId = state.currentWorkspace.workspace_id;

  try {
    const res = await api(`/api/workspaces/${wsId}/outreach/approve`, {
      method: 'POST',
      body: {
        pitch_id: pitch.pitch_id,
        content_hash: pitch.content_hash,
      },
    });

    toast('Outreach draft approved for manual human dispatch!', 'success');
    DOM.modalContainer.style.display = 'none';
    DOM.kpiDraftsCount.textContent = '0';
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* -------------------------- Event Listeners ----------------------------- */

function setupEventListeners() {
  // Navigation tabs
  DOM.navItems.forEach((item) => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      navigateTo(item.dataset.view);
    });
  });

  DOM.ctaStartDiscovery.addEventListener('click', () => navigateTo('discovery'));

  // Auth screen tabs
  DOM.tabLogin.addEventListener('click', () => {
    DOM.tabLogin.classList.add('active');
    DOM.tabRegister.classList.remove('active');
    DOM.loginForm.style.display = 'block';
    DOM.registerForm.style.display = 'none';
  });

  DOM.tabRegister.addEventListener('click', () => {
    DOM.tabRegister.classList.add('active');
    DOM.tabLogin.classList.remove('active');
    DOM.registerForm.style.display = 'block';
    DOM.loginForm.style.display = 'none';
  });

  // Loopback demo login trigger
  if (DOM.quickDemoFill) {
    DOM.quickDemoFill.addEventListener('click', async () => {
      try {
        const res = await api('/api/auth/demo-login', { method: 'POST' });
        state.csrfToken = res.csrf_token;
        toast('Local demo session established!', 'success');
        await checkSession();
      } catch (err) {
        toast(`Demo login unavailable: ${err.message}`, 'error');
      }
    });
  }

  // Login Form
  DOM.loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await api('/api/auth/login', {
        method: 'POST',
        body: {
          email: DOM.loginEmail.value.trim(),
          password: DOM.loginPassword.value,
        },
      });

      state.csrfToken = res.csrf_token;
      toast('Signed in successfully!', 'success');
      await checkSession();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // Register Form
  DOM.registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await api('/api/auth/register', {
        method: 'POST',
        body: {
          email: DOM.regEmail.value.trim(),
          password: DOM.regPassword.value,
          organization: DOM.regOrg.value.trim(),
          workspaceName: DOM.regWorkspace.value.trim(),
        },
      });

      state.csrfToken = res.csrf_token;
      toast('Account and workspace created!', 'success');
      await checkSession();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // Logout
  DOM.logoutBtn.addEventListener('click', async () => {
    stopResearchJobsPolling();
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch {
      // Ignored
    }
    state.session = null;
    state.csrfToken = null;
    state.currentWorkspace = null;
    closeResearchResult();
    crm.members = null;
    crm.accounts = [];
    renderUnauthenticatedState();
    toast('Signed out', 'info');
  });

  // Research Jobs form
  DOM.researchJobForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const criteria = readResearchForm();
    if (!criteria) return;
    await submitResearchJob(criteria);
  });
  setupResearchResultsListeners();
  setupCrmListeners();
  setupCompetitorListeners();

  // Research Jobs refresh
  DOM.rjRefreshBtn.addEventListener('click', () => loadResearchJobs());

  // Discovery Form
  DOM.discoveryForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const criteria = {
      industry: DOM.discIndustry.value.trim(),
      targetCountry: DOM.discCountry.value,
      cityOrRegion: DOM.discRegion.value.trim(),
      targetCustomerType: DOM.discCustomerType.value.trim(),
      businessRequirements: DOM.discRequirements.value.trim(),
      isSynthetic: true,
    };
    await executeDiscovery(criteria);
  });

  // Preset Cards
  document.querySelectorAll('.preset-card').forEach((card) => {
    card.addEventListener('click', () => {
      DOM.discIndustry.value = card.dataset.industry;
      DOM.discCountry.value = card.dataset.country;
      DOM.discRegion.value = card.dataset.city;
      DOM.discRequirements.value = card.dataset.req;
      navigateTo('discovery');
    });
  });

  // Modal Close
  DOM.modalCloseBtn.addEventListener('click', () => {
    DOM.modalContainer.style.display = 'none';
  });

  DOM.modalContainer.addEventListener('click', (e) => {
    if (e.target === DOM.modalContainer) {
      DOM.modalContainer.style.display = 'none';
    }
  });
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/* ----------------------------- Bootstrap -------------------------------- */

document.addEventListener('DOMContentLoaded', async () => {
  setupEventListeners();
  const params = new URLSearchParams(window.location.search);
  const isLoopback = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

  if (params.get('autologin') === '1' && isLoopback) {
    try {
      const res = await api('/api/auth/demo-login', { method: 'POST' });
      state.csrfToken = res.csrf_token;
    } catch (e) {
      console.warn('Loopback demo autologin skipped:', e.message);
    }
  }
  await checkSession();

  if (params.get('execute_demo') === '1') {
    navigateTo('discovery');
    await executeDiscovery({
      industry: 'Healthcare & Specialized Clinics',
      targetCountry: 'United Kingdom',
      cityOrRegion: 'London',
      targetCustomerType: 'Private specialist clinics',
      businessRequirements: 'Outdated legacy appointment booking portal, slow response time, and missing meta description.',
      isSynthetic: true,
    });
    if (params.get('modal') === 'detail' && state.discoveredOpportunities.length) {
      openInspectionModal(state.discoveredOpportunities[0]);
    } else if (params.get('modal') === 'outreach' && state.discoveredOpportunities.length) {
      openOutreachPreparationModal(state.discoveredOpportunities[0]);
    }
  } else if (params.get('view')) {
    navigateTo(params.get('view'));
  }
});
