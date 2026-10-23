/* Lead-intelligence renderer helpers.
 * Safe DOM only: text goes through createTextNode, attributes through a whitelist.
 * No innerHTML, no inline event attributes, no inline styles (CSP-safe).
 *
 * Module format: works as CommonJS (bundled renderer) or as a plain <script>
 * (attaches to window.ZTechLI). INTEGRATION POINT: load it the same way the
 * existing renderer loads its scripts.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ZTechLI = Object.assign(root.ZTechLI || {}, { dom: factory() });
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ALLOWED_ATTRS = {
    class: 1, id: 1, title: 1, type: 1, disabled: 1, value: 1, name: 1, for: 1, role: 1,
    'aria-label': 1, 'aria-live': 1, 'aria-expanded': 1, 'aria-busy': 1, colspan: 1,
    checked: 1, placeholder: 1, tabindex: 1, rows: 1, maxlength: 1,
    'data-ref': 1, 'data-id': 1, 'data-state': 1,
  };
  var EVENTS = { onClick: 'click', onChange: 'change', onInput: 'input', onSubmit: 'submit' };

  function h(doc, tag, attrs) {
    var el = doc.createElement(tag);
    var a = attrs || {};
    Object.keys(a).forEach(function (k) {
      var v = a[k];
      if (EVENTS[k]) {
        if (typeof v === 'function') el.addEventListener(EVENTS[k], v);
        return;
      }
      if (!ALLOWED_ATTRS[k]) throw new Error('attribute not allowed: ' + k);
      if (v === false || v === null || v === undefined) return;
      el.setAttribute(k, v === true ? '' : String(v));
    });
    for (var i = 3; i < arguments.length; i += 1) append(doc, el, arguments[i]);
    return el;
  }

  function append(doc, el, child) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) { child.forEach(function (c) { append(doc, el, c); }); return; }
    if (typeof child === 'object' && child.nodeType) { el.appendChild(child); return; }
    el.appendChild(doc.createTextNode(String(child)));
  }

  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function refChips(doc, refs) {
    if (!refs || !refs.length) return null;
    return h(doc, 'span', { class: 'li-refs', title: 'Evidence references' },
      refs.map(function (r) { return h(doc, 'code', { class: 'li-ref', 'data-ref': r }, r); }));
  }

  function section(doc, title, body) {
    return h(doc, 'section', { class: 'li-section' }, h(doc, 'h3', { class: 'li-section-title' }, title), body);
  }

  function kv(doc, rows) {
    return h(doc, 'dl', { class: 'li-kv' }, rows.filter(Boolean).map(function (r) {
      return [h(doc, 'dt', null, r[0]), h(doc, 'dd', null, r[1] === null || r[1] === undefined || r[1] === '' ? '—' : r[1])];
    }));
  }

  function badge(doc, text, state) {
    return h(doc, 'span', { class: 'li-badge', 'data-state': state || text }, text);
  }

  function errorBox(doc, err) {
    var msg = err && err.message ? err.message : 'Something went wrong';
    return h(doc, 'div', { class: 'li-error', role: 'alert' }, msg,
      err && err.errors && err.errors.length ? h(doc, 'ul', null, err.errors.map(function (e) { return h(doc, 'li', null, e.path + ': ' + e.message); })) : null);
  }

  /** Unwrap {ok, data, error} IPC responses. */
  function unwrap(res) {
    if (res && res.ok) return res.data;
    var e = new Error(res && res.error ? res.error.message : 'Request failed');
    e.code = res && res.error ? res.error.code : 'ERROR';
    e.errors = res && res.error ? res.error.errors : undefined;
    throw e;
  }

  return { h: h, clear: clear, refChips: refChips, section: section, kv: kv, badge: badge, errorBox: errorBox, unwrap: unwrap, ALLOWED_ATTRS: ALLOWED_ATTRS };
}));
