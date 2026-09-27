'use strict';

const { FACT_KEYS } = require('../contracts/constants');

/**
 * EvidencePacketEnrichmentProvider — a real, local enrichment source.
 * It performs no network calls: it reads the lead's latest stored EvidencePacket
 * (Zuni-SEO research) and exposes a few website facts as enrichment fields.
 *
 * source_ref is the fact_id (or packet_id for the audited domain), so every enriched
 * value traces back to the research evidence and its provenance.
 * Failed or stale packets are not used (the field is simply not returned -> UNKNOWN).
 */
class EvidencePacketEnrichmentProvider {
  constructor({ store, freshness, clock = () => new Date() }) {
    this.id = 'zuni-seo-evidence';
    this.name = 'Zuni-SEO research evidence';
    this.store = store;
    this.freshness = freshness;
    this.clock = clock;
  }

  capabilities() {
    return { fields: ['website.platform', 'website.language', 'website.audited_domain'], tier: 'first_party', requires: ['lead_id'] };
  }

  async status() {
    return { state: 'READY' };
  }

  async enrich({ lead, fields }) {
    const packet = await this.store.packets.latestForLead(lead.lead_id);
    if (!packet || packet.research_status === 'failed' || !this.freshness.isFresh(packet, this.clock())) {
      return { provider_ref: null, fields: [] };
    }
    const fact = (key) => packet.facts.find((f) => f.key === key && f.value !== null) || null;
    const out = [];
    const want = new Set(fields);
    if (want.has('website.platform')) {
      const f = fact(FACT_KEYS.TECH_PLATFORM);
      if (f && typeof f.value === 'string') out.push({ field: 'website.platform', status: 'FOUND', value: f.value, source_ref: f.fact_id });
    }
    if (want.has('website.language')) {
      const f = fact(FACT_KEYS.SITE_LANGUAGE);
      if (f && typeof f.value === 'string') out.push({ field: 'website.language', status: 'FOUND', value: f.value, source_ref: f.fact_id });
    }
    if (want.has('website.audited_domain') && packet.audited_domain) {
      out.push({ field: 'website.audited_domain', status: 'FOUND', value: packet.audited_domain, source_ref: packet.packet_id });
    }
    return { provider_ref: packet.packet_id, fields: out };
  }
}

module.exports = { EvidencePacketEnrichmentProvider };
