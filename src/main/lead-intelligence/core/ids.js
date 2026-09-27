'use strict';

const crypto = require('node:crypto');

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function stableHash(...parts) {
  const h = crypto.createHash('sha256');
  h.update(parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join('␟'));
  return h.digest('hex');
}

/** Deterministic id: same inputs -> same id. */
function stableId(prefix, ...parts) {
  return `${prefix}_${stableHash(...parts).slice(0, 24)}`;
}

module.exports = { newId, stableHash, stableId };
