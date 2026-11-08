'use strict';

/**
 * Personalised proposal drafts (P08).
 *
 * A draft is built from ONE ranked opportunity in a finished research result:
 * the business, the needs the customer can serve, and the evidence behind
 * them. It separates FACTS (what was observed, each with its evidence id,
 * page and time) from INFERENCES (what that may mean, with caveats).
 *
 * A draft is only ever a draft: it is returned to the person who asked for
 * it, it is editable, and nothing in this module or in the API that calls it
 * can send it. `can_send` is always false.
 *
 * Two generators:
 *   - template: deterministic, no network, no cost; always available;
 *   - gemini:   optional (GEMINI_API_KEY + ZTECH_LLM_MODEL); the model only
 *               rewrites the same facts. Its output is checked: it must cite
 *               evidence ids that exist, and may not mention web addresses
 *               that are not in the evidence or the offer. A draft that fails
 *               the checks is replaced by the template draft, and the reason
 *               is reported.
 */

const MAX_POINTS = 3;
const LIMITS = Object.freeze({ subject: 120, body: 4000, offerSummary: 600, name: 80, company: 120, cta: 200 });

class ProposalError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'ProposalError';
    this.code = code;
    this.status = status;
  }
}

function clean(value, max, multiline = false) {
  let s = String(value === undefined || value === null ? '' : value);
  s = multiline ? s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '') : s.replace(/[\u0000-\u001f\u007f]+/g, ' ');
  return s.trim().slice(0, max);
}

function validateOffer(input) {
  const o = input && typeof input === 'object' ? input : {};
  const offer = {
    sender_name: clean(o.sender_name, LIMITS.name),
    sender_company: clean(o.sender_company, LIMITS.company),
    offer_summary: clean(o.offer_summary, LIMITS.offerSummary, true),
    call_to_action: clean(o.call_to_action, LIMITS.cta),
  };
  if (!offer.sender_name) throw new ProposalError('invalid_offer', 'the sender name is required');
  if (!offer.sender_company) throw new ProposalError('invalid_offer', 'the company name is required');
  if (!offer.offer_summary) throw new ProposalError('invalid_offer', 'describe what you offer in a sentence or two');
  if (!offer.call_to_action) offer.call_to_action = 'Would a short call next week be useful?';
  return offer;
}

/** The facts and inferences for one opportunity, from a stored result. */
function proposalContext(result, opportunityId) {
  if (!result || result.schema !== 'ztech.research.v1') {
    throw new ProposalError('no_research_result', 'this job has no finished research result', 409);
  }
  const opp = (result.opportunities || []).find((o) => o.opportunity_id === opportunityId);
  if (!opp) throw new ProposalError('not_found', 'no such opportunity in this research', 404);
  if (!opp.need_ids || opp.need_ids.length === 0) {
    throw new ProposalError('no_matching_need', 'this business has no evidenced need that matches your services, so there is nothing true to propose', 409);
  }
  const business = result.businesses.find((b) => b.business_id === opp.business_id);
  // A first message should be short: the (at most) three most important
  // needs, each with its strongest finding. The needs are already ordered by
  // severity in the result.
  const needs = result.needs.filter((n) => opp.need_ids.includes(n.need_id)).slice(0, MAX_POINTS);
  const findingsById = new Map(result.findings.map((f) => [f.finding_id, f]));
  const evidenceById = new Map(result.evidence.map((e) => [e.evidence_id, e]));
  const facts = [];
  for (const need of needs) {
    const f = findingsById.get(need.finding_ids[0]);
    if (!f) continue;
    const ev = evidenceById.get(f.evidence_ids[0]);
    if (!ev) continue;
    facts.push({
      evidence_id: ev.evidence_id,
      need_id: need.need_id,
      title: f.title,
      observation: ev.excerpt,
      source_url: ev.source_url,
      method: ev.method,
      observed_at: ev.observed_at,
    });
  }
  if (facts.length === 0) {
    throw new ProposalError('no_evidence', 'the needs for this business have no stored evidence, so no draft is made', 409);
  }
  const used = new Set(facts.map((f) => f.need_id));
  const inferences = needs.filter((n) => used.has(n.need_id)).map((n) => ({
    need_id: n.need_id,
    service: n.service,
    text: n.problems[0],
    caveats: n.caveats,
  }));
  return { opportunity: opp, business, facts, inferences };
}

function dateOf(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 10);
}

function templateDraft(ctx, offer) {
  const b = ctx.business;
  const noWebsite = !b.website;
  const subject = (noWebsite
    ? `A website for ${b.name}`
    : `A few things I noticed on the ${b.name} website`).slice(0, LIMITS.subject);
  const lines = [];
  lines.push(`Hello ${b.name} team,`);
  lines.push('');
  if (noWebsite) {
    lines.push(`I was looking for ${b.name} online and could not find a website listed for you.`);
  } else {
    lines.push(`I looked at your website on ${dateOf(ctx.facts[0].observed_at)} and noticed:`);
    lines.push('');
    for (const f of ctx.facts) lines.push(`- ${f.title}`);
  }
  lines.push('');
  lines.push('What this may mean for you (my reading, not a certainty):');
  for (const i of ctx.inferences) {
    lines.push(`- ${i.text}${i.caveats.length ? ` (${i.caveats.join(' ')})` : ''}`);
  }
  lines.push('');
  lines.push(offer.offer_summary);
  lines.push('');
  lines.push(offer.call_to_action);
  lines.push('');
  lines.push(offer.sender_name);
  lines.push(offer.sender_company);
  return {
    subject,
    body: lines.join('\n').slice(0, LIMITS.body),
    cited_evidence_ids: ctx.facts.map((f) => f.evidence_id),
  };
}

const SYSTEM_PROMPT = [
  'You write a short, polite first-contact business email from a small agency to a local business.',
  'Use ONLY the facts given. Never add a fact, a number, a name or a claim that is not in the input.',
  'Keep facts and opinions apart: state observations plainly, and phrase every consequence as a possibility.',
  'Mention each caveat that applies. No pressure tactics, no false urgency, no flattery.',
  'At most 180 words. Plain text, no markdown.',
  'Return JSON: {"subject": string, "body": string, "cited_evidence_ids": string[]} where cited_evidence_ids lists the evidence ids of the facts you used.',
].join(' ');

function urlHosts(text) {
  const hosts = [];
  for (const m of String(text).matchAll(/\b(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:[/:?#][^\s]*)?/gi)) {
    hosts.push(m[1].toLowerCase().replace(/^www\./, ''));
  }
  return hosts;
}

/**
 * Check a model's draft against the context. Returns a list of problems
 * (empty when the draft is acceptable).
 */
function checkDraft(draft, ctx, offer) {
  const problems = [];
  if (!draft || typeof draft !== 'object') return ['the model did not return a draft'];
  if (typeof draft.subject !== 'string' || !draft.subject.trim() || draft.subject.length > LIMITS.subject) problems.push('the subject is missing or too long');
  if (typeof draft.body !== 'string' || draft.body.trim().length < 40 || draft.body.length > LIMITS.body) problems.push('the body is missing, too short or too long');
  const known = new Set(ctx.facts.map((f) => f.evidence_id));
  const cited = Array.isArray(draft.cited_evidence_ids) ? draft.cited_evidence_ids.map(String) : [];
  if (cited.length === 0) problems.push('the draft cites no evidence');
  const unknown = cited.filter((id) => !known.has(id));
  if (unknown.length) problems.push(`the draft cites evidence that does not exist: ${unknown.slice(0, 3).join(', ')}`);
  const allowed = new Set([
    ...ctx.facts.flatMap((f) => urlHosts(f.source_url)),
    ...ctx.facts.flatMap((f) => urlHosts(f.observation)),
    ...(ctx.business.website ? urlHosts(ctx.business.website) : []),
    ...urlHosts(`${offer.offer_summary} ${offer.call_to_action} ${offer.sender_company}`),
  ]);
  const foreign = urlHosts(`${draft.subject || ''} ${draft.body || ''}`).filter((h) => !allowed.has(h));
  if (foreign.length) problems.push(`the draft mentions web addresses that are not in the evidence: ${[...new Set(foreign)].slice(0, 3).join(', ')}`);
  return problems;
}

async function geminiDraft({ ctx, offer, request, apiKey, model, signal }) {
  const input = {
    business: { name: ctx.business.name, website: ctx.business.website || null },
    facts: ctx.facts.map((f) => ({ evidence_id: f.evidence_id, fact: `${f.title}: ${f.observation}`, observed_on: dateOf(f.observed_at) })),
    possible_meaning: ctx.inferences.map((i) => ({ text: i.text, caveats: i.caveats })),
    sender: { name: offer.sender_name, company: offer.sender_company, offer: offer.offer_summary, call_to_action: offer.call_to_action },
  };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const res = await request({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: JSON.stringify(input) }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 1024, responseMimeType: 'application/json' },
    }),
    signal,
  });
  if (!res.ok) return { error: `the AI service did not respond (${res.error || 'no response'})` };
  if (res.status < 200 || res.status >= 300) return { error: `the AI service answered HTTP ${res.status}` };
  let text;
  try {
    const parsed = JSON.parse(res.body);
    text = parsed.candidates[0].content.parts.map((p) => p.text || '').join('');
  } catch {
    return { error: 'the AI service sent a response that could not be read' };
  }
  try {
    return { draft: JSON.parse(text) };
  } catch {
    return { error: 'the AI draft was not valid JSON' };
  }
}

/**
 * @param {{result: object, opportunityId: string, offer: object,
 *          llm?: {request: Function, apiKey: string, model: string}|null,
 *          signal?: AbortSignal, now?: () => Date}} input
 */
async function generateProposal({ result, opportunityId, offer: rawOffer, llm = null, signal, now = () => new Date() }) {
  const offer = validateOffer(rawOffer);
  const ctx = proposalContext(result, opportunityId);
  let draft = null;
  let generator = 'template';
  const notes = [];
  if (llm && llm.apiKey && llm.model) {
    const out = await geminiDraft({ ctx, offer, request: llm.request, apiKey: llm.apiKey, model: llm.model, signal });
    if (out.error) {
      notes.push(`AI draft not used: ${out.error}. The template draft is shown instead.`);
    } else {
      const problems = checkDraft(out.draft, ctx, offer);
      if (problems.length) {
        notes.push(`AI draft not used: ${problems.join('; ')}. The template draft is shown instead.`);
      } else {
        draft = {
          subject: out.draft.subject.trim(),
          body: out.draft.body.trim(),
          cited_evidence_ids: [...new Set(out.draft.cited_evidence_ids.map(String))],
        };
        generator = `gemini:${llm.model}`;
      }
    }
  }
  if (!draft) draft = templateDraft(ctx, offer);
  return {
    opportunity_id: ctx.opportunity.opportunity_id,
    business_id: ctx.business.business_id,
    business_name: ctx.business.name,
    status: 'draft_requires_human_review',
    can_send: false,
    generator,
    generated_at: now().toISOString(),
    subject: draft.subject,
    body: draft.body,
    facts: ctx.facts.filter((f) => draft.cited_evidence_ids.includes(f.evidence_id)),
    inferences: ctx.inferences,
    notes,
  };
}

module.exports = {
  generateProposal, proposalContext, templateDraft, checkDraft, validateOffer, ProposalError, SYSTEM_PROMPT, LIMITS,
};
