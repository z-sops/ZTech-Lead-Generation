'use strict';

const { summarizePacket } = require('../contracts/evidencePacket');
const { computeDigitalFootprint } = require('../research/digitalFootprint');
const { deriveSignals, UNSUPPORTED_SIGNALS } = require('../research/signals');
const { publicJob } = require('../research/researchState');
const { sanitizeUntrusted, WITHHELD } = require('../agent/sanitize');

/**
 * Lead Research Profile — one view model with the 15 sections the Lead Profile shows.
 * Every research claim carries refs (fact_id / finding_id / strength_id) and provenance.
 * Website-derived text is sanitised; instruction-like text is withheld.
 */
class ProfileService {
  constructor({ contexts, store, freshness, enrichment = null, clock = () => new Date() }) {
    this.enrichment = enrichment;
    this.contexts = contexts;
    this.store = store;
    this.freshness = freshness;
    this.clock = clock;
  }

  async build({ leadId, targetId }) {
    const now = this.clock();
    const ctx = await this.contexts.getContext(leadId, { targetId });
    const { view, packet } = ctx;
    const safe = (v, max = 500) => {
      if (v === null || v === undefined) return null;
      const r = sanitizeUntrusted(v, max);
      return r.flagged ? WITHHELD : r.text;
    };

    const facts = packet ? packet.facts.map((f) => ({
      fact_id: f.fact_id,
      key: f.key,
      area: f.area,
      label: safe(f.label, 200),
      value: typeof f.value === 'string' ? safe(f.value, 500) : f.value,
      untrusted: f.untrusted,
      source_url: f.source_url,
      provenance: f.provenance,
    })) : [];
    const findings = packet ? packet.findings.map((g) => ({
      finding_id: g.finding_id,
      rule_id: g.rule_id,
      area: g.area,
      title: safe(g.title, 300),
      severity: g.severity,
      basis: g.basis,
      observed: safe(g.observed, 1000),
      recommendation: safe(g.recommendation, 1000),
      urls: g.urls.slice(0, 10),
      fact_ids: g.fact_ids,
      provenance: g.provenance,
    })) : [];
    const strengths = packet ? packet.strengths.map((s) => ({
      strength_id: s.strength_id,
      area: s.area,
      statement: safe(s.statement, 500),
      fact_ids: s.fact_ids,
      finding_ids: s.finding_ids,
      provenance: s.provenance,
    })) : [];

    const missing = [];
    if (!view.has_email) missing.push({ source: 'lead', item: 'email', message: view.email_raw_present ? 'Email on the lead is not a valid address.' : 'No email address on the lead.' });
    if (!view.has_phone) missing.push({ source: 'lead', item: 'phone', message: 'No phone number on the lead.' });
    if (!view.has_website) missing.push({ source: 'lead', item: 'website', message: 'No website on the lead. This does not mean the company has no online presence.' });
    if (!view.industry) missing.push({ source: 'lead', item: 'industry', message: 'No industry on the lead.' });
    if (!view.city) missing.push({ source: 'lead', item: 'city', message: 'No city on the lead.' });
    if (!view.qualification_status) missing.push({ source: 'lead', item: 'qualification', message: 'No qualification status recorded.' });
    if (packet) {
      for (const n of packet.not_measured) missing.push({ source: 'research', item: `not_measured:${n.area}`, message: safe(n.reason, 300) });
      for (const l of packet.limitations) missing.push({ source: 'research', item: `limitation:${l.code}`, message: safe(l.message, 300) });
    } else {
      missing.push({ source: 'research', item: 'evidence', message: 'No research evidence yet.' });
    }

    const changes = await this.store.changes.listByLead(view.id);
    const enrichment = this.enrichment ? await this.enrichment.profile({ leadId: view.id }) : null;
    if (enrichment) {
      for (const f of Object.values(enrichment.fields)) {
        if (f.selected && typeof f.selected.value === 'string') f.selected.value = safe(f.selected.value, 1000);
        for (const a of f.alternatives) if (typeof a.value === 'string') a.value = safe(a.value, 1000);
      }
    }
    const history = await this.store.packets.listMetaByLead(view.id);

    return {
      lead_id: view.id,
      generated_at: now.toISOString(),
      identity: { name: view.name, website: view.website, address: view.address },
      contact: { email: view.email, phone: view.phone, email_valid: view.has_email },
      company: { industry: view.industry, business_type: view.business_type, city: view.city, country: view.country },
      data_quality: { level: view.data_quality, has_website: view.has_website, has_phone: view.has_phone, has_email: view.has_email },
      qualification: { status: view.qualification_status },
      icp_fit: ctx.icp_fit,
      digital_footprint: packet ? packet.digital_footprint : computeDigitalFootprint({ packet: null, leadView: view }),
      research_status: {
        state: ctx.research_state,
        job: ctx.job ? publicJob(ctx.job) : null,
      },
      evidence: { packet: summarizePacket(packet), facts },
      findings,
      strengths,
      missing_information: missing,
      freshness: packet ? {
        captured_at: packet.captured_at,
        expires_at: packet.freshness.expires_at,
        max_age_days: packet.freshness.max_age_days,
        fresh: this.freshness.isFresh(packet, now),
        age_days: this.freshness.ageDays(packet, now),
      } : null,
      provenance: packet ? packet.provenance : null,
      enrichment,
      research_history: {
        jobs: ctx.jobs.map(publicJob),
        packets: history,
        changes,
        signals: deriveSignals(changes),
        unsupported_signals: UNSUPPORTED_SIGNALS,
      },
    };
  }
}

module.exports = { ProfileService };
