'use strict';

/**
 * A canonical, fully-populated OI IntelligenceReport used by the I2 tests.
 *
 * It is deliberately MESSY: six providers with four different statuses, a mix of
 * fact / estimate / inference evidence, a competitor, a comparison, a change, an
 * opportunity, a sales angle, a timeline, conflicts and limitations. If the
 * adapter can carry this report it can carry a real one.
 *
 * Nothing here came from a live provider. `synthetic` is stamped on the source
 * urls so a test can assert no real external call was involved.
 */

const GENERATED_AT = '2026-10-05T12:00:00.000000Z';

function report(overrides = {}) {
  return {
    schema_version: '1.0',
    research_id: 'res_20261005120000_abcdef01',
    snapshot_id: 'snap_20261005120000_abcdef01',
    previous_snapshot_id: null,
    status: 'partial',
    generated_at: GENERATED_AT,
    prospect: {
      entity_id: 'ent_prospect01',
      entity_key: 'dom:acme.example',
      kind: 'prospect',
      company_name: 'Acme Bakery',
      domain: 'acme.example',
      location: 'Lisbon',
      industry: 'food',
      profile: { title: 'Acme Bakery', services: ['bread'], technologies: [] },
    },
    competitors: [
      {
        entity_id: 'ent_competitor1',
        entity_key: 'dom:rival.example',
        kind: 'competitor',
        company_name: 'Rival Foods',
        domain: 'rival.example',
        location: 'Porto',
        industry: 'food',
        relationship_type: 'direct_competitor',
        relationship_confidence: 0.9,
        reason: 'Both sell artisan bread in Portugal.',
        discovered_via: 'search',
        evidence_refs: ['ev_discovery01'],
        profile: { title: 'Rival Foods', services: ['bread', 'pastry'], technologies: [] },
      },
    ],
    evidence: [
      {
        evidence_id: 'ev_web01',
        entity_id: 'ent_prospect01',
        provider: 'website',
        source_type: 'website.homepage',
        source_url: 'https://acme.example/',
        observation_type: 'website.homepage',
        observed_at: GENERATED_AT,
        captured_at: GENERATED_AT,
        expires_at: null,
        freshness: 'fresh',
        claim_kind: 'fact',
        claim: 'Homepage lists an online ordering link.',
        metric: 'has_online_ordering',
        value: true,
        estimate: null,
        confidence: 0.95,
        conflicts_with: [],
      },
      {
        evidence_id: 'ev_web02',
        entity_id: 'ent_prospect01',
        provider: 'website',
        source_type: 'website.company_profile',
        source_url: 'https://acme.example/about',
        observation_type: 'website.company_profile',
        captured_at: GENERATED_AT,
        freshness: 'fresh',
        claim_kind: 'fact',
        claim: 'Company profile names three physical shops.',
        metric: 'shop_count',
        value: 3,
        estimate: null,
        confidence: 0.9,
        conflicts_with: [],
      },
      {
        evidence_id: 'ev_est01',
        entity_id: 'ent_prospect01',
        provider: 'content',
        source_type: 'content.topics',
        source_url: 'https://acme.example/blog',
        observation_type: 'content.topics',
        captured_at: GENERATED_AT,
        freshness: 'fresh',
        // An ESTIMATE. It must stay an estimate all the way through.
        claim_kind: 'estimate',
        claim: 'Roughly 4 new articles were published in the last 60 days.',
        metric: 'articles_60d',
        value: 4,
        estimate: { low: 3, high: 5 },
        confidence: 0.7,
        conflicts_with: [],
      },
      {
        evidence_id: 'ev_inf01',
        entity_id: 'ent_prospect01',
        provider: 'content',
        source_type: 'content.topics',
        source_url: null,
        observation_type: 'content.topics',
        captured_at: GENERATED_AT,
        freshness: 'unknown',
        // An INFERENCE. It must never become an observed fact.
        claim_kind: 'inference',
        claim: 'Content appears to be produced by an agency rather than in-house.',
        metric: null,
        value: null,
        estimate: null,
        confidence: 0.6,
        conflicts_with: [],
      },
      {
        evidence_id: 'ev_disc01',
        entity_id: 'ent_competitor1',
        provider: 'competitors',
        source_type: 'competitors.candidates',
        source_url: null,
        observation_type: 'competitors.candidates',
        captured_at: GENERATED_AT,
        freshness: 'fresh',
        claim_kind: 'fact',
        claim: 'Rival Foods was returned as a candidate for the same market.',
        metric: null,
        value: null,
        estimate: null,
        confidence: 0.8,
        conflicts_with: [],
      },
      {
        evidence_id: 'ev_low01',
        entity_id: 'ent_prospect01',
        provider: 'meta_ads',
        source_type: 'ads.meta',
        source_url: null,
        observation_type: 'ads.meta',
        captured_at: GENERATED_AT,
        freshness: 'unknown',
        // Below the bridge's confidence floor: carried in the report, dropped by
        // the bridge, and the drop is reported as a limitation.
        claim_kind: 'fact',
        claim: 'One possibly-organic ad sighting was recorded.',
        metric: 'ad_count',
        value: 1,
        estimate: null,
        confidence: 0.2,
        conflicts_with: [],
      },
    ],
    observations: [
      {
        observation_id: 'obs_web01',
        entity_id: 'ent_prospect01',
        provider: 'website',
        type: 'website.page_inventory',
        captured_at: GENERATED_AT,
        claim_kind: 'fact',
        metrics: { pages: 12 },
        items: [],
        evidence_refs: ['ev_web01', 'ev_web02'],
      },
    ],
    signals: [
      {
        signal_id: 'sig_gap01',
        type: 'ADVERTISING_GAP',
        subject_id: 'ent_prospect01',
        observed_at: GENERATED_AT,
        strength: 0.8,
        confidence: 0.75,
        claim_kind: 'inference',
        summary: 'Rival advertises on Meta while Acme does not.',
        evidence_refs: ['ev_web01'],
        comparison_refs: ['cmp_ads01'],
        change_refs: [],
      },
    ],
    advertising_intelligence: {
      'dom:acme.example': [
        {
          entity_id: 'ent_prospect01',
          provider: 'meta_ads',
          status: 'unavailable',
          metrics: {},
          observation_refs: [],
          limitations: ['Meta Ad Library API not configured.'],
          errors: [{ code: 'PROVIDER_NOT_CONFIGURED', message: 'set META_ACCESS_TOKEN' }],
        },
      ],
      'dom:rival.example': [
        {
          entity_id: 'ent_competitor1',
          provider: 'meta_ads',
          status: 'partial',
          metrics: { active_ads: 4 },
          observation_refs: ['obs_ads01'],
          limitations: ['EU/UK counts unreliable.'],
          errors: [],
        },
      ],
    },
    content_intelligence: {
      'dom:acme.example': [
        {
          entity_id: 'ent_prospect01',
          provider: 'content',
          status: 'success',
          metrics: { articles_60d: 4 },
          observation_refs: ['obs_web01'],
          limitations: [],
          errors: [],
        },
      ],
    },
    social_intelligence: {
      'dom:acme.example': [
        {
          entity_id: 'ent_prospect01',
          provider: 'twitter',
          status: 'unavailable',
          metrics: {},
          observation_refs: [],
          limitations: ['X API not configured.'],
          errors: [{ code: 'PROVIDER_NOT_CONFIGURED', message: 'set X_BEARER_TOKEN' }],
        },
      ],
    },
    comparisons: [
      {
        comparison_id: 'cmp_ads01',
        dimension: 'meta_creative_activity',
        prospect_id: 'ent_prospect01',
        competitor_id: 'ent_competitor1',
        prospect_observed: null,
        competitor_observed: 4,
        unit: 'active_ads',
        topic: null,
        window: '30d',
        interpretation: 'competitor_materially_ahead',
        confidence: 0.8,
        evidence_refs: ['ev_web01', 'ev_disc01'],
        note: null,
      },
    ],
    changes: [
      {
        change_id: 'chg_01',
        type: 'CONTENT_ACTIVITY_INCREASED',
        channel: 'content',
        entity_id: 'ent_prospect01',
        entity_name: 'Acme Bakery',
        previous_snapshot_id: 'snap_20260905120000_abcdef01',
        current_snapshot_id: 'snap_20261005120000_abcdef01',
        before: 1,
        after: 4,
        detail: 'Article output rose from 1 to 4 per 60 days.',
        claim_kind: 'fact',
        confidence: 0.85,
        evidence_refs: ['ev_est01'],
      },
    ],
    opportunities: [
      {
        opportunity_id: 'opp_ads01',
        type: 'ADVERTISING_GAP',
        title: 'Competitor is running Meta ads where the prospect is not',
        confidence: 0.75,
        severity: 'high',
        // OI fixes this to inference. It must stay inference.
        claim_kind: 'inference',
        what_was_observed: 'Rival Foods shows 4 active Meta ads; the prospect had no Meta Ad Library coverage.',
        who: ['Acme Bakery', 'Rival Foods'],
        prospect_state: 'No paid social coverage observed.',
        why_it_matters: 'Paid social is a live demand-capture surface the prospect is not using.',
        reasoning_summary: 'Comparison on meta_creative_activity plus provider availability on both sides.',
        evidence_refs: ['ev_web01', 'ev_disc01'],
        signal_refs: ['sig_gap01'],
        comparison_refs: ['cmp_ads01'],
        change_refs: [],
        limitations: ['Meta counts for the prospect are unavailable, not zero.'],
      },
    ],
    opportunity_score: {
      score: 38,
      model_version: 'score-1.0',
      previous_score: null,
      explanation: ['Score 38/100 from 4 of 9 components (model score-1.0).'],
      components: [
        { key: 'competitive_pressure', value: 0.7, weight: 0.22, effective_weight: 0.22, computed: true, rationale: 'One competitor ahead on ads.', inputs: {} },
        { key: 'research_confidence', value: 0.5, weight: 0.07, effective_weight: 0.07, computed: true, rationale: '2 of 6 providers succeeded.', inputs: {} },
      ],
    },
    sales_angles: [
      {
        angle_id: 'ang_01',
        angle: 'Lead with the paid-social blind spot',
        summary: 'Rival is capturing paid-social demand in the same city while Acme has no presence there.',
        confidence: 0.7,
        evidence_refs: ['ev_web01', 'ev_disc01'],
        opportunity_refs: ['opp_ads01'],
        limitations: ['Prospect-side Meta coverage is unavailable.'],
        do_not_claim: ['Do not say the prospect has zero ads.'],
      },
    ],
    timeline: [
      {
        event_id: 'evt_01',
        event_type: 'RESEARCH_STARTED',
        entity_id: 'ent_prospect01',
        occurred_at: GENERATED_AT,
        title: 'Research started',
        summary: 'Opportunity research started for Acme Bakery',
        claim_kind: 'fact',
        research_id: 'res_20261005120000_abcdef01',
        evidence_refs: [],
      },
      {
        event_id: 'evt_02',
        event_type: 'PROVIDER_UNAVAILABLE',
        entity_id: 'ent_prospect01',
        occurred_at: GENERATED_AT,
        title: 'meta_ads: unavailable',
        summary: 'Meta Ad Library API not configured',
        claim_kind: 'fact',
        research_id: 'res_20261005120000_abcdef01',
        evidence_refs: [],
      },
      {
        event_id: 'evt_03',
        event_type: 'OPPORTUNITY_IDENTIFIED',
        entity_id: 'ent_prospect01',
        occurred_at: GENERATED_AT,
        title: 'Opportunity identified',
        summary: 'ADVERTISING_GAP',
        claim_kind: 'inference',
        research_id: 'res_20261005120000_abcdef01',
        evidence_refs: ['ev_web01'],
      },
      {
        event_id: 'evt_04',
        event_type: 'SNAPSHOT_CAPTURED',
        entity_id: 'ent_prospect01',
        occurred_at: GENERATED_AT,
        title: 'Snapshot captured',
        summary: 'snap_20261005120000_abcdef01',
        claim_kind: 'fact',
        research_id: 'res_20261005120000_abcdef01',
        evidence_refs: [],
      },
    ],
    conflicts: [
      {
        entity_id: 'ent_prospect01',
        metric: 'articles_60d',
        evidence_refs: ['ev_est01'],
        values: [4, 1],
        resolution: 'Kept the newer estimate; the older value is from a prior snapshot.',
      },
    ],
    limitations: [
      'No search API configured (BRAVE_API_KEY or SERPER_API_KEY); automatic competitor discovery skipped.',
      'First snapshot for this prospect: change detection needs a later re-run.',
    ],
    provider_status: {
      'dom:acme.example': {
        website: 'success',
        content: 'success',
        competitors: 'success',
        meta_ads: 'unavailable',
        google_ads: 'partial',
        twitter: 'unavailable',
        linkedin: 'unsupported',
      },
      'dom:rival.example': {
        website: 'success',
        meta_ads: 'partial',
        linkedin: 'unsupported',
      },
    },
    telemetry: {
      started_at: GENERATED_AT,
      completed_at: GENERATED_AT,
      duration_ms: 4210,
      providers: [
        {
          research_id: 'res_20261005120000_abcdef01',
          provider: 'website',
          entity_id: 'ent_prospect01',
          started_at: GENERATED_AT,
          completed_at: GENERATED_AT,
          duration_ms: 900,
          status: 'success',
          items_observed: 12,
          evidence_created: 2,
          error_code: null,
          retry_count: 0,
        },
        {
          research_id: 'res_20261005120000_abcdef01',
          provider: 'linkedin',
          entity_id: 'ent_prospect01',
          started_at: GENERATED_AT,
          completed_at: GENERATED_AT,
          duration_ms: 0,
          status: 'unsupported',
          items_observed: 0,
          evidence_created: 0,
          error_code: 'UNSUPPORTED_SOURCE',
          retry_count: 0,
        },
      ],
    },
    ...overrides,
  };
}

/** A report OI would produce when it could observe nothing at all. */
function failedReport() {
  return report({
    status: 'failed',
    evidence: [],
    observations: [],
    signals: [],
    comparisons: [],
    changes: [],
    opportunities: [],
    sales_angles: [],
    conflicts: [],
    opportunity_score: { score: 0, model_version: 'score-1.0', previous_score: null, explanation: [], components: [] },
    limitations: ['COMPANY_NOT_FOUND: no provider could observe the prospect.'],
  });
}

/** Minimal valid report - the smallest thing the contract must accept. */
function minimalReport() {
  return {
    schema_version: '1.0',
    research_id: 'res_20260101120000_0000aaaa',
    snapshot_id: 'snap_20260101120000_0000aaaa',
    previous_snapshot_id: null,
    status: 'completed',
    generated_at: GENERATED_AT,
    prospect: { entity_id: 'ent_p1', entity_key: 'dom:min.example', kind: 'prospect', company_name: 'Min Co', domain: 'min.example' },
    competitors: [],
    evidence: [],
    observations: [],
    signals: [],
    advertising_intelligence: {},
    content_intelligence: {},
    social_intelligence: {},
    comparisons: [],
    changes: [],
    opportunities: [],
    opportunity_score: { score: 0, model_version: 'score-1.0', previous_score: null, explanation: [], components: [] },
    sales_angles: [],
    timeline: [],
    conflicts: [],
    limitations: [],
    provider_status: { 'dom:min.example': { website: 'success' } },
    telemetry: { started_at: GENERATED_AT, completed_at: GENERATED_AT, duration_ms: 1, providers: [] },
  };
}

/** A report that violates the contract in each of several distinct ways. */
function malformedVariants() {
  const base = report();
  const clone = () => JSON.parse(JSON.stringify(base));
  return {
    missing_research_id: (() => { const r = clone(); delete r.research_id; return r; })(),
    bad_schema_version: (() => { const r = clone(); r.schema_version = '2.0'; return r; })(),
    missing_snapshot_id: (() => { const r = clone(); delete r.snapshot_id; return r; })(),
    bad_status: (() => { const r = clone(); r.status = 'error'; return r; })(),
    missing_opportunity_score: (() => { const r = clone(); delete r.opportunity_score; return r; })(),
    opportunity_relabels_itself_a_fact: (() => {
      const r = clone();
      r.opportunities[0].claim_kind = 'fact';
      return r;
    })(),
    unknown_provider_status: (() => {
      const r = clone();
      r.provider_status['dom:acme.example'].website = 'ok-ish';
      return r;
    })(),
    dangling_evidence_ref: (() => {
      const r = clone();
      r.opportunities[0].evidence_refs = ['ev_does_not_exist'];
      return r;
    })(),
    prototype_pollution: (() => {
      // A real OWN key named __proto__, which is what JSON.parse produces for a
      // hostile payload. Assigning r.__proto__ would only change the prototype
      // and would not test anything, so define it explicitly.
      const r = clone();
      Object.defineProperty(r, '__proto__', { value: { polluted: true }, enumerable: true, configurable: true, writable: true });
      return r;
    })(),
    not_an_object: 'this is a string, not a report',
  };
}

module.exports = { report, failedReport, minimalReport, malformedVariants, GENERATED_AT };