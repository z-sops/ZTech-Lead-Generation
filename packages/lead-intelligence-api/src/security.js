'use strict';

const crypto = require('node:crypto');

/** The five roles, in order of authority. */
const ROLES = Object.freeze(['owner', 'admin', 'manager', 'member', 'viewer']);

/** Every permission the service knows about. */
const PERMISSIONS = Object.freeze([
  'workspace.read', 'workspace.write', 'workspace.create', 'workspace.delete',
  'member.read', 'member.invite', 'member.remove', 'member.role',
  'settings.write', 'suppression.check', 'audit.read', 'outreach.approve',
]);

/**
 * The permission matrix. It is here, in one place, and it is the ONLY
 * place: the API's authorization, the audit's reason and the tests all
 * read this table.
 */
const MATRIX = Object.freeze({
  owner: PERMISSIONS.slice(),
  admin: [
    'workspace.read', 'workspace.write', 'workspace.create',
    'member.read', 'member.invite', 'member.remove', 'member.role',
    'settings.write', 'suppression.check', 'audit.read', 'outreach.approve',
  ],
  manager: [
    'workspace.read', 'workspace.write',
    'member.read', 'member.invite', 'suppression.check', 'audit.read', 'outreach.approve',
  ],
  member: ['workspace.read', 'workspace.write', 'suppression.check'],
  viewer: ['workspace.read', 'suppression.check'],
});

/** The minimum length of a password. */
const MIN_PASSWORD = 12;

/** Is this a role the service knows? */
function isRole(role) {
  return ROLES.includes(role);
}

/** Does the role hold the permission? */
function hasPermission(role, permission) {
  const allowed = MATRIX[role];
  return Array.isArray(allowed) && allowed.includes(permission);
}

/**
 * The hash of a password: scrypt, with a random salt, and the parameters
 * in the string, so a stored hash can be checked and re-hashed later.
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${derived.toString('base64')}`;
}

/**
 * Is this the right password? The comparison is constant-time.
 */
function verifyPassword(password, stored) {
  try {
    const [scheme, n, r, p, salt, expected] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const expectedBytes = Buffer.from(expected, 'base64');
    const derived = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expectedBytes.length, {
      N: Number(n), r: Number(r), p: Number(p),
    });
    return crypto.timingSafeEqual(derived, expectedBytes);
  } catch {
    return false;
  }
}

/** A random token, and the hash that is stored instead of it. */
function newToken(bytes = 32) {
  const token = crypto.randomBytes(bytes).toString('base64url');
  return { token, hash: hashToken(token) };
}

/** The hash of a token: what the database stores. */
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** A random identifier. */
function newId() {
  return crypto.randomUUID();
}

/** A constant-time comparison of two strings. */
function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * The login throttle.
 *
 * A failed attempt is remembered, per email and per address, and the
 * attempt is refused for a while. It is in memory: with more than one
 * service instance the counter must be shared, and that is a deployment
 * concern rather than a security one - the window and the limit are the
 * same either way.
 */
class Throttle {
  constructor({ limit = 5, windowMs = 15 * 60 * 1000 } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.attempts = new Map();
  }

  /** Is this key currently locked out? */
  blocked(key) {
    const entry = this.attempts.get(key);
    if (!entry) return false;
    if (Date.now() - entry.first > this.windowMs) {
      this.attempts.delete(key);
      return false;
    }
    return entry.count >= this.limit;
  }

  /** A failure. */
  fail(key) {
    const entry = this.attempts.get(key);
    if (!entry || Date.now() - entry.first > this.windowMs) {
      this.attempts.set(key, { count: 1, first: Date.now() });
      return;
    }
    entry.count += 1;
  }

  /** A success: the counter is cleared. */
  succeed(key) {
    this.attempts.delete(key);
  }
}

module.exports = {
  ROLES, PERMISSIONS, MATRIX, MIN_PASSWORD, isRole, hasPermission,
  hashPassword, verifyPassword, newToken, hashToken, newId, safeEqual, Throttle,
};
