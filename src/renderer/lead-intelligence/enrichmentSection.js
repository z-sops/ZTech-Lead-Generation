/* Lead Profile — Enrichment section (Round 1).
 * Shows provider status (READY / NOT_CONFIGURED / UNAVAILABLE), every enrichable field
 * with its state (FOUND / NOT_FOUND / UNKNOWN), selected value, provider, source,
 * collected time, stale/conflict flags, and the waterfall steps of the latest job.
 *
 * INTEGRATION POINT: mount inside the existing Lead Profile next to the research section,
 * api = window.ztechLeadIntel.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./dom'));
  else root.ZTechLI = Object.assign(root.ZTechLI || {}, { enrichmentSection: factory(root.ZTechLI.dom) });
}(typeof self !== 'undefined' ? self : this, function (dom) {
  'use strict';

  var ACTIVE = ['requested', 'running', 'pending'];
  var STATE_LABEL = {
    requested: 'RUNNING', running: 'RUNNING', pending: 'RUNNING',
    complete: 'COMPLETE', partial: 'PARTIAL', no_result: 'UNKNOWN', failed: 'FAILED', blocked: 'BLOCKED', stale: 'STALE',
  };

  function mountEnrichmentSection(opts) {
    var doc = opts.doc || document;
    var h = dom.h;
    var api = opts.api;
    var container = opts.container;
    var leadId = opts.leadId;
    var pollMs = opts.pollMs || 5000;
    var timer = null;
    var destroyed = false;

    function run(force) {
      api.enrichment.request({ leadId: leadId, force: Boolean(force) }).then(dom.unwrap).then(refresh).catch(function (e) { render(null, null, e); });
    }

    function providersBlock(list) {
      return dom.section(doc, 'Enrichment providers', h(doc, 'ul', { class: 'li-list' }, list.map(function (p) {
        return h(doc, 'li', null, dom.badge(doc, p.state), ' ', h(doc, 'strong', null, p.name), p.tier ? ' (' + p.tier.replace('_', ' ') + ')' : '', p.reason ? h(doc, 'span', { class: 'li-muted' }, ' — ' + p.reason) : null);
      })));
    }

    function fieldsBlock(profile) {
      var rows = Object.keys(profile.fields).map(function (k) {
        var f = profile.fields[k];
        var s = f.selected;
        var state = f.status + (f.stale ? ' · STALE' : '') + (f.conflict ? ' · CONFLICT' : '');
        return h(doc, 'tr', null,
          h(doc, 'td', null, k),
          h(doc, 'td', null, dom.badge(doc, state, f.stale ? 'stale' : f.status === 'FOUND' ? 'complete' : 'unknown')),
          h(doc, 'td', null, s ? String(s.value) : (f.status === 'NOT_FOUND' ? 'No value from: ' + f.not_found_by.join(', ') : '—')),
          h(doc, 'td', null, s ? s.provider_id + ' (' + s.tier.replace('_', ' ') + ')' : ''),
          h(doc, 'td', null, s ? s.collected_at : ''),
          h(doc, 'td', null, s ? dom.refChips(doc, [s.provenance_id]) : null, s && s.source_ref ? h(doc, 'div', { class: 'li-muted' }, s.source_ref) : null,
            f.alternatives.length ? h(doc, 'div', { class: 'li-muted' }, 'Other values: ' + f.alternatives.map(function (a) { return String(a.value) + ' (' + a.provider_id + ')'; }).join('; ')) : null));
      });
      return dom.section(doc, 'Enriched fields', [
        dom.kv(doc, [
          ['Found', String(profile.summary.found)],
          ['Not found', String(profile.summary.not_found)],
          ['Unknown', String(profile.summary.unknown)],
          ['Stale', String(profile.summary.stale)],
          ['Conflicts', String(profile.summary.conflicts)],
          ['Max age (days)', String(profile.max_age_days)],
        ]),
        h(doc, 'p', { class: 'li-muted' }, 'Enriched values never overwrite the lead record. NOT_FOUND means the listed providers had no value — not that the company has none.'),
        h(doc, 'table', { class: 'li-table' },
          h(doc, 'thead', null, h(doc, 'tr', null, h(doc, 'th', null, 'Field'), h(doc, 'th', null, 'State'), h(doc, 'th', null, 'Value'), h(doc, 'th', null, 'Provider'), h(doc, 'th', null, 'Collected'), h(doc, 'th', null, 'Provenance'))),
          h(doc, 'tbody', null, rows)),
      ]);
    }

    function jobBlock(job) {
      if (!job) return dom.section(doc, 'Enrichment status', h(doc, 'p', { class: 'li-muted' }, 'Enrichment has not been run for this lead.'));
      return dom.section(doc, 'Enrichment status', [
        dom.badge(doc, STATE_LABEL[job.state] || job.state, job.state),
        job.last_error_code ? h(doc, 'span', { class: 'li-muted' }, ' ' + job.last_error_code) : null,
        job.next_attempt_at ? h(doc, 'p', { class: 'li-muted' }, 'Next retry: ' + job.next_attempt_at) : null,
        h(doc, 'ol', { class: 'li-list' }, job.steps.map(function (s) {
          return h(doc, 'li', null, h(doc, 'strong', null, s.provider_id), ' ', dom.badge(doc, s.state),
            s.error_code ? ' ' + s.error_code : '',
            s.fields_found.length ? ' — found: ' + s.fields_found.join(', ') : '',
            s.fields_not_found.length ? ' — no value: ' + s.fields_not_found.join(', ') : '',
            s.rejected.length ? ' — rejected: ' + s.rejected.map(function (r) { return r.field + ' (' + r.reason + ')'; }).join(', ') : '');
        })),
      ]);
    }

    function render(profile, providers, err) {
      dom.clear(container);
      var busy = profile && profile.latest_job && ACTIVE.indexOf(profile.latest_job.state) !== -1;
      container.appendChild(h(doc, 'div', { class: 'li-research', 'aria-live': 'polite' },
        err ? dom.errorBox(doc, err) : null,
        h(doc, 'div', { class: 'li-actions' },
          h(doc, 'button', { type: 'button', class: 'li-btn', disabled: busy, onClick: function () { run(false); } }, busy ? 'Enrichment running…' : 'Run enrichment'),
          h(doc, 'button', { type: 'button', class: 'li-btn li-btn-secondary', disabled: busy, onClick: function () { run(true); } }, 'Refresh enrichment')),
        providers ? providersBlock(providers) : null,
        profile ? jobBlock(profile.latest_job) : null,
        profile ? fieldsBlock(profile) : null));
      if (timer) clearTimeout(timer);
      timer = null;
      if (busy && !destroyed) timer = setTimeout(refresh, pollMs);
    }

    function refresh() {
      if (destroyed) return Promise.resolve();
      return Promise.all([
        api.enrichment.profile({ leadId: leadId }).then(dom.unwrap),
        api.enrichment.providers().then(dom.unwrap),
      ]).then(function (r) { render(r[0], r[1], null); }).catch(function (e) { render(null, null, e); });
    }

    refresh();
    return { refresh: refresh, destroy: function () { destroyed = true; if (timer) clearTimeout(timer); dom.clear(container); } };
  }

  return { mountEnrichmentSection: mountEnrichmentSection };
}));
