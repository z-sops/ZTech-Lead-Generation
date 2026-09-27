/* Pitch preview + Outreach Gate status panel.
 * Shows each observation with its evidence refs, unsupported claims, gate reasons,
 * and an explicit human "Approve" action. There is no send button unless the email
 * channel is enabled in main-process config (it is disabled in this phase).
 *
 * INTEGRATION POINT: mount under the research section in the Lead Profile.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./dom'));
  else root.ZTechLI = Object.assign(root.ZTechLI || {}, { pitchPanel: factory(root.ZTechLI.dom) });
}(typeof self !== 'undefined' ? self : this, function (dom) {
  'use strict';

  function mountPitchPanel(opts) {
    var doc = opts.doc || document;
    var h = dom.h;
    var api = opts.api;
    var container = opts.container;
    var leadId = opts.leadId;
    var targetId = opts.targetId;

    function fail(e) { render(null, null, e); }
    function withTarget(o) { if (targetId !== undefined && targetId !== null) o.targetId = targetId; return o; }

    function generate() {
      api.pitch.generate(withTarget({ leadId: leadId })).then(dom.unwrap).then(showPitch).catch(fail);
    }

    function showPitch(pitch) {
      if (!pitch) { render(null, null, null); return null; }
      return api.outreach.gate({ pitchId: pitch.pitch_id }).then(dom.unwrap).then(function (g) { render(pitch, g, null); }).catch(function (e) { render(pitch, null, e); });
    }

    function saveEdits(pitch) {
      var get = function (n) { var el = container.querySelector('[name="' + n + '"]'); return el ? el.value : undefined; };
      api.pitch.update({ pitchId: pitch.pitch_id, subject: get('li-subject'), opening: get('li-opening'), valueProposition: get('li-value'), callToAction: get('li-cta') })
        .then(dom.unwrap).then(showPitch).catch(fail);
    }

    function render(pitch, gate, err) {
      dom.clear(container);
      var parts = [h(doc, 'h3', { class: 'li-section-title' }, 'Pitch preview'), err ? dom.errorBox(doc, err) : null,
        h(doc, 'div', { class: 'li-actions' }, h(doc, 'button', { type: 'button', class: 'li-btn', onClick: generate }, pitch ? 'Regenerate from latest evidence' : 'Generate pitch'))];
      if (pitch) {
        parts.push(dom.badge(doc, pitch.status));
        parts.push(h(doc, 'label', { for: 'li-subject' }, 'Subject'), h(doc, 'input', { type: 'text', id: 'li-subject', name: 'li-subject', value: pitch.subject, maxlength: 150 }));
        parts.push(h(doc, 'label', { for: 'li-opening' }, 'Opening'), h(doc, 'textarea', { id: 'li-opening', name: 'li-opening', rows: 3, maxlength: 600 }, pitch.opening));
        parts.push(h(doc, 'h4', null, 'Observations (from evidence, not editable)'));
        parts.push(pitch.observations.length ? h(doc, 'ul', { class: 'li-list' }, pitch.observations.map(function (o) {
          return h(doc, 'li', null, o.text, ' ', dom.refChips(doc, o.refs));
        })) : h(doc, 'p', { class: 'li-muted' }, 'No evidence-backed observations available.'));
        parts.push(h(doc, 'label', { for: 'li-value' }, 'Value proposition'), h(doc, 'textarea', { id: 'li-value', name: 'li-value', rows: 3, maxlength: 1200 }, pitch.valueProposition));
        parts.push(h(doc, 'label', { for: 'li-cta' }, 'Call to action'), h(doc, 'textarea', { id: 'li-cta', name: 'li-cta', rows: 2, maxlength: 400 }, pitch.callToAction));
        if (pitch.unsupportedClaims.length) {
          parts.push(h(doc, 'div', { class: 'li-warning', role: 'alert' }, h(doc, 'strong', null, 'Unsupported claims — remove before approval:'),
            h(doc, 'ul', { class: 'li-list' }, pitch.unsupportedClaims.map(function (c) { return h(doc, 'li', null, c.field + ': “' + c.text + '” (' + c.reason + ')'); }))));
        }
        parts.push(h(doc, 'div', { class: 'li-actions' },
          h(doc, 'button', { type: 'button', class: 'li-btn li-btn-secondary', onClick: function () { saveEdits(pitch); } }, 'Save edits'),
          h(doc, 'button', { type: 'button', class: 'li-btn', disabled: pitch.status !== 'draft', onClick: function () {
            api.outreach.approve({ pitchId: pitch.pitch_id }).then(dom.unwrap).then(function () { return showPitch(pitch); }).catch(fail);
          } }, 'Approve pitch')));
        if (gate) {
          parts.push(h(doc, 'div', { class: 'li-gate', 'data-state': gate.decision },
            h(doc, 'h4', null, 'Outreach gate: ', dom.badge(doc, gate.decision)),
            gate.reasons.length ? h(doc, 'ul', { class: 'li-list' }, gate.reasons.map(function (r) { return h(doc, 'li', null, h(doc, 'code', null, r.code), ' ', r.message); })) : h(doc, 'p', null, 'All checks passed. Sending is not automatic.'),
            gate.warnings.length ? h(doc, 'ul', { class: 'li-list li-muted' }, gate.warnings.map(function (w) { return h(doc, 'li', null, w.message); })) : null));
        }
      }
      container.appendChild(h(doc, 'div', { class: 'li-panel' }, parts));
    }

    function load() {
      return api.pitch.get({ leadId: leadId }).then(dom.unwrap).then(showPitch).catch(fail);
    }
    load();
    return { refresh: load, destroy: function () { dom.clear(container); } };
  }

  return { mountPitchPanel: mountPitchPanel };
}));
