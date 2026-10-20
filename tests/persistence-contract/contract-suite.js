'use strict';

/**
 * The shared persistence contract suite (M1).
 *
 * ONE suite, two backends. Every assertion here runs unchanged against the
 * desktop's sql.js store and against the PostgreSQL store, and the two
 * backends must produce the SAME results. That is the acceptance criterion:
 * the persistence suite runs against both backends and produces identical
 * results.
 *
 * A backend is described by:
 *
 *   label         how it is named in the test output
 *   create()      returns a store (already migrated)
 *   corrupt()     makes one row's JSON payload unreadable, in the way this
 *                 backend can: the desktop writes broken text into a TEXT
 *                 column, PostgreSQL empties a JSONB column
 *   insertSearch  writes one row with a raw statement, for the transaction
 *                 test - the two schemas differ by the workspace column
 *
 * The suite only uses the repository seam, so a method that only exists on
 * one backend fails here.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkRepositoryShape } = require('../../packages/lead-intelligence/src/persistence/interfaces');

/** A canonical timestamp: the same string on both backends. */
const T1 = '2026-09-01T00:00:00.000Z';
const T2 = '2026-09-02T00:00:00.000Z';
const T3 = '2026-09-03T00:00:00.000Z';

function job(over = {}) {
  return {
    job_id: 'rjob_a', lead_id: 'L1', provider_id: 'fake', request_key: 'k1', requested_domain: 'acme.test', domain_key: 'acme.test',
    state: 'requested', options: { depth: 1 }, attempts: 0, poll_count: 0, created_at: T1, updated_at: T1, version: 1,
    ...over,
  };
}

function packet(over = {}) {
  return {
    packet_id: 'pkt_1', lead_id: 'L1', job_id: 'rjob_a', research_status: 'complete',
    digital_footprint: { state: 'clean' }, requested_domain: 'acme.test',
    captured_at: T1, freshness: { expires_at: T2 }, created_at: T1,
    facts: [{ key: 'f1', value: 1 }], findings: [], strengths: [], not_measured: [], limitations: [], source_references: [],
    ...over,
  };
}

function pitch(over = {}) {
  return {
    pitch_id: 'p1', lead_id: 'L1', packet_id: 'pkt_1', status: 'draft', content_hash: 'h1',
    pitch_id_ref: 'p1', subject: 's', opening: 'o', body: 'b', created_at: T1, updated_at: T1,
    ...over,
  };
}

/**
 * Register the whole contract suite.
 * @param {{label: string, create: () => Promise<object>, corrupt: (store: object) => Promise<void>}} backend
 */
function describePersistenceContract(backend) {
  const { label, create, corrupt, insertSearch, workspaceId } = backend;
  // The workspace identifier the fixtures use: the desktop's local one, or the
  // uuid the PostgreSQL schema requires.
  const BACKEND = { workspaceId };

  test(`[${label}] the store satisfies the repository seam`, async () => {
    const store = await create();
    assert.deepEqual(checkRepositoryShape(store), [], 'the store satisfies the seam');
  });

  test(`[${label}] a research job round-trips, and only one may be active per request key`, async () => {
    const store = await create();
    await store.jobs.insert(job());
    const read = await store.jobs.get('rjob_a');
    assert.equal(read.lead_id, 'L1');
    assert.deepEqual(read.options, { depth: 1 }, 'the JSON options survive');
    assert.equal(read.created_at, T1, 'the timestamp survives unchanged');

    await assert.rejects(store.jobs.insert(job({ job_id: 'rjob_b' })), (e) => e.code === 'DUPLICATE_ACTIVE_JOB');
    await store.jobs.update(job({ state: 'failed', version: 2 }), 1);
    await store.jobs.insert(job({ job_id: 'rjob_c' }), 'a failed job does not block a new one');
  });

  test(`[${label}] a compare-and-set refuses a stale version`, async () => {
    const store = await create();
    await store.jobs.insert(job());
    // The first compare-and-set succeeds: the version is still 1.
    await store.jobs.update(job({ state: 'preflight', version: 2 }), 1);
    // The second one is stale, and is refused.
    await assert.rejects(store.jobs.update(job({ state: 'preflight', version: 2 }), 1), (e) => e.code === 'CONFLICT');
    await assert.rejects(store.jobs.update(job({ job_id: 'missing', version: 2 }), 1), (e) => e.code === 'NOT_FOUND');
  });

  test(`[${label}] the job queries agree`, async () => {
    const store = await create();
    await store.jobs.insert(job());
    await store.jobs.insert(job({ job_id: 'rjob_b', request_key: 'k2', state: 'pending', next_attempt_at: T1, created_at: T2 }));
    await store.jobs.insert(job({ job_id: 'rjob_c', request_key: 'k3', state: 'pending', next_attempt_at: T3, created_at: T3 }));
    assert.equal((await store.jobs.findActive('k1')).job_id, 'rjob_a');
    assert.equal((await store.jobs.listByLead('L1')).length, 3);
    assert.equal((await store.jobs.listByStates(['pending'])).length, 2);
    // A pending job is due only once its next attempt has come.
    assert.deepEqual((await store.jobs.listDue(T2)).map((j) => j.job_id), ['rjob_a', 'rjob_b']);
    const latest = await store.jobs.latestPerLead();
    assert.equal(latest.get('L1').job_id, 'rjob_c', 'the newest job wins');
  });

  test(`[${label}] an evidence packet round-trips, and the metadata agrees with the document`, async () => {
    const store = await create();
    await store.packets.insert(packet());
    const read = await store.packets.get('pkt_1');
    assert.equal(read.packet_id, 'pkt_1');
    assert.equal(read.facts.length, 1, 'the document survives');
    const meta = await store.packets.getMeta('pkt_1');
    assert.equal(meta.captured_at, T1);
    assert.equal(meta.research_status, 'complete');
    assert.equal((await store.packets.listMetaByLead('L1')).length, 1);
    assert.equal((await store.packets.latestMetaPerLead()).get('L1').packet_id, 'pkt_1');
  });

  test(`[${label}] a duplicate packet id is a conflict, not an overwrite`, async () => {
    const store = await create();
    await store.packets.insert(packet());
    await assert.rejects(store.packets.insert(packet({ facts: [] })), (e) => e.code === 'CONFLICT');
  });

  test(`[${label}] the newest readable packet is returned, and the previous one is found`, async () => {
    const store = await create();
    await store.packets.insert(packet());
    await store.packets.insert(packet({ packet_id: 'pkt_2', captured_at: T2, created_at: T2 }));
    const latest = await store.packets.latestForLead('L1');
    assert.equal(latest.packet_id, 'pkt_2');
    const previous = await store.packets.previousForLead('L1', 'pkt_2');
    assert.equal(previous.packet_id, 'pkt_1');
  });

  test(`[${label}] a corrupt row is skipped and reported, never fatal`, async () => {
    const store = await create();
    await store.packets.insert(packet());
    await store.packets.insert(packet({ packet_id: 'pkt_2', captured_at: T2, created_at: T2 }));
    await corrupt(store);
    const latest = await store.packets.latestForLead('L1');
    assert.ok(latest, 'a readable packet is still returned');
    assert.notEqual(latest.packet_id, 'pkt_2', 'the corrupt packet is skipped');
    assert.ok(store.corruptRows.length > 0, 'the corrupt row is reported');
  });

  test(`[${label}] the changes are recorded and read back`, async () => {
    const store = await create();
    const change = { change_id: 'ch1', lead_id: 'L1', type: 'fact_changed', detectedAt: T1, provenance: { previous_packet_id: 'pkt_1', current_packet_id: 'pkt_2' } };
    assert.equal(await store.changes.insertMany([change]), 1);
    const list = await store.changes.listByLead('L1');
    assert.equal(list.length, 1);
    assert.equal(list[0].change_id, 'ch1');
    assert.equal(list[0].provenance.current_packet_id, 'pkt_2', 'the provenance survives');
  });

  test(`[${label}] the saved searches round-trip and sort by name`, async () => {
    const store = await create();
    await store.savedSearches.upsert({ search_id: 's2', name: 'Beta', filter: { city: 'Karachi' }, created_at: T1, updated_at: T1 });
    await store.savedSearches.upsert({ search_id: 's1', name: 'alpha', filter: { city: 'Lahore' }, created_at: T1, updated_at: T1 });
    const list = await store.savedSearches.list();
    assert.deepEqual(list.map((r) => r.name), ['alpha', 'Beta'], 'the order does not depend on the case');
    assert.equal((await store.savedSearches.get('s1')).filter.city, 'Lahore');
    assert.equal(await store.savedSearches.delete('s1'), true);
    assert.equal((await store.savedSearches.list()).length, 1);
  });

  test(`[${label}] the segments and their members round-trip`, async () => {
    const store = await create();
    await store.segments.upsert({ segment_id: 'sg1', name: 'Food', kind: 'static', filter: { city: 'Karachi' }, created_at: T1, updated_at: T1 });
    assert.equal((await store.segments.get('sg1')).filter.city, 'Karachi');
    assert.equal(await store.segments.addMembers('sg1', ['L1', 'L2'], T1), 2);
    assert.equal(await store.segments.addMembers('sg1', ['L1'], T1), 2, 'adding twice is a no-op');
    assert.deepEqual(await store.segments.members('sg1'), ['L1', 'L2']);
    assert.equal(await store.segments.removeMembers('sg1', ['L1']), 1);
    assert.deepEqual(await store.segments.members('sg1'), ['L2']);
    assert.equal(await store.segments.delete('sg1'), true);
    assert.deepEqual(await store.segments.members('sg1'), []);
  });

  test(`[${label}] the pitch drafts round-trip, and the list is bounded and counted`, async () => {
    const store = await create();
    await store.pitches.upsert(pitch());
    const read = await store.pitches.get('p1');
    assert.equal(read.pitch_id, 'p1');
    assert.equal(read.subject, 's', 'the document survives');
    const list = await store.pitches.list({ limit: 10, offset: 0 });
    assert.equal(list.total, 1);
    assert.equal(list.rows.length, 1);
    assert.equal(list.limit, 10);
    assert.equal((await store.pitches.latestForLead('L1')).pitch_id, 'p1');
    assert.equal((await store.pitches.listByLead('L1')).length, 1);
  });

  test(`[${label}] an unknown pitch status is refused`, async () => {
    const store = await create();
    await assert.rejects(store.pitches.list({ status: 'blocked' }), (e) => e.code === 'VALIDATION_FAILED');
  });

  test(`[${label}] the approvals round-trip, and a regenerated draft drops them`, async () => {
    const store = await create();
    await store.approvals.insert({ approval_id: 'ap1', pitch_id: 'p1', content_hash: 'h1', approved_by: 'Zee', approved_at: T1 });
    assert.equal((await store.approvals.latestForPitch('p1')).approved_by, 'Zee');
    await store.approvals.deleteForPitches(['p1']);
    assert.equal(await store.approvals.latestForPitch('p1'), null);
  });

  test(`[${label}] the activity ledger is append-only and bounded`, async () => {
    const store = await create();
    await store.activity.append({ activity_id: 'a1', lead_id: 'L1', pitch_id: 'p1', activity_type: 'PITCH_APPROVED', metadata: { approvedBy: 'Zee' }, created_at: T1 });
    const list = await store.activity.list({ leadId: 'L1' });
    assert.equal(list.total, 1);
    assert.equal(list.rows[0].metadata.approvedBy, 'Zee');
    assert.equal((await store.activity.latestForPitch('p1', 'PITCH_APPROVED')).activity_id, 'a1');
    await assert.rejects(store.activity.append({ activity_id: 'a2', lead_id: 'L1', activity_type: 'NOT_A_TYPE', created_at: T1 }), (e) => e.code === 'VALIDATION_FAILED');
  });

  test(`[${label}] the send ledger records, accepts and refuses`, async () => {
    const store = await create();
    const rec = { send_id: 's1', lead_id: 'L1', pitch_id: 'p1', channel: 'email', content_hash: 'h1', idempotency_key: 'key1', state: 'attempted', created_at: T1, updated_at: T1 };
    await store.sends.record(rec);
    const attempted = await store.sends.get('s1');
    assert.equal(attempted.state, 'attempted');
    assert.equal(attempted.failure_code, null);
    const accepted = await store.sends.accept({ sendId: 's1', providerId: 'resend', providerMessageId: 'pm1', at: T2 });
    assert.equal(accepted.ok, true);
    assert.equal(accepted.row.state, 'accepted');
    assert.equal((await store.sends.findAccepted('key1')).send_id, 's1');
  });

  test(`[${label}] the idempotency guarantee: one accepted send per key`, async () => {
    const store = await create();
    const rec = { send_id: 's1', lead_id: 'L1', pitch_id: 'p1', channel: 'email', content_hash: 'h1', idempotency_key: 'key1', state: 'attempted', created_at: T1, updated_at: T1 };
    await store.sends.record(rec);
    await store.sends.accept({ sendId: 's1', providerId: 'resend', providerMessageId: 'pm1', at: T2 });
    // A second attempt with the same key: the database refuses it, and the
    // caller is told it is an idempotent replay, not a crash.
    await store.sends.record({ ...rec, send_id: 's2' });
    const second = await store.sends.accept({ sendId: 's2', providerId: 'resend', providerMessageId: 'pm2', at: T3 });
    assert.equal(second.ok, false);
    assert.equal(second.code, 'ALREADY_ACCEPTED');
    assert.equal(second.row.send_id, 's1', 'the first accepted send wins');
  });

  test(`[${label}] a send that failed may be retried`, async () => {
    const store = await create();
    const rec = { send_id: 's1', lead_id: 'L1', pitch_id: 'p1', channel: 'email', content_hash: 'h1', idempotency_key: 'key1', state: 'attempted', created_at: T1, updated_at: T1 };
    await store.sends.record(rec);
    const failed = await store.sends.fail({ sendId: 's1', failureCode: 'PROVIDER_REFUSED', failureMessage: 'no', at: T2 });
    assert.equal(failed.state, 'failed');
    await store.sends.record({ ...rec, send_id: 's2' });
    const accepted = await store.sends.accept({ sendId: 's2', providerId: 'resend', providerMessageId: 'pm2', at: T3 });
    assert.equal(accepted.ok, true, 'a failed attempt does not block the key');
  });

  test(`[${label}] the enrichment jobs keep one active job per lead`, async () => {
    const store = await create();
    const ej = { job_id: 'ej1', lead_id: 'L1', state: 'requested', fields: ['email'], steps: [], created_at: T1, updated_at: T1, version: 1 };
    await store.enrichmentJobs.insert(ej);
    await assert.rejects(store.enrichmentJobs.insert({ ...ej, job_id: 'ej2' }), (e) => e.code === 'DUPLICATE_ACTIVE_JOB');
    await store.enrichmentJobs.update({ ...ej, state: 'complete', version: 2 }, 1);
    await assert.rejects(store.enrichmentJobs.update({ ...ej, state: 'complete', version: 2 }, 1), (e) => e.code === 'CONFLICT');
    assert.deepEqual((await store.enrichmentJobs.get('ej1')).fields, ['email']);
  });

  test(`[${label}] the enrichment observations keep their provenance`, async () => {
    const store = await create();
    const obs = { observation_id: 'o1', lead_id: 'L1', job_id: 'ej1', field: 'email', status: 'FOUND', value: 'a@b.test', provider_id: 'fake', tier: 'first_party', collected_at: T1, provenance_id: 'pv1' };
    assert.equal(await store.enrichmentObservations.upsertMany([obs]), 1);
    const list = await store.enrichmentObservations.listByLead('L1');
    assert.equal(list.length, 1);
    assert.equal(list[0].value, 'a@b.test');
    assert.equal(list[0].provenance_id, 'pv1', 'the provenance survives');
    const grouped = await store.enrichmentObservations.listAllGrouped();
    assert.equal(grouped.get('L1').length, 1);
  });

  test(`[${label}] the OI associations and refresh requests round-trip`, async () => {
    const store = await create();
    await store.oiAssociations.put({ research_id: 'r1', lead_id: 'L1', snapshot_id: 'sn1', entity_key: 'ek1', status: 'ok', generated_at: T1, recorded_at: T1 });
    const all = await store.oiAssociations.listAll();
    assert.equal(all.length, 1);
    assert.equal(all[0].research_id, 'r1');

    const opened = await store.oiRefreshRequests.open({ request_id: 'req1', lead_id: 'L1', created_at: T1 });
    assert.equal(opened.state, 'pending');
    assert.equal((await store.oiRefreshRequests.pendingForLead('L1')).request_id, 'req1');
    await assert.rejects(store.oiRefreshRequests.open({ request_id: 'req2', lead_id: 'L1', created_at: T1 }));
    const closed = await store.oiRefreshRequests.close('req1', { state: 'succeeded', research_id: 'r1', updated_at: T2 });
    assert.equal(closed.state, 'succeeded');
    assert.equal(await store.oiRefreshRequests.pendingForLead('L1'), null);
  });

  test(`[${label}] the trust tables round-trip`, async () => {
    const store = await create();
    await store.suppressions.add({ suppression_id: 'sup1', scope: 'workspace', workspace_id: BACKEND.workspaceId, channel: 'email', normalized_address: 'a@b.test', reason: 'unsubscribe', source: 'relay', created_at: T1 });
    const found = await store.suppressions.find({ channel: 'email', address: 'a@b.test' });
    assert.equal(found.suppression_id, 'sup1');

    await store.consents.record({ consent_id: 'c1', lead_id: 'L1', channel: 'email', normalized_address: 'a@b.test', method: 'inbound_message', evidence_note: 'note', recorded_by: 'Zee', consented_at: T1, recorded_at: T1, source: 'user' });
    assert.equal((await store.consents.latestFor({ channel: 'email', address: 'a@b.test' })).consent_id, 'c1');

    await store.provenance.put({ lead_id: 'L1', field: 'email', source_kind: 'import', source_ref: 'src', collected_at: T1, backfilled: true, recorded_at: T1 });
    assert.equal((await store.provenance.listByLead('L1'))[0].backfilled, 1, 'the flag keeps its 0/1 shape');

    await store.trustEvents.append({ row_id: 'te1', event_id: 'ev1', kind: 'unsubscribe', channel: 'email', normalized_address: 'a@b.test', source: 'relay', state: 'applied', received_at: T1, recorded_at: T1 });
    assert.equal((await store.trustEvents.get('ev1')).row_id, 'te1');

    await store.recipientRefs.ensure({ recipient_ref: 'rref_0123456789abcdef0123456789abcdef', channel: 'email', normalized_address: 'a@b.test', created_at: T1 });
    assert.equal((await store.recipientRefs.resolve('rref_0123456789abcdef0123456789abcdef')).normalized_address, 'a@b.test');
  });

  test(`[${label}] a trust event is accepted only once`, async () => {
    const store = await create();
    const ev = { row_id: 'te1', event_id: 'ev1', kind: 'unsubscribe', channel: 'email', normalized_address: 'a@b.test', source: 'relay', state: 'applied', received_at: T1, recorded_at: T1 };
    await store.trustEvents.append(ev);
    await store.trustEvents.append({ ...ev, row_id: 'te2' });
    const listed = await store.trustEvents.list({});
    assert.equal(listed.rows.length, 1, 'the duplicate event is not recorded twice');
  });

  test(`[${label}] the mailboxes and their limits round-trip`, async () => {
    const store = await create();
    const mb = {
      mailbox_id: 'mbx_aaaaaaaa', provider: 'gmail', email_address: 'z@z.test', display_name: 'Zee', status: 'ready', status_code: null,
      daily_cap: 20, hourly_cap: 5, min_gap_seconds: 60, window_start: '09:00', window_end: '17:00', window_days: '1,2,3,4,5',
      time_zone: 'UTC', is_default: 0, sync_cursor: null, connected_at: T1, updated_at: T1,
    };
    await store.mailboxes.upsert(mb);
    assert.equal((await store.mailboxes.get('mbx_aaaaaaaa')).email_address, 'z@z.test');
    assert.equal((await store.mailboxes.list()).length, 1);
    await store.mailboxes.setDefault('mbx_aaaaaaaa', T2);
    assert.equal((await store.mailboxes.getDefault()).mailbox_id, 'mbx_aaaaaaaa');

    await store.mailboxSent.record({ send_id: 's1', mailbox_id: 'mbx_aaaaaaaa', provider_message_id: 'pm1', stored_message_id: 'sm1', thread_id: 'th1', recipient_address: 'a@b.test', recorded_at: T1 });
    assert.equal((await store.mailboxSent.get('s1')).stored_message_id, 'sm1');
    assert.equal((await store.mailboxSent.findByStoredIds('mbx_aaaaaaaa', ['sm1'])).stored_message_id, 'sm1');
  });

  test(`[${label}] the market rules are readable, and the reply reviews round-trip`, async () => {
    const store = await create();
    // The market rules are PLATFORM data: a tenant may read them, but only
    // the platform may write them. The write path is therefore not part of
    // this shared suite - it is proved by the multi-workspace suite, which
    // runs against the cloud backend.
    assert.ok(Array.isArray(await store.marketRules.list()), 'the rules are readable');
    assert.equal(await store.marketRules.get('pk'), null, 'a rule that was never set is absent');

    await store.replyReviews.put({ review_id: 'rv1', event_id: 'ev1', channel: 'email', normalized_address: 'a@b.test', outcome: 'interested', reviewed_by: 'Zee', reviewed_at: T1 });
    assert.equal((await store.replyReviews.forEvent('ev1')).outcome, 'interested');
    assert.equal((await store.replyReviews.latestFor({ channel: 'email', address: 'a@b.test' })).review_id, 'rv1');
  });

  test(`[${label}] the sequences round-trip, and only one may be open per lead`, async () => {
    const store = await create();
    const seq = {
      sequence_id: 'seq_aaaaaaaa', lead_id: 'L1', mailbox_id: 'mbx_aaaaaaaa', first_send_id: 's1', first_pitch_id: 'p1', thread_id: 'th1',
      first_subject: 'subject', recipient_address: 'a@b.test', first_accepted_at: T1, status: 'draft', hold_code: null,
      resume_at: null, replies_gap_at: null, stop_reason: null, activated_at: null, created_at: T1, updated_at: T1,
    };
    const step = { sequence_id: 'seq_aaaaaaaa', step_no: 1, pitch_id: 'sp1', delay_days: 3, state: 'waiting', due_at: null, next_attempt_at: null, send_id: null, sent_at: null, last_code: null, limit_strikes: 0, draft: { pitch_id: 'sp1', kind: 'followup', subject: 'follow up' }, updated_at: T1 };
    await store.sequences.create(seq, [step]);
    assert.equal((await store.sequences.get('seq_aaaaaaaa')).status, 'draft');
    assert.equal((await store.sequences.openForLead('L1')).sequence_id, 'seq_aaaaaaaa');
    assert.equal((await store.sequences.steps('seq_aaaaaaaa')).length, 1);
    assert.equal((await store.sequences.steps('seq_aaaaaaaa'))[0].draft.subject, 'follow up', 'the draft document survives');

    await assert.rejects(store.sequences.create({ ...seq, sequence_id: 'sq2' }, [step]), 'a second open sequence for the lead is refused');

    const activated = await store.sequences.update('seq_aaaaaaaa', { status: 'active', activated_at: T2 }, { expect: ['draft'] });
    assert.equal(activated.status, 'active');
    assert.equal(await store.sequences.update('seq_aaaaaaaa', { status: 'paused', hold_code: 'x' }, { expect: ['draft'] }), null, 'a stale expectation loses');
  });

  test(`[${label}] the sequence audit and the pause switch round-trip`, async () => {
    const store = await create();
    await store.sequences.appendEvent({ event_id: 'sev_aaaaaaaa', sequence_id: 'seq_aaaaaaaa', step_no: null, actor: 'operator', event: 'created', code: null, at: T1 });
    assert.equal((await store.sequences.events('seq_aaaaaaaa')).length, 1);
    assert.equal((await store.sequences.control()).paused, false);
    await store.sequences.setControl({ paused: true, updatedAt: T2 });
    assert.equal((await store.sequences.control()).paused, true);
    await store.sequences.setControl({ paused: false, updatedAt: T3 });
    assert.equal((await store.sequences.control()).paused, false);
  });

  test(`[${label}] the reply routes round-trip`, async () => {
    const store = await create();
    const route = { event_id: 'route_aaaaaaaa', lead_id: 'L1', mailbox_id: 'mbx_aaaaaaaa', kind: 'reply', suggested: 'interested', rule_id: 'rule_one', input: 'subject', confidence: 'high', confirmed: null, confirmed_by: null, confirmed_at: null, routed_at: T1 };
    await store.replyRoutes.put(route);
    assert.equal((await store.replyRoutes.get('route_aaaaaaaa')).suggested, 'interested');
    assert.equal((await store.replyRoutes.forLead('L1')).length, 1);
    const confirmed = await store.replyRoutes.confirm('route_aaaaaaaa', { category: 'interested', by: 'Zee', at: T2 });
    assert.equal(confirmed.confirmed, 'interested');
  });

  test(`[${label}] purgeLead removes the lead data and keeps the address-keyed history`, async () => {
    const store = await create();
    await store.packets.insert(packet());
    await store.pitches.upsert(pitch());
    await store.approvals.insert({ approval_id: 'ap1', pitch_id: 'p1', content_hash: 'h1', approved_by: 'Zee', approved_at: T1 });
    await store.suppressions.add({ suppression_id: 'sup1', scope: 'workspace', workspace_id: BACKEND.workspaceId, channel: 'email', normalized_address: 'a@b.test', reason: 'unsubscribe', source: 'relay', created_at: T1 });
    await store.trustEvents.append({ row_id: 'te1', event_id: 'ev1', kind: 'unsubscribe', channel: 'email', normalized_address: 'a@b.test', source: 'relay', state: 'applied', received_at: T1, recorded_at: T1 });

    await store.purgeLead('L1');

    assert.equal(await store.packets.get('pkt_1'), null, 'the packet is gone');
    assert.equal(await store.pitches.get('p1'), null, 'the pitch is gone');
    assert.equal(await store.approvals.latestForPitch('p1'), null, 'the approval is gone');
    assert.ok(await store.suppressions.find({ channel: 'email', address: 'a@b.test' }), 'the suppression stays');
    assert.ok(await store.trustEvents.get('ev1'), 'the trust event stays');
  });

  test(`[${label}] a transaction commits, and a failure rolls back`, async () => {
    const store = await create();
    await store.tx(async () => {
      await insertSearch(store, { search_id: 'tx1', name: 'Tx' });
    });
    const found = await store.savedSearches.get('tx1');
    assert.ok(found, 'the committed row is there');
    await assert.rejects(store.tx(async () => {
      await insertSearch(store, { search_id: 'tx2', name: 'Tx2' });
      throw new Error('deliberate');
    }));
    assert.equal(await store.savedSearches.get('tx2'), null, 'the failed transaction left nothing behind');
  });
}

module.exports = { describePersistenceContract };
