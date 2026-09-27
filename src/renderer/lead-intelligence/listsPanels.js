/* Saved Searches and Segments panels.
 *
 * INTEGRATION POINTS:
 * - getCurrentFilter(): returns the Lead Library's current filter converted to the
 *   lead-intelligence filter shape (src/search/filters.js FILTER_SCHEMA). QwenCoder maps
 *   the existing Lead Library filter state to it; unknown dimensions are omitted.
 * - getSelectedLeadIds(): returns selected lead ids from the existing Lead Library table.
 * - onShowResults(rows, title): hands result rows to the existing Lead Library list
 *   (e.g. filter the table to these ids). Rows are references only; no copies stored.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./dom'));
  else root.ZTechLI = Object.assign(root.ZTechLI || {}, { listsPanels: factory(root.ZTechLI.dom) });
}(typeof self !== 'undefined' ? self : this, function (dom) {
  'use strict';

  function mountSavedSearchesPanel(opts) {
    var doc = opts.doc || document;
    var h = dom.h;
    var api = opts.api;
    var container = opts.container;

    function fail(e) { render([], e); }

    function saveCurrent() {
      var input = container.querySelector('input[name="li-search-name"]');
      var name = input ? input.value.trim() : '';
      if (!name) return;
      api.searches.save({ name: name, filter: opts.getCurrentFilter() }).then(dom.unwrap).then(load).catch(fail);
    }

    function render(list, err) {
      dom.clear(container);
      container.appendChild(h(doc, 'div', { class: 'li-panel' },
        h(doc, 'h3', { class: 'li-section-title' }, 'Saved searches'),
        err ? dom.errorBox(doc, err) : null,
        h(doc, 'div', { class: 'li-actions' },
          h(doc, 'input', { type: 'text', name: 'li-search-name', placeholder: 'Name for current filters', maxlength: 120, 'aria-label': 'Saved search name' }),
          h(doc, 'button', { type: 'button', class: 'li-btn', onClick: saveCurrent }, 'Save current filters')),
        h(doc, 'ul', { class: 'li-list' }, list.map(function (s) {
          return h(doc, 'li', null,
            h(doc, 'strong', null, s.name), ' ', h(doc, 'span', { class: 'li-muted' }, 'updated ' + s.updated_at), ' ',
            h(doc, 'button', { type: 'button', class: 'li-btn li-btn-secondary', onClick: function () {
              api.searches.run({ searchId: s.search_id }).then(dom.unwrap).then(function (r) { opts.onShowResults(r.rows, s.name); }).catch(fail);
            } }, 'Run'), ' ',
            h(doc, 'button', { type: 'button', class: 'li-btn li-btn-danger', onClick: function () {
              api.searches.delete({ searchId: s.search_id }).then(dom.unwrap).then(load).catch(fail);
            } }, 'Delete'));
        }))));
    }

    function load() { return api.searches.list().then(dom.unwrap).then(function (l) { render(l, null); }).catch(fail); }
    load();
    return { refresh: load, destroy: function () { dom.clear(container); } };
  }

  function mountSegmentsPanel(opts) {
    var doc = opts.doc || document;
    var h = dom.h;
    var api = opts.api;
    var container = opts.container;

    function fail(e) { render([], e); }

    function create(kind) {
      var input = container.querySelector('input[name="li-segment-name"]');
      var name = input ? input.value.trim() : '';
      if (!name) return;
      var args = { name: name, kind: kind };
      if (kind === 'dynamic') args.filter = opts.getCurrentFilter();
      api.segments.save(args).then(dom.unwrap).then(function (seg) {
        if (kind === 'static') {
          var ids = opts.getSelectedLeadIds();
          if (ids && ids.length) return api.segments.addLeads({ segmentId: seg.segment_id, leadIds: ids }).then(dom.unwrap);
        }
        return null;
      }).then(load).catch(fail);
    }

    function render(list, err) {
      dom.clear(container);
      container.appendChild(h(doc, 'div', { class: 'li-panel' },
        h(doc, 'h3', { class: 'li-section-title' }, 'Segments'),
        err ? dom.errorBox(doc, err) : null,
        h(doc, 'div', { class: 'li-actions' },
          h(doc, 'input', { type: 'text', name: 'li-segment-name', placeholder: 'Segment name', maxlength: 120, 'aria-label': 'Segment name' }),
          h(doc, 'button', { type: 'button', class: 'li-btn', onClick: function () { create('dynamic'); } }, 'New dynamic (current filters)'),
          h(doc, 'button', { type: 'button', class: 'li-btn li-btn-secondary', onClick: function () { create('static'); } }, 'New static (selected leads)')),
        h(doc, 'ul', { class: 'li-list' }, list.map(function (s) {
          return h(doc, 'li', null,
            dom.badge(doc, s.kind), ' ', h(doc, 'strong', null, s.name), ' ',
            h(doc, 'button', { type: 'button', class: 'li-btn li-btn-secondary', onClick: function () {
              api.segments.members({ segmentId: s.segment_id }).then(dom.unwrap).then(function (r) { opts.onShowResults(r.rows, s.name); }).catch(fail);
            } }, 'Show'), ' ',
            s.kind === 'static' ? h(doc, 'button', { type: 'button', class: 'li-btn li-btn-secondary', onClick: function () {
              var ids = opts.getSelectedLeadIds();
              if (!ids || !ids.length) return;
              api.segments.addLeads({ segmentId: s.segment_id, leadIds: ids }).then(dom.unwrap).then(load).catch(fail);
            } }, 'Add selected') : null, ' ',
            h(doc, 'button', { type: 'button', class: 'li-btn li-btn-secondary', onClick: function () {
              api.exports.research({ scope: { segmentId: s.segment_id }, format: 'csv' }).then(dom.unwrap).catch(fail);
            } }, 'Export CSV'), ' ',
            h(doc, 'button', { type: 'button', class: 'li-btn li-btn-danger', onClick: function () {
              api.segments.delete({ segmentId: s.segment_id }).then(dom.unwrap).then(load).catch(fail);
            } }, 'Delete'));
        }))));
    }

    function load() { return api.segments.list().then(dom.unwrap).then(function (l) { render(l, null); }).catch(fail); }
    load();
    return { refresh: load, destroy: function () { dom.clear(container); } };
  }

  return { mountSavedSearchesPanel: mountSavedSearchesPanel, mountSegmentsPanel: mountSegmentsPanel };
}));
