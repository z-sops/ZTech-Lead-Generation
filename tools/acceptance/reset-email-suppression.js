'use strict';

/**
 * ZTech ACCEPTANCE-ONLY tool: reset the EMAIL unsubscribe / suppression state of ONE test contact
 * in the local database, so a manual acceptance run can record a fresh opt-in.
 *
 * This is NOT part of the app. It lives outside src/ (the packaged build ships only index.html,
 * main.js, preload.js, package.json and src/**), has no IPC channel, no preload method and no
 * button. Inside ZTech an unsubscribe, bounce or complaint stays irreversible.
 *
 * What it changes, in the local whatsapp.db only, for ONE email address that belongs to a lead:
 *   - deletes the EMAIL rows in li_suppressions for that address (any scope, any reason);
 *   - deletes the EMAIL opt-ins in li_contact_consents for that address, so the lead shows
 *     "No opt-in recorded" and the opt-in must be recorded again, explicitly;
 *   - writes one audit row (kind ACCEPTANCE_RESET) to ztech_acceptance_resets, a table of this
 *     tool's own, and keeps a backup copy of the database file next to it.
 * What it never touches: WhatsApp suppressions / opt-ins, li_trust_events (the unsubscribe event
 * stays in the history), reply reviews, sends, pitches, mailbox connections and their tokens
 * (those live in ZTech's settings file, which this tool never opens), any other address.
 *
 * Refused when the address has REPLY history (a relay or mailbox reply, reviewed or not): a reviewed
 * "interested" reply is itself a basis for emailing, so a reset would not end at "No opt-in
 * recorded". Use another test address (e.g. a Gmail +alias) in that case.
 *
 * ZTech must be CLOSED. It keeps the database in memory and saves the whole file on its next change,
 * which would silently undo a reset. The running-process check below is the real guard (it fails
 * closed); the file-time check only catches a save during the few milliseconds the tool runs.
 *
 * Usage:
 *   node tools\acceptance\reset-email-suppression.js --email you@example.com            (dry run)
 *   node tools\acceptance\reset-email-suppression.js --email you@example.com --apply --confirm "RESET you@example.com"
 * Options: --lead-id <id> (only reset if that lead has this address), --db <path to whatsapp.db>.
 */

const fs = require('fs');
const path = require('path');

const KIND = 'ACCEPTANCE_RESET';
const TOOL = 'tools/acceptance/reset-email-suppression.js v1';
const EMAIL = /^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,63}$/;

function normalizeEmail(raw) {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return EMAIL.test(s) ? s : null;
}

/** "zs…1@gmail.com" - enough to recognise, never the whole address in a log. */
function mask(address) {
  const [local, domain] = String(address).split('@');
  if (!domain) return '…';
  return `${local.slice(0, 2)}…${local.length > 3 ? local.slice(-1) : ''}@${domain}`;
}

function rows(db, sql, params = []) {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    const out = [];
    while (stmt.step()) out.push(stmt.getAsObject());
    return out;
  } finally { stmt.free(); }
}

function tableExists(db, name) {
  return rows(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [name]).length === 1;
}

/** What a reset of this address would change. Reads only. */
function planReset(db, { email, leadId = null }) {
  const address = normalizeEmail(email);
  if (!address) return { ok: false, code: 'BAD_EMAIL', message: 'That is not a valid email address.' };
  for (const t of ['numbers', 'li_suppressions', 'li_contact_consents']) {
    if (!tableExists(db, t)) return { ok: false, code: 'NOT_A_ZTECH_DB', message: `Table ${t} is missing: this is not a ZTech database (or ZTech has never been started on it).` };
  }
  const leads = rows(db, 'SELECT id, title FROM numbers WHERE lower(trim(email)) = ?', [address]);
  if (!leads.length) return { ok: false, code: 'NOT_A_LEAD_CONTACT', message: 'No lead in this database has that email address. Only a lead\'s own contact can be reset.' };
  if (leadId !== null && !leads.some((l) => String(l.id) === String(leadId))) {
    return { ok: false, code: 'LEAD_MISMATCH', message: 'That lead does not have this email address.' };
  }
  const suppressions = rows(db, "SELECT suppression_id, scope, reason, source, created_at FROM li_suppressions WHERE channel = 'email' AND normalized_address = ? ORDER BY created_at", [address]);
  const consents = rows(db, "SELECT consent_id, method, recorded_at FROM li_contact_consents WHERE channel = 'email' AND normalized_address = ?", [address]);
  const replies = tableExists(db, 'li_trust_events')
    ? rows(db, "SELECT count(*) AS n FROM li_trust_events WHERE channel = 'email' AND kind = 'reply' AND state != 'rejected' AND normalized_address = ?", [address])[0].n : 0;
  if (replies > 0) {
    return { ok: false, code: 'REPLY_HISTORY', message: `This address has ${replies} recorded reply event(s). A reviewed reply can itself allow emailing, so a reset would not end at "No opt-in recorded". Use another test address (for example a Gmail +alias).` };
  }
  return { ok: true, address, leads, suppressions, consents, nothingToDo: !suppressions.length && !consents.length };
}

/** Apply a plan in one transaction and write the audit row. Returns the audit record. */
function applyReset(db, plan, { now = new Date(), note = '' } = {}) {
  if (!plan || !plan.ok) throw new Error('refusing: the plan is not valid');
  if (plan.nothingToDo) throw new Error('refusing: there is nothing to reset for this address');
  const at = now.toISOString();
  const resetId = `rst_${at.replace(/[^0-9]/g, '')}_${Math.random().toString(36).slice(2, 8)}`;
  db.run('BEGIN');
  try {
    db.run(`CREATE TABLE IF NOT EXISTS ztech_acceptance_resets (
      reset_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind = 'ACCEPTANCE_RESET'),
      channel TEXT NOT NULL CHECK (channel = 'email'),
      normalized_address TEXT NOT NULL,
      lead_ids_json TEXT NOT NULL,
      removed_suppressions_json TEXT NOT NULL,
      removed_consents INTEGER NOT NULL,
      note TEXT,
      tool TEXT NOT NULL,
      at TEXT NOT NULL
    )`);
    db.run("DELETE FROM li_suppressions WHERE channel = 'email' AND normalized_address = ?", [plan.address]);
    db.run("DELETE FROM li_contact_consents WHERE channel = 'email' AND normalized_address = ?", [plan.address]);
    const record = {
      reset_id: resetId, kind: KIND, channel: 'email', normalized_address: plan.address,
      lead_ids_json: JSON.stringify(plan.leads.map((l) => String(l.id))),
      removed_suppressions_json: JSON.stringify(plan.suppressions.map((s) => ({ id: s.suppression_id, scope: s.scope, reason: s.reason, source: s.source, created_at: s.created_at }))),
      removed_consents: plan.consents.length,
      note: String(note || 'local acceptance test data reset').slice(0, 200), tool: TOOL, at,
    };
    db.run(`INSERT INTO ztech_acceptance_resets (reset_id, kind, channel, normalized_address, lead_ids_json, removed_suppressions_json, removed_consents, note, tool, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, Object.values(record));
    db.run('COMMIT');
    return record;
  } catch (e) {
    db.run('ROLLBACK');
    throw e;
  }
}

/* ------------------------------------ CLI ------------------------------------ */

function parseArgs(argv) {
  const a = { apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    if (k === '--apply') a.apply = true;
    else if (['--email', '--lead-id', '--db', '--confirm', '--note'].includes(k)) { a[k.slice(2)] = argv[i + 1]; i += 1; } else throw new Error(`unknown option ${k}`);
  }
  return a;
}

/** The one ZTech database on this computer; null (pass --db) when there is none or more than one. */
function defaultDbPath(env = process.env) {
  if (!env.APPDATA) return { file: null, found: [] };
  const found = ['phone-global-leads', 'phone全球获客'].map((n) => path.join(env.APPDATA, n, 'data', 'whatsapp.db')).filter((f) => fs.existsSync(f));
  return { file: found.length === 1 ? found[0] : null, found };
}

/** ZTech keeps the database in memory and writes it back: a reset while it runs would be overwritten. */
// Process names via PowerShell in UTF-8 (tasklist prints in the OEM code page, which garbles the
// packaged "phone全球获客" name). An ASCII "phone" prefix is matched too, so a garbled name still counts.
const ZTECH_PROCESS = /^(electron|phone.*|ztech.*)$/i;
function ztechRunning(exec = require('child_process').execSync, platform = process.platform) {
  if (platform !== 'win32') return false;
  let out;
  try {
    out = String(exec('powershell -NoProfile -Command "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Process | ForEach-Object { $_.ProcessName }"', { encoding: 'utf8' }));
  } catch {
    return true; // cannot tell: fail closed
  }
  return out.split(/\r?\n/).map((l) => l.trim()).some((name) => ZTECH_PROCESS.test(name));
}

async function main(argv = process.argv.slice(2), io = { log: console.log, env: process.env, running: ztechRunning, initSqlJs: () => require('sql.js')() }) {
  let args;
  try { args = parseArgs(argv); } catch (e) { io.log(e.message); return 2; }
  if (!args.email) { io.log('Give the test address: --email you@example.com'); return 2; }
  const auto = args.db ? null : defaultDbPath(io.env);
  if (auto && auto.found.length > 1) { io.log(`More than one ZTech database found - pick one with --db:\n${auto.found.join('\n')}`); return 2; }
  const file = args.db || (auto && auto.file);
  if (!file || !fs.existsSync(file)) { io.log('ZTech database not found. Pass it with --db "<path>\\whatsapp.db".'); return 2; }
  if (io.running()) { io.log('ZTech (or another Electron app) is running, or this could not be checked. Close ZTech completely (it rewrites the database), then run this again.'); return 3; }

  const SQL = await io.initSqlJs();
  const before = fs.statSync(file).mtimeMs;
  const db = new SQL.Database(fs.readFileSync(file));
  const plan = planReset(db, { email: args.email, leadId: args['lead-id'] ?? null });
  if (!plan.ok) { io.log(`Refused (${plan.code}): ${plan.message}`); return 4; }

  io.log(`ACCEPTANCE RESET - ${args.apply ? 'APPLY' : 'DRY RUN (nothing is changed)'}`);
  io.log(`Database: ${file}`);
  io.log(`Address: ${mask(plan.address)} - on ${plan.leads.length} lead(s): ${plan.leads.map((l) => l.id).join(', ')}`);
  io.log(`Email suppressions to remove: ${plan.suppressions.length}${plan.suppressions.map((s) => `\n  - ${s.reason} (${s.scope}, by ${s.source}, ${s.created_at})`).join('')}`);
  io.log(`Email opt-ins to remove: ${plan.consents.length}`);
  io.log('Not touched: WhatsApp do-not-contact and opt-ins, the unsubscribe event history, mailbox connections, sends, pitches, other addresses.');
  if (plan.nothingToDo) { io.log('Nothing to reset for this address.'); return 0; }
  if (!args.apply) { io.log(`\nTo apply: add  --apply --confirm "RESET ${plan.address}"`); return 0; }
  if (args.confirm !== `RESET ${plan.address}`) { io.log(`Refused: --confirm must be exactly "RESET ${plan.address}".`); return 5; }

  const record = applyReset(db, plan, { note: args.note });
  if (fs.statSync(file).mtimeMs !== before) { io.log('Refused: the database changed while this ran (is ZTech open?). Nothing was written.'); return 6; }
  const backup = `${file}.bak-acceptance-reset-${record.at.replace(/[^0-9]/g, '').slice(0, 14)}`;
  fs.copyFileSync(file, backup);
  const tmp = `${file}.acceptance-reset.tmp`;
  fs.writeFileSync(tmp, Buffer.from(db.export()));
  fs.renameSync(tmp, file);
  io.log(`\nDone. Audit ${record.kind} ${record.reset_id} written (removed ${JSON.parse(record.removed_suppressions_json).length} suppression(s), ${record.removed_consents} opt-in(s)).`);
  io.log(`Backup of the previous database: ${backup}`);
  io.log('Start ZTech: the lead\'s Email line shows "No opt-in recorded". Record the opt-in yourself.');
  return 0;
}

if (require.main === module) main().then((code) => { process.exitCode = code; }, (e) => { console.log(`Failed: ${e && e.message}`); process.exitCode = 1; });

module.exports = { planReset, applyReset, main, normalizeEmail, mask, ztechRunning, KIND };
