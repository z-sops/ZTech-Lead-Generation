'use strict';

/**
 * Phase 3, P09: the CRM and sales pipeline.
 *
 * Accounts (businesses being sold to) move through a fixed pipeline; every
 * change is written to an append-only activity trail in the SAME transaction
 * as the change, so the trail can never disagree with the data. Accounts are
 * archived, never deleted. Concurrent edits are caught with a version number.
 *
 * Roles: viewers read; members create, edit, move stages and write notes;
 * changing an account's owner (other than taking an unowned account
 * yourself) and archiving need `crm.manage` (owner, admin, manager).
 *
 * Nothing here contacts anyone. Stages record what a PERSON did.
 */

const crypto = require('node:crypto');

const STAGES = Object.freeze(['new', 'contacted', 'replied', 'meeting', 'proposal', 'won', 'lost']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LIMITS = Object.freeze({
  name: 200, website: 500, phone: 60, address: 300, nextStep: 300, lostReason: 300, note: 4000,
  maxValueCents: 100000000000, pageMax: 200, importMax: 100, q: 100,
});

class CrmError extends Error {
  constructor(status, code, message, field) {
    super(message);
    this.name = 'CrmError';
    this.status = status;
    this.code = code;
    if (field) this.field = field;
  }
}

const bad = (field, message) => new CrmError(400, 'invalid_account', message, field);

function oneLine(value, max, field, { required = false } = {}) {
  if (value === undefined) {
    if (required) throw bad(field, `${field} is required`);
    return undefined;
  }
  if (value === null || value === '') {
    if (required) throw bad(field, `${field} is required`);
    return null;
  }
  if (typeof value !== 'string') throw bad(field, `${field} must be text`);
  const s = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) {
    if (required) throw bad(field, `${field} is required`);
    return null;
  }
  if (s.length > max) throw bad(field, `${field} is longer than ${max} characters`);
  return s;
}

function website(value) {
  const s = oneLine(value, LIMITS.website, 'website');
  if (s === undefined || s === null) return s;
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(s) && !/^https?:\/\//i.test(s)) throw bad('website', 'the website must start with http or https');
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    throw bad('website', 'the website is not a web address');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw bad('website', 'the website must start with http or https');
  if (u.username || u.password) throw bad('website', 'the website may not contain a user name or password');
  if (!u.hostname.includes('.')) throw bad('website', 'the website is not a web address');
  return u.toString();
}

/** Validate the editable fields. `partial` = only the fields present. */
function validateFields(input, { partial }) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('account', 'the account must be an object');
  const out = {};
  const name = oneLine(input.name, LIMITS.name, 'name', { required: !partial });
  if (name !== undefined) {
    if (name === null) throw bad('name', 'name is required');
    out.name = name;
  }
  const w = website(input.website);
  if (w !== undefined) out.website = w;
  const phone = oneLine(input.phone, LIMITS.phone, 'phone');
  if (phone !== undefined) out.phone = phone;
  const address = oneLine(input.address, LIMITS.address, 'address');
  if (address !== undefined) out.address = address;
  const next = oneLine(input.next_step, LIMITS.nextStep, 'next_step');
  if (next !== undefined) out.next_step = next;
  if (input.next_step_at !== undefined) {
    if (input.next_step_at === null || input.next_step_at === '') out.next_step_at = null;
    else {
      const t = Date.parse(input.next_step_at);
      if (!Number.isFinite(t)) throw bad('next_step_at', 'the next-step date is not a date');
      out.next_step_at = new Date(t).toISOString();
    }
  }
  if (input.estimated_value_cents !== undefined) {
    const v = input.estimated_value_cents;
    if (v === null || v === '') out.estimated_value_cents = null;
    else if (!Number.isInteger(v) || v < 0 || v > LIMITS.maxValueCents) throw bad('estimated_value_cents', 'the value must be a whole number of cents, 0 or more');
    else out.estimated_value_cents = v;
  }
  if (input.currency !== undefined) {
    if (typeof input.currency !== 'string' || !/^[A-Z]{3}$/.test(input.currency)) throw bad('currency', 'the currency must be a three-letter code such as USD');
    out.currency = input.currency;
  }
  if (input.stage !== undefined) {
    if (!STAGES.includes(input.stage)) throw bad('stage', `the stage must be one of: ${STAGES.join(', ')}`);
    out.stage = input.stage;
  }
  const lost = oneLine(input.lost_reason, LIMITS.lostReason, 'lost_reason');
  if (lost !== undefined) out.lost_reason = lost;
  if (input.owner_user_id !== undefined) {
    if (input.owner_user_id === null || input.owner_user_id === '') out.owner_user_id = null;
    else if (typeof input.owner_user_id !== 'string' || !UUID_RE.test(input.owner_user_id)) throw bad('owner_user_id', 'the owner is not a user id');
    else out.owner_user_id = input.owner_user_id.toLowerCase();
  }
  return out;
}

function activity(accountId, kind, detail, actor, at) {
  return { activity_id: crypto.randomUUID(), account_id: accountId, kind, detail, actor_user_id: actor, at };
}

/** The fields a person sees changed, old -> new (never the note text, never contact data). */
function diff(before, after, fields) {
  const changes = {};
  for (const f of fields) {
    if ((before[f] ?? null) !== (after[f] ?? null)) changes[f] = { from: before[f] ?? null, to: after[f] ?? null };
  }
  return changes;
}

const TRACKED = ['name', 'website', 'phone', 'address', 'estimated_value_cents', 'currency', 'next_step', 'next_step_at'];

class CrmService {
  /**
   * @param {{now?: () => Date}} [deps]
   */
  constructor(deps = {}) {
    this.now = deps.now || (() => new Date());
  }

  /**
   * @param {object} store a workspace-scoped store (PostgresStore or in-memory)
   * @param {{userId: string, canManage: boolean, isMember: (userId: string) => Promise<boolean>}} actor
   */
  async create(store, actor, input) {
    const fields = validateFields(input, { partial: false });
    if (fields.stage === 'lost' && !fields.lost_reason) throw bad('lost_reason', 'say why the deal was lost');
    if (fields.stage !== 'lost') fields.lost_reason = null;
    if (fields.owner_user_id && fields.owner_user_id !== actor.userId) {
      if (!actor.canManage) throw new CrmError(403, 'forbidden', 'only a manager can give an account to someone else');
      if (!await actor.isMember(fields.owner_user_id)) throw bad('owner_user_id', 'the owner is not a member of this workspace');
    }
    const at = this.now().toISOString();
    const rec = {
      account_id: crypto.randomUUID(),
      stage: 'new',
      currency: 'USD',
      ...fields,
      source: 'manual',
      created_by: actor.userId, created_at: at, updated_by: actor.userId, updated_at: at, version: 1,
    };
    return store.tx(async () => {
      const row = await store.crm.createAccount(rec);
      await store.crm.addActivity(activity(row.account_id, 'created', { source: 'manual', stage: row.stage }, actor.userId, at));
      return row;
    });
  }

  /**
   * Add researched businesses to the CRM. The business's facts come from the
   * stored research result, never from the request, so nothing can be
   * invented on the way in. A business already in the CRM is skipped.
   */
  async importFromResearch(store, actor, { jobId, opportunityIds }) {
    if (typeof jobId !== 'string' || !UUID_RE.test(jobId)) throw new CrmError(400, 'invalid_import', 'the research job id is not valid');
    if (!Array.isArray(opportunityIds) || opportunityIds.length === 0 || opportunityIds.length > LIMITS.importMax) {
      throw new CrmError(400, 'invalid_import', `choose 1 to ${LIMITS.importMax} businesses to add`);
    }
    const ids = [...new Set(opportunityIds.map(String))];
    const at = this.now().toISOString();
    return store.tx(async () => {
      const row = await store.researchJobs.result({ jobId });
      const result = row && row.result;
      if (!result || result.schema !== 'ztech.research.v1') {
        throw new CrmError(409, 'no_research_result', 'this research job has no finished result to import from');
      }
      const opps = new Map(result.opportunities.map((o) => [o.opportunity_id, o]));
      const businesses = new Map(result.businesses.map((b) => [b.business_id, b]));
      const needs = new Map(result.needs.map((n) => [n.need_id, n]));
      const created = [];
      const skipped = [];
      for (const id of ids) {
        const opp = opps.get(id);
        if (!opp) { skipped.push({ opportunity_id: id, reason: 'not_in_this_research' }); continue; }
        const b = businesses.get(opp.business_id);
        const existing = await store.crm.findBySourceBusiness(b.business_id);
        if (existing) { skipped.push({ opportunity_id: id, reason: 'already_in_crm', account_id: existing.account_id }); continue; }
        const rec = {
          account_id: crypto.randomUUID(),
          name: String(b.name).slice(0, LIMITS.name),
          website: b.website ? String(b.website).slice(0, LIMITS.website) : null,
          phone: b.phone ? String(b.phone).slice(0, LIMITS.phone) : null,
          address: b.address ? String(b.address).slice(0, LIMITS.address) : null,
          stage: 'new',
          currency: 'USD',
          source: 'research',
          source_job_id: jobId,
          source_business_id: String(b.business_id).slice(0, 120),
          source_url: b.source_url ? String(b.source_url).slice(0, 500) : null,
          research_score: Number.isInteger(opp.score) ? opp.score : null,
          created_by: actor.userId, created_at: at, updated_by: actor.userId, updated_at: at, version: 1,
        };
        const account = await store.crm.createAccount(rec);
        await store.crm.addActivity(activity(account.account_id, 'imported', {
          job_id: jobId,
          score: opp.score,
          needs: opp.need_ids.map((n) => needs.get(n)).filter(Boolean).map((n) => n.category),
          source_url: rec.source_url,
        }, actor.userId, at));
        created.push(account);
      }
      return { created, skipped };
    });
  }

  async list(store, query = {}) {
    const limit = Math.min(Math.max(Number(query.limit) || 50, 1), LIMITS.pageMax);
    const offset = Math.max(Number(query.offset) || 0, 0);
    if (query.stage !== undefined && query.stage !== '' && !STAGES.includes(query.stage)) throw bad('stage', 'unknown stage');
    let ownerUserId = null;
    let unassigned = false;
    if (query.owner === 'unassigned') unassigned = true;
    else if (query.owner === 'me') ownerUserId = query.userId;
    else if (query.owner) {
      if (!UUID_RE.test(query.owner)) throw bad('owner', 'the owner filter is not valid');
      ownerUserId = query.owner.toLowerCase();
    }
    const q = query.q ? String(query.q).trim().slice(0, LIMITS.q) : '';
    return store.tx(async () => {
      const page = await store.crm.listAccounts({
        q, stage: query.stage || null, ownerUserId, unassigned, includeArchived: query.archived === 'include', limit, offset,
      });
      const summary = await store.crm.pipelineSummary();
      return { accounts: page.rows, more: page.more, offset, limit, pipeline: STAGES.map((s) => summary.find((x) => x.stage === s) || { stage: s, accounts: 0, value_cents: 0 }) };
    });
  }

  async detail(store, accountId) {
    if (!UUID_RE.test(String(accountId))) return null;
    return store.tx(async () => {
      const account = await store.crm.getAccount(accountId);
      if (!account) return null;
      // One after the other: both run on the transaction's single connection.
      const notes = await store.crm.listNotes(accountId);
      const activityRows = await store.crm.listActivity(accountId);
      return { account, notes, activity: activityRows };
    });
  }

  /**
   * @param {object} input editable fields + `version` (required) + optional `archived` boolean
   */
  async update(store, actor, accountId, input) {
    if (!UUID_RE.test(String(accountId))) throw new CrmError(404, 'not_found', 'no such account');
    if (!input || !Number.isInteger(input.version)) throw bad('version', 'the version you edited is required');
    const fields = validateFields(input, { partial: true });
    const at = this.now().toISOString();
    return store.tx(async () => {
      const before = await store.crm.getAccount(accountId);
      if (!before) throw new CrmError(404, 'not_found', 'no such account');
      if (before.version !== input.version) {
        throw new CrmError(409, 'version_conflict', 'someone else changed this account; reload it and try again');
      }
      const patch = { ...fields };
      const events = [];

      if (input.archived !== undefined) {
        if (typeof input.archived !== 'boolean') throw bad('archived', 'archived must be true or false');
        if (!actor.canManage) throw new CrmError(403, 'forbidden', 'only a manager can archive or restore an account');
        const isArchived = Boolean(before.archived_at);
        if (input.archived && !isArchived) { patch.archived_at = at; events.push(['archived', {}]); }
        if (!input.archived && isArchived) { patch.archived_at = null; events.push(['restored', {}]); }
      } else if (before.archived_at && Object.keys(fields).length) {
        throw new CrmError(409, 'archived', 'restore the account before changing it');
      }

      if (fields.owner_user_id !== undefined && fields.owner_user_id !== before.owner_user_id) {
        const takingUnowned = !before.owner_user_id && fields.owner_user_id === actor.userId;
        if (!actor.canManage && !takingUnowned) throw new CrmError(403, 'forbidden', 'only a manager can change who owns an account');
        if (fields.owner_user_id && !await actor.isMember(fields.owner_user_id)) throw bad('owner_user_id', 'the owner is not a member of this workspace');
        events.push(['assigned', { from: before.owner_user_id || null, to: fields.owner_user_id }]);
      }

      const stage = fields.stage !== undefined ? fields.stage : before.stage;
      const lostReason = fields.lost_reason !== undefined ? fields.lost_reason : before.lost_reason;
      if (stage === 'lost' && !lostReason) throw bad('lost_reason', 'say why the deal was lost');
      if (stage !== 'lost') patch.lost_reason = null;
      if (fields.stage !== undefined && fields.stage !== before.stage) {
        events.push(['stage_changed', { from: before.stage, to: fields.stage, ...(fields.stage === 'lost' ? { reason: lostReason } : {}) }]);
      }

      const changes = diff(before, { ...before, ...patch }, TRACKED);
      if (Object.keys(changes).length) events.push(['updated', { changes }]);
      if (!events.length) return before; // nothing changed: no write, no event

      patch.updated_by = actor.userId;
      patch.updated_at = at;
      const after = await store.crm.updateAccount(accountId, before.version, patch);
      if (!after) throw new CrmError(409, 'version_conflict', 'someone else changed this account; reload it and try again');
      for (const [kind, detail] of events) await store.crm.addActivity(activity(accountId, kind, detail, actor.userId, at));
      return after;
    });
  }

  async addNote(store, actor, accountId, body) {
    if (!UUID_RE.test(String(accountId))) throw new CrmError(404, 'not_found', 'no such account');
    if (typeof body !== 'string' || !body.trim()) throw new CrmError(400, 'invalid_note', 'the note is empty');
    const text = body.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
    if (text.length > LIMITS.note) throw new CrmError(400, 'invalid_note', `the note is longer than ${LIMITS.note} characters`);
    const at = this.now().toISOString();
    return store.tx(async () => {
      const account = await store.crm.getAccount(accountId);
      if (!account) throw new CrmError(404, 'not_found', 'no such account');
      const note = { note_id: crypto.randomUUID(), account_id: accountId, body: text, author_user_id: actor.userId, created_at: at };
      await store.crm.addNote(note);
      // The trail records THAT a note was written and by whom; the text stays in the note.
      await store.crm.addActivity(activity(accountId, 'note_added', { note_id: note.note_id }, actor.userId, at));
      return note;
    });
  }
}

module.exports = { CrmService, CrmError, STAGES, LIMITS, validateFields };
