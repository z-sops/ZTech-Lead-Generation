'use strict';

/**
 * Error types for the ZTech lead-intelligence module.
 * Messages are always authored by ZTech code. Text returned by remote services is
 * never copied into an error message, so errors are safe to show in the renderer.
 */

class LiError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'LiError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

class ValidationError extends LiError {
  constructor(message, errors) {
    super('VALIDATION_FAILED', message, { errors: errors || [] });
    this.name = 'ValidationError';
  }
}

class NotFoundError extends LiError {
  constructor(what, id) {
    super('NOT_FOUND', `${what} not found`, { what, id: id === undefined ? null : String(id) });
    this.name = 'NotFoundError';
  }
}

class ConflictError extends LiError {
  constructor(message, details) {
    super('CONFLICT', message, details);
    this.name = 'ConflictError';
  }
}

class DuplicateActiveJobError extends ConflictError {
  constructor(requestKey) {
    super('An active research job already exists for this request', { requestKey });
    this.code = 'DUPLICATE_ACTIVE_JOB';
    this.name = 'DuplicateActiveJobError';
  }
}

class ProviderError extends LiError {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{retryable?: boolean, blocking?: boolean, details?: any}} [opts]
   *   retryable: temporary (network, 429, 5xx, outage) -> job goes to `pending`
   *   blocking: configuration/credential problem -> job goes to `blocked`
   */
  constructor(code, message, opts = {}) {
    super(code, message, opts.details);
    this.name = 'ProviderError';
    this.retryable = Boolean(opts.retryable);
    this.blocking = Boolean(opts.blocking);
  }
}

class ForbiddenError extends LiError {
  constructor(message) {
    super('FORBIDDEN', message || 'Request not allowed');
    this.name = 'ForbiddenError';
  }
}

/** Convert any error to a renderer-safe shape. Never includes stacks or remote text. */
function publicError(err) {
  if (err instanceof ValidationError) {
    const errors = (err.details && err.details.errors ? err.details.errors : [])
      .slice(0, 20)
      .map((e) => ({ path: String(e.path), message: String(e.message) }));
    return { code: err.code, message: err.message, errors };
  }
  if (err instanceof LiError) return { code: err.code, message: err.message };
  return { code: 'INTERNAL_ERROR', message: 'Internal error' };
}

module.exports = {
  LiError,
  ValidationError,
  NotFoundError,
  ConflictError,
  DuplicateActiveJobError,
  ProviderError,
  ForbiddenError,
  publicError,
};
