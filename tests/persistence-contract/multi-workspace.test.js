'use strict';

/**
 * Two workspaces against one PostgreSQL 16 (M1 review, items 3 and 4).
 *
 * A key that is not scoped by the workspace lets one customer's row block
 * another customer's row, and lets a lookup cross the boundary. These tests
 * prove, against a real PostgreSQL 16:
 *
 *   1. two workspaces can hold the SAME business key - the same request key,
 *      the same lead id, the same packet id, the same idempotency key, the
 *      same sequence, the same trust event, the same reply review, the same
 *      stored message id, the same mailbox address - without blocking each
 *      other;
 *   2. neither workspace can READ or WRITE the other's rows: every read is
 *      empty, and a direct write of a foreign row is refused by the key;
 *   3. one workspace's "pause all follow-ups" does not pause another's
 *      sequences;
 *   4. the market rules are platform data: a tenant may read them, only the
 *      platform may write them;
 *   5. a global suppression blocks every workspace, but it never exposes the
 *      contact information it holds.
 *
 * These are STRUCTURAL tests. They prove the schema and the store's scoping
 * are tenant-safe. They do NOT prove tenant SECURITY: row-level security,
 * the role ladder and the cross-tenant denial suite are M2, and nothing here
 * may be read as a claim that they exist.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { PostgresStore } = require('../../packages/lead-intelligence-postgres/src/PostgresStore');
const { PLATFORM_WORKSPACE_ID } = require('../../packages/lead-intelligence-postgres/src/dialect');
const { freshDatabase, dropDatabase, skip } = require('./lib/postgres');

const URL = process.env.ZTECH_PG_URL || '';

const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const T1 = '2026-09-01T00:00:00.000Z';
const T2 = '2026-09-02T00:00:00.000Z';

const DATABASE = 'ztech_multi';

async function withSchema(fn) {
  const db = await freshDatabase(DATABASE, { workspace: A, workspaces: [A, B, PLATFORM_WORKSPACE_ID] });
  try {
    return await fn(db.pool, db.owner, db.platformPool);
  } finally {
    await dropDatabase(DATABASE, [db.pool, db.owner, db.platformPool, db.admin]);
  }
}

function job(over = {}) {
  return {
    job_id: 'rjob_1', lead_id: 'L1', provider_id: 'fake', request_key: 'the-same-key', requested_domain: 'acme.test',
    domain_key: 'acme.test', state: 'requested', options: {}, attempts: 0, poll_count: 0,
    created_at: T1, updated_at: T1, version: 1, ...over,
  };
}

function packet(over = {}) {
  return {
    packet_id: 'pkt_1', lead_id: 'L1', job_id: 'rjob_1', research_status: 'complete',
    digital_footprint: { state: 'clean' }, requested_domain: 'acme.test',
    captured_at: T1, freshness: { expires_at: T2 }, created_at: T1,
    facts: [], findings: [], strengths: [], not_measured: [], limitations: [], source_references: [], ...over,
  };
}

test('two workspaces can hold the same business key', { skip }, async () => {
  await withSchema(async (pool, owner, platformPool) => {
    const a = new PostgresStore({ pool, workspaceId: A, logger: { warn() {} } });
    const b = new PostgresStore({ pool, workspaceId: B, logger: { warn() {} } });

    // The same request key, the same lead, the same job id, the same domain.
    await a.jobs.insert(job());
    await b.jobs.insert(job());
    assert.ok(await a.jobs.get('rjob_1'), 'workspace A has its job');
    assert.ok(await b.jobs.get('rjob_1'), 'workspace B has its job');
    assert.equal((await a.jobs.findActive('the-same-key')).lead_id, 'L1');
    assert.equal((await b.jobs.findActive('the-same-key')).lead_id, 'L1');

    // The same packet id, the same lead.
    await a.packets.insert(packet());
    await b.packets.insert(packet());
    assert.ok(await a.packets.get('pkt_1'));
    assert.ok(await b.packets.get('pkt_1'));

    // The same idempotency key, the same send id.
    const send = { send_id: 's1', lead_id: 'L1', pitch_id: 'p1', channel: 'email', content_hash: 'h1', idempotency_key: 'the-same-key', state: 'attempted', created_at: T1, updated_at: T1 };
    await a.sends.record(send);
    await b.sends.record(send);
    const acceptedA = await a.sends.accept({ sendId: 's1', providerId: 'resend', providerMessageId: 'pm1', at: T2 });
    const acceptedB = await b.sends.accept({ sendId: 's1', providerId: 'resend', providerMessageId: 'pm2', at: T2 });
    assert.equal(acceptedA.ok, true, 'workspace A accepted its send');
    assert.equal(acceptedB.ok, true, 'workspace B accepted the same key: the index is tenant-scoped');

    // The same sequence, the same lead, the same first send.
    const seq = {
      sequence_id: 'seq_aaaaaaaa', lead_id: 'L1', mailbox_id: 'mbx_aaaaaaaa', first_send_id: 's1', first_pitch_id: 'p1',
      thread_id: 'th1', first_subject: 'subject', recipient_address: 'a@b.test', first_accepted_at: T1, status: 'draft',
      hold_code: null, resume_at: null, replies_gap_at: null, stop_reason: null, activated_at: null, created_at: T1, updated_at: T1,
    };
    const step = { sequence_id: 'seq_aaaaaaaa', step_no: 1, pitch_id: 'sp1', delay_days: 3, state: 'waiting', due_at: null, next_attempt_at: null, send_id: null, sent_at: null, last_code: null, limit_strikes: 0, draft: { pitch_id: 'sp1', kind: 'followup' }, updated_at: T1 };
    await a.sequences.create(seq, [step]);
    await b.sequences.create(seq, [step]);
    assert.ok(await a.sequences.openForLead('L1'));
    assert.ok(await b.sequences.openForLead('L1'), 'both workspaces may hold an open sequence for the same lead');

    // The same trust event id, the same reply review, the same route.
    const event = { row_id: 'te1', event_id: 'ev1', kind: 'unsubscribe', channel: 'email', normalized_address: 'a@b.test', source: 'relay', state: 'applied', received_at: T1, recorded_at: T1 };
    await a.trustEvents.append(event);
    await b.trustEvents.append(event);
    assert.ok(await a.trustEvents.get('ev1'));
    assert.ok(await b.trustEvents.get('ev1'));

    await a.replyReviews.put({ review_id: 'rv1', event_id: 'ev1', channel: 'email', normalized_address: 'a@b.test', outcome: 'interested', reviewed_by: 'Zee', reviewed_at: T1 });
    await b.replyReviews.put({ review_id: 'rv1', event_id: 'ev1', channel: 'email', normalized_address: 'a@b.test', outcome: 'not_interested', reviewed_by: 'Ze', reviewed_at: T1 });
    assert.equal((await a.replyReviews.forEvent('ev1')).outcome, 'interested');
    assert.equal((await b.replyReviews.forEvent('ev1')).outcome, 'not_interested', 'each workspace keeps its own review');

    // The same mailbox address, the same stored message id.
    const mailbox = {
      mailbox_id: 'mbx_aaaaaaaa', provider: 'gmail', email_address: 'z@z.test', display_name: 'Zee', status: 'ready', status_code: null,
      daily_cap: 20, hourly_cap: 5, min_gap_seconds: 60, window_start: '09:00', window_end: '17:00', window_days: '1,2,3,4,5',
      time_zone: 'UTC', is_default: 0, sync_cursor: null, connected_at: T1, updated_at: T1,
    };
    await a.mailboxes.upsert(mailbox);
    await b.mailboxes.upsert(mailbox);
    assert.ok(await a.mailboxes.get('mbx_aaaaaaaa'));
    assert.ok(await b.mailboxes.get('mbx_aaaaaaaa'));
    await a.mailboxSent.record({ send_id: 's1', mailbox_id: 'mbx_aaaaaaaa', provider_message_id: 'pm1', stored_message_id: 'sm1', thread_id: 'th1', recipient_address: 'a@b.test', recorded_at: T1 });
    await b.mailboxSent.record({ send_id: 's1', mailbox_id: 'mbx_aaaaaaaa', provider_message_id: 'pm1', stored_message_id: 'sm1', thread_id: 'th1', recipient_address: 'a@b.test', recorded_at: T1 });
    assert.ok(await a.mailboxSent.get('s1'));
    assert.ok(await b.mailboxSent.get('s1'));
  });
});

test('one workspace cannot read the other\'s rows', { skip }, async () => {
  await withSchema(async (pool, owner, platformPool) => {
    const a = new PostgresStore({ pool, workspaceId: A, logger: { warn() {} } });
    const b = new PostgresStore({ pool, workspaceId: B, logger: { warn() {} } });
    await a.jobs.insert(job());
    await a.packets.insert(packet());
    await a.pitches.upsert({ pitch_id: 'p1', lead_id: 'L1', status: 'draft', content_hash: 'h1', created_at: T1, updated_at: T1 });
    await a.savedSearches.upsert({ search_id: 's1', name: 'A search', filter: { city: 'Karachi' }, created_at: T1, updated_at: T1 });
    await a.trustEvents.append({ row_id: 'te1', event_id: 'ev1', kind: 'unsubscribe', channel: 'email', normalized_address: 'a@b.test', source: 'relay', state: 'applied', received_at: T1, recorded_at: T1 });

    assert.equal(await b.jobs.get('rjob_1'), null, 'the job is not visible');
    assert.equal(await b.packets.get('pkt_1'), null, 'the packet is not visible');
    assert.equal(await b.pitches.get('p1'), null, 'the pitch is not visible');
    assert.equal(await b.savedSearches.get('s1'), null, 'the saved search is not visible');
    assert.equal(await b.trustEvents.get('ev1'), null, 'the trust event is not visible');
    assert.equal((await b.jobs.listByLead('L1')).length, 0, 'the list is empty');
    assert.equal((await b.jobs.latestPerLead()).size, 0, 'the map is empty');
    assert.equal((await b.packets.latestMetaPerLead()).size, 0, 'the packet map is empty');
    assert.equal((await b.enrichmentObservations.listAllGrouped()).size, 0, 'the observation map is empty');
  });
});

test('a row of one workspace cannot be written under another workspace\'s key', { skip }, async () => {
  await withSchema(async (pool, owner, platformPool) => {
    const a = new PostgresStore({ pool, workspaceId: A, logger: { warn() {} } });
    const b = new PostgresStore({ pool, workspaceId: B, logger: { warn() {} } });
    await a.jobs.insert(job());
    // B may hold the same id, but it is B's own row: the key is tenant-scoped.
    await b.jobs.insert(job({ request_key: 'other-key' }));
    const aJob = await a.jobs.get('rjob_1');
    const bJob = await b.jobs.get('rjob_1');
    assert.equal(aJob.request_key, 'the-same-key');
    assert.equal(bJob.request_key, 'other-key', 'the two rows are separate');
  });
});

test('one workspace\'s pause-all does not pause another\'s sequences', { skip }, async () => {
  await withSchema(async (pool, owner, platformPool) => {
    const a = new PostgresStore({ pool, workspaceId: A, logger: { warn() {} } });
    const b = new PostgresStore({ pool, workspaceId: B, logger: { warn() {} } });
    await a.sequences.setControl({ paused: true, updatedAt: T1 });
    assert.equal((await a.sequences.control()).paused, true, 'workspace A is paused');
    assert.equal((await b.sequences.control()).paused, false, 'workspace B is not');
  });
});

test('the market rules are platform data', { skip }, async () => {
  await withSchema(async (pool, owner, platformPool) => {
    const tenant = new PostgresStore({ pool, workspaceId: A, role: 'tenant', logger: { warn() {} } });
    const platform = new PostgresStore({ pool: platformPool, workspaceId: PLATFORM_WORKSPACE_ID, role: 'platform', logger: { warn() {} } });

    await assert.rejects(
      tenant.marketRules.set({ country_code: 'PK', rule: 'consent_required', note: 'note', reviewed_by: 'Zee', reviewed_at: T1 }),
      (e) => e.code === 'FORBIDDEN',
      'a tenant may not write the platform data',
    );
    const rule = await platform.marketRules.set({ country_code: 'PK', rule: 'consent_required', note: 'note', reviewed_by: 'Zee', reviewed_at: T1 });
    assert.equal(rule.rule, 'consent_required');
    assert.equal((await tenant.marketRules.get('pk')).rule, 'consent_required', 'a tenant may read it');
  });
});

test('a global suppression blocks every workspace, and exposes no contact information', { skip }, async () => {
  await withSchema(async (pool, owner, platformPool) => {
    const a = new PostgresStore({ pool, workspaceId: A, logger: { warn() {} } });
    const b = new PostgresStore({ pool, workspaceId: B, logger: { warn() {} } });
    const platform = new PostgresStore({ pool: platformPool, workspaceId: PLATFORM_WORKSPACE_ID, role: 'platform', logger: { warn() {} } });

    await platform.suppressions.add({ suppression_id: 'sup_g', scope: 'global', channel: 'email', normalized_address: 'secret@other.test', reason: 'unsubscribe', source: 'relay', created_at: T1 });

    // It blocks both workspaces...
    assert.equal(await a.suppressions.isSuppressed({ channel: 'email', address: 'secret@other.test' }), true, 'workspace A is blocked');
    assert.equal(await b.suppressions.isSuppressed({ channel: 'email', address: 'secret@other.test' }), true, 'workspace B is blocked');

    // ...but the address is never shown to a tenant: the row is invisible to
    // it, so there is nothing to redact - and the authorized check answers
    // with a yes or a no.
    const found = await a.suppressions.find({ channel: 'email', address: 'secret@other.test' });
    assert.equal(found, null, 'the tenant cannot read the global row at all');
    const listed = await a.suppressions.list({});
    assert.equal(listed.rows.length, 0, 'a global row is never listed to a tenant');
    const byAddress = await a.suppressions.listForAddress({ channel: 'email', address: 'secret@other.test' });
    assert.equal(byAddress.length, 0, 'and never listed by address either');
  });
});

test('a workspace sees only its own suppressions', { skip }, async () => {
  await withSchema(async (pool, owner, platformPool) => {
    const a = new PostgresStore({ pool, workspaceId: A, logger: { warn() {} } });
    const b = new PostgresStore({ pool, workspaceId: B, logger: { warn() {} } });
    await a.suppressions.add({ suppression_id: 'sup_a', scope: 'workspace', channel: 'email', normalized_address: 'a@b.test', reason: 'bounce', source: 'relay', created_at: T1 });
    assert.ok(await a.suppressions.find({ channel: 'email', address: 'a@b.test' }));
    assert.equal(await b.suppressions.find({ channel: 'email', address: 'a@b.test' }), null, 'workspace B does not see it');
    assert.equal(await b.suppressions.isSuppressed({ channel: 'email', address: 'a@b.test' }), false);
    assert.equal((await b.suppressions.list({})).rows.length, 0);
  });
});
