'use strict';

/**
 * Phase 3, P09: the CRM and sales pipeline, over HTTP.
 *
 * The same suite runs against the in-memory store always, and against a real
 * PostgreSQL 16 when ZTECH_PG_URL is set - where it also proves that the
 * database itself isolates the CRM tables and keeps the activity trail
 * append-only.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { ApiServer } = require('../../packages/lead-intelligence-api/src/server');
const { STORAGE } = require('../../packages/lead-intelligence-api/src/inMemoryStore');
const { createResearchExecutor } = require('../../packages/lead-intelligence-worker/src/research');
const { startFixtureServer } = require('../lib/phase2-fixture-server');

class Client {
  constructor(base) { this.base = base; this.cookie = ''; this.csrf = ''; }

  async call(method, p, body) {
    const res = await fetch(`${this.base}${p}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(this.csrf ? { 'x-csrf-token': this.csrf } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  get(p) { return this.call('GET', p); }
  post(p, b) { return this.call('POST', p, b); }
  patch(p, b) { return this.call('PATCH', p, b); }
}

const PASSWORD = 'correct-horse-battery-staple-secure';
const CRITERIA = { industry: 'dentist', location: 'Leeds, UK', offer_categories: ['seo', 'security', 'web_design', 'booking'], max_results: 25 };

async function researchResult() {
  const fx = await startFixtureServer();
  try {
    const exec = createResearchExecutor({ env: {
      ZTECH_INSPECT_ALLOW_PRIVATE: '1', ZTECH_INSPECT_HOST_MAP: fx.hostMap, ZTECH_NOMINATIM_URL: fx.nominatimUrl, ZTECH_OVERPASS_URL: fx.overpassUrl,
    } });
    return await exec({ jobType: 'research', jobClass: 'noop', payload: { kind: 'business_research', criteria: CRITERIA } });
  } finally {
    await fx.close();
  }
}

async function harness(mode) {
  if (mode === 'memory') {
    const server = new ApiServer({ logger: { warn() {}, error() {}, log() {}, info() {} }, llm: null });
    const addr = await server.listen(0);
    return {
      base: `http://127.0.0.1:${addr.port}`,
      completeJob: async (ws, jobId, result) => {
        Object.assign(STORAGE.researchJobs.get(ws).get(jobId), { state: 'succeeded', result, finished_at: new Date().toISOString() });
      },
      // The in-memory identity has no invitation flow; a membership is added
      // the way its INSERT would add one. (PostgreSQL runs the real flow.)
      addMember: async (ws, userId, role) => {
        await server.service.db.query('INSERT INTO id.workspace_memberships (membership_id, workspace_id, user_id, role) VALUES ($1, $2, $3, $4)', [require('node:crypto').randomUUID(), ws, userId, role]);
      },
      close: () => server.close(),
    };
  }
  const { freshDatabase, dropDatabase } = require('../persistence-contract/lib/postgres');
  const { PostgresStore } = require('../../packages/lead-intelligence-postgres/src/PostgresStore');
  const db = await freshDatabase('ztech_api_crm', { workspaces: ['44444444-4444-4444-8444-444444444444'] });
  const server = new ApiServer({
    identity: db.identityPool,
    tenant: db.pool,
    llm: null,
    logger: { warn() {}, error(...a) { if (process.env.ZTECH_API_DEBUG) console.error('[api]', ...a); }, log() {}, info() {} },
    storeFor: async (session, workspaceId) => new PostgresStore({
      pool: db.pool, controlPool: db.controlPool, workspaceId, sessionId: session.session_id, userId: session.user_id, logger: { warn() {} },
    }),
  });
  const addr = await server.listen(0);
  return {
    base: `http://127.0.0.1:${addr.port}`,
    db,
    // Exactly what the worker's write_job_result leaves behind.
    completeJob: async (ws, jobId, result) => {
      await db.owner.query("UPDATE li.job_queue SET state = 'succeeded', result = $2::jsonb, finished_at = now() WHERE job_id = $1", [jobId, JSON.stringify(result)]);
    },
    close: async () => {
      await server.close();
      await dropDatabase('ztech_api_crm', [db.pool, db.owner, db.controlPool, db.identityPool, db.platformPool, db.admin]);
    },
  };
}

const MODES = ['memory', ...(process.env.ZTECH_PG_URL ? ['postgres'] : [])];

for (const mode of MODES) {
  test(`[${mode}] CRM and sales pipeline`, async (t) => {
    const result = await researchResult();
    const h = await harness(mode);
    t.after(() => h.close());
    const tag = `${mode}-${Date.now()}`;

    async function signUp(name) {
      const c = new Client(h.base);
      const r = await c.post('/api/auth/register', { email: `${name}-${tag}@ztech.test`, password: PASSWORD, organization: `${name} Org`, workspaceName: `${name} WS` });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      c.csrf = r.body.csrf_token;
      return { client: c, ws: r.body.workspace_id, userId: r.body.user_id, email: `${name}-${tag}@ztech.test` };
    }
    async function join(owner, name, role) {
      const user = await signUp(name);
      if (h.addMember) {
        await h.addMember(owner.ws, user.userId, role);
        return user;
      }
      const inv = await owner.client.post(`/api/workspaces/${owner.ws}/invitations`, { email: user.email, role });
      assert.equal(inv.status, 201, `invite: ${JSON.stringify(inv.body)}`);
      const acc = await user.client.post('/api/invitations/accept', { token: inv.body.token });
      assert.equal(acc.status, 200, JSON.stringify(acc.body));
      return user;
    }

    const owner = await signUp('owner');
    const member = await join(owner, 'member', 'member');
    const viewer = await join(owner, 'viewer', 'viewer');
    const rival = await signUp('rival');
    const crm = (ws) => `/api/workspaces/${ws}/crm/accounts`;

    let manual;
    let imported;

    await t.test('a member creates an account; the trail records it', async () => {
      const r = await member.client.post(crm(owner.ws), { name: '  Acme   Dental ', website: 'acme-dental.example', phone: '+44 113 000 0000', estimated_value_cents: 150000 });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      manual = r.body.account;
      assert.equal(manual.name, 'Acme Dental');
      assert.equal(manual.website, 'https://acme-dental.example/');
      assert.equal(manual.stage, 'new');
      assert.equal(manual.source, 'manual');
      assert.equal(manual.version, 1);
      assert.equal(manual.estimated_value_cents, 150000);
      const d = await member.client.get(`${crm(owner.ws)}/${manual.account_id}`);
      assert.deepEqual(d.body.activity.map((a) => a.kind), ['created']);
      assert.equal(d.body.activity[0].actor_user_id, member.userId);
    });

    await t.test('bad input is refused with the field', async () => {
      for (const [body, field] of [
        [{}, 'name'], [{ name: 'x'.repeat(201) }, 'name'], [{ name: 'A', website: 'ftp://x.example' }, 'website'],
        [{ name: 'A', stage: 'maybe' }, 'stage'], [{ name: 'A', estimated_value_cents: -1 }, 'estimated_value_cents'],
        [{ name: 'A', stage: 'lost' }, 'lost_reason'], [{ name: 'A', owner_user_id: 'nope' }, 'owner_user_id'],
      ]) {
        const r = await member.client.post(crm(owner.ws), body);
        assert.equal(r.status, 400, `${field}: ${JSON.stringify(r.body)}`);
        assert.equal(r.body.field, field);
      }
    });

    await t.test('a viewer reads and may not write', async () => {
      const list = await viewer.client.get(crm(owner.ws));
      assert.equal(list.status, 200);
      assert.equal(list.body.can_write, false);
      const r = await viewer.client.post(crm(owner.ws), { name: 'Nope Ltd' });
      assert.equal(r.status, 403);
      const p = await viewer.client.patch(`${crm(owner.ws)}/${manual.account_id}`, { version: 1, stage: 'contacted' });
      assert.equal(p.status, 403);
    });

    await t.test('stages move with a version check; a stale edit is refused', async () => {
      const a = await member.client.patch(`${crm(owner.ws)}/${manual.account_id}`, { version: 1, stage: 'contacted', next_step: 'Call back Tuesday' });
      assert.equal(a.status, 200, JSON.stringify(a.body));
      assert.equal(a.body.account.version, 2);
      const stale = await owner.client.patch(`${crm(owner.ws)}/${manual.account_id}`, { version: 1, stage: 'meeting' });
      assert.equal(stale.status, 409);
      assert.equal(stale.body.error, 'version_conflict');
      const noReason = await member.client.patch(`${crm(owner.ws)}/${manual.account_id}`, { version: 2, stage: 'lost' });
      assert.equal(noReason.status, 400);
      assert.equal(noReason.body.field, 'lost_reason');
      const same = await member.client.patch(`${crm(owner.ws)}/${manual.account_id}`, { version: 2, stage: 'contacted' });
      assert.equal(same.body.account.version, 2, 'no change, no write');
      const d = await member.client.get(`${crm(owner.ws)}/${manual.account_id}`);
      const kinds = d.body.activity.map((x) => x.kind);
      assert.deepEqual(kinds.sort(), ['created', 'stage_changed', 'updated'].sort());
      const sc = d.body.activity.find((x) => x.kind === 'stage_changed');
      assert.deepEqual(sc.detail, { from: 'new', to: 'contacted' });
      const up = d.body.activity.find((x) => x.kind === 'updated');
      assert.deepEqual(up.detail.changes.next_step, { from: null, to: 'Call back Tuesday' });
    });

    await t.test('owners: a member may take an unowned account; only a manager may reassign; owners must be members', async () => {
      const take = await member.client.patch(`${crm(owner.ws)}/${manual.account_id}`, { version: 2, owner_user_id: member.userId });
      assert.equal(take.status, 200, JSON.stringify(take.body));
      const give = await member.client.patch(`${crm(owner.ws)}/${manual.account_id}`, { version: 3, owner_user_id: owner.userId });
      assert.equal(give.status, 403);
      const outsider = await owner.client.patch(`${crm(owner.ws)}/${manual.account_id}`, { version: 3, owner_user_id: rival.userId });
      assert.equal(outsider.status, 400);
      assert.equal(outsider.body.field, 'owner_user_id');
      const mine = await member.client.get(`${crm(owner.ws)}?owner=me`);
      assert.deepEqual(mine.body.accounts.map((x) => x.account_id), [manual.account_id]);
    });

    await t.test('notes are added and the trail says who wrote one, not what', async () => {
      const n = await member.client.post(`${crm(owner.ws)}/${manual.account_id}/notes`, { body: 'Spoke to the practice manager; wants a quote.' });
      assert.equal(n.status, 201);
      const empty = await member.client.post(`${crm(owner.ws)}/${manual.account_id}/notes`, { body: '   ' });
      assert.equal(empty.status, 400);
      const d = await member.client.get(`${crm(owner.ws)}/${manual.account_id}`);
      assert.equal(d.body.notes[0].body, 'Spoke to the practice manager; wants a quote.');
      const added = d.body.activity.find((x) => x.kind === 'note_added');
      assert.ok(added && !JSON.stringify(added.detail).includes('quote'));
    });

    await t.test('import from research: real businesses only, facts from the stored result, no duplicates', async () => {
      const job = await member.client.post(`/api/workspaces/${owner.ws}/research/jobs`, { idempotency_key: `crm-${tag}`, payload: { kind: 'business_research', criteria: CRITERIA } });
      assert.equal(job.status, 202);
      const early = await member.client.post(`${crm(owner.ws)}/import`, { job_id: job.body.job_id, opportunity_ids: [result.opportunities[0].opportunity_id] });
      assert.equal(early.status, 409, 'nothing to import before the research finished');
      await h.completeJob(owner.ws, job.body.job_id, result);
      const picks = result.opportunities.filter((o) => o.score > 0).slice(0, 2).map((o) => o.opportunity_id);
      const r = await member.client.post(`${crm(owner.ws)}/import`, { job_id: job.body.job_id, opportunity_ids: [...picks, 'op_invented'] });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.created.length, 2);
      assert.deepEqual(r.body.skipped, [{ opportunity_id: 'op_invented', reason: 'not_in_this_research' }]);
      imported = r.body.created[0];
      const b = result.businesses.find((x) => x.name === imported.name);
      assert.ok(b, 'the account is a business from the research');
      assert.equal(imported.source, 'research');
      assert.equal(imported.source_url, b.source_url);
      assert.equal(imported.research_score, result.opportunities.find((o) => o.business_id === b.business_id).score);
      const again = await member.client.post(`${crm(owner.ws)}/import`, { job_id: job.body.job_id, opportunity_ids: picks });
      assert.equal(again.body.created.length, 0);
      assert.ok(again.body.skipped.every((s) => s.reason === 'already_in_crm'));
      const d = await member.client.get(`${crm(owner.ws)}/${imported.account_id}`);
      const imp = d.body.activity.find((x) => x.kind === 'imported');
      assert.equal(imp.detail.job_id, job.body.job_id);
    });

    await t.test('search, filters and the pipeline summary', async () => {
      const byName = await viewer.client.get(`${crm(owner.ws)}?q=acme`);
      assert.deepEqual(byName.body.accounts.map((x) => x.name), ['Acme Dental']);
      const wild = await viewer.client.get(`${crm(owner.ws)}?q=${encodeURIComponent('%')}`);
      assert.equal(wild.body.accounts.length, 0, 'a % in the search is a character, not a wildcard');
      const fresh = await viewer.client.get(`${crm(owner.ws)}?stage=new`);
      assert.equal(fresh.body.accounts.length, 2);
      const unassigned = await viewer.client.get(`${crm(owner.ws)}?owner=unassigned`);
      assert.ok(unassigned.body.accounts.every((x) => x.owner_user_id === null));
      const pipeline = Object.fromEntries(byName.body.pipeline.map((p) => [p.stage, p]));
      assert.equal(pipeline.new.accounts, 2);
      assert.equal(pipeline.contacted.accounts, 1);
      assert.equal(pipeline.contacted.value_cents, 150000);
      assert.deepEqual(byName.body.stages, ['new', 'contacted', 'replied', 'meeting', 'proposal', 'won', 'lost']);
    });

    await t.test('archiving: managers only; an archived account is hidden and frozen until restored', async () => {
      const cur = (await owner.client.get(`${crm(owner.ws)}/${imported.account_id}`)).body.account;
      const byMember = await member.client.patch(`${crm(owner.ws)}/${imported.account_id}`, { version: cur.version, archived: true });
      assert.equal(byMember.status, 403);
      const arch = await owner.client.patch(`${crm(owner.ws)}/${imported.account_id}`, { version: cur.version, archived: true });
      assert.equal(arch.status, 200);
      const list = await owner.client.get(crm(owner.ws));
      assert.ok(!list.body.accounts.some((x) => x.account_id === imported.account_id));
      const all = await owner.client.get(`${crm(owner.ws)}?archived=include`);
      assert.ok(all.body.accounts.some((x) => x.account_id === imported.account_id));
      const frozen = await owner.client.patch(`${crm(owner.ws)}/${imported.account_id}`, { version: arch.body.account.version, stage: 'won' });
      assert.equal(frozen.status, 409);
      assert.equal(frozen.body.error, 'archived');
      const back = await owner.client.patch(`${crm(owner.ws)}/${imported.account_id}`, { version: arch.body.account.version, archived: false });
      assert.equal(back.status, 200);
    });

    await t.test('another workspace sees nothing and changes nothing', async () => {
      const list = await rival.client.get(crm(rival.ws));
      assert.equal(list.body.accounts.length, 0);
      const peek = await rival.client.get(`${crm(owner.ws)}/${manual.account_id}`);
      assert.equal(peek.status, 403);
      const own = await rival.client.get(`${crm(rival.ws)}/${manual.account_id}`);
      assert.equal(own.status, 404, 'the id does not exist in another workspace');
      const edit = await rival.client.patch(`${crm(rival.ws)}/${manual.account_id}`, { version: 4, stage: 'won' });
      assert.equal(edit.status, 404);
      const note = await rival.client.post(`${crm(rival.ws)}/${manual.account_id}/notes`, { body: 'x' });
      assert.equal(note.status, 404);
    });

    if (mode === 'postgres') {
      await t.test('the database itself: isolation forced, trail append-only, worker shut out', async () => {
        const { db } = h;
        const tables = (await db.owner.query(
          `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'li' AND c.relkind = 'r' AND c.relname LIKE 'li_crm_%' ORDER BY 1`,
        )).rows;
        assert.deepEqual(tables.map((x) => [x.relname, x.relrowsecurity, x.relforcerowsecurity]),
          [['li_crm_accounts', true, true], ['li_crm_activity', true, true], ['li_crm_notes', true, true]]);
        const priv = async (role, table, p) => (await db.owner.query('SELECT has_table_privilege($1, $2, $3) AS ok', [role, `li.${table}`, p])).rows[0].ok;
        assert.equal(await priv('ztech_app', 'li_crm_activity', 'UPDATE'), false, 'the trail cannot be edited');
        assert.equal(await priv('ztech_app', 'li_crm_activity', 'DELETE'), false, 'the trail cannot be deleted');
        assert.equal(await priv('ztech_app', 'li_crm_notes', 'UPDATE'), false);
        assert.equal(await priv('ztech_app', 'li_crm_accounts', 'DELETE'), false, 'accounts are archived, never deleted');
        for (const tb of ['li_crm_accounts', 'li_crm_notes', 'li_crm_activity']) {
          assert.equal(await priv('ztech_worker', tb, 'SELECT'), false, `the worker cannot read ${tb}`);
        }
        // Without a workspace context the app role sees no CRM row at all.
        const bare = await db.pool.query('SELECT count(*)::int AS n FROM li.li_crm_accounts');
        assert.equal(bare.rows[0].n, 0);
        const { assertRuntimeRoles } = require('../../packages/lead-intelligence-postgres/src/assertRoles');
        assert.deepEqual((await assertRuntimeRoles(db.pool)).problems, []);
      });
    }
  });
}
