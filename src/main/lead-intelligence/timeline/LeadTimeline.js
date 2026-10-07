'use strict';

/**
 * I6 - Unified Lead Timeline: ONE read-only projection over the records ZTech already keeps.
 *
 * It is computed on every request and never stored. Each source stays the system of record
 * for its own events: the Activity ledger stays the Activity ledger, OI history stays OI
 * history, and nothing here writes, reorders or merges anything in storage.
 *
 *   per-source read (safety cap 500 rows)
 *     -> map each row to ONE event shape (invalid time -> skipped and counted, never "now")
 *     -> merge + deterministic sort (at DESC, source order, event_id)
 *     -> GLOBAL window: the newest 500 merged events (frozen clarification 1)
 *     -> optional source filter, then a page of at most 50 after the `before` cursor
 *
 * It makes NO network call (T1): Opportunity Intelligence appears only through ZTech's own
 * records of it. It reads outreach only from the Activity ledger (T3), so a send is never
 * counted twice. It never infers an event nobody observed (delivered, opened, read, replied).
 */

const SOURCES = Object.freeze(['lead', 'research', 'enrichment', 'opportunity', 'pitch', 'outreach']);
const OPEN_TARGETS = Object.freeze(['research', 'enrichment', 'opportunity', 'pitch', 'outreach']);

const TIMELINE_LIMITS = Object.freeze({
  PER_SOURCE_CAP: 500,
  WINDOW: 500,
  PAGE_MAX: 50,
  ACTIVITY_PAGE: 100, // the Activity contract's own paging clamp
  DETAIL_MAX: 200,
});

/** Known Activity types -> closed timeline kinds. Anything else is OUTREACH_UNKNOWN (clarification 3). */
const ACTIVITY_KIND = Object.freeze({
  PITCH_APPROVED: { source: 'pitch', kind: 'PITCH_APPROVED', title: 'Pitch approved', open: 'pitch' },
  OUTREACH_READY: { source: 'outreach', kind: 'OUTREACH_READY', title: 'Lead marked ready for outreach', open: 'outreach' },
  APPROVAL_INVALIDATED: { source: 'pitch', kind: 'APPROVAL_INVALIDATED', title: 'Approval no longer valid (the pitch or its evidence changed)', open: 'pitch' },
  OUTREACH_SEND_BLOCKED: { source: 'outreach', kind: 'OUTREACH_SEND_BLOCKED', title: 'Send blocked before contacting a provider', open: 'outreach' },
  OUTREACH_SEND_ATTEMPTED: { source: 'outreach', kind: 'OUTREACH_SEND_ATTEMPTED', title: 'Send attempted', open: 'outreach' },
  OUTREACH_SEND_ACCEPTED: { source: 'outreach', kind: 'OUTREACH_SEND_ACCEPTED', title: 'Send accepted by the provider', open: 'outreach' },
  OUTREACH_SEND_FAILED: { source: 'outreach', kind: 'OUTREACH_SEND_FAILED', title: 'Send failed', open: 'outreach' },
});

const EVENT_KINDS = Object.freeze([
  'LEAD_COLLECTED',
  'ROUND1_RESEARCH_FINISHED', 'RESEARCH_REQUESTED', 'RESEARCH_FINISHED', 'EVIDENCE_CAPTURED', 'WEBSITE_CHANGE_DETECTED',
  'ENRICHMENT_FINISHED',
  'OI_RESEARCH_REQUESTED', 'OI_RESEARCH_FAILED', 'OI_REPORT_RECORDED',
  'PITCH_DRAFTED',
  ...Object.values(ACTIVITY_KIND).map((k) => k.kind),
  'OUTREACH_UNKNOWN',
]);

const FINISHED_RESEARCH = new Set(['complete', 'partial', 'failed', 'stale', 'blocked']);
const FINISHED_ENRICHMENT = new Set(['complete', 'partial', 'no_result', 'failed', 'blocked', 'stale']);
const SOURCE_RANK = Object.freeze(Object.fromEntries(SOURCES.map((s, i) => [s, i])));

/** A plain, bounded, single-line string - or null. Never markup, never a control character. */
function clean(v, max = TIMELINE_LIMITS.DETAIL_MAX) {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** A word safe to show as data (an unknown type, a change type). */
function token(v) {
  const s = clean(v, 60);
  return s ? s.replace(/[^A-Za-z0-9_.:-]/g, '_') : null;
}

function isoOrNull(v) {
  if (typeof v !== 'string' || !v.trim()) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function idPart(v) {
  return String(v == null ? '' : v).replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 120);
}

function compareEvents(a, b) {
  if (a.at !== b.at) return a.at < b.at ? 1 : -1;
  const ra = SOURCE_RANK[a.source];
  const rb = SOURCE_RANK[b.source];
  if (ra !== rb) return ra - rb;
  return a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0;
}

/** True when `e` sorts strictly AFTER the cursor (i.e. is older than the last event shown). */
function afterCursor(e, before) {
  const c = { at: before.at, source: before.source, event_id: before.event_id };
  if (!(c.source in SOURCE_RANK)) {
    // A cursor without a source still pages correctly on (at, event_id).
    return e.at < c.at || (e.at === c.at && e.event_id > c.event_id);
  }
  return compareEvents(c, e) < 0;
}

class LeadTimeline {
  /**
   * @param {object} deps
   * @param {object} deps.store          the Lead Intelligence store (SqlJsStore / MemoryStore)
   * @param {object} deps.leadSource     { getLead(id) }
   * @param {object} [deps.round1]       { listByLead(id) } round-1 research records
   * @param {object} [deps.opportunity]  the OI service (only its LOCAL association ledger is read)
   */
  constructor({ store, leadSource, round1 = null, opportunity = null } = {}) {
    if (!store || !leadSource) throw new TypeError('store and leadSource are required');
    this.store = store;
    this.leadSource = leadSource;
    this.round1 = round1;
    this.opportunity = opportunity;
  }

  /**
   * @param {string} leadId
   * @param {{limit?:number, before?:{at:string,event_id:string,source?:string}|null, sources?:string[]}} [opts]
   */
  async forLead(leadId, { limit = TIMELINE_LIMITS.PAGE_MAX, before = null, sources = null } = {}) {
    const lead = String(leadId);
    const pageSize = Math.max(1, Math.min(TIMELINE_LIMITS.PAGE_MAX, Number.isInteger(limit) ? limit : TIMELINE_LIMITS.PAGE_MAX));
    const wanted = Array.isArray(sources) && sources.length ? new Set(sources.filter((s) => SOURCES.includes(s))) : null;

    const unavailable = [];
    let skipped = 0;
    const all = [];
    const collect = async (source, fn) => {
      let produced;
      try {
        produced = await fn();
      } catch {
        unavailable.push(source);
        return;
      }
      for (const e of produced) {
        if (!e || !e.at) { skipped += 1; continue; }
        all.push(e);
      }
    };

    await collect('lead', () => this.leadEvents(lead));
    await collect('research', () => this.researchEvents(lead));
    await collect('enrichment', () => this.enrichmentEvents(lead));
    await collect('opportunity', () => this.opportunityEvents(lead));
    await collect('pitch', () => this.pitchEvents(lead));
    await collect('outreach', () => this.activityEvents(lead));

    all.sort(compareEvents);
    // Frozen clarification 1: the GLOBAL window is the newest 500 merged events.
    const windowed = all.slice(0, TIMELINE_LIMITS.WINDOW);
    const filtered = wanted ? windowed.filter((e) => wanted.has(e.source)) : windowed;
    const start = before && typeof before === 'object' && typeof before.at === 'string'
      ? filtered.filter((e) => afterCursor(e, before))
      : filtered;
    const events = start.slice(0, pageSize);
    const last = events[events.length - 1];
    return {
      lead_id: lead,
      events,
      has_more: start.length > events.length,
      next: start.length > events.length && last ? { at: last.at, source: last.source, event_id: last.event_id } : null,
      total_in_window: filtered.length,
      window_limit: TIMELINE_LIMITS.WINDOW,
      truncated: all.length > TIMELINE_LIMITS.WINDOW,
      skipped,
      unavailable_sources: unavailable,
      affects_outreach: false,
    };
  }

  // --- sources -------------------------------------------------------------

  event(source, kind, rowId, at, title, { detail = null, open = null, phase = null } = {}) {
    const iso = isoOrNull(at);
    if (!iso) return null; // counted as skipped by the caller - never placed at "now"
    return Object.freeze({
      event_id: `${source}:${idPart(rowId)}${phase ? `:${phase}` : ''}`,
      at: iso,
      source,
      kind,
      title,
      detail: clean(detail),
      open: open && OPEN_TARGETS.includes(open) ? open : null,
    });
  }

  async leadEvents(lead) {
    const row = await this.leadSource.getLead(lead);
    if (!row) return [];
    const at = row.collectedAt || row.collected_at || null;
    if (at == null) return [];
    return [this.event('lead', 'LEAD_COLLECTED', row.id != null ? row.id : lead, at, 'Lead collected', { detail: row.keyword ? `Search: ${row.keyword}` : null })];
  }

  async researchEvents(lead) {
    const out = [];
    const cap = TIMELINE_LIMITS.PER_SOURCE_CAP;
    if (this.round1 && typeof this.round1.listByLead === 'function') {
      for (const r of (await this.round1.listByLead(lead)).slice(0, cap)) {
        if (!r || !r.finishedAt) continue;
        const phase = token(r.phase) || 'finished';
        out.push(this.event('research', 'ROUND1_RESEARCH_FINISHED', r.id || r.jobId || `${lead}-${r.finishedAt}`, r.finishedAt,
          'Website research finished', { detail: `Result: ${phase}`, open: 'research' }));
      }
    }
    const jobs = this.store.jobs && typeof this.store.jobs.listByLead === 'function' ? await this.store.jobs.listByLead(lead) : [];
    for (const j of jobs.slice(0, cap)) {
      if (!j) continue;
      out.push(this.event('research', 'RESEARCH_REQUESTED', j.job_id, j.created_at, 'Website research requested', { open: 'research', phase: 'requested' }));
      if (FINISHED_RESEARCH.has(j.state) && j.finished_at) {
        out.push(this.event('research', 'RESEARCH_FINISHED', j.job_id, j.finished_at, 'Website research finished', { detail: `Result: ${token(j.state)}`, open: 'research', phase: 'finished' }));
      }
    }
    const packets = this.store.packets && typeof this.store.packets.listMetaByLead === 'function' ? await this.store.packets.listMetaByLead(lead) : [];
    for (const p of packets.slice(0, cap)) {
      if (!p) continue;
      out.push(this.event('research', 'EVIDENCE_CAPTURED', p.packet_id, p.captured_at, 'Evidence captured',
        { detail: p.research_status ? `Research status: ${token(p.research_status)}` : null, open: 'research' }));
    }
    const changes = this.store.changes && typeof this.store.changes.listByLead === 'function' ? await this.store.changes.listByLead(lead) : [];
    for (const c of changes.slice(0, cap)) {
      if (!c) continue;
      out.push(this.event('research', 'WEBSITE_CHANGE_DETECTED', c.change_id, c.detectedAt || c.detected_at, 'Website change detected',
        { detail: c.type ? `Change: ${token(c.type)}` : null, open: 'research' }));
    }
    return out;
  }

  async enrichmentEvents(lead) {
    const jobs = this.store.enrichmentJobs && typeof this.store.enrichmentJobs.listByLead === 'function'
      ? await this.store.enrichmentJobs.listByLead(lead) : [];
    const out = [];
    for (const j of jobs.slice(0, TIMELINE_LIMITS.PER_SOURCE_CAP)) {
      if (!j || !j.finished_at || !FINISHED_ENRICHMENT.has(j.state)) continue;
      // No drawer tab shows enrichment on its own, so there is no Open target (clarification 2).
      out.push(this.event('enrichment', 'ENRICHMENT_FINISHED', j.job_id, j.finished_at, 'Contact enrichment finished', { detail: `Result: ${token(j.state)}` }));
    }
    return out;
  }

  async opportunityEvents(lead) {
    const out = [];
    const assoc = this.opportunity && this.opportunity.associations && typeof this.opportunity.associations.listForLead === 'function'
      ? this.opportunity.associations.listForLead(lead) : [];
    for (const a of assoc.slice(0, TIMELINE_LIMITS.PER_SOURCE_CAP)) {
      out.push(this.event('opportunity', 'OI_REPORT_RECORDED', a.research_id, a.generated_at, 'Opportunity report recorded',
        { detail: a.status ? `Status: ${token(a.status)}` : null, open: 'opportunity' }));
    }
    const ledger = this.store.oiRefreshRequests;
    const reqs = ledger && typeof ledger.listByLead === 'function' ? await ledger.listByLead(lead, TIMELINE_LIMITS.PER_SOURCE_CAP) : [];
    for (const r of reqs) {
      if (!r) continue;
      out.push(this.event('opportunity', 'OI_RESEARCH_REQUESTED', r.request_id, r.created_at, 'Opportunity research requested', { open: 'opportunity', phase: 'requested' }));
      if (r.state === 'failed') {
        out.push(this.event('opportunity', 'OI_RESEARCH_FAILED', r.request_id, r.updated_at, 'Opportunity research did not complete',
          { detail: r.error_code ? `Reason: ${token(r.error_code)}` : null, open: 'opportunity', phase: 'failed' }));
      }
    }
    return out;
  }

  async pitchEvents(lead) {
    const p = this.store.pitches;
    const list = p && typeof p.listByLead === 'function' ? await p.listByLead(lead, TIMELINE_LIMITS.PER_SOURCE_CAP) : [];
    return list.map((x) => this.event('pitch', 'PITCH_DRAFTED', x.pitch_id, x.created_at, 'Pitch drafted',
      { detail: x.status ? `Status: ${token(x.status)}` : null, open: 'pitch' }));
  }

  async activityEvents(lead) {
    const a = this.store.activity;
    if (!a || typeof a.list !== 'function') return [];
    const out = [];
    for (let offset = 0; offset < TIMELINE_LIMITS.PER_SOURCE_CAP; offset += TIMELINE_LIMITS.ACTIVITY_PAGE) {
      const page = await a.list({ leadId: lead, limit: TIMELINE_LIMITS.ACTIVITY_PAGE, offset });
      const rows = page && Array.isArray(page.rows) ? page.rows : [];
      for (const r of rows) out.push(this.activityEvent(r));
      if (rows.length < TIMELINE_LIMITS.ACTIVITY_PAGE) break;
    }
    return out;
  }

  activityEvent(r) {
    const known = ACTIVITY_KIND[r.activity_type];
    const m = r.metadata && typeof r.metadata === 'object' ? r.metadata : {};
    if (!known) {
      // Clarification 3: a fixed safe title; the raw type only as sanitized detail.
      return this.event('outreach', 'OUTREACH_UNKNOWN', r.activity_id, r.created_at, 'Outreach activity recorded',
        { detail: `Type: ${token(r.activity_type) || 'unknown'}`, open: 'outreach' });
    }
    const bits = [];
    if (m.channel) bits.push(m.channel === 'whatsapp' ? 'WhatsApp' : m.channel === 'email' ? 'Email' : token(m.channel));
    if (m.reason) bits.push(clean(m.reason, 120));
    if (m.failureCode) bits.push(`Code: ${token(m.failureCode)}`);
    return this.event(known.source, known.kind, r.activity_id, r.created_at, known.title, { detail: bits.filter(Boolean).join(' · ') || null, open: known.open });
  }
}

module.exports = { LeadTimeline, SOURCES, OPEN_TARGETS, EVENT_KINDS, ACTIVITY_KIND, TIMELINE_LIMITS, compareEvents };
