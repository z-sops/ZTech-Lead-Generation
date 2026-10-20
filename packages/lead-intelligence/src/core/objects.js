'use strict';

/** Read a dotted path ("a.b.0.c") from an object. Returns undefined when absent. */
function getPath(obj, path) {
  if (obj == null) return undefined;
  let cur = obj;
  for (const part of String(path).split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    if (part === '__proto__' || part === 'constructor' || part === 'prototype') return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = cur[part];
  }
  return cur;
}

/** First defined, non-null value among several dotted paths. */
function pick(obj, paths) {
  for (const p of paths) {
    const v = getPath(obj, p);
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

const SECRET_KEY = /(token|secret|password|passwd|api[_-]?key|apikey|authorization|credential|bearer|cookie|session[_-]?id|private[_-]?key)/i;

/**
 * Deep copy that drops any key whose name looks like a secret.
 * Used on every export and every IPC response as a last line of defence.
 */
function scrubSecrets(value, depth = 0) {
  if (depth > 40) return null;
  if (Array.isArray(value)) return value.map((v) => scrubSecrets(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY.test(k)) continue;
      out[k] = scrubSecrets(v, depth + 1);
    }
    return out;
  }
  return value;
}

function iso(date) {
  return (date instanceof Date ? date : new Date(date)).toISOString();
}

module.exports = { getPath, pick, clone, scrubSecrets, SECRET_KEY, iso };
