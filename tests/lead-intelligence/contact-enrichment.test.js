'use strict';

/**
 * Contact enrichment: emails, phones and social links from the business's own
 * website and its map listing; owners from Companies House; Instagram
 * activity from the Business Discovery API. The official APIs are played by
 * the local fixture server: nothing here reaches the internet or costs money.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { intel } = require('@zunitech/lead-intelligence');
const { createResearchExecutor } = require('../../packages/lead-intelligence-worker/src/research');
const { startFixtureServer } = require('../lib/phase2-fixture-server');

const CRITERIA = { industry: 'dentist', location: 'Leeds, UK', offer_categories: ['seo', 'security', 'web_design', 'booking', 'social_media'], max_results: 25 };
const NOW = () => new Date('2026-11-09T10:00:00Z');
const CH_KEY = 'test-ch-key-0123456789';
const IG_TOKEN = 'test-ig-token-0123456789';

function env(fx, extra = {}) {
  return {
    ZTECH_INSPECT_ALLOW_PRIVATE: '1', ZTECH_INSPECT_HOST_MAP: fx.hostMap, ZTECH_NOMINATIM_URL: fx.nominatimUrl, ZTECH_OVERPASS_URL: fx.overpassUrl,
    ...extra,
  };
}

const run = (exec) => exec({ jobType: 'research', jobClass: 'noop', payload: { kind: 'business_research', criteria: CRITERIA } });
const byId = (result, id) => result.businesses.find((b) => b.business_id === id);

test('contacts from a page: mailto and text emails, tel links, profile links; junk dropped', () => {
  const html = `<html><body>
    <a href="mailto:Reception@Example-Dental.co.uk?subject=Hi">email</a>
    <p>Manager: sarah.khan@example-dental.co.uk. Agency: someone@example.com</p>
    <img src="/logo@2x.png"><p>logo@2x.png</p>
    <a href="tel:+44 113 496 0000">call</a> <a href="tel:123">bad</a>
    <a href="https://www.instagram.com/p/Cabc/">post</a>
    <a href="https://instagram.com/exampledental?hl=en">ig</a>
    <a href="https://www.facebook.com/sharer/sharer.php?u=x">share</a>
    <a href="https://www.facebook.com/ExampleDental/">fb</a>
    <a href="https://www.linkedin.com/company/example-dental/">li</a>
  </body></html>`;
  const doc = intel.html.readHtml(html);
  const c = intel.contacts.contactsFromPage(doc, 'https://www.example-dental.co.uk/contact');
  assert.deepEqual(c.emails.map((e) => [e.address, e.kind, e.same_domain]), [
    ['reception@example-dental.co.uk', 'generic', true],
    ['sarah.khan@example-dental.co.uk', 'named', true],
  ]);
  assert.deepEqual(c.phones.map((p) => p.number), ['+441134960000']);
  assert.equal(c.socials.instagram.handle, 'exampledental');
  assert.equal(c.socials.instagram.url, 'https://www.instagram.com/exampledental/');
  assert.equal(c.socials.facebook.handle, 'ExampleDental');
  assert.equal(c.socials.linkedin.handle, 'example-dental');
  for (const e of c.emails) assert.equal(e.source_url, 'https://www.example-dental.co.uk/contact');
});

test('enrich: Companies House match needs the name AND the postcode', async () => {
  const calls = [];
  const request = async ({ url, headers }) => {
    calls.push({ url, auth: headers.Authorization });
    if (url.includes('/search/companies')) {
      return { ok: true, status: 200, body: JSON.stringify({ items: [
        { title: 'SMILE STUDIO LTD', company_number: '00000001', company_status: 'active', address: { postal_code: 'LS1 4AP' } },
        { title: 'OLD TOWN DENTAL SURGERY LIMITED', company_number: '01234567', company_status: 'active', address: { postal_code: 'ls14ap' }, address_snippet: 'Leeds LS1 4AP' },
        { title: 'OLD TOWN DENTAL SURGERY LIMITED', company_number: '09999999', company_status: 'dissolved', address: { postal_code: 'LS1 4AP' } },
      ] }) };
    }
    return { ok: true, status: 200, body: JSON.stringify({ items: [
      { name: 'KHAN, Sarah', officer_role: 'director', appointed_on: '2015-03-01' },
      { name: 'OLD, Gone', officer_role: 'director', resigned_on: '2020-01-01' },
      { name: 'SEC LTD', officer_role: 'corporate-secretary' },
      { name: 'PARTNER, Pat', officer_role: 'llp-designated-member' },
    ] }) };
  };
  const r = await intel.enrich.companiesHouseOwners({ request, apiKey: 'k', business: { name: 'Old Town Dental Surgery', postcode: 'LS1 4AP' } });
  assert.equal(r.status, 'matched');
  assert.equal(r.company.number, '01234567');
  assert.equal(r.company.url, 'https://find-and-update.company-information.service.gov.uk/company/01234567');
  assert.deepEqual(r.owners.map((o) => o.name), ['KHAN, Sarah', 'PARTNER, Pat']);
  assert.deepEqual(r.match, { name_score: 1, postcode: 'same' });
  assert.equal(calls[0].auth, `Basic ${Buffer.from('k:').toString('base64')}`);
  assert.ok(!calls.some((c) => c.url.includes('k:')), 'the key travels in a header only');

  // Same name, wrong town: not a match.
  const far = await intel.enrich.companiesHouseOwners({ request, apiKey: 'k', business: { name: 'Old Town Dental Surgery', postcode: 'M1 1AA' } });
  assert.equal(far.status, 'no_match');
  // No postcode: not searched at all.
  const none = await intel.enrich.companiesHouseOwners({ request: () => assert.fail('no call'), apiKey: 'k', business: { name: 'X' } });
  assert.equal(none.status, 'not_checked');
  // A refused key is an error, not "no owners".
  const refused = await intel.enrich.companiesHouseOwners({ request: async () => ({ ok: true, status: 401, body: '' }), apiKey: 'k', business: { name: 'X', postcode: 'LS1 4AP' } });
  assert.equal(refused.status, 'error');
});

test('enrich: Instagram activity, stale accounts and personal accounts', async () => {
  const reply = (body) => async () => ({ ok: true, status: 200, body: JSON.stringify(body) });
  const stale = await intel.enrich.instagramActivity({
    request: reply({ business_discovery: { followers_count: 120, media_count: 9, media: { data: [{ timestamp: '2026-05-01T10:00:00+0000' }] } } }),
    token: 't', igUserId: '1', handle: 'abc', now: NOW,
  });
  assert.equal(stale.status, 'ok');
  assert.equal(stale.days_since_last_post, 192);
  assert.equal(stale.stale, true);
  const fresh = await intel.enrich.instagramActivity({
    request: reply({ business_discovery: { followers_count: 5, media_count: 3, media: { data: [{ timestamp: '2026-11-01T10:00:00+0000' }] } } }),
    token: 't', igUserId: '1', handle: 'abc', now: NOW,
  });
  assert.equal(fresh.stale, false);
  const personal = await intel.enrich.instagramActivity({
    request: reply({ error: { message: 'Invalid user id: cannot find business account abc' } }), token: 't', igUserId: '1', handle: 'abc', now: NOW,
  });
  assert.equal(personal.status, 'not_business_account');
  const bad = await intel.enrich.instagramActivity({ request: () => assert.fail('no call'), token: 't', igUserId: '1', handle: 'a/b', now: NOW });
  assert.equal(bad.status, 'error');
});

test('research without keys: contacts are collected from websites and listings, nothing else is called', async () => {
  const fx = await startFixtureServer();
  try {
    const result = await run(createResearchExecutor({ env: env(fx), now: NOW }));
    const good = byId(result, 'osm_node_1001');
    const addrs = good.contacts.emails.map((e) => [e.address, e.kind]);
    assert.deepEqual(addrs, [['reception@good-dental.ztech-fixture.com', 'generic'], ['sarah.khan@good-dental.ztech-fixture.com', 'named']]);
    assert.ok(good.contacts.emails.every((e) => e.source_url === 'https://good-dental.ztech-fixture.com/contact'));
    assert.deepEqual(good.contacts.phones.map((p) => p.number).sort(), ['+441134960000', '07700900123']);
    assert.equal(good.contacts.socials.instagram.handle, 'riversidefamilydental');
    assert.equal(good.contacts.socials.facebook.handle, 'RiversideFamilyDentalLeeds');
    assert.equal(good.owners, null);
    assert.equal(good.instagram, null);

    // No website: contacts come from the map listing, attributed to it.
    const beeston = byId(result, 'osm_node_1007');
    assert.deepEqual(beeston.contacts.emails.map((e) => e.address), ['info@beestondental.example.co.uk']);
    assert.equal(beeston.contacts.emails[0].source_url, 'https://www.openstreetmap.org/node/1007');
    assert.equal(beeston.contacts.socials.instagram.handle, 'beestondental');

    assert.ok(!fx.requests.some((r) => r.host === 'ch.ztech-fixture.com' || r.host === 'graph.ztech-fixture.com'));
    assert.ok(!result.findings.some((f) => f.check_id === 'INSTAGRAM_INACTIVE'));
  } finally {
    await fx.close();
  }
});

test('research with keys: owners from Companies House, Instagram activity, and a social finding with evidence', async () => {
  const fx = await startFixtureServer();
  try {
    const exec = createResearchExecutor({
      env: env(fx, {
        COMPANIES_HOUSE_API_KEY: CH_KEY, ZTECH_COMPANIES_HOUSE_URL: fx.companiesHouseUrl,
        ZTECH_IG_ACCESS_TOKEN: IG_TOKEN, ZTECH_IG_USER_ID: '1789', ZTECH_GRAPH_URL: fx.graphUrl,
      }),
      now: NOW,
    });
    const result = await run(exec);

    const oldTown = byId(result, 'osm_node_1002');
    assert.equal(oldTown.owners.status, 'matched');
    assert.equal(oldTown.owners.company.number, '01234567');
    assert.deepEqual(oldTown.owners.owners.map((o) => o.name), ['KHAN, Sarah'], 'resigned directors and corporate secretaries are left out');
    assert.equal(oldTown.owners.match.postcode, 'same');

    // Same area but a different name: not used.
    assert.equal(byId(result, 'osm_node_1007').owners.status, 'no_match');

    const good = byId(result, 'osm_node_1001');
    assert.equal(good.instagram.status, 'ok');
    assert.equal(good.instagram.followers, 850);
    assert.equal(good.instagram.stale, true);
    assert.equal(good.instagram.url, 'https://www.instagram.com/riversidefamilydental/');
    const f = result.findings.find((x) => x.business_id === 'osm_node_1001' && x.check_id === 'INSTAGRAM_INACTIVE');
    assert.ok(f, 'a stale Instagram becomes a finding');
    const ev = result.evidence.find((e) => f.evidence_ids.includes(e.evidence_id));
    assert.equal(ev.source_url, 'https://www.instagram.com/riversidefamilydental/');
    assert.match(ev.excerpt, /last post on 2026-05-01 \(192 days ago\), 850 followers/);
    assert.equal(byId(result, 'osm_node_1007').instagram.status, 'not_business_account');

    // Keys never appear in the result.
    const text = JSON.stringify(result);
    assert.ok(!text.includes(CH_KEY) && !text.includes(IG_TOKEN));
  } finally {
    await fx.close();
  }
});
