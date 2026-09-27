'use strict';

const { stableId } = require('../core/ids');
const { ValidationError } = require('../core/errors');
const { FOOTPRINT } = require('../contracts/constants');

/**
 * Change detection between two EvidencePackets of the same lead.
 *
 * Rule: a change is only reported when BOTH packets measured the thing being compared.
 * Everything else is reported in `insufficient` with a reason, never as a change.
 *   - facts: compared by key when the fact's area was measured in both packets.
 *     A fact that appears/disappears is only a change when the engine version is the
 *     same (a new engine may simply emit different facts).
 *   - findings: compared by rule_id per area, same conditions as facts.
 *   - footprint: compared only when neither packet is failed/partial/not-checked.
 *   - completeness: always comparable (it is a fact about the research itself).
 */

const UNCOMPARABLE_FOOTPRINT = new Set([FOOTPRINT.NOT_CHECKED, FOOTPRINT.RESEARCH_FAILED, FOOTPRINT.RESEARCH_PARTIAL]);

function measured(packet, area) {
  return Boolean(packet.completeness && packet.completeness.areas && packet.completeness.areas[area] === 'measured');
}

function usable(packet) {
  return packet.research_status !== 'failed';
}

function chainKey(chain) {
  return (chain || []).map((r) => `${r.status ?? ''} ${r.url}`).join(' -> ');
}

function detectChangesDetailed(previous, current, { now = new Date() } = {}) {
  if (!previous || !current) return { changes: [], insufficient: [{ subject: 'packets', reason: 'Two research runs are needed to detect changes.' }] };
  if (previous.lead_id !== current.lead_id) throw new ValidationError('packets belong to different leads', [{ path: '$.lead_id', message: 'mismatch' }]);
  if (previous.packet_id === current.packet_id) return { changes: [], insufficient: [] };

  const detectedAt = now.toISOString();
  const changes = [];
  const insufficient = [];
  const provenance = {
    previous_packet_id: previous.packet_id,
    current_packet_id: current.packet_id,
    provider: current.provider.id,
    previous_captured_at: previous.captured_at,
    current_captured_at: current.captured_at,
    previous_engine_version: previous.engine_version,
    current_engine_version: current.engine_version,
  };
  const add = (type, area, subject, previousValue, newValue, refs) => {
    changes.push({
      change_id: stableId('chg', previous.packet_id, current.packet_id, type, subject),
      lead_id: current.lead_id,
      type,
      area,
      subject,
      previousValue,
      newValue,
      detectedAt,
      fact_refs: { previous: refs.prevFacts || [], current: refs.curFacts || [] },
      finding_refs: { previous: refs.prevFindings || [], current: refs.curFindings || [] },
      provenance,
    });
  };
  const sameEngine = previous.engine_version === current.engine_version;

  // Research completeness (always comparable)
  if (previous.completeness.level !== current.completeness.level) {
    add('research_completeness_changed', 'research', 'completeness.level', previous.completeness.level, current.completeness.level, {});
  }

  const bothUsable = usable(previous) && usable(current);
  if (!bothUsable) {
    insufficient.push({ subject: 'evidence', reason: 'At least one research run failed; website facts are not compared.' });
    return { changes, insufficient };
  }

  // Domain
  if (previous.audited_domain && current.audited_domain) {
    if (previous.audited_domain !== current.audited_domain) {
      add('domain_changed', 'identity', 'audited_domain', previous.audited_domain, current.audited_domain, {});
    }
  } else {
    insufficient.push({ subject: 'audited_domain', reason: 'The audited domain is missing in at least one run.' });
  }

  // Redirect chain
  if (previous.redirect_chain.length && current.redirect_chain.length) {
    const a = chainKey(previous.redirect_chain);
    const b = chainKey(current.redirect_chain);
    if (a !== b) add('redirect_chain_changed', 'identity', 'redirect_chain', a, b, {});
  } else {
    insufficient.push({ subject: 'redirect_chain', reason: 'The redirect chain is missing in at least one run.' });
  }

  // Identity (lead-side data captured into each packet)
  for (const k of ['company_name', 'lead_domain']) {
    const a = previous.identity[k];
    const b = current.identity[k];
    if (a && b && a !== b) add('identity_changed', 'identity', `identity.${k}`, a, b, {});
  }

  // Facts by key
  const pf = new Map(previous.facts.map((f) => [f.key, f]));
  const cf = new Map(current.facts.map((f) => [f.key, f]));
  for (const key of new Set([...pf.keys(), ...cf.keys()])) {
    const a = pf.get(key);
    const b = cf.get(key);
    const area = (b || a).area;
    if (!measured(previous, area) || !measured(current, area)) {
      insufficient.push({ subject: `fact:${key}`, reason: `Area "${area}" was not measured in both runs.` });
      continue;
    }
    if (a && b) {
      if (a.value !== b.value && a.value !== null && b.value !== null) {
        add('fact_changed', area, key, a.value, b.value, { prevFacts: [a.fact_id], curFacts: [b.fact_id] });
      } else if (a.value === null || b.value === null) {
        if (a.value !== b.value) insufficient.push({ subject: `fact:${key}`, reason: 'The value is missing in one run.' });
      }
    } else if (!sameEngine) {
      insufficient.push({ subject: `fact:${key}`, reason: 'Engine version differs; a missing fact may be a reporting difference.' });
    } else if (b) {
      add('fact_added', area, key, null, b.value, { curFacts: [b.fact_id] });
    } else {
      add('fact_removed', area, key, a.value, null, { prevFacts: [a.fact_id] });
    }
  }

  // Findings by rule id
  const group = (p) => {
    const m = new Map();
    for (const g of p.findings) {
      if (!m.has(g.rule_id)) m.set(g.rule_id, []);
      m.get(g.rule_id).push(g);
    }
    return m;
  };
  const pg = group(previous);
  const cg = group(current);
  for (const rule of new Set([...pg.keys(), ...cg.keys()])) {
    const a = pg.get(rule);
    const b = cg.get(rule);
    const area = (b || a)[0].area;
    if (a && b) continue; // present in both: unchanged at rule level
    if (!measured(previous, area) || !measured(current, area)) {
      insufficient.push({ subject: `finding:${rule}`, reason: `Area "${area}" was not measured in both runs.` });
      continue;
    }
    if (!sameEngine) {
      insufficient.push({ subject: `finding:${rule}`, reason: 'Engine version differs; finding rules may have changed.' });
      continue;
    }
    if (b) {
      add(`${area}_finding_appeared`, area, rule, null, b[0].title, { curFindings: b.map((x) => x.finding_id), curFacts: b.flatMap((x) => x.fact_ids) });
    } else {
      add(`${area}_finding_resolved`, area, rule, a[0].title, null, { prevFindings: a.map((x) => x.finding_id), prevFacts: a.flatMap((x) => x.fact_ids) });
    }
  }

  // Digital footprint
  const fa = previous.digital_footprint.state;
  const fb = current.digital_footprint.state;
  if (UNCOMPARABLE_FOOTPRINT.has(fa) || UNCOMPARABLE_FOOTPRINT.has(fb)) {
    if (fa !== fb) insufficient.push({ subject: 'digital_footprint', reason: 'At least one run was partial or failed.' });
  } else if (fa !== fb) {
    add('digital_footprint_changed', 'footprint', 'digital_footprint', fa, fb, {
      prevFacts: previous.digital_footprint.fact_ids,
      curFacts: current.digital_footprint.fact_ids,
    });
  }

  return { changes, insufficient };
}

function detectChanges(previous, current, opts) {
  return detectChangesDetailed(previous, current, opts).changes;
}

module.exports = { detectChanges, detectChangesDetailed };
