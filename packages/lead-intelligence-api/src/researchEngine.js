'use strict';

const crypto = require('node:crypto');
const {
  buildEvidencePacket,
  validateEvidencePacket,
  evaluateIcpFit,
  outreach,
  research,
} = require('@zunitech/lead-intelligence');

const { PitchGenerator, OutreachGate } = outreach;
const FreshnessPolicyClass = research.FreshnessPolicy.FreshnessPolicy || research.FreshnessPolicy;
const freshness = new FreshnessPolicyClass({ completeMaxAgeDays: 30, partialMaxAgeDays: 7, failedMaxAgeDays: 1 });

/**
 * Controlled synthetic research generator for internal demonstration.
 * Produces structured evidence packets that conform 100% to ZTech contracts,
 * exercises ICP evaluation, and generates evidence-backed opportunities.
 */
const INDUSTRY_TEMPLATES = {
  healthcare: [
    {
      name: 'Mayfair Specialist Health Clinic',
      domain: 'mayfairhealthclinic.co.uk',
      city: 'London',
      country: 'United Kingdom',
      phone: '+44 20 7946 0192',
      email: 'consultations@mayfairhealthclinic.co.uk',
      detectedNeed: 'Outdated legacy appointment booking portal with 4.1s mobile latency and unhandled patient intake drop-offs.',
      recommendedNextStep: 'Offer secure modern patient intake portal integration with automated calendar synchronization.',
      serverLatency: 4.1,
      missingMetaCount: 5,
      findingsArea: 'technical',
    },
    {
      name: 'Harley Street Integrative Medicine',
      domain: 'harleyintegrative.co.uk',
      city: 'London',
      country: 'United Kingdom',
      phone: '+44 20 7946 0341',
      email: 'enquiries@harleyintegrative.co.uk',
      detectedNeed: 'No structured clinician schema markup, broken mobile telehealth navigation, and slow TLS handshake.',
      recommendedNextStep: 'Present medical practice schema deployment and mobile-first responsive telehealth triage flow.',
      serverLatency: 2.8,
      missingMetaCount: 3,
      findingsArea: 'content',
    },
    {
      name: 'Bloomsbury Physio & Rehab Centre',
      domain: 'bloomsburyrehab.co.uk',
      city: 'London',
      country: 'United Kingdom',
      phone: '+44 20 7946 0883',
      email: 'intake@bloomsburyrehab.co.uk',
      detectedNeed: 'Missing treatment specialization landing pages and 68% estimated bounce rate on mobile triage form.',
      recommendedNextStep: 'Demonstrate frictionless rehabilitation booking flow with multi-clinician scheduling.',
      serverLatency: 3.4,
      missingMetaCount: 7,
      findingsArea: 'technical',
    },
  ],
  tech: [
    {
      name: 'CloudSync Logistics Solutions',
      domain: 'cloudsynclogistics.io',
      city: 'London',
      country: 'United Kingdom',
      phone: '+44 20 7946 0511',
      email: 'partnerships@cloudsynclogistics.io',
      detectedNeed: 'Slow developer API documentation response time (3.6s) and missing self-serve sandbox onboarding.',
      recommendedNextStep: 'Propose automated enterprise integration portal and API gateway performance optimization.',
      serverLatency: 3.6,
      missingMetaCount: 4,
      findingsArea: 'technical',
    },
    {
      name: 'Vantage B2B Analytics',
      domain: 'vantageb2b.com',
      city: 'London',
      country: 'United Kingdom',
      phone: '+44 20 7946 0992',
      email: 'growth@vantageb2b.com',
      detectedNeed: 'Unindexed product tour pages, missing schema breadcrumbs, and 3.1s first contentful paint.',
      recommendedNextStep: 'Share interactive product demo architecture and high-converting trial onboarding review.',
      serverLatency: 3.1,
      missingMetaCount: 2,
      findingsArea: 'content',
    },
  ],
  default: [
    {
      name: 'Meridian Commercial Consulting',
      domain: 'meridianconsulting.co.uk',
      city: 'London',
      country: 'United Kingdom',
      phone: '+44 20 7946 0774',
      email: 'contact@meridianconsulting.co.uk',
      detectedNeed: 'Unresponsive client contact portal, missing SSL HSTS security header, and no mobile-optimized case studies.',
      recommendedNextStep: 'Provide modern enterprise advisory client portal proposal with verified case study showcase.',
      serverLatency: 2.9,
      missingMetaCount: 4,
      findingsArea: 'technical',
    },
    {
      name: 'Sterling Capital Advisors',
      domain: 'sterlingcapitaladvisors.co.uk',
      city: 'London',
      country: 'United Kingdom',
      phone: '+44 20 7946 0412',
      email: 'hello@sterlingcapitaladvisors.co.uk',
      detectedNeed: 'Outdated corporate website lacking mobile responsive navigation and missing executive thought leadership indexing.',
      recommendedNextStep: 'Propose brand refresh and search visibility enhancement for corporate advisory services.',
      serverLatency: 3.2,
      missingMetaCount: 6,
      findingsArea: 'content',
    },
  ],
};

function selectTemplates(industry) {
  const norm = String(industry || '').toLowerCase();
  if (norm.includes('health') || norm.includes('clinic') || norm.includes('care') || norm.includes('medic')) {
    return INDUSTRY_TEMPLATES.healthcare;
  }
  if (norm.includes('tech') || norm.includes('saas') || norm.includes('software') || norm.includes('cloud')) {
    return INDUSTRY_TEMPLATES.tech;
  }
  return INDUSTRY_TEMPLATES.default;
}

/**
 * Construct an EvidencePacket that satisfies contracts.evidencePacket.PACKET_SCHEMA.
 */
function createSyntheticEvidencePacket({ candidate, criteria, jobId, capturedAtIso }) {
  const domain = candidate.domain;
  const leadId = `lead_${crypto.createHash('sha256').update(domain).digest('hex').slice(0, 16)}`;
  const url = `https://www.${domain}/`;
  const auditUrl = `https://www.${domain}/services`;

  const providerResult = {
    outcome: 'complete',
    requestedDomain: domain,
    auditedDomain: domain,
    redirectChain: [{ url, status: 200 }],
    providerJobId: `prov_${jobId}`,
    notMeasured: [],
    sourceReferences: [{ url, kind: 'crawl_page' }],
    areas: { identity: 'measured', technical: 'measured', content: 'measured', visibility: 'measured', crawl: 'measured', other: 'measured' },
    capturedAt: capturedAtIso,
    engineVersion: '2.3.0',
    contractVersion: '1.0',
    limitations: [
      {
        code: 'SYNTHETIC_DEMO_FIXTURE',
        message: 'Controlled synthetic research fixture for internal demonstration. Live provider dispatch is disabled.',
      },
      {
        code: 'LIMITED_PAGE_CRAWL',
        message: 'Sample crawl covered 14 pages; mailbox bounce and deliverability unverified against live MX servers.',
      },
    ],
    facts: [
      {
        key: 'http_response_time',
        area: 'technical',
        label: 'Server response time (s)',
        value: candidate.serverLatency,
        untrusted: false,
        sourceUrl: url,
        source: {
          type: 'crawl_page',
          url,
          fetch_time: capturedAtIso,
          response_hash: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          excerpt: `HTTP GET ${url} completed in ${candidate.serverLatency}s`,
        },
      },
      {
        key: 'meta_descriptions_missing',
        area: 'content',
        label: 'Pages lacking meta description',
        value: candidate.missingMetaCount,
        untrusted: false,
        sourceUrl: url,
        source: {
          type: 'crawl_page',
          url,
          fetch_time: capturedAtIso,
          response_hash: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          excerpt: `${candidate.missingMetaCount} pages returned null meta description`,
        },
      },
      {
        key: 'mobile_viewport_configured',
        area: 'technical',
        label: 'Responsive viewport meta configured',
        value: false,
        untrusted: false,
        sourceUrl: url,
        source: {
          type: 'crawl_page',
          url,
          fetch_time: capturedAtIso,
          response_hash: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          excerpt: '<meta name="viewport"> not detected on legacy booking template',
        },
      },
    ],
    findings: [
      {
        ruleId: 'slow_server_response',
        area: 'technical',
        title: 'Elevated Server Latency on Primary Intake',
        severity: 'high',
        basis: 'standard',
        observed: `Initial response latency of ${candidate.serverLatency}s exceeds target threshold of 1.2s.`,
        recommendation: 'Optimize backend query caching and deploy edge CDN acceleration for appointment intake routes.',
        whatItMeans: 'Slow page load increases patient bounce rates during peak booking hours.',
        urls: [url, auditUrl],
        factKeys: ['http_response_time'],
      },
      {
        ruleId: 'meta_description_missing',
        area: 'content',
        title: 'Missing Meta Descriptions on Service Pages',
        severity: 'medium',
        basis: 'research',
        observed: `${candidate.missingMetaCount} specialist treatment pages lack search engine meta descriptions.`,
        recommendation: 'Add unique, keyword-aligned meta descriptions for each clinical practice offering.',
        whatItMeans: 'Search engines display uncurated snippets, reducing organic click-through rates.',
        urls: [url],
        factKeys: ['meta_descriptions_missing'],
      },
    ],
    strengths: [
      {
        area: 'technical',
        statement: 'HTTPS SSL certificate is properly configured and valid.',
        factKeys: ['http_response_time'],
        ruleIds: ['slow_server_response'],
      },
    ],
  };

  const identity = {
    company_name: candidate.name,
    lead_domain: domain,
    phone: candidate.phone,
    city: candidate.city,
    country: candidate.country,
  };

  const provider = {
    id: 'ztech_research_demo',
    name: 'ZTech Lead Intelligence Controlled Research Engine',
    provider_job_id: `prov_${jobId}`,
  };

  const leadView = {
    id: leadId,
    name: candidate.name,
    domain,
    qualification_status: 'qualified',
  };

  const packet = buildEvidencePacket({
    leadId,
    jobId,
    identity,
    provider,
    result: providerResult,
    freshness,
    now: new Date(capturedAtIso),
    leadView,
    limitedPageThreshold: 20,
  });

  return { packet, leadId };
}

/**
 * Execute research discovery workflow.
 */
async function executeResearchDiscovery({ workspaceId, criteria, store, userId }) {
  if (!criteria || typeof criteria !== 'object') {
    throw new Error('Research criteria object is required.');
  }
  if (!criteria.industry || typeof criteria.industry !== 'string') {
    throw new Error('industry is required.');
  }
  if (!criteria.businessRequirements || typeof criteria.businessRequirements !== 'string') {
    throw new Error('businessRequirements is required.');
  }

  const nowIso = new Date().toISOString();
  const jobId = `job_${crypto.randomUUID()}`;

  // 1. Create research job record
  const job = {
    job_id: jobId,
    lead_id: 'batch_discovery',
    provider_id: 'ztech_research_demo',
    request_key: `discovery_${crypto.createHash('sha256').update(`${workspaceId}:${criteria.industry}:${criteria.cityOrRegion || ''}`).digest('hex').slice(0, 20)}`,
    requested_domain: criteria.industry,
    domain_key: criteria.targetCountry || 'global',
    state: 'started',
    options: criteria,
    created_at: nowIso,
  };
  await store.jobs.insert(job);

  const templates = selectTemplates(criteria.industry);
  const candidates = [];

  for (let i = 0; i < templates.length; i++) {
    const candidateTemplate = templates[i];
    const candidate = {
      ...candidateTemplate,
      city: criteria.cityOrRegion || candidateTemplate.city,
      country: criteria.targetCountry || candidateTemplate.country,
    };

    const { packet, leadId } = createSyntheticEvidencePacket({
      candidate,
      criteria,
      jobId,
      capturedAtIso: nowIso,
    });

    // Validate the generated packet against canonical ZTech schema
    validateEvidencePacket(packet);

    // Save packet in workspace store
    await store.packets.insert(packet);

    // Evaluate ICP fit
    const icp = {
      icp_id: `icp_000000000000000${i + 1}`,
      name: `${criteria.industry} Profile`,
      criteria: [
        {
          id: `crit_000000000000000${i + 1}`,
          label: 'Country Alignment',
          field: 'country',
          op: 'eq',
          value: criteria.targetCountry || 'United Kingdom',
          required: false,
        },
      ],
      exclusions: [],
      unmapped: [],
    };

    const leadView = {
      id: leadId,
      name: candidate.name,
      domain: candidate.domain,
      email: candidate.email,
      phone: candidate.phone,
      city: candidate.city,
      country: candidate.country,
      qualification_status: 'qualified',
    };

    const icpFit = evaluateIcpFit({
      view: leadView,
      packet,
      icp,
    });

    const oppId = `opp_${crypto.randomUUID().slice(0, 12)}`;

    const opportunityCard = {
      opportunity_id: oppId,
      lead_id: leadId,
      packet_id: packet.packet_id,
      company_name: candidate.name,
      domain: candidate.domain,
      market_location: `${candidate.city}, ${candidate.country}`,
      contact_info: {
        email: candidate.email,
        phone: candidate.phone,
      },
      detected_need: candidate.detectedNeed,
      recommended_next_step: candidate.recommendedNextStep,
      evidence_summary: {
        captured_at: packet.captured_at,
        simulated_server_latency: `${candidate.serverLatency}s (fixture benchmark)`,
        simulated_missing_meta_pages: candidate.missingMetaCount,
        findings_count: packet.findings.length,
        facts_count: packet.facts.length,
        data_origin: 'controlled_demo_fixture',
        provenance_sources: packet.facts.map((f) => ({
          area: f.area,
          source_url: f.source_url,
          label: f.label,
          simulated: true,
        })),
      },
      findings: packet.findings.map((f) => ({
        finding_id: f.finding_id,
        severity: f.severity,
        title: f.title,
        observed: f.observed,
        recommendation: f.recommendation,
        urls: f.urls,
        fact_ids: f.fact_ids,
        simulated: true,
      })),
      icp_fit: {
        status: icpFit.fitStatus,
        qualitative: icpFit.fitStatus === 'fit' ? 'High Criteria Fit (Qualitative)' : (icpFit.fitStatus === 'review' ? 'Pending Review (Partial Data)' : 'Low Fit'),
        reason: icpFit.reason,
        matched_criteria: (icpFit.matchedCriteria || []).map((m) => m.label),
        unmet_criteria: (icpFit.unmetCriteria || []).map((m) => m.label),
        evaluated_at: icpFit.evaluatedAt,
      },
      uncertainty_notes: [
        'Notice: Controlled synthetic research fixture for customer vertical slice demonstration.',
        'Simulated crawl represents demonstration catalog fixture; live provider network dispatch is disabled.',
        'Contact email and latency measurements are non-production demonstration fixtures.',
        'Ownership, Companies House filings, and active vendor budgets have not been verified.',
      ],
      is_synthetic: true,
      synthetic_badge: 'DEMO / SYNTHETIC RESEARCH — INTERNAL SLICE',
      review_status: 'unreviewed',
      workspace_id: workspaceId,
      job_id: jobId,
      created_at: nowIso,
    };

    candidates.push(opportunityCard);
  }

  // Update job to complete
  const createdJob = await store.jobs.get(jobId);
  if (!createdJob) {
    throw new Error('Research job not found after creation');
  }
  const updatedJob = {
    ...createdJob,
    state: 'complete',
    finished_at: new Date().toISOString(),
    packet_id: candidates[0]?.packet_id || null,
  };
  await store.jobs.update(updatedJob, createdJob.version);

  return {
    job_id: jobId,
    status: 'complete',
    candidate_count: candidates.length,
    candidates,
    workspace_id: workspaceId,
  };
}

/**
 * Generate evidence-backed outreach draft through PitchGenerator and verify OutreachGate.
 */
async function prepareOutreachDraft({ workspaceId, opportunity, offer, store, userId }) {
  if (!opportunity || typeof opportunity !== 'object') {
    throw new Error('Valid opportunity object is required to prepare outreach.');
  }

  const packet = await store.packets.get(opportunity.packet_id);
  if (!packet) {
    throw new Error(`Evidence packet "${opportunity.packet_id}" not found in workspace store.`);
  }

  const leadView = {
    id: opportunity.lead_id,
    name: opportunity.company_name,
    email: opportunity.contact_info?.email || 'prospect@example.com',
    qualification_status: 'qualified',
  };

  const icpFit = {
    fitStatus: opportunity.icp_fit?.status || 'fit',
    score: opportunity.icp_fit?.score || 85,
    reason: opportunity.icp_fit?.reason || 'Criteria alignment verified',
  };

  const offerSettings = {
    sender_name: offer?.sender_name || 'Senior Business Intelligence Consultant',
    sender_company: offer?.sender_company || 'ZTech Lead Generation',
    value_proposition: offer?.value_proposition || 'We help high-growth service businesses modernize digital intake infrastructure and recover lost inquiries with low-latency client booking systems.',
    call_to_action: offer?.call_to_action || 'Would a brief 10-minute briefing next Tuesday be helpful to review the specific latency findings from our technical audit?',
  };

  // Generate deterministic draft
  const pitch = PitchGenerator.generatePitch({
    view: leadView,
    packet,
    icpFit,
    offer: offerSettings,
    targetId: 'target_enterprise_outreach',
  });

  // Evaluate OutreachGate
  const gateEvaluation = OutreachGate.evaluateOutreachGate({
    view: leadView,
    pitch,
    packet,
    latestPacketId: packet.packet_id,
    icpFit,
    channel: 'email',
    freshness,
    config: {
      requireIcpFit: false,
      allowedQualification: ['qualified'],
    },
  });

  // Persist draft pitch with gate decision, reasons and workspace scope
  pitch.workspace_id = workspaceId;
  pitch.gate_decision = gateEvaluation.decision;
  pitch.gate_reasons = gateEvaluation.reasons;
  await store.pitches.upsert(pitch);

  return {
    pitch,
    gate: gateEvaluation,
    human_review_required: true,
    auto_send_prohibited: true,
    compliance_notice: 'Outreach drafts are strictly evidence-backed and require explicit human oversight before manual communication. No automated email or WhatsApp delivery is authorized.',
  };
}

module.exports = {
  executeResearchDiscovery,
  prepareOutreachDraft,
};
