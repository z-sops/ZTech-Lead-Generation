/* Phase I2 — Opportunity Intelligence read-only surface.
 *
 * A SEPARATE intelligence system from Zuni-SEO. It answers a different
 * question (multi-entity, opportunities, competitors, ads, social, timeline)
 * and has its own channels, store and contract (IntelligenceReport).
 * The renderer CANNOT supply a URL, host, endpoint or credential.
 * The renderer CANNOT trigger a send, approve, schedule or campaign.
 * The only write is REQUEST: asking main to run OI for a lead,
 * where identity comes from the main store, never the renderer.
 *
 * Options: { doc, container, api, leadId }
 *   api = window.ztechLeadIntel (preload bridge)
 *   leadId = current lead id
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./dom'));
  else root.ZTechLI = Object.assign(root.ZTechLI || {}, { opportunitySection: factory(root.ZTechLI.dom) });
}(typeof self !== 'undefined' ? self : this, function (dom) {
  'use strict';

  var CLAIM_KIND_LABEL = {
    fact: 'FACT',
    estimate: 'ESTIMATE',
    inference: 'INFERENCE',
    unknown: 'UNKNOWN',
  };

  var PROVIDER_STATUS_LABEL = {
    success: 'Success',
    partial: 'Partial',
    unavailable: 'Unavailable',
    unsupported: 'Unsupported',
    failed: 'Failed',
    rate_limited: 'Rate limited',
  };

  function mountOpportunitySection(opts) {
    var doc = opts.doc || document;
    var container = opts.container;
    var api = opts.api;
    var leadId = opts.leadId;
    var h = dom.h;

    function claimKindBadge(kind) {
      var label = CLAIM_KIND_LABEL[kind] || kind || 'UNKNOWN';
      var state = kind === 'fact' ? 'fit' : kind === 'estimate' ? 'partial' : kind === 'inference' ? 'unknown' : 'unknown';
      return dom.badge(doc, label, state);
    }

    function providerStatusBadge(status) {
      var label = PROVIDER_STATUS_LABEL[status] || status;
      var state = status === 'success' ? 'fit' : status === 'partial' ? 'partial' : status === 'unavailable' ? 'failed' : status === 'unsupported' ? 'unknown' : status === 'failed' ? 'failed' : 'partial';
      return dom.badge(doc, label, state);
    }

    function requestOI() {
      if (!api || !api.opportunity) return Promise.reject(new Error('Opportunity bridge not available'));
      return api.opportunity.request({ leadId: leadId, force: true });
    }

    function loadLatest() {
      if (!api || !api.opportunity) return Promise.reject(new Error('Opportunity bridge not available'));
      return api.opportunity.latest({ leadId: leadId });
    }

    function loadPitchContext() {
      if (!api || !api.opportunity) return Promise.reject(new Error('Opportunity bridge not available'));
      return api.opportunity.pitchContext({ leadId: leadId });
    }

    function loadEngine() {
      if (!api || !api.opportunity) return Promise.reject(new Error('Opportunity bridge not available'));
      return api.opportunity.engine();
    }

    function loadHealth() {
      if (!api || !api.opportunity) return Promise.reject(new Error('Opportunity bridge not available'));
      return api.opportunity.health();
    }

    function renderUnavailable(msg) {
      dom.clear(container);
      var parts = [
        h(doc, 'h3', { class: 'li-section-title' }, 'Opportunity Intelligence'),
        dom.errorBox(doc, { message: msg || 'Opportunity Intelligence is not available in this build.' }),
      ];
      container.appendChild(h(doc, 'div', { class: 'li-panel' }, parts));
    }

    function renderEmpty() {
      dom.clear(container);
      var parts = [
        h(doc, 'h3', { class: 'li-section-title' }, 'Opportunity Intelligence'),
        h(doc, 'p', { class: 'li-muted' }, 'No Opportunity Intelligence research has been run for this lead yet.'),
        h(doc, 'div', { class: 'li-actions' },
          h(doc, 'button', { type: 'button', class: 'li-btn', onClick: function () { loadAndRender(); } }, 'Run Opportunity Research')
        ),
      ];
      container.appendChild(h(doc, 'div', { class: 'li-panel' }, parts));
    }

    function renderError(err) {
      dom.clear(container);
      var parts = [
        h(doc, 'h3', { class: 'li-section-title' }, 'Opportunity Intelligence'),
        dom.errorBox(doc, err),
        h(doc, 'div', { class: 'li-actions' },
          h(doc, 'button', { type: 'button', class: 'li-btn li-btn-secondary', onClick: function () { loadAndRender(); } }, 'Retry')
        ),
      ];
      container.appendChild(h(doc, 'div', { class: 'li-panel' }, parts));
    }

    function renderReport(view) {
      if (!view || !view.model) { renderEmpty(); return; }
      var m = view.model;
      dom.clear(container);
      var parts = [];

      // Header with research status
      var statusText = view.state === 'ok' ? 'Report available' : view.state === 'failed' ? 'Research failed' : 'Unknown';
      var statusBadge = dom.badge(doc, statusText, view.state === 'ok' ? 'fit' : view.state === 'failed' ? 'failed' : 'unknown');
      parts.push(h(doc, 'div', { class: 'li-actions' }, statusBadge));

      // OVERVIEW
      var overview = [
        h(doc, 'h4', null, 'Overview'),
        dom.kv(doc, [
          ['Research ID', m.research_id],
          ['Snapshot ID', m.snapshot_id],
          ['Entity key', m.entity_key],
          ['Generated', m.generated_at],
          ['Status', m.status],
          ['Degraded', m.degraded ? 'Yes — some providers unavailable' : 'No'],
          ['Opportunity score', typeof m.opportunity_score === 'object' ? String(m.opportunity_score.value || m.opportunity_score) : String(m.opportunity_score)],
        ]),
      ];
      if (m.limitations && m.limitations.length) {
        overview.push(h(doc, 'h5', null, 'Limitations'));
        overview.push(h(doc, 'ul', { class: 'li-list' }, m.limitations.map(function (l) {
          return h(doc, 'li', null, l);
        })));
      }
      parts.push(dom.section(doc, 'Overview', overview));

      // PROVIDER STATUS
      var provRows = [];
      if (m.provider_status && m.provider_status.length) {
        provRows = m.provider_status.map(function (p) {
          return [p.provider, p.entity_key, providerStatusBadge(p.status)];
        });
      }
      parts.push(dom.section(doc, 'Provider status', provRows.length ? h(doc, 'table', { class: 'li-table' },
        h(doc, 'thead', null, h(doc, 'tr', null, h(doc, 'th', null, 'Provider'), h(doc, 'th', null, 'Entity'), h(doc, 'th', null, 'Status'))),
        h(doc, 'tbody', null, provRows.map(function (r) {
          return h(doc, 'tr', null, h(doc, 'td', null, r[0]), h(doc, 'td', null, r[1]), h(doc, 'td', null, r[2]));
        }))
      ) : h(doc, 'p', { class: 'li-muted' }, 'No provider status information.')));

      // OPPORTUNITIES
      var oppItems = [];
      if (m.opportunities && m.opportunities.length) {
        oppItems = m.opportunities.map(function (o) {
          return h(doc, 'li', { class: 'li-opportunity' },
            h(doc, 'div', null, h(doc, 'strong', null, o.title || 'Opportunity'), ' ', claimKindBadge(o.claim_kind || 'inference')),
            h(doc, 'div', { class: 'li-muted' }, o.description || ''),
            o.score !== undefined ? h(doc, 'div', null, 'Score: ', o.score) : null,
            o.confidence !== undefined ? h(doc, 'div', null, 'Confidence: ', o.confidence) : null,
            o.evidence_refs && o.evidence_refs.length ? h(doc, 'div', null, 'Evidence: ', dom.refChips(doc, o.evidence_refs)) : null,
            o.provenance ? h(doc, 'div', { class: 'li-muted' }, 'Provider: ', o.provenance.provider, ' ', dom.refChips(doc, [o.provenance.captured_at].filter(Boolean))) : null
          );
        });
      }
      parts.push(dom.section(doc, 'Opportunities', oppItems.length ? h(doc, 'ul', { class: 'li-list' }, oppItems) : h(doc, 'p', { class: 'li-muted' }, 'No opportunities identified.')));

      // COMPETITORS
      var compItems = [];
      if (m.competitors && m.competitors.length) {
        compItems = m.competitors.map(function (c) {
          return h(doc, 'li', { class: 'li-competitor' },
            h(doc, 'strong', null, c.company_name), ' ', dom.badge(doc, c.relationship_type || 'competitor'),
            h(doc, 'br'), h(doc, 'span', { class: 'li-muted' }, 'Domain: ', c.domain || '—'),
            c.relationship_confidence !== undefined ? h(doc, 'span', { class: 'li-muted' }, ' Confidence: ', c.relationship_confidence) : null,
            c.evidence_refs && c.evidence_refs.length ? h(doc, 'div', null, 'Evidence: ', dom.refChips(doc, c.evidence_refs)) : null
          );
        });
      }
      parts.push(dom.section(doc, 'Competitors', compItems.length ? h(doc, 'ul', { class: 'li-list' }, compItems) : h(doc, 'p', { class: 'li-muted' }, 'No competitors identified.')));

      // COMPARISONS
      var cmpItems = [];
      if (m.comparisons && m.comparisons.length) {
        cmpItems = m.comparisons.map(function (c) {
          return h(doc, 'li', null,
            h(doc, 'strong', null, c.metric || 'Comparison'), ': ',
            h(doc, 'span', null, c.prospect_value === undefined ? '—' : String(c.prospect_value)),
            ' vs ',
            h(doc, 'span', null, c.competitor_value === undefined ? '—' : String(c.competitor_value)),
            c.evidence_refs && c.evidence_refs.length ? h(doc, 'div', null, 'Evidence: ', dom.refChips(doc, c.evidence_refs)) : null
          );
        });
      }
      if (cmpItems.length) parts.push(dom.section(doc, 'Comparisons', h(doc, 'ul', { class: 'li-list' }, cmpItems)));

      // ADS
      var adItems = [];
      if (m.advertising_intelligence) {
        for (var ch in m.advertising_intelligence) {
          var chData = m.advertising_intelligence[ch];
          adItems.push(h(doc, 'li', { class: 'li-ad-channel' },
            h(doc, 'strong', null, ch), ' ',
            providerStatusBadge(chData.provider_status || 'unavailable'),
            h(doc, 'br'),
            chData.spend_estimate ? h(doc, 'span', null, 'Spend estimate: ', chData.spend_estimate) : null,
            chData.impressions_estimate ? h(doc, 'span', { class: 'li-muted' }, ' Impressions: ', chData.impressions_estimate) : null,
            chData.evidence_refs && chData.evidence_refs.length ? h(doc, 'div', null, 'Evidence: ', dom.refChips(doc, chData.evidence_refs)) : null
          ));
        }
      }
      parts.push(dom.section(doc, 'Ads', adItems.length ? h(doc, 'ul', { class: 'li-list' }, adItems) : h(doc, 'p', { class: 'li-muted' }, 'No advertising intelligence available.')));

      // CONTENT & SOCIAL
      var contentItems = [];
      if (m.content_intelligence) {
        for (var ch2 in m.content_intelligence) {
          var ch2Data = m.content_intelligence[ch2];
          contentItems.push(h(doc, 'li', { class: 'li-content-channel' },
            h(doc, 'strong', null, ch2), ' ',
            providerStatusBadge(ch2Data.provider_status || 'unavailable'),
            h(doc, 'br'),
            ch2Data.articles_60d !== undefined ? h(doc, 'span', null, 'Articles (60d): ', ch2Data.articles_60d) : null,
            ch2Data.evidence_refs && ch2Data.evidence_refs.length ? h(doc, 'div', null, 'Evidence: ', dom.refChips(doc, ch2Data.evidence_refs)) : null
          ));
        }
      }
      if (m.social_intelligence) {
        for (var ch3 in m.social_intelligence) {
          var ch3Data = m.social_intelligence[ch3];
          contentItems.push(h(doc, 'li', { class: 'li-social-channel' },
            h(doc, 'strong', null, ch3), ' ',
            providerStatusBadge(ch3Data.provider_status || 'unavailable'),
            h(doc, 'br'),
            ch3Data.followers !== undefined ? h(doc, 'span', null, 'Followers: ', ch3Data.followers) : null,
            ch3Data.evidence_refs && ch3Data.evidence_refs.length ? h(doc, 'div', null, 'Evidence: ', dom.refChips(doc, ch3Data.evidence_refs)) : null
          ));
        }
      }
      parts.push(dom.section(doc, 'Content & Social', contentItems.length ? h(doc, 'ul', { class: 'li-list' }, contentItems) : h(doc, 'p', { class: 'li-muted' }, 'No content or social intelligence available.')));

      // TIMELINE
      var tlItems = [];
      if (m.timeline && m.timeline.length) {
        tlItems = m.timeline.map(function (t) {
          return h(doc, 'li', null,
            h(doc, 'span', { class: 'li-muted' }, t.timestamp || t.at || ''), ' ',
            h(doc, 'strong', null, t.event || t.type || 'Event'), ': ',
            h(doc, 'span', null, t.detail || t.description || '')
          );
        });
      }
      parts.push(dom.section(doc, 'Timeline', tlItems.length ? h(doc, 'ul', { class: 'li-list' }, tlItems) : h(doc, 'p', { class: 'li-muted' }, 'No timeline events available. Note: OI timeline is separate from ZTech operational Activity.')));

      // EVIDENCE
      var evItems = [];
      if (m.evidence && m.evidence.length) {
        evItems = m.evidence.map(function (e) {
          return h(doc, 'li', { class: 'li-evidence' },
            h(doc, 'div', null,
              claimKindBadge(e.claim_kind), ' ',
              h(doc, 'strong', null, e.claim || e.title || 'Evidence'), ' ',
              providerStatusBadge(e.provider || '')
            ),
            e.entity_key ? h(doc, 'div', { class: 'li-muted' }, 'Entity: ', e.entity_key) : null,
            e.confidence !== undefined ? h(doc, 'div', { class: 'li-muted' }, 'Confidence: ', e.confidence) : null,
            e.captured_at ? h(doc, 'div', { class: 'li-muted' }, 'Captured: ', e.captured_at) : null,
            e.observed ? h(doc, 'div', null, 'Observed: ', e.observed) : null,
            e.evidence_id ? h(doc, 'div', { class: 'li-muted' }, 'Evidence ID: ', e.evidence_id) : null
          );
        });
      }
      parts.push(dom.section(doc, 'Evidence', evItems.length ? h(doc, 'ul', { class: 'li-list' }, evItems) : h(doc, 'p', { class: 'li-muted' }, 'No evidence items available.')));

      // OBSERVATIONS
      var obsItems = [];
      if (m.observations && m.observations.length) {
        obsItems = m.observations.map(function (o) {
          return h(doc, 'li', null,
            h(doc, 'strong', null, o.title || 'Observation'), ' ',
            claimKindBadge(o.claim_kind),
            h(doc, 'br'),
            h(doc, 'span', null, o.observed || ''),
            o.evidence_refs && o.evidence_refs.length ? h(doc, 'div', null, 'Evidence: ', dom.refChips(doc, o.evidence_refs)) : null
          );
        });
      }
      if (obsItems.length) parts.push(dom.section(doc, 'Observations', h(doc, 'ul', { class: 'li-list' }, obsItems)));

      // SIGNALS
      var sigItems = [];
      if (m.signals && m.signals.length) {
        sigItems = m.signals.map(function (s) {
          return h(doc, 'li', null,
            h(doc, 'span', { class: 'li-muted' }, s.observed_at || ''), ' ',
            dom.badge(doc, s.type || 'Signal'), ' ',
            h(doc, 'span', null, s.observed || s.description || '')
          );
        });
      }
      if (sigItems.length) parts.push(dom.section(doc, 'Signals', h(doc, 'ul', { class: 'li-list' }, sigItems)));

      // SALES ANGLES
      var angleItems = [];
      if (m.sales_angles && m.sales_angles.length) {
        angleItems = m.sales_angles.map(function (a) {
          return h(doc, 'li', { class: 'li-angle' },
            h(doc, 'strong', null, a.title || 'Sales angle'), ' ',
            claimKindBadge(a.claim_kind || 'inference'),
            h(doc, 'br'),
            h(doc, 'span', null, a.observed || a.description || ''),
            a.do_not_claim ? h(doc, 'div', { class: 'li-warning' }, 'Do not claim: ', a.do_not_claim) : null,
            a.evidence_refs && a.evidence_refs.length ? h(doc, 'div', null, 'Evidence: ', dom.refChips(doc, a.evidence_refs)) : null
          );
        });
      }
      parts.push(dom.section(doc, 'Sales Angles', angleItems.length ? h(doc, 'ul', { class: 'li-list' }, angleItems) : h(doc, 'p', { class: 'li-muted' }, 'No sales angles available. These are intelligence-derived recommendations, not verified facts.')));

      // RESEARCH ACTION
      parts.push(h(doc, 'div', { class: 'li-actions' },
        h(doc, 'button', { type: 'button', class: 'li-btn', onClick: loadAndRender }, 'Run Opportunity Research')
      ));

      container.appendChild(h(doc, 'div', { class: 'li-panel', 'aria-live': 'polite' }, parts));
    }

    function loadAndRender() {
      if (!api || !api.opportunity) { renderUnavailable(); return; }
      dom.clear(container);
      container.appendChild(h(doc, 'p', { class: 'li-muted' }, 'Loading Opportunity Intelligence...'));
      loadLatest()
        .then(function (v) { if (v && v.available) return v; return loadEngine().then(function () { return loadLatest(); }); })
        .then(function (v) { if (v && v.available) renderReport(v); else if (v && v.state === 'not_researched') renderEmpty(); else renderUnavailable(v ? v.message : 'Opportunity Intelligence unavailable'); })
        .catch(function (e) { renderError(e); });
    }

    // Initial load
    loadAndRender();

    return {
      refresh: loadAndRender,
      destroy: function () { dom.clear(container); },
    };
  }

  return { mountOpportunitySection: mountOpportunitySection };
}));