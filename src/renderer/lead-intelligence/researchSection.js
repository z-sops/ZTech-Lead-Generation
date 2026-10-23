/* Lead Profile — research section (Lead Profile items 1–15, research action,
 * research status, evidence viewer, ICP explanation, research history).
 *
 * Options: { doc, container, api, leadId, targetId?, pollMs?, researchActions? (default true;
 * set false in research.mode "round1") }
 *
 * INTEGRATION POINT: call mountResearchSection() from the existing Lead Profile view,
 * passing the container element under the existing profile content and
 * api = window.ztechLeadIntel (preload bridge). Do not replace the existing profile.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./dom'));
  else root.ZTechLI = Object.assign(root.ZTechLI || {}, { researchSection: factory(root.ZTechLI.dom) });
}(typeof self !== 'undefined' ? self : this, function (dom) {
  'use strict';

  var ACTIVE = ['requested', 'preflight', 'started', 'polling', 'pending'];
  var FOOTPRINT_LABELS = {
    NOT_CHECKED: 'Not checked',
    NO_WEBSITE: 'No website on record',
    SITE_UNREACHABLE: 'Website unreachable',
    NO_CRAWLABLE_CONTENT: 'No crawlable content',
    LIMITED_DIGITAL_FOOTPRINT: 'Limited website footprint',
    DIGITAL_FOOTPRINT_FOUND: 'Website footprint found',
    RESEARCH_PARTIAL: 'Research partial',
    RESEARCH_FAILED: 'Research failed',
  };

  function mountResearchSection(opts) {
    var doc = opts.doc || document;
    var container = opts.container;
    var api = opts.api;
    var leadId = opts.leadId;
    var targetId = opts.targetId;
    var pollMs = opts.pollMs || 5000;
    var timer = null;
    var destroyed = false;
    var h = dom.h;

    function schedule(state) {
      if (timer) clearTimeout(timer);
      timer = null;
      if (!destroyed && ACTIVE.indexOf(state) !== -1) timer = setTimeout(refresh, pollMs);
    }

    function act(fn) {
      return function () {
        fn().then(refresh).catch(function (e) { render(null, e); });
      };
    }

    function actions(profile) {
      // Option A (research.mode "round1"): research is started from round-1's own Prospect
      // Research panel, so this section only shows results. Pass researchActions: false.
      if (opts.researchActions === false) {
        return h(doc, 'p', { class: 'li-muted' }, 'Research is run from the Prospect Research panel. Results appear here when it finishes.');
      }
      var state = profile ? profile.research_status.state : 'not_researched';
      var busy = ACTIVE.indexOf(state) !== -1;
      return h(doc, 'div', { class: 'li-actions' },
        h(doc, 'button', { type: 'button', class: 'li-btn', disabled: busy, onClick: act(function () { return api.research.request({ leadId: leadId }).then(dom.unwrap); }) },
          busy ? 'Research running…' : 'Run research'),
        h(doc, 'button', { type: 'button', class: 'li-btn li-btn-secondary', disabled: busy, onClick: act(function () { return api.research.request({ leadId: leadId, force: true }).then(dom.unwrap); }) },
          'Refresh research'),
        h(doc, 'button', { type: 'button', class: 'li-btn li-btn-secondary', disabled: busy, onClick: act(function () { return api.research.importArtifact({ leadId: leadId }).then(dom.unwrap); }) },
          'Import Zuni-SEO file'));
    }

    function statusBlock(p) {
      var rs = p.research_status;
      var j = rs.job;
      return dom.section(doc, 'Research status', [
        dom.badge(doc, rs.state),
        j ? dom.kv(doc, [
          ['Provider', j.provider_id],
          ['Website', j.requested_domain],
          ['Started', j.created_at],
          ['Last update', j.updated_at],
          j.next_attempt_at ? ['Next retry', j.next_attempt_at] : null,
          j.last_error_message ? ['Reason', j.last_error_message] : null,
        ]) : h(doc, 'p', { class: 'li-muted' }, 'Research has not been run for this lead.'),
      ]);
    }

    function footprintBlock(fp) {
      return dom.section(doc, 'Digital footprint', [
        dom.badge(doc, FOOTPRINT_LABELS[fp.state] || fp.state, fp.state),
        h(doc, 'ul', { class: 'li-list' }, fp.reasons.map(function (r) { return h(doc, 'li', null, r, ' ', dom.refChips(doc, fp.fact_ids)); })),
        h(doc, 'p', { class: 'li-muted' }, fp.scope),
      ]);
    }

    function icpBlock(fit) {
      if (!fit) return dom.section(doc, 'ICP fit', h(doc, 'p', { class: 'li-muted' }, 'Select a target to evaluate ICP fit.'));
      function list(title, items) {
        if (!items.length) return null;
        return h(doc, 'div', { class: 'li-icp-group' }, h(doc, 'h4', null, title), h(doc, 'ul', { class: 'li-list' }, items.map(function (c) {
          return h(doc, 'li', null, h(doc, 'strong', null, c.label), ' — ', c.explanation, ' ', h(doc, 'span', { class: 'li-muted' }, '(' + c.source + ')'), ' ', dom.refChips(doc, (c.fact_ids || []).concat(c.finding_ids || [])));
        })));
      }
      return dom.section(doc, 'ICP fit', [
        dom.badge(doc, fit.fitStatus), h(doc, 'p', null, fit.reason),
        list('Exclusions matched', fit.exclusions),
        list('Not met', fit.unmetCriteria),
        list('Unknown (not enough data — not the same as not fit)', fit.unknownCriteria),
        list('Met', fit.matchedCriteria),
        h(doc, 'p', { class: 'li-muted' }, 'Evaluated ' + fit.evaluatedAt),
      ]);
    }

    function evidenceBlock(p) {
      var ev = p.evidence;
      if (!ev.packet) return dom.section(doc, 'Evidence', h(doc, 'p', { class: 'li-muted' }, 'No evidence yet.'));
      var pk = ev.packet;
      var table = h(doc, 'table', { class: 'li-table' },
        h(doc, 'thead', null, h(doc, 'tr', null, h(doc, 'th', null, 'Fact'), h(doc, 'th', null, 'Value'), h(doc, 'th', null, 'Area'), h(doc, 'th', null, 'Ref'))),
        h(doc, 'tbody', null, ev.facts.map(function (f) {
          return h(doc, 'tr', null, h(doc, 'td', null, f.label), h(doc, 'td', null, f.untrusted ? '“' + String(f.value) + '” (website text)' : String(f.value)), h(doc, 'td', null, f.area), h(doc, 'td', null, dom.refChips(doc, [f.fact_id])));
        })));
      return dom.section(doc, 'Evidence', [
        dom.kv(doc, [
          ['Audited website', pk.audited_domain || pk.requested_domain],
          ['Status', pk.research_status],
          ['Completeness', pk.completeness.level],
          ['Packet', pk.packet_id],
        ]),
        h(doc, 'details', { class: 'li-details' }, h(doc, 'summary', null, 'Facts (' + ev.facts.length + ')'), table),
      ]);
    }

    function findingsBlock(findings) {
      if (!findings.length) return dom.section(doc, 'Findings', h(doc, 'p', { class: 'li-muted' }, 'No findings reported.'));
      return dom.section(doc, 'Findings', h(doc, 'ul', { class: 'li-list' }, findings.map(function (g) {
        return h(doc, 'li', { class: 'li-finding', 'data-state': g.severity },
          dom.badge(doc, g.severity), ' ', h(doc, 'strong', null, g.title), ' ', h(doc, 'span', { class: 'li-muted' }, '(' + g.area + ', basis: ' + g.basis + ')'),
          h(doc, 'div', null, g.observed),
          g.recommendation ? h(doc, 'div', { class: 'li-muted' }, 'Recommendation: ' + g.recommendation) : null,
          dom.refChips(doc, [g.finding_id].concat(g.fact_ids)));
      })));
    }

    function strengthsBlock(items) {
      if (!items.length) return dom.section(doc, 'Strengths', h(doc, 'p', { class: 'li-muted' }, 'No evidence-backed strengths reported.'));
      return dom.section(doc, 'Strengths', h(doc, 'ul', { class: 'li-list' }, items.map(function (s) {
        return h(doc, 'li', null, s.statement, ' ', dom.refChips(doc, [s.strength_id].concat(s.fact_ids, s.finding_ids)));
      })));
    }

    function missingBlock(items) {
      return dom.section(doc, 'Missing information', h(doc, 'ul', { class: 'li-list' }, items.map(function (m) {
        return h(doc, 'li', null, h(doc, 'span', { class: 'li-muted' }, '[' + m.source + '] '), m.message);
      })));
    }

    function freshnessBlock(f, prov) {
      return dom.section(doc, 'Research freshness & provenance', f ? dom.kv(doc, [
        ['Captured', f.captured_at],
        ['Expires', f.expires_at],
        ['Age (days)', String(f.age_days)],
        ['Fresh', f.fresh ? 'Yes' : 'No — run research again before outreach'],
        prov ? ['Provider', prov.provider] : null,
        prov ? ['Provider job', prov.provider_job_id] : null,
        prov ? ['Engine version', prov.engine_version] : null,
        prov ? ['Contract version', prov.contract_version] : null,
      ]) : h(doc, 'p', { class: 'li-muted' }, 'No research yet.'));
    }

    function historyBlock(hist) {
      return dom.section(doc, 'Research history', [
        h(doc, 'details', { class: 'li-details' }, h(doc, 'summary', null, 'Jobs (' + hist.jobs.length + ')'),
          h(doc, 'ul', { class: 'li-list' }, hist.jobs.map(function (j) {
            return h(doc, 'li', null, dom.badge(doc, j.state), ' ', j.created_at, ' ', j.requested_domain || '', j.last_error_message ? ' — ' + j.last_error_message : '');
          }))),
        h(doc, 'details', { class: 'li-details' }, h(doc, 'summary', null, 'Changes between runs (' + hist.changes.length + ')'),
          h(doc, 'ul', { class: 'li-list' }, hist.changes.map(function (c) {
            return h(doc, 'li', null, h(doc, 'strong', null, c.type), ' ', c.subject + ': ', String(c.previousValue), ' → ', String(c.newValue), ' ', dom.refChips(doc, c.fact_refs.previous.concat(c.fact_refs.current, c.finding_refs.previous, c.finding_refs.current)));
          }))),
        h(doc, 'details', { class: 'li-details' }, h(doc, 'summary', null, 'Signals (' + hist.signals.length + ')'),
          h(doc, 'ul', { class: 'li-list' }, hist.signals.map(function (s) {
            return h(doc, 'li', null, dom.badge(doc, s.type), ' ', s.description, ' ', h(doc, 'span', { class: 'li-muted' }, s.observedAt));
          })),
          h(doc, 'p', { class: 'li-muted' }, 'Not available: ' + hist.unsupported_signals.map(function (u) { return u.type + ' (' + u.reason + ')'; }).join('; '))),
      ]);
    }

    function render(p, err) {
      dom.clear(container);
      var body = [];
      if (err) body.push(dom.errorBox(doc, err));
      body.push(actions(p));
      if (p) {
        body.push(dom.section(doc, 'Identity', dom.kv(doc, [['Name', p.identity.name], ['Website', p.identity.website], ['Address', p.identity.address]])));
        body.push(dom.section(doc, 'Contact', dom.kv(doc, [['Email', p.contact.email], ['Phone', p.contact.phone]])));
        body.push(dom.section(doc, 'Company', dom.kv(doc, [['Industry', p.company.industry], ['Business type', p.company.business_type], ['City', p.company.city], ['Country', p.company.country]])));
        body.push(dom.section(doc, 'Data quality', dom.kv(doc, [['Level', p.data_quality.level], ['Website', p.data_quality.has_website ? 'Yes' : 'No'], ['Phone', p.data_quality.has_phone ? 'Yes' : 'No'], ['Email', p.data_quality.has_email ? 'Yes' : 'No']])));
        body.push(dom.section(doc, 'Qualification', dom.kv(doc, [['Status', p.qualification.status]])));
        body.push(icpBlock(p.icp_fit));
        body.push(footprintBlock(p.digital_footprint));
        body.push(statusBlock(p));
        body.push(evidenceBlock(p));
        body.push(findingsBlock(p.findings));
        body.push(strengthsBlock(p.strengths));
        body.push(missingBlock(p.missing_information));
        body.push(freshnessBlock(p.freshness, p.provenance));
        body.push(historyBlock(p.research_history));
      }
      container.appendChild(dom.h(doc, 'div', { class: 'li-research', 'aria-live': 'polite' }, body));
      schedule(p ? p.research_status.state : null);
    }

    function refresh() {
      if (destroyed) return Promise.resolve();
      var args = { leadId: leadId };
      if (targetId !== undefined && targetId !== null) args.targetId = targetId;
      return api.profile.get(args).then(dom.unwrap).then(function (p) { render(p, null); }).catch(function (e) { render(null, e); });
    }

    refresh();
    return {
      refresh: refresh,
      destroy: function () { destroyed = true; if (timer) clearTimeout(timer); dom.clear(container); },
    };
  }

  return { mountResearchSection: mountResearchSection, FOOTPRINT_LABELS: FOOTPRINT_LABELS };
}));
