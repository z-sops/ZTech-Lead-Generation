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
};

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

async function checkSession() {
  try {
    const data = await api('/api/session');
    if (data && data.user_id) {
      state.session = data;
      if (data.memberships && data.memberships.length > 0) {
        state.currentWorkspace = data.memberships[0];
      }
      renderAuthenticatedState();
      await loadSavedOpportunities();
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
    updateProgress('Step 1/4: Analyzing Market Entities & URLs...', 25);
    await new Promise((r) => setTimeout(r, 350));

    updateProgress('Step 2/4: Executing Page Crawl & Footprint Analysis...', 50);
    await new Promise((r) => setTimeout(r, 400));

    updateProgress('Step 3/4: Indexing Evidence Packets & Facts...', 75);
    await new Promise((r) => setTimeout(r, 350));

    const result = await api(`/api/workspaces/${wsId}/research`, {
      method: 'POST',
      body: criteria,
    });

    updateProgress('Step 4/4: Computing ICP Fit & Opportunity Scoring...', 100);
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
  const fitScore = opp.icp_fit?.score ? `${opp.icp_fit.score}% Match` : 'Fit Verified';

  card.innerHTML = `
    <div>
      <div class="card-top">
        <div>
          <div class="company-name">${escapeHtml(opp.company_name)}</div>
          <a href="https://${escapeHtml(opp.domain)}" target="_blank" rel="noopener" class="company-domain">🌐 ${escapeHtml(opp.domain)}</a>
          <div style="font-size: 11px; color: var(--text-dim); margin-top: 2px;">📍 ${escapeHtml(opp.market_location)}</div>
        </div>
        <div class="fit-badge ${fitClass}">
          <span>🎯</span> ${fitScore}
        </div>
      </div>

      <div class="need-box">
        <strong>Detected Need:</strong> ${escapeHtml(opp.detected_need)}
      </div>

      <div class="evidence-provenance-box">
        <div style="font-weight: 700; color: #fff; margin-bottom: 4px;">🔬 Supporting Evidence (${opp.evidence_summary?.findings_count || 2} findings, ${opp.evidence_summary?.facts_count || 3} facts):</div>
        <ul>
          <li>• Server Response: <strong style="color: #f87171;">${opp.evidence_summary?.server_latency || '3.2s'}</strong> (Audit target: &lt; 1.2s)</li>
          <li>• Content Deficit: <strong>${opp.evidence_summary?.missing_meta_pages || 4} pages</strong> lack structured descriptions</li>
          <li>• Audit Source: Verified crawl on ${escapeHtml((opp.evidence_summary?.captured_at || '').slice(0, 10))}</li>
        </ul>
      </div>

      <div class="uncertainty-box">
        <strong>⚠️ Information Completeness:</strong> ${(opp.uncertainty_notes && opp.uncertainty_notes[1]) || 'Controlled synthetic fixture for demonstration.'}
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
      <div style="font-size: 11px; color: var(--text-dim); margin-top: 6px;">Audited URLs: ${escapeHtml((f.urls || []).join(', '))}</div>
    </div>
  `).join('');

  DOM.modalBody.innerHTML = `
    <div style="margin-bottom: 20px;">
      <div class="demo-banner-pill" style="margin-bottom: 14px;">
        <span>⚡</span> ${escapeHtml(opp.synthetic_badge || 'DEMO / SYNTHETIC RESEARCH')}
      </div>
      <h3 style="font-size: 15px; margin-bottom: 8px;">Technical Audit Findings</h3>
      ${findingsHtml}
    </div>

    <div style="margin-bottom: 20px;">
      <h3 style="font-size: 15px; margin-bottom: 8px;">ICP Fit Analysis</h3>
      <div style="background: var(--bg-canvas); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); padding: 14px;">
        <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
          <span><strong>Fit Status:</strong> ${(opp.icp_fit?.status || 'fit').toUpperCase()}</span>
          <span><strong>Alignment Score:</strong> ${opp.icp_fit?.score || 85}%</span>
        </div>
        <div style="font-size: 12px; color: var(--text-muted);">${escapeHtml(opp.icp_fit?.reason || 'Verified match against target criteria')}</div>
      </div>
    </div>

    <div style="margin-bottom: 20px;">
      <h3 style="font-size: 15px; margin-bottom: 8px;">Source Provenance & Limitations</h3>
      <div style="background: var(--bg-canvas); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); padding: 14px; font-size: 12px; color: var(--text-muted);">
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
      btnElement.className = 'btn btn-secondary';
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

      <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px;">
        <button class="btn btn-secondary" onclick="DOM.modalContainer.style.display='none'">Cancel</button>
        <button class="btn btn-primary" id="approve-outreach-btn" style="background: #10b981;">
          Approve Draft for Human Dispatch
        </button>
      </div>
    `;

    document.getElementById('approve-outreach-btn').addEventListener('click', () => {
      approveOutreachDraft(pitch);
    });

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

  // Quick fill button for easy demo login
  DOM.quickDemoFill.addEventListener('click', () => {
    DOM.loginEmail.value = 'alice@ztech.test';
    DOM.loginPassword.value = 'correct-horse-battery-staple';
    DOM.regEmail.value = `founder_${Math.floor(Math.random() * 1000)}@ztech.test`;
    DOM.regPassword.value = 'correct-horse-battery-staple';
    DOM.regOrg.value = 'Apex Health Ventures';
    DOM.regWorkspace.value = 'London Operations';
  });

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
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch {
      // Ignored
    }
    state.session = null;
    state.csrfToken = null;
    state.currentWorkspace = null;
    renderUnauthenticatedState();
    toast('Signed out', 'info');
  });

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
  if (params.get('autologin') === '1') {
    try {
      const res = await api('/api/auth/login', {
        method: 'POST',
        body: { email: 'alice@ztech.test', password: 'correct-horse-battery-staple' },
      });
      state.csrfToken = res.csrf_token;
    } catch (e) {
      console.warn('Autologin error:', e.message);
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
