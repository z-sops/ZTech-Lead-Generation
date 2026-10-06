'use strict';

const { OI_ID, SNAP_ID } = require('./OpportunityIntelligenceGateway');

/**
 * lead_id <-> OI research_id <-> snapshot_id <-> prospect entity_key.
 *
 * `lead_id` is ZTech's authoritative identity and is always the left-hand side.
 * OI's `entity_key` / `research_id` / `snapshot_id` are OI's, and are stored
 * exactly as OI minted them.
 *
 * THE JOIN IS NEVER A NAME MATCH. A business name is not an identity: "Acme
 * Ltd", "ACME LIMITED" and "Acme" are three strings for possibly three
 * different companies, and a rename would silently re-attach old intelligence
 * to the wrong prospect. `assertLeadAssociation` is the only writer and it takes
 * the ids that OI itself returned on the report ZTech just validated, so the
 * association cannot be asserted from anything the renderer supplied.
 *
 * PERSISTENCE (I3, migration 006). Reads stay synchronous and in-process; the
 * optional `backing` (store.oiAssociations) is loaded once by `load()` and every new
 * association is written through to it. Only the seven persisted columns survive a
 * restart (lead_id, research_id, snapshot_id, entity_key, status, generated_at,
 * recorded_at). The report body is never stored here - it stays in OI and is
 * re-fetched by research_id.
 */

/** Migration 006 is applied (I3). Kept as a record of what the table holds. */
const MIGRATION_NEED = Object.freeze({
  migration_required: true,
  applied: true,
  file: '006_oi_associations.sql',
  tables: ['li_oi_associations'],
  columns: ['lead_id', 'research_id', 'snapshot_id', 'entity_key', 'status', 'generated_at', 'recorded_at'],
  rationale: 'ZTech persists only the minimum association needed to reopen intelligence for a lead. '
    + 'The detailed report is never copied into whatsapp.db.',
});

const MAX_PER_LEAD = 50;

class OpportunityAssociationStore {
  constructor({ clock = () => new Date(), maxPerLead = MAX_PER_LEAD, backing = null, logger = null } = {}) {
    this.clock = clock;
    this.maxPerLead = maxPerLead;
    this.backing = backing && typeof backing.put === 'function' && typeof backing.listAll === 'function' ? backing : null;
    this.logger = logger;
    this.byResearchId = new Map(); // research_id -> association
    this.byLeadId = new Map();     // lead_id    -> [association] newest first
    this.pendingWrites = new Set();
  }

  /**
   * Load persisted associations (migration 006). Rows that do not carry valid OI ids are
   * skipped, never repaired. Never throws: an unreadable table leaves the store empty,
   * which renders as "not researched yet", never as a crash.
   */
  async load() {
    if (!this.backing) return 0;
    let stored = [];
    try {
      stored = await this.backing.listAll();
    } catch (e) {
      this.warn(`opportunity associations could not be loaded: ${e && e.message}`);
      return 0;
    }
    let loaded = 0;
    for (const r of Array.isArray(stored) ? stored : []) {
      if (!r || !OI_ID.pattern.test(String(r.research_id || '')) || !SNAP_ID.pattern.test(String(r.snapshot_id || ''))) continue;
      if (!r.lead_id || !r.entity_key || this.byResearchId.has(String(r.research_id))) continue;
      const a = Object.freeze({
        association_id: `oia_${r.lead_id}_${r.research_id}`,
        lead_id: String(r.lead_id),
        research_id: String(r.research_id),
        snapshot_id: String(r.snapshot_id),
        entity_key: String(r.entity_key),
        status: String(r.status),
        generated_at: String(r.generated_at),
        schema_version: null, // not persisted (migration 006 holds seven columns only)
        created_at: String(r.recorded_at),
      });
      this.byResearchId.set(a.research_id, a);
      const list = this.byLeadId.get(a.lead_id) || [];
      list.push(a);
      this.byLeadId.set(a.lead_id, list);
      loaded += 1;
    }
    for (const [lead, list] of this.byLeadId) {
      list.sort((x, y) => (x.created_at < y.created_at ? 1 : x.created_at > y.created_at ? -1 : (x.research_id < y.research_id ? 1 : -1)));
      if (list.length > this.maxPerLead) list.length = this.maxPerLead;
      this.byLeadId.set(lead, list);
    }
    return loaded;
  }

  /** Resolves when every write-through started so far has settled (tests, shutdown). */
  async flush() {
    await Promise.allSettled([...this.pendingWrites]);
  }

  warn(msg) {
    if (this.logger && typeof this.logger.warn === 'function') this.logger.warn(`[opportunity-intelligence] ${msg}`);
  }

  persist(a) {
    if (!this.backing) return;
    const rec = {
      research_id: a.research_id,
      lead_id: a.lead_id,
      snapshot_id: a.snapshot_id,
      entity_key: a.entity_key,
      status: a.status,
      generated_at: a.generated_at,
      recorded_at: a.created_at,
    };
    let p;
    try {
      p = Promise.resolve(this.backing.put(rec, { keep: this.maxPerLead }));
    } catch (e) {
      p = Promise.reject(e);
    }
    const tracked = p.catch((e) => this.warn(`opportunity association could not be saved: ${e && e.message}`))
      .finally(() => this.pendingWrites.delete(tracked));
    this.pendingWrites.add(tracked);
  }

  /**
   * Record the association proven by a validated report.
   *
   * @param {object} input
   * @param {string|number} input.leadId   ZTech's authoritative lead id
   * @param {object} input.report          a report that already passed validateIntelligenceReport
   * @returns {{ok:true, association:object} | {ok:false, error:string}}
   */
  assertLeadAssociation({ leadId, report }) {
    if (leadId === undefined || leadId === null || leadId === '') {
      return { ok: false, error: 'leadId is required' };
    }
    if (!report || typeof report !== 'object') return { ok: false, error: 'report is required' };
    const researchId = report.research_id;
    const snapshotId = report.snapshot_id;
    const entityKey = report.prospect && report.prospect.entity_key;
    if (!OI_ID.pattern.test(String(researchId || ''))) return { ok: false, error: 'report.research_id is not an OI research id' };
    if (!SNAP_ID.pattern.test(String(snapshotId || ''))) return { ok: false, error: 'report.snapshot_id is not an OI snapshot id' };
    if (!entityKey || typeof entityKey !== 'string') return { ok: false, error: 'report.prospect.entity_key is required' };

    const lead = String(leadId);
    const association = Object.freeze({
      association_id: `oia_${lead}_${researchId}`,
      lead_id: lead,
      research_id: String(researchId),
      snapshot_id: String(snapshotId),
      entity_key: String(entityKey),
      status: String(report.status),
      generated_at: String(report.generated_at),
      schema_version: String(report.schema_version),
      created_at: this.clock().toISOString(),
    });

    const existing = this.byResearchId.get(association.research_id);
    if (existing) {
      if (existing.lead_id !== lead) {
        // research_id is OI-unique; two different leads claiming it means the
        // caller wired something wrong. Refuse rather than steal the mapping.
        return { ok: false, error: 'research_id is already associated with a different lead_id' };
      }
      return { ok: true, association: existing, updated: false };
    }

    this.byResearchId.set(association.research_id, association);
    const list = this.byLeadId.get(lead) || [];
    list.unshift(association);
    if (list.length > this.maxPerLead) list.length = this.maxPerLead;
    this.byLeadId.set(lead, list);
    this.persist(association);
    return { ok: true, association, updated: true };
  }

  /** Most recent association for a lead, or null. */
  latestForLead(leadId) {
    if (leadId === undefined || leadId === null || leadId === '') return null;
    const list = this.byLeadId.get(String(leadId));
    return (list && list[0]) || null;
  }

  /** Every association for a lead, newest first. */
  listForLead(leadId) {
    if (leadId === undefined || leadId === null || leadId === '') return [];
    return [...(this.byLeadId.get(String(leadId)) || [])];
  }

  /** Reverse lookup: which lead owns this OI research_id. */
  leadForResearch(researchId) {
    const a = this.byResearchId.get(String(researchId || ''));
    return a ? a.lead_id : null;
  }

  associationForResearch(researchId) {
    return this.byResearchId.get(String(researchId || '')) || null;
  }

  /** Renderer-safe view: no internals, ids only. */
  toView(leadId) {
    return {
      lead_id: leadId === null || leadId === undefined ? null : String(leadId),
      count: (this.byLeadId.get(String(leadId)) || []).length,
      associations: this.listForLead(leadId).map((a) => ({ ...a })),
    };
  }
}

module.exports = { OpportunityAssociationStore, MIGRATION_NEED, MAX_PER_LEAD };