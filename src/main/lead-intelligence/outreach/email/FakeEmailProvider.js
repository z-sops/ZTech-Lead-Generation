'use strict';

const { EmailProvider, validateEmailMessage } = require('./EmailProvider');
const { LiError } = require('../../core/errors');

/** In-memory provider for tests and demos. Never delivers anything. */
class FakeEmailProvider extends EmailProvider {
  /**
   * @param {{failWith?: 'send'|'status'|null}} opts
   */
  constructor({ failWith = null } = {}) {
    super();
    this.failWith = failWith;
    this.outbox = [];
    this.seq = 0;
  }

  get id() { return 'fake-email'; }

  validate(message) { return validateEmailMessage(message); }

  async send(message) {
    const v = this.validate(message);
    if (!v.valid) throw new LiError('EMAIL_INVALID', 'Email message is invalid', { errors: v.errors });
    if (this.failWith === 'send') throw new LiError('EMAIL_SEND_FAILED', 'Fake provider configured to fail');
    this.seq += 1;
    const messageId = `fake-msg-${this.seq}`;
    this.outbox.push({ messageId, status: 'sent', message: { ...message } });
    return { messageId, status: 'sent' };
  }

  async getStatus(messageId) {
    if (this.failWith === 'status') throw new LiError('EMAIL_STATUS_FAILED', 'Fake provider configured to fail');
    const m = this.outbox.find((x) => x.messageId === messageId);
    return { messageId, status: m ? m.status : 'unknown' };
  }
}

module.exports = { FakeEmailProvider };
