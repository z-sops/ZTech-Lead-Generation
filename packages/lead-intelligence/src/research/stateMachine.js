'use strict';

const { ConflictError } = require('../core/errors');
const { ACTIVE_STATES, RESEARCH_STATES } = require('../contracts/constants');

/**
 * Research job state machine.
 *
 *  requested -> preflight -> started -> polling -> complete | partial | failed
 *                   |           |          |
 *                   +--------> pending <---+   (temporary failure; retried at next_attempt_at)
 *                   |
 *                   +--------> blocked         (missing identity/domain/config/credentials;
 *                                               also from started/polling/pending on auth/quota errors)
 *
 *  complete | partial -> stale   (freshness expired; new research is allowed)
 *  failed, blocked, stale are final for that job; a new request creates a new job.
 */
const TRANSITIONS = Object.freeze({
  requested: ['preflight', 'blocked', 'failed'],
  preflight: ['started', 'blocked', 'pending', 'failed'],
  started: ['polling', 'complete', 'partial', 'failed', 'pending', 'blocked'],
  polling: ['polling', 'complete', 'partial', 'failed', 'pending', 'blocked'],
  pending: ['preflight', 'polling', 'pending', 'failed', 'blocked'],
  complete: ['stale'],
  partial: ['stale'],
  failed: [],
  blocked: [],
  stale: [],
});

function canTransition(from, to) {
  return Boolean(TRANSITIONS[from] && TRANSITIONS[from].includes(to));
}

function assertTransition(from, to) {
  if (!RESEARCH_STATES.includes(to)) throw new ConflictError(`Unknown research state ${to}`);
  if (!canTransition(from, to)) {
    const e = new ConflictError(`Invalid research transition ${from} -> ${to}`, { from, to });
    e.code = 'INVALID_TRANSITION';
    throw e;
  }
}

function isActive(state) {
  return ACTIVE_STATES.includes(state);
}

module.exports = { TRANSITIONS, canTransition, assertTransition, isActive };
