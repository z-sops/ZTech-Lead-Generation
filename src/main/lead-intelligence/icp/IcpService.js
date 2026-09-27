'use strict';

const { NotFoundError } = require('../core/errors');

/** IcpService — evaluate one lead against a target's ICP (read-only, deterministic). */
class IcpService {
  constructor({ contexts }) {
    this.contexts = contexts;
  }

  async evaluate({ leadId, targetId }) {
    const ctx = await this.contexts.getContext(leadId, { targetId });
    if (!ctx.icp || !ctx.icp_fit) throw new NotFoundError('Target', targetId);
    return ctx.icp_fit;
  }
}

module.exports = { IcpService };
