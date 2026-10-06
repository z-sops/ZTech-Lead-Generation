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
 * In Phase I2 this is an in-process store. Persistence is deliberately NOT
 * added here: adding a `li_*` table means a production migration to ZTech's
 * whatsapp.db, which is reported separately before it is done. See
 * MIGRATION-NEED below.
 */

/**
 * The smallest migration I2 would need, documented rather than applied.
 *
 * Nothing here is executed. `li_evidence_packets` already stores
 * (lead_id, job_id, research_status, captured_at) but has no research_id,
 * snapshot_id or OI entity_key, and its job_id is Zuni-SEO's - so the tuple
 * genuinely cannot be expressed there. The minimal addition is:
 *
 *   CREATE TABLE li_oi_associations (
 *     association_id TEXT PRIMARY KEY,
 *     lead_id       TEXT NOT NULL,
 *     research_id   TEXT NOT NULL,
 *     snapshot_id   TEXT NOT NULL,
 *     entity_key    TEXT NOT NULL,
 *     status        TEXT NOT NULL,
 *     generated_at  TEXT NOT NULL,
 *     provider_status_json TEXT NOT NULL,
 *     created_at    TEXT NOT NULL
 *   );
 *   CREATE INDEX li_oi_assoc_lead  ON li_oi_associations(lead_id, generated_at DESC);
 *   CREATE UNIQUE INDEX li_oi_assoc_research ON li_oi_associations(research_id);
 *
 * One row per research_id, keyed by research_id so a re-fetch is idempotent.
 * It stores NO report body: the full IntelligenceReport stays in OI's own
 * SQLite store and is re-fetched by research_id.
 */
const MIGRATION_NEED = Object.freeze({
  migration_required: true,
  applied: false,
  reason: 'No existing ZTech table can hold (lead_id, research_id, snapshot_id, entity_key, status). '
    + 'li_evidence_packets stores Zuni-SEO job_id only, and OI has its own store.',
  file: '006_oi_associations.sql',
  tables: ['li_oi_associations'],
  also_required: [
    'SqlJsStore accessor (associationForLead / putAssociation / associationForResearch)',
    'LI_TABLES entry in src/main/lead-intelligence/lead-intelligence-runtime.js',
    'MIGRATIONS entry in src/main/lead-intelligence/persistence/migrations.js (regenerate via scripts/embed-migrations.js)',
  ],
  rationale: 'ZTech persists only the minimum association needed to reopen intelligence for a lead. '
    + 'The detailed report is never copied into whatsapp.db.',
});

const MAX_PER_LEAD = 50;

class OpportunityAssociationStore {
  constructor({ clock = () => new Date(), maxPerLead = MAX_PER_LEAD } = {}) {
    this.clock = clock;
    this.maxPerLead = maxPerLead;
    this.byResearchId = new Map(); // research_id -> association
    this.byLeadId = new Map();     // lead_id    -> [association] newest first
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