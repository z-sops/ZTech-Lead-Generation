'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { build, researchToCompletion } = require('./helpers');
const { RESEARCH_COLUMNS, toCsv, csvCell } = require('../../src/main/lead-intelligence/export/ResearchExport');

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i += 1; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\r') { /* skip */ } else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else cell += c;
  }
  return rows;
}

async function prepared() {
  const ctx = build();
  ctx.leads.L1.apiKey = 'sk-should-never-export';
  ctx.leads.L1.password = 'nope';
  await researchToCompletion(ctx, 'L1');
  await ctx.li.outreach.generate({ leadId: 'L1', targetId: 'T1' });
  return ctx;
}

test('export: CSV and JSON have parity (same leads, same fields, same values)', async () => {
  const ctx = await prepared();
  const csv = await ctx.li.exporter.export({ scope: { leadIds: ['L1', 'L2', 'L3'] }, format: 'csv', targetId: 'T1' });
  const json = await ctx.li.exporter.export({ scope: { leadIds: ['L1', 'L2', 'L3'] }, format: 'json', targetId: 'T1' });
  assert.equal(csv.count, 3);
  assert.equal(json.count, 3);
  const rows = parseCsv(csv.content);
  assert.deepEqual(rows[0], RESEARCH_COLUMNS);
  const j = JSON.parse(json.content);
  assert.equal(j.leads.length, 3);
  for (const lead of j.leads) {
    const r = rows.find((x) => x[0] === lead.lead_id);
    RESEARCH_COLUMNS.forEach((col, i) => {
      let expected = lead[col] === null || lead[col] === undefined ? '' : String(lead[col]);
      if (/^[=+\-@\t\r]/.test(expected)) expected = `'${expected}`; // CSV formula guard is the only allowed difference
      assert.equal(r[i], expected, `${lead.lead_id}.${col}`);
    });
  }
  const l1 = j.leads.find((x) => x.lead_id === 'L1');
  assert.equal(l1.icp_fit_status, 'fit');
  assert.equal(l1.research_state, 'complete');
  assert.equal(l1.pitch_status, 'draft');
  assert.equal(l1.digital_footprint, 'DIGITAL_FOOTPRINT_FOUND');
  assert.equal(j.leads.find((x) => x.lead_id === 'L2').digital_footprint, 'NO_WEBSITE');
});

test('export: provenance is preserved per lead and per finding', async () => {
  const ctx = await prepared();
  const json = JSON.parse((await ctx.li.exporter.export({ scope: { leadIds: ['L1'] }, format: 'json' })).content);
  const l1 = json.leads[0];
  assert.equal(l1.provenance_provider, 'fake');
  assert.equal(l1.provenance_engine_version, '0.14.0-fake');
  assert.ok(l1.packet_id);
  assert.ok(l1.evidence.findings.length > 0);
  for (const f of l1.evidence.findings) {
    assert.equal(f.provenance.finding_id, f.finding_id);
    assert.equal(f.provenance.lead_id, 'L1');
    assert.ok(f.provenance.captured_at && f.provenance.contract_version);
  }
  assert.match(l1.findings, /\[find_[0-9a-f]+\]/);
});

test('export: never contains credentials or secret-like fields', async () => {
  const ctx = await prepared();
  for (const format of ['csv', 'json']) {
    const out = await ctx.li.exporter.export({ scope: { leadIds: ['L1'] }, format });
    assert.ok(!out.content.includes('sk-should-never-export'), format);
    assert.ok(!/"(apiKey|password|token|authorization)"/i.test(out.content), format);
  }
});

test('export: segment and saved-search scopes; formula injection is neutralised', async () => {
  const ctx = await prepared();
  const seg = await ctx.li.segments.save({ name: 'S', kind: 'static' });
  await ctx.li.segments.addLeads(seg.segment_id, ['L3']);
  const bySeg = await ctx.li.exporter.export({ scope: { segmentId: seg.segment_id }, format: 'json' });
  assert.deepEqual(JSON.parse(bySeg.content).leads.map((l) => l.lead_id), ['L3']);
  const s = await ctx.li.savedSearches.save({ name: 'no site', filter: { website: 'absent' } });
  const bySearch = await ctx.li.exporter.export({ scope: { searchId: s.search_id }, format: 'json' });
  assert.deepEqual(JSON.parse(bySearch.content).leads.map((l) => l.lead_id).sort(), ['L2', 'L4']);
  assert.equal(csvCell('=HYPERLINK("http://x")'), '"\'=HYPERLINK(""http://x"")"');
  assert.equal(csvCell('+123'), "'+123");
  assert.match(toCsv([{ lead_id: '@cmd' }], ['lead_id']), /'@cmd/);
  await assert.rejects(ctx.li.exporter.export({ scope: {}, format: 'csv' }), (e) => e.code === 'VALIDATION_FAILED');
  await assert.rejects(ctx.li.exporter.export({ scope: { leadIds: ['L1'] }, format: 'xlsx' }), (e) => e.code === 'VALIDATION_FAILED');
});
