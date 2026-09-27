const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { logger } = require('./logger');

const DATA_DIR = path.join(require('electron').app.getPath('userData'), 'data');

function csvField(value) {
  let s = value === undefined || value === null ? '' : String(value);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return s.replace(/"/g, '""');
}

// CSV-only note normalisation. A stored note may contain line breaks and the
// lead library CSV joins rows with '\n', so a multi-line note would split one
// lead across several physical lines. Storage, the Lead Profile and the JSON
// export keep the value verbatim; only the CSV field is collapsed to spaces.
function csvNotes(value) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/\r\n|\r|\n/g, ' ');
}

function canonicalPhone(phone) {
  if (typeof phone !== 'string') return phone;
  return phone.replace(/[\s\-.()]/g, '');
}

// B1 lead schema: new persisted fields. Naming follows the existing
// camelCase convention (cf. collectedAt / runSlug in the renderer).
const LEAD_NEW_FIELDS = ['title', 'website', 'email', 'address', 'runSlug'];

// B6 user-owned lead fields. They are deliberately NOT part of
// LEAD_NEW_FIELDS: that list also feeds mergeEmptyLeadFields, so a merge
// would let an untrusted collection or import row populate - or overwrite -
// user data. B6 fields are written only by setLeadUserFields and are stripped
// from every provider/import payload in _addNumbers.
const LEAD_B6_FIELDS = ['qualification', 'tags', 'notes'];
// Compile-time defaults shared by the table-creation literals, the legacy
// migration backfill and read normalisation, so a fresh row, a migrated row
// and a row loaded from numbers.json expose identical logical values.
const LEAD_B6_DEFAULTS = { qualification: 'unqualified', tags: '[]', notes: '' };
const LEAD_QUALIFICATION_VALUES = ['unqualified', 'qualified'];
const MAX_LEAD_TAGS = 20;
const MAX_LEAD_TAG_LENGTH = 50;
const MAX_LEAD_NOTES_LENGTH = 5000;

// P1-C user-owned data-quality status overrides. These are USER ASSERTIONS
// ("I checked this phone"), never third-party verification, and they are kept
// in their own list for the same reason as LEAD_B6_FIELDS: they must not be
// reachable from the provider/import merge or the add path.
const LEAD_USER_STATUS_FIELDS = ['phoneStatus', 'emailStatus', 'websiteStatus', 'businessStatus'];
const LEAD_USER_STATUS_VALUES = {
  phoneStatus: ['unknown', 'verified', 'unverified', 'invalid'],
  emailStatus: ['unknown', 'verified', 'unverified', 'risky'],
  websiteStatus: ['unknown', 'live', 'dead', 'redirect'],
  businessStatus: ['unknown', 'active', 'closed']
};
const DEFAULT_LEAD_USER_STATUS = 'unknown';
// Every user-owned lead column, in one place: schema default, migration
// backfill, read defaulting, add-path stripping, startup repair and rollback.
const LEAD_USER_OWNED_FIELDS = [...LEAD_B6_FIELDS, ...LEAD_USER_STATUS_FIELDS];

// B6 tags are a bounded ordered set: trimmed, non-empty, at most 20 entries of
// at most 50 characters, deduplicated case-insensitively with the first
// occurrence kept. Any unexpected value degrades to an empty set instead of
// throwing, so hand-edited or legacy data can never break a read.
function normalizeLeadTags(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const tag of value) {
    if (typeof tag !== 'string') continue;
    const trimmed = tag.trim();
    if (!trimmed || trimmed.length > MAX_LEAD_TAG_LENGTH) continue;
    const key = trimmed.toLowerCase();
    if (out.some(existing => existing.toLowerCase() === key)) continue;
    out.push(trimmed);
    if (out.length === MAX_LEAD_TAGS) break;
  }
  return out;
}

// SQL stores tags as a JSON array string, the JSON store keeps a native
// array; both are read back as string[].
function parseLeadTags(value) {
  if (Array.isArray(value)) return normalizeLeadTags(value);
  if (typeof value !== 'string' || value.trim() === '') return [];
  try {
    return normalizeLeadTags(JSON.parse(value));
  } catch (err) {
    return [];
  }
}

// Normalises the three B6 user-owned fields in place. Only missing or
// out-of-contract values are replaced, so valid stored user data is never
// rewritten by a load or a read.
function normalizeLeadB6Fields(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  if (!LEAD_QUALIFICATION_VALUES.includes(row.qualification)) {
    row.qualification = LEAD_B6_DEFAULTS.qualification;
  }
  row.tags = parseLeadTags(row.tags);
  if (typeof row.notes !== 'string') row.notes = LEAD_B6_DEFAULTS.notes;
  return row;
}

// P1-C: a user status is a stored USER ASSERTION. An unrecognised or absent
// value normalises to 'unknown' so a read can never present a status the
// product does not recognise, and never implies external verification.
function normalizeLeadUserStatusFields(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  for (const field of LEAD_USER_STATUS_FIELDS) {
    if (!LEAD_USER_STATUS_VALUES[field].includes(row[field])) {
      row[field] = DEFAULT_LEAD_USER_STATUS;
    }
  }
  return row;
}

// Every user-owned lead field, in one pass.
function normalizeUserOwnedLeadFields(row) {
  normalizeLeadB6Fields(row);
  return normalizeLeadUserStatusFields(row);
}

// Ownership boundary: a collection or import payload may carry any key, so
// the user-owned keys are removed before the row reaches either storage.
// Deliberately not folded into normalizeLeadRow, which also runs when
// already-stored records are loaded.
function stripUserOwnedLeadFields(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  for (const field of LEAD_USER_OWNED_FIELDS) delete row[field];
  // P1-D: same ownership boundary for the company foundation. companyKey is
  // derived from the row itself and companyId is system-owned, so a collection
  // or import payload can never set either one. normalizeLeadRow (which runs
  // right after this) re-derives the key from the accepted fields only.
  for (const field of LEAD_COMPANY_FIELDS) delete row[field];
  return row;
}

// Store-side guard for setLeadUserStatuses. The main process is the primary
// validator; this re-checks so no caller can persist an unrecognised status.
// A partial update is allowed: only the provided fields are written.
function validateLeadUserStatusUpdate(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: 'Invalid lead status update (object required)' };
  }
  if (typeof payload.id !== 'string' || !payload.id || payload.id.length > 100) {
    return { ok: false, error: 'Invalid lead status update: id' };
  }
  const value = { id: payload.id };
  let provided = 0;
  for (const field of LEAD_USER_STATUS_FIELDS) {
    if (payload[field] === undefined || payload[field] === null) continue;
    if (!LEAD_USER_STATUS_VALUES[field].includes(payload[field])) {
      return { ok: false, error: 'Invalid lead status update: ' + field };
    }
    value[field] = payload[field];
    provided++;
  }
  if (provided === 0) {
    return { ok: false, error: 'Invalid lead status update (no status field)' };
  }
  return { ok: true, value };
}

// Store-side guard for setLeadUserFields. The main process remains the
// primary validator (B6.2); this re-checks so no caller can persist an
// out-of-contract user-owned state directly. Mirrors validateJobRecord.
function validateLeadUserFields(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: 'Invalid lead update (object required)' };
  }
  if (typeof payload.id !== 'string' || !payload.id || payload.id.length > 100) {
    return { ok: false, error: 'Invalid lead update: id' };
  }
  if (!LEAD_QUALIFICATION_VALUES.includes(payload.qualification)) {
    return { ok: false, error: 'Invalid lead update: qualification' };
  }
  if (!Array.isArray(payload.tags) || payload.tags.length > MAX_LEAD_TAGS) {
    return { ok: false, error: 'Invalid lead update: tags' };
  }
  const tags = [];
  for (const tag of payload.tags) {
    if (typeof tag !== 'string') return { ok: false, error: 'Invalid lead update: tags' };
    const trimmed = tag.trim();
    if (!trimmed || trimmed.length > MAX_LEAD_TAG_LENGTH) {
      return { ok: false, error: 'Invalid lead update: tags' };
    }
    const key = trimmed.toLowerCase();
    if (tags.some(existing => existing.toLowerCase() === key)) continue;
    tags.push(trimmed);
  }
  if (typeof payload.notes !== 'string' || payload.notes.length > MAX_LEAD_NOTES_LENGTH) {
    return { ok: false, error: 'Invalid lead update: notes' };
  }
  return {
    ok: true,
    value: {
      id: payload.id,
      qualification: payload.qualification,
      tags,
      notes: payload.notes
    }
  };
}

// === P1-B derived data-quality filters ===
// These signals are DERIVED from stored columns, never persisted: a phone
// cannot be indexed by a quality value that only exists at read time. The
// generic `field = ?` predicate cannot express them either, so one shared
// JavaScript predicate evaluates them for BOTH storage branches. That is what
// makes SQL and JSON filtering identical by construction rather than by two
// parallel implementations staying in sync.
const LEAD_QUALITY_FILTER_FIELDS = [
  'phoneQuality', 'emailQuality', 'websiteQuality', 'businessQuality', 'completeness'
];
const LEAD_QUALITY_UNKNOWN = 'unknown';
const LEAD_QUALITY_VALID = 'valid';
const LEAD_QUALITY_INVALID = 'invalid';
const LEAD_COMPLETENESS_FIELDS = ['phone', 'title', 'website', 'email', 'address'];
// All rows are scanned when a derived filter is active, so the page slice is
// taken from the filtered set. Bounded by library size, never by an
// unbounded read of anything external.
const LEAD_QUALITY_SCAN_LIMIT = 2147483647;

function qualityTrimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// Same strip as the store's phone key, so a quality signal and dedup agree.
function leadPhoneKey(value) {
  return qualityTrimmed(value).replace(/[\s\-().]/g, '');
}

// Mirrors the import validator: optional '+', digits/spaces/dashes/dots/
// parentheses, at least five digits, 50 characters maximum.
function leadPhoneQuality(value) {
  const raw = qualityTrimmed(value);
  if (!raw) return LEAD_QUALITY_UNKNOWN;
  if (raw.length > 50) return LEAD_QUALITY_INVALID;
  if (!/^\+?[\d\s.\-()]+$/.test(raw)) return LEAD_QUALITY_INVALID;
  return raw.replace(/\D/g, '').length >= 5 ? LEAD_QUALITY_VALID : LEAD_QUALITY_INVALID;
}

function leadEmailQuality(value) {
  const raw = qualityTrimmed(value);
  if (!raw) return LEAD_QUALITY_UNKNOWN;
  if (/\s/.test(raw) || raw.length > 500) return LEAD_QUALITY_INVALID;
  const parts = raw.split('@');
  const domain = parts[1] || '';
  if (parts.length !== 2 || !parts[0] || !domain.includes('.') || domain.startsWith('.')
      || domain.endsWith('.') || domain.includes('..')) {
    return LEAD_QUALITY_INVALID;
  }
  return LEAD_QUALITY_VALID;
}

function leadWebsiteQuality(value) {
  const raw = qualityTrimmed(value);
  if (!raw) return LEAD_QUALITY_UNKNOWN;
  let parsed = null;
  try {
    parsed = new URL(raw);
  } catch {
    parsed = null;
  }
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    return LEAD_QUALITY_INVALID;
  }
  return LEAD_QUALITY_VALID;
}

// Business status has no local evidence source: no stored column, no provider
// verification. It is therefore UNKNOWN for every lead until a user-provided
// value exists (a later batch). Active/Closed are accepted by the validator
// for forward compatibility but can never match today, which is honest: the
// app does not pretend to know.
function leadBusinessQuality() {
  return LEAD_QUALITY_UNKNOWN;
}

function leadCompletenessCount(lead) {
  const row = lead && typeof lead === 'object' ? lead : {};
  let present = 0;
  for (const field of LEAD_COMPLETENESS_FIELDS) {
    if (qualityTrimmed(row[field])) present++;
  }
  return present;
}

function leadMatchesQualityFilters(lead, filters) {
  const row = lead && typeof lead === 'object' ? lead : {};
  const wanted = filters && typeof filters === 'object' ? filters : {};
  const expectations = {
    phoneQuality: leadPhoneQuality(row.phone),
    emailQuality: leadEmailQuality(row.email),
    websiteQuality: leadWebsiteQuality(row.website),
    businessQuality: leadBusinessQuality(row),
    completeness: String(leadCompletenessCount(row))
  };
  for (const field of LEAD_QUALITY_FILTER_FIELDS) {
    const value = wanted[field];
    if (typeof value !== 'string') continue;
    if (expectations[field] !== value) return false;
  }
  return true;
}

// === P1-D company foundation (derived, read-only) ===
// companyKey is a DETERMINISTIC grouping helper computed from the lead's own
// stored columns at read time. It is never persisted, never accepted from a
// provider or an import payload (see stripUserOwnedLeadFields) and never
// written back: no company record is created, no stored lead is altered
// because of another lead, and this batch introduces no new persisted entity.
//
// The rule, in order:
//   1. the normalized website host, whenever the stored website parses;
//   2. otherwise normalized title + ' | ' + normalized address, when BOTH are
//      present;
//   3. otherwise '' (never a fabricated key).
// A valid website host always wins: title/address is a fallback, not a
// primary. Email and phone are deliberately not part of the rule, there is no
// mail-provider domain list, and the result is an exact deterministic value:
// no ranking, confidence value or approximate match is involved.
const LEAD_COMPANY_FIELDS = ['companyKey', 'companyId'];
// companyKey is derived, so it is not a column at all. companyId is the only
// P1-D column: a nullable TEXT pointer with NULL as its correct value, which
// is why it is excluded from the '' backfill in migrateSchema.
const LEAD_COMPANY_NULLABLE_FIELDS = ['companyId'];
// Cannot occur inside a normalised part (the punctuation class below keeps only
// letters, digits and single spaces), so the composite key is unambiguous.
const COMPANY_KEY_SEPARATOR = ' | ';
// Every character that is not a Unicode letter or digit - punctuation, symbols
// and all whitespace - collapses to a single space, which simultaneously
// trims, collapses whitespace runs and normalises punctuation consistently.
// Unicode-aware, so a non-Latin title/address folds by the same rule.
const COMPANY_KEY_PUNCTUATION = /[^\p{L}\p{N}]+/gu;

// Website host normalisation follows the app's existing URL conventions
// (leadWebsiteQuality here, qualityWebsiteSignal in the renderer): the value
// must parse as an http(s) URL, and `URL.hostname` already excludes the port,
// path, query and fragment. A value that is not a usable web address produces
// no host key and falls through to the title+address fallback.
function companyKeyWebsiteHost(website) {
  if (typeof website !== 'string') return '';
  const raw = website.trim();
  if (!raw) return '';
  let parsed = null;
  try {
    parsed = new URL(raw);
  } catch {
    return '';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
  return parsed.hostname.toLowerCase().replace(/^www\./, '');
}

function companyKeyText(value) {
  if (typeof value !== 'string') return '';
  return value.toLowerCase().replace(COMPANY_KEY_PUNCTUATION, ' ').trim();
}

function deriveCompanyKey(lead) {
  const row = lead && typeof lead === 'object' && !Array.isArray(lead) ? lead : {};
  const host = companyKeyWebsiteHost(row.website);
  if (host) return host;
  const title = companyKeyText(row.title);
  const address = companyKeyText(row.address);
  if (title && address) return title + COMPANY_KEY_SEPARATOR + address;
  return '';
}

// companyId is a system-owned forward-compatible pointer: exposed as stored and
// defaulted to null only. P1-D exposes no write path for it, so a stored value
// can only come from a later phase.
function normalizeLeadCompanyFields(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  if (row.companyId === undefined || row.companyId === null || row.companyId === '') {
    row.companyId = null;
  }
  row.companyKey = deriveCompanyKey(row);
  return row;
}

// === P1-E identity resolution: deterministic duplicate REVIEW (read-only) ===
// P1-E answers exactly one question: which stored leads share a deterministic
// key with this lead, so a human can decide what to do. It never combines,
// deletes or updates anything: there is no duplicate column, no duplicate index
// and no persisted state, and canonicalPhone remains the lead identity.
//
// Every rule below is an EXACT comparison of normalised values, in a fixed
// precedence order, so the classification of a lead can never depend on
// iteration order. There is no approximate matching, no confidence value, no
// ordering of likelihood beyond that fixed precedence, and no external input of
// any kind: the review reads exactly the columns the lead library already has.
const DUPLICATE_REVIEW_RULES = ['all', 'canonicalPhone', 'website-host', 'email', 'title+address'];
// Strongest first. The first rule that matches classifies the lead, so a lead
// is never simultaneously EXACT and LIKELY, whatever order the library is read
// in. 'all' is a review filter, not a rule: it matches any of the four.
const DUPLICATE_RULE_PRECEDENCE = ['canonicalPhone', 'website-host', 'email', 'title+address'];
const DUPLICATE_RULE_CLASS = {
  canonicalPhone: 'EXACT',
  'website-host': 'LIKELY',
  email: 'LIKELY',
  'title+address': 'POSSIBLE'
};
const DUPLICATE_CLASS_UNIQUE = 'UNIQUE';
// Paging bounds mirror the B2/B4 contract, so the review surface can never ask
// for an unbounded read.
const DUPLICATE_REVIEW_DEFAULT_LIMIT = 20;
const DUPLICATE_REVIEW_MAX_LIMIT = 100;
const DUPLICATE_REVIEW_MAX_OFFSET = 100000;
// The existing lead information a reviewer needs, and nothing else. B6 and
// P1-C columns are deliberately absent so a review row can never be mistaken
// for a writable lead. companyKey is included because P1-D already derives it
// on every read; a review never changes it.
const DUPLICATE_REVIEW_LEAD_FIELDS = [
  'id', 'phone', 'title', 'website', 'email', 'address',
  'companyKey', 'source', 'keyword', 'collectedAt', 'runSlug'
];

// Email: trim, lowercase, non-empty only. An absent or unusable address is
// never a key, so two leads with no email can never match each other.
function duplicateReviewEmailKey(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

// title+address: BOTH parts must be present. A one-sided or punctuation-only
// pair yields no key, so it can never match another lead. The parts are
// normalised exactly as P1-D normalises them, reusing the shared helpers.
function duplicateReviewTitleAddressKey(lead) {
  const row = lead && typeof lead === 'object' && !Array.isArray(lead) ? lead : {};
  const title = companyKeyText(row.title);
  const address = companyKeyText(row.address);
  if (!title || !address) return '';
  return title + COMPANY_KEY_SEPARATOR + address;
}

function duplicateReviewPhoneKey(value) {
  const key = canonicalPhone(value);
  return typeof key === 'string' ? key : '';
}

// The exact key one rule produces for one lead, or '' when the lead has no
// usable value for that rule. An empty key is never indexed and never compared,
// which is what makes "missing data never matches" structural rather than a
// check that has to be remembered at each use site.
function duplicateReviewRuleKey(rule, lead) {
  const row = lead && typeof lead === 'object' && !Array.isArray(lead) ? lead : {};
  switch (rule) {
    case 'canonicalPhone': return duplicateReviewPhoneKey(row.phone);
    case 'website-host': return companyKeyWebsiteHost(row.website);
    case 'email': return duplicateReviewEmailKey(row.email);
    case 'title+address': return duplicateReviewTitleAddressKey(row);
    default: return '';
  }
}

// === P1-F Target builder: reusable prospecting definitions ===
// A Target is a USER-OWNED definition of what to look for. It is
// provider-independent, owns no lead field, and is never part of the lead write
// path: creating, editing or archiving a target cannot add, change or remove a
// single lead, and no collection or import payload can carry a target field.
//
// requiredFields/optionalFields are PROSPECTING CRITERIA, never save gates. A
// lead is never rejected from storage because a required field is missing:
// missing required data is a quality/fit condition, reported elsewhere, not a
// storage failure. This store therefore never reads a target when a lead is
// written, and never writes a target when a lead is saved.
const TARGET_STATUS_VALUES = ['active', 'archived'];
const TARGET_DEFAULT_STATUS = 'active';
// Required/optional criteria may only name fields that a lead actually has in
// the current model. Nothing is invented: an unknown name is a validation
// error, so a criterion can never silently refer to a field that does not exist
// (and no unavailable industry/business-type data is implied by a criterion).
const TARGET_FIELD_ALLOWLIST = ['phone', 'title', 'website', 'email', 'address'];
const MAX_TARGET_NAME_LENGTH = 120;
const MAX_TARGET_INDUSTRY_LENGTH = 120;
const MAX_TARGET_TERM_LENGTH = 50;
const MAX_TARGET_TERMS = 20;
const MAX_TARGET_FIELDS = TARGET_FIELD_ALLOWLIST.length;
// CSV-style list fields. SQL stores them as a JSON array string and the JSON
// store keeps the native array, exactly as the B6 tags column does, so both
// storages read back the same logical value.
const TARGET_LIST_FIELDS = ['businessTypes', 'locations', 'exclusions'];
// SQL stores a list column as a JSON array string and the JSON store keeps the
// native array, so a read has to accept both encodings of the same value. A
// string that is not JSON array text is left alone: it is CSV the user typed.
function parseTargetList(value) {
  if (Array.isArray(value) || typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('[')) return value;
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

// Deterministic CSV normalisation: commas and newlines separate, each entry is
// trimmed, empties are dropped and duplicates are removed case-insensitively
// with the first occurrence kept. User ORDER is preserved everywhere, and
// exceeding a limit is refused rather than truncated, so valid user intent is
// never silently discarded.
function normalizeTargetTerms(value) {
  const source = parseTargetList(value);
  if (source === undefined || source === null) return [];
  const raw = Array.isArray(source) ? source : String(source).split(/[,\n]/);
  const out = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (out.some(existing => existing.toLowerCase() === key)) continue;
    out.push(trimmed);
  }
  return out;
}

// Criteria are a set drawn from the allowlist, in the user's order, without
// duplicates. Returns { ok, value } or { ok: false, error }.
function normalizeTargetFields(value, field) {
  const source = parseTargetList(value);
  if (source === undefined || source === null) return { ok: true, value: [] };
  const raw = Array.isArray(source) ? source : String(source).split(/[,\n]/);
  const out = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') return { ok: false, error: 'Invalid target: ' + field };
    const name = entry.trim();
    if (!name) continue;
    if (!TARGET_FIELD_ALLOWLIST.includes(name)) {
      return { ok: false, error: 'Invalid target: ' + field + ' (unknown lead field: ' + name + ')' };
    }
    if (!out.includes(name)) out.push(name);
  }
  if (out.length > MAX_TARGET_FIELDS) return { ok: false, error: 'Invalid target: ' + field };
  return { ok: true, value: out };
}

// The one target validation, shared by create and update. `existing` is the
// stored row on an update; createdAt is system-owned and is never taken from
// input, and updatedAt is always stamped here so a caller cannot forge it.
function validateTargetRecord(payload, existing) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: 'Invalid target (object required)' };
  }
  const name = typeof payload.name === 'string' ? payload.name.trim() : '';
  if (!name || name.length > MAX_TARGET_NAME_LENGTH) {
    return { ok: false, error: 'Invalid target: name' };
  }
  const industry = payload.industry === undefined || payload.industry === null
    ? ''
    : (typeof payload.industry === 'string' ? payload.industry.trim() : null);
  if (industry === null || industry.length > MAX_TARGET_INDUSTRY_LENGTH) {
    return { ok: false, error: 'Invalid target: industry' };
  }
  // industry and businessTypes are Target INTENT: the current lead model has no
  // authoritative industry or business-type data, so they are stored as the
  // user wrote them and are never derived from a lead.
  const lists = {};
  for (const field of TARGET_LIST_FIELDS) {
    const terms = normalizeTargetTerms(payload[field]);
    if (terms.length > MAX_TARGET_TERMS) return { ok: false, error: 'Invalid target: ' + field };
    for (const term of terms) {
      if (term.length > MAX_TARGET_TERM_LENGTH) return { ok: false, error: 'Invalid target: ' + field };
    }
    lists[field] = terms;
  }
  const required = normalizeTargetFields(payload.requiredFields, 'requiredFields');
  if (!required.ok) return required;
  const optional = normalizeTargetFields(payload.optionalFields, 'optionalFields');
  if (!optional.ok) return optional;
  // A field cannot be both required and optional: that is a contradiction, and
  // it is refused rather than resolved by guessing which the user meant.
  for (const name of required.value) {
    if (optional.value.includes(name)) {
      return { ok: false, error: 'Invalid target: field is both required and optional: ' + name };
    }
  }
  const status = payload.status === undefined || payload.status === null
    ? TARGET_DEFAULT_STATUS
    : payload.status;
  if (!TARGET_STATUS_VALUES.includes(status)) {
    return { ok: false, error: 'Invalid target: status' };
  }
  const now = new Date().toISOString();
  return {
    ok: true,
    value: {
      id: existing ? existing.id : randomUUID(),
      name,
      industry,
      businessTypes: lists.businessTypes,
      locations: lists.locations,
      requiredFields: required.value,
      optionalFields: optional.value,
      exclusions: lists.exclusions,
      // System-owned: createdAt is preserved on update, updatedAt always moves.
      createdAt: existing && typeof existing.createdAt === 'string' ? existing.createdAt : now,
      updatedAt: now,
      status
    }
  };
}

// Reads a stored row (SQL text or JSON value) into the logical Target shape.
function normalizeTargetRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const out = {};
  for (const field of ['id', 'name', 'industry', 'createdAt', 'updatedAt']) {
    out[field] = typeof row[field] === 'string' ? row[field] : '';
  }
  out.status = TARGET_STATUS_VALUES.includes(row.status) ? row.status : TARGET_DEFAULT_STATUS;
  for (const field of TARGET_LIST_FIELDS) {
    out[field] = normalizeTargetTerms(row[field]);
  }
  for (const field of ['requiredFields', 'optionalFields']) {
    const parsed = normalizeTargetFields(row[field], field);
    out[field] = parsed.ok ? parsed.value : [];
  }
  return out;
}

function targetTermsFile(row) {
  const terms = Array.isArray(row.exclusions) ? row.exclusions : normalizeTargetTerms(row.exclusions);
  return terms.map(term => term.trim().toLowerCase()).filter(Boolean);
}

// A closed-business exclusion is satisfied only by a lead whose businessStatus
// is EXPLICITLY 'closed'. An unknown status is not a closed business, and
// unknown data never becomes a negative fact.
const TARGET_CLOSED_STATUS = 'closed';

// Deterministic local exclusion evaluation. It uses ONLY data the lead already
// has: an exclusion term matches a whole-token sequence inside the stored
// title/address text, and the reserved term 'closed' matches an explicitly
// closed business. There is no model, no inference and no external lookup, and
// a lead with no matching evidence is NOT excluded - including a lead with
// missing data, which stays unknown.
// Returns { excluded, reason, matched } where reason is 'excluded-term' or
// 'closed-business' and matched is the exact term that matched.
function evaluateTargetExclusions(target, lead) {
  const t = target && typeof target === 'object' && !Array.isArray(target) ? target : {};
  const l = lead && typeof lead === 'object' && !Array.isArray(lead) ? lead : {};
  if (l.businessStatus === TARGET_CLOSED_STATUS) {
    return { excluded: true, reason: 'closed-business', matched: TARGET_CLOSED_STATUS };
  }
  // The stored lead text, tokenised the same way for every comparison.
  const tokens = [];
  for (const field of ['title', 'address']) {
    const value = typeof l[field] === 'string' ? l[field] : '';
    for (const token of value.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
      if (token) tokens.push(token);
    }
  }
  for (const term of targetTermsFile(t)) {
    if (term === TARGET_CLOSED_STATUS) continue; // handled by the status above
    const needle = term.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    if (!needle.length || needle.length > tokens.length) continue;
    // Whole-token contiguous sequence: deterministic, and it cannot match a
    // fragment of a longer word.
    outer: for (let start = 0; start + needle.length <= tokens.length; start++) {
      for (let offset = 0; offset < needle.length; offset++) {
        if (tokens[start + offset] !== needle[offset]) continue outer;
      }
      return { excluded: true, reason: 'excluded-term', matched: term };
    }
  }
  return { excluded: false, reason: '', matched: '' };
}

// === P1-G Collection Quality Report ===
// Real save counters, persisted at JOB level and written by exactly one path:
// the local collection save (recordJobSaveMetrics). They are never derived from
// a guess, never computed from the provider response, and never part of the
// lead table. A report counter is a fact about what the user actually saved.
const JOB_SAVE_COUNTER_FIELDS = ['submittedCount', 'addedCount', 'duplicateCount'];
// A legacy job row has no counter at all; zero is the honest "nothing recorded
// yet" value, never a fabricated measurement.
const JOB_DEFAULT_SAVE_COUNT = 0;
const MAX_JOB_SAVE_COUNT = 1000000;
// The minimum safe Target association: a nullable pointer to a P1-F definition
// so the report can state required-field completeness for a run. There is no
// foreign key (a target may be archived and must never block a job) and no
// second campaign concept: a job still identifies exactly one provider run.
const JOB_TARGET_FIELD = 'targetId';
// Completeness fields, reported from persisted lead data only.
const QUALITY_REPORT_FIELDS = ['email', 'website', 'address', 'title'];
const QUALITY_REPORT_DEFAULT_LIMIT = 20;
const QUALITY_REPORT_MAX_LIMIT = 100;
const QUALITY_REPORT_MAX_OFFSET = 100000;

// A counter is a plain non-negative integer count, bounded so a malformed value
// can never be stored or reported. The READ side (normalizeJobCounter) maps an
// absent or legacy value to zero; the WRITE side below is deliberately strict,
// so a bug in the save flow is reported instead of being recorded as a zero.
function normalizeJobCounter(value) {
  if (value === undefined || value === null) return JOB_DEFAULT_SAVE_COUNT;
  if (!Number.isInteger(value) || value < 0 || value > MAX_JOB_SAVE_COUNT) return null;
  return value;
}

// Strict writer-side check: only a real count is accepted.
function requireJobCounter(value) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_JOB_SAVE_COUNT) return null;
  return value;
}

// duplicateCount / (addedCount + duplicateCount). A zero denominator is a real
// case (nothing was saved yet) and is reported as zero: the report never divides
// by zero and never invents a percentage. A value that is not a count also
// reports zero rather than a meaningless ratio.
function jobDuplicateRate(added, duplicates) {
  if (!Number.isInteger(added) || !Number.isInteger(duplicates)) return 0;
  const denominator = added + duplicates;
  if (denominator <= 0) return 0;
  return duplicates / denominator;
}

// Reads one counter off a raw or projected job row: an absent, legacy or
// out-of-range value is zero, because zero is the honest "nothing recorded
// yet". Shared by the writer, the report and the gate below.
function jobCounterValue(row, field) {
  const normalized = normalizeJobCounter(row ? row[field] : undefined);
  return normalized === null ? JOB_DEFAULT_SAVE_COUNT : normalized;
}

// Exact provenance literal written by the manual-import save path
// (renderer.js: source: '手动导入'). Used to map legacy `source` values.
const LEGACY_IMPORT_SOURCE = '手动导入';

// B4 local collection-job ledger. Status vocabulary is limited to the three
// states evidenced by the repository's polling/history behaviour; no other
// lifecycle state exists (there is no cancel/partial/retry API anywhere).
const JOB_STATUS_VALUES = ['running', 'succeeded', 'failed'];
// Provider run-identifier shape (RFC 3986 unreserved characters, max 200) —
// the same format the collection adapter validates, re-checked here so the
// store never persists unvalidated provider-supplied text.
const JOB_RUN_SLUG_PATTERN = /^[A-Za-z0-9._~-]{1,200}$/;
// ISO-8601 shape gate for startedAt/completedAt (plus Date.parse sanity).
const JOB_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const MAX_JOB_PROVIDER_ID_LENGTH = 100;
const MAX_JOB_QUERY_LENGTH = 20000;
const MAX_JOB_ERROR_LENGTH = 500;
const MAX_JOB_TIME_LENGTH = 100;
const JOB_TEXT_FIELDS = ['runSlug', 'providerId', 'query', 'startedAt', 'completedAt', 'status', 'error'];

// B2 query layer. Free-text search covers the human-meaningful lead fields
// (runSlug is an opaque run identifier and is not searched); filters are
// exact-match only; sort identifiers reach SQL exclusively through the
// QUERY_SORT_COLUMNS values, which are compile-time literals.
const QUERY_SEARCH_FIELDS = ['phone', 'title', 'website', 'email', 'address', 'source', 'keyword'];
const QUERY_FILTER_FIELDS = ['status', 'source', 'keyword', 'qualification'];
const QUERY_SORT_COLUMNS = {
  collectedAt: 'collectedAt',
  title: 'title',
  phone: 'phone',
  source: 'source',
  keyword: 'keyword'
};

// SQLite LIKE folds ASCII letters only; the JSON fallback must apply the
// identical folding or the two storages diverge on non-ASCII case.
function asciiFold(value) {
  return value.replace(/[A-Z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 32));
}

// Escape LIKE wildcards so a search term matches literally on both storages.
function escapeLikePattern(term) {
  return term.replace(/[\\%_]/g, (ch) => '\\' + ch);
}

// NULL sorts smallest (SQLite default); otherwise compare as SQLite's
// BINARY collation does (code-unit order matches byte order for BMP text).
function compareQueryValues(a, b) {
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;
  if (aNull || bNull) {
    if (aNull && bNull) return 0;
    return aNull ? -1 : 1;
  }
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function asText(value) {
  return typeof value === 'string' ? value : '';
}

// Legacy `source` was overloaded: the collection save path wrote the business
// title into it (renderer wrote source: item.title), the import path wrote the
// provenance literal. Map the title meaning best-effort for NEW fields only;
// the original `source` value itself is never modified or destroyed.
function legacySourceTitle(sourceValue) {
  if (sourceValue === LEGACY_IMPORT_SOURCE) return '';
  return asText(sourceValue);
}

// Adds missing B1 fields to a lead row without touching existing values.
// Idempotent: a row that already carries the fields is returned unchanged.
// Returns { row, changed }.
function normalizeLeadRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return { row, changed: false };
  let changed = false;
  if (row.title === undefined || row.title === null) {
    row.title = legacySourceTitle(row.source);
    changed = true;
  }
  for (const field of ['website', 'email', 'address', 'runSlug']) {
    if (row[field] === undefined || row[field] === null) {
      row[field] = '';
      changed = true;
    }
  }
  // User-owned fields (B6 + P1-C): default only, never rewritten when valid.
  const before = {};
  for (const field of LEAD_USER_OWNED_FIELDS) before[field] = JSON.stringify(row[field]);
  normalizeUserOwnedLeadFields(row);
  for (const field of LEAD_USER_OWNED_FIELDS) {
    if (JSON.stringify(row[field]) !== before[field]) changed = true;
  }
  // P1-D: the derived company key is (re)computed from this row's own
  // website/title/address, and companyId is only defaulted to null. A stored
  // key is never trusted, so a JSON row cannot carry a stale grouping key.
  const companyKey = deriveCompanyKey(row);
  if (row.companyKey !== companyKey) {
    row.companyKey = companyKey;
    changed = true;
  }
  if (row.companyId === undefined || row.companyId === '') {
    row.companyId = null;
    changed = true;
  }
  return { row, changed };
}

// One-time schema extension for an existing 6-column numbers table.
// Adds missing B1 columns, backfills title from the legacy `source` value
// (import provenance literal maps to an empty title; `source` untouched),
// and normalises NULLs to ''. Returns the number of columns added.
// Returns 0 on an already-migrated or fresh table (zero writes / idempotent).
function migrateSchema(db) {
  if (!db) return 0;
  let info;
  try {
    info = db.exec('PRAGMA table_info(numbers)');
  } catch {
    return 0;
  }
  if (!info.length || !info[0].values.length) return 0;
  const existing = new Set(info[0].values.map(r => r[1]));
  const added = [];
  // B1 fields first (unchanged order and behaviour), then the user-owned
  // columns. Those are added as plain TEXT: their defaults come from the
  // shared backfill below, and a default clause cannot be added to an
  // existing column by ALTER TABLE.
  for (const field of [...LEAD_NEW_FIELDS, ...LEAD_USER_OWNED_FIELDS]) {
    if (existing.has(field)) continue;
    db.run(`ALTER TABLE numbers ADD COLUMN ${field} TEXT`);
    added.push(field);
  }
  // P1-D: additive only. companyKey is derived, so it is never a column;
  // companyId is a plain nullable TEXT pointer with no default clause and no
  // foreign key (nothing in this batch owns a row it could point at). It is
  // deliberately left out of the backfill below, because NULL is its correct
  // value - not ''.
  for (const field of LEAD_COMPANY_NULLABLE_FIELDS) {
    if (existing.has(field)) continue;
    db.run(`ALTER TABLE numbers ADD COLUMN ${field} TEXT`);
    added.push(field);
  }
  if (!added.length) return 0;
  if (added.includes('title')) {
    db.run(
      "UPDATE numbers SET title = CASE WHEN source = ? THEN '' ELSE IFNULL(source, '') END",
      [LEGACY_IMPORT_SOURCE]
    );
  }
  for (const field of added) {
    // A nullable P1-D pointer keeps NULL: backfilling '' would fabricate a
    // value that no lead owns.
    if (LEAD_COMPANY_NULLABLE_FIELDS.includes(field)) continue;
    // B1 columns keep the historical '' backfill; user-owned columns get their
    // own defaults so migrated rows are byte-identical to fresh ones.
    const fallback = field in LEAD_B6_DEFAULTS
      ? LEAD_B6_DEFAULTS[field]
      : (LEAD_USER_STATUS_FIELDS.includes(field) ? DEFAULT_LEAD_USER_STATUS : '');
    db.run(`UPDATE numbers SET ${field} = ? WHERE ${field} IS NULL`, [fallback]);
  }
  return added.length;
}

// P1-G: additive job-schema migration, exactly in the shape migrateSchema uses
// for the lead table. The three counters are added as plain INTEGER columns
// (SQLite cannot attach a default to an added column) and backfilled to zero,
// because zero is the honest value for a job that recorded no save. targetId is
// added and deliberately NOT backfilled: NULL means "no target attached", which
// the report must be able to state. Idempotent: a second run adds nothing and
// writes nothing. Returns the number of columns added.
function migrateJobSchema(db) {
  if (!db) return 0;
  let info;
  try {
    info = db.exec('PRAGMA table_info(jobs)');
  } catch {
    return 0;
  }
  if (!info.length || !info[0].values.length) return 0;
  const existing = new Set(info[0].values.map(r => r[1]));
  const added = [];
  for (const field of JOB_SAVE_COUNTER_FIELDS) {
    if (existing.has(field)) continue;
    db.run(`ALTER TABLE jobs ADD COLUMN ${field} INTEGER`);
    added.push(field);
  }
  if (!existing.has(JOB_TARGET_FIELD)) {
    db.run(`ALTER TABLE jobs ADD COLUMN ${JOB_TARGET_FIELD} TEXT`);
    added.push(JOB_TARGET_FIELD);
  }
  if (!added.length) return 0;
  // One UPDATE PER COLUMN, so a job that already has a counter keeps it.
  for (const field of JOB_SAVE_COUNTER_FIELDS) {
    if (!added.includes(field)) continue;
    db.run(`UPDATE jobs SET ${field} = ? WHERE ${field} IS NULL`, [JOB_DEFAULT_SAVE_COUNT]);
  }
  return added.length;
}

// B6.4.1/P1-C idempotent repair of the user-owned lead columns.
// these columns (SQLite cannot attach a default to a column added that way),
// so their raw bytes are NULL even though every read path already reports the
// defaults. The repair runs once per startup, is scoped strictly to the
// user-owned columns, and is a no-op on a second run.
//
// It is deliberately one UPDATE PER COLUMN: a single combined statement
// ("WHERE qualification IS NULL OR tags IS NULL OR notes IS NULL") would also
// rewrite the already-set values of the other columns, so a row saved as
// qualified with a NULL note would silently lose its qualification.
// Returns the number of rows touched.
//
// P1-D: this repair is scoped strictly to the user-owned columns, so
// `companyId` is never touched here - NULL is its correct stored value, and a
// repair that "filled" it would fabricate a pointer no lead owns.
function repairLeadUserFields(db) {
  if (!db) return 0;
  let changed = 0;
  for (const field of LEAD_USER_OWNED_FIELDS) {
    const fallback = field in LEAD_B6_DEFAULTS
      ? LEAD_B6_DEFAULTS[field]
      : DEFAULT_LEAD_USER_STATUS;
    const stmt = db.prepare(`UPDATE numbers SET ${field} = ? WHERE ${field} IS NULL`);
    try {
      stmt.bind([fallback]);
      stmt.run();
      // sql.js exposes the affected-row count on the database, not the
      // statement; it reports 0 once the data is already canonical.
      if (typeof db.getRowsModified === 'function') changed += db.getRowsModified();
    } finally {
      stmt.free();
    }
  }
  return changed;
}

// Map a positional SELECT row to an object using the result's column names,
// so reads work both before and after the B1 column migration. Original
// columns keep their raw values; B1 columns default to '' when absent.
function rowToObject(columns, values) {
  const out = {};
  for (let i = 0; i < columns.length; i++) out[columns[i]] = values[i];
  for (const field of LEAD_NEW_FIELDS) {
    if (out[field] === undefined || out[field] === null) out[field] = '';
  }
  // B6/P1-C: text columns (tags) and legacy/NULL values are projected to the
  // logical API shape. `out` is a fresh object, so stored rows are untouched.
  normalizeUserOwnedLeadFields(out);
  // P1-D: companyKey is recomputed on EVERY read from the row's own
  // website/title/address - it is not read from a column, and it is never
  // written back. companyId is the stored nullable pointer, exposed as null
  // when absent, so both storage branches report the same logical shape.
  normalizeLeadCompanyFields(out);
  return out;
}

// Duplicate-phone merge rule: existing non-empty values win (first writer
// wins); empty/missing metadata fields are filled from the incoming row.
// Applies to the original four fields plus the B1 fields.
function mergeEmptyLeadFields(existing, incoming) {
  let changed = false;
  for (const field of ['source', 'keyword', 'status', 'collectedAt', ...LEAD_NEW_FIELDS]) {
    const cur = existing[field];
    const inc = incoming[field];
    const curEmpty = cur === undefined || cur === null || (typeof cur === 'string' && cur.trim() === '');
    const incFilled = inc !== undefined && inc !== null && !(typeof inc === 'string' && inc.trim() === '');
    if (curEmpty && incFilled) {
      existing[field] = inc;
      changed = true;
    }
  }
  return changed;
}

function writeJsonAtomic(filePath, contents) {
  const tmpPath = filePath + '.tmp';
  try {
    fs.writeFileSync(tmpPath, contents, 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch (cleanupErr) {}
    throw err;
  }
}

// B4 ledger: validate and normalise one job record. Returns { ok: false,
// error } or { ok: true, row } with a freshly generated local id. The input
// is constructed in the main process from already-validated data, but every
// field is re-checked here so malformed input can never reach either storage.
function validateJobRecord(job) {
  if (!job || typeof job !== 'object' || Array.isArray(job)) {
    return { ok: false, error: 'Invalid job (object required)' };
  }
  if (typeof job.runSlug !== 'string' || !JOB_RUN_SLUG_PATTERN.test(job.runSlug)) {
    return { ok: false, error: 'Invalid job: runSlug' };
  }
  if (typeof job.providerId !== 'string' || job.providerId.length < 1 ||
      job.providerId.length > MAX_JOB_PROVIDER_ID_LENGTH) {
    return { ok: false, error: 'Invalid job: providerId' };
  }
  const query = job.query === undefined || job.query === null ? '' : job.query;
  if (typeof query !== 'string' || query.length > MAX_JOB_QUERY_LENGTH) {
    return { ok: false, error: 'Invalid job: query' };
  }
  if (typeof job.startedAt !== 'string' || !job.startedAt ||
      job.startedAt.length > MAX_JOB_TIME_LENGTH ||
      !JOB_TIME_PATTERN.test(job.startedAt) || Number.isNaN(Date.parse(job.startedAt))) {
    return { ok: false, error: 'Invalid job: startedAt' };
  }
  const completedAt = job.completedAt === undefined || job.completedAt === null ? '' : job.completedAt;
  if (completedAt !== '' && (typeof completedAt !== 'string' ||
      completedAt.length > MAX_JOB_TIME_LENGTH ||
      !JOB_TIME_PATTERN.test(completedAt) || Number.isNaN(Date.parse(completedAt)))) {
    return { ok: false, error: 'Invalid job: completedAt' };
  }
  if (!JOB_STATUS_VALUES.includes(job.status)) {
    return { ok: false, error: 'Invalid job: status' };
  }
  const resultCount = job.resultCount === undefined || job.resultCount === null ? null : job.resultCount;
  if (resultCount !== null && (!Number.isInteger(resultCount) || resultCount < 0)) {
    return { ok: false, error: 'Invalid job: resultCount' };
  }
  const error = typeof job.error === 'string' ? job.error.slice(0, MAX_JOB_ERROR_LENGTH) : '';
  return {
    ok: true,
    row: {
      id: randomUUID(),
      runSlug: job.runSlug,
      providerId: job.providerId,
      query,
      startedAt: job.startedAt,
      completedAt,
      status: job.status,
      resultCount,
      error
    }
  };
}

// Map a positional SELECT row of the jobs table to an object with the fixed
// B4 field set; text columns normalise NULL to '' (mirrors rowToObject's B1
// handling) while resultCount keeps null as the explicit "unknown" value.
// The logical job shape, applied to a raw row from EITHER storage. The SQL
// branch reads a fixed column set; the JSON branch reads whatever a previous
// version wrote, so both go through this one projection and therefore report
// identical values for identical stored data.
function projectJobRow(source) {
  const out = {};
  for (const [key, value] of Object.entries(source || {})) out[key] = value;
  if (out.id === undefined || out.id === null) out.id = '';
  for (const field of JOB_TEXT_FIELDS) {
    if (out[field] === undefined || out[field] === null) out[field] = '';
  }
  if (out.resultCount === undefined) out.resultCount = null;
  // P1-G: the save counters are non-negative counts, so a legacy NULL or a
  // hand-edited out-of-range value reads as zero. targetId stays nullable.
  for (const field of JOB_SAVE_COUNTER_FIELDS) {
    const normalized = normalizeJobCounter(out[field]);
    out[field] = normalized === null ? JOB_DEFAULT_SAVE_COUNT : normalized;
  }
  if (out[JOB_TARGET_FIELD] === undefined || out[JOB_TARGET_FIELD] === '') out[JOB_TARGET_FIELD] = null;
  return out;
}

function jobRowToObject(columns, values) {
  const raw = {};
  for (let i = 0; i < columns.length; i++) raw[columns[i]] = values[i];
  return projectJobRow(raw);
}

let initSQL;
try {
  initSQL = require('sql.js');
} catch (e) {
  initSQL = null;
}

class AccountStore {
  constructor() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    this.dbPath = path.join(DATA_DIR, 'whatsapp.db');
    this.db = null;
    this._numbers = [];
    this._jobs = [];
    this._sessionQuarantine = null;
    this.storageStatus = { mode: 'json-fallback', reason: null, quarantine: null, dataMayBeIncomplete: false };
    this.ready = this.initDB();
  }

  async initDB() {
    if (!initSQL) {
      this.db = null;
      this.fallbackToJson();
      logger.warn('accountStore', 'sql.js not available, using JSON fallback storage');
      this._completeStatus('json-fallback', 'sqljs-unavailable');
      return;
    }

    let SQL;
    try {
      SQL = await initSQL();
    } catch (err) {
      logger.error('accountStore', 'database init failed, falling back to JSON storage', { error: err.message });
      this.db = null;
      this.fallbackToJson();
      this._completeStatus('json-fallback', 'sqljs-unavailable');
      return;
    }

    let buffer = null;
    if (fs.existsSync(this.dbPath)) {
      try {
        buffer = fs.readFileSync(this.dbPath);
      } catch (err) {
        logger.error('accountStore', 'database init failed, falling back to JSON storage', { error: err.message });
        this.db = null;
        this.fallbackToJson();
        this._completeStatus('json-fallback', 'read-failed');
        return;
      }
    }

    const hasExisting = !!(buffer && buffer.length);
    try {
      this.db = buffer ? new SQL.Database(buffer) : new SQL.Database();

      this.db.run(`CREATE TABLE IF NOT EXISTS numbers (
        id TEXT PRIMARY KEY,
        phone TEXT,
        source TEXT,
        keyword TEXT,
        status TEXT DEFAULT 'pending',
        collectedAt TEXT,
        title TEXT,
        website TEXT,
        email TEXT,
        address TEXT,
        runSlug TEXT,
        qualification TEXT DEFAULT '${LEAD_B6_DEFAULTS.qualification}',
        tags TEXT DEFAULT '${LEAD_B6_DEFAULTS.tags}',
        notes TEXT DEFAULT '${LEAD_B6_DEFAULTS.notes}',
        phoneStatus TEXT DEFAULT '${DEFAULT_LEAD_USER_STATUS}',
        emailStatus TEXT DEFAULT '${DEFAULT_LEAD_USER_STATUS}',
        websiteStatus TEXT DEFAULT '${DEFAULT_LEAD_USER_STATUS}',
        businessStatus TEXT DEFAULT '${DEFAULT_LEAD_USER_STATUS}',
        companyId TEXT
      )`);

      this.db.run(`CREATE INDEX IF NOT EXISTS idx_numbers_phone ON numbers(phone)`);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_numbers_status ON numbers(status)`);

      // B4 job ledger: one row per local collection execution, keyed uniquely
      // by (providerId, runSlug) so a repeated reference to the same provider
      // run is always the same row. No foreign key to numbers on purpose:
      // lead provenance stays exactly as B1/B3 defined it.
      this.db.run(`CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        runSlug TEXT,
        providerId TEXT,
        query TEXT,
        startedAt TEXT,
        completedAt TEXT,
        status TEXT,
        resultCount INTEGER,
        error TEXT,
        -- P1-G: the real save counters, written only by the local save flow.
        -- A legacy row has no value for them, so they are read as zero.
        submittedCount INTEGER,
        addedCount INTEGER,
        duplicateCount INTEGER,
        -- P1-G: nullable pointer to a P1-F target definition. No foreign key.
        targetId TEXT,
        UNIQUE(providerId, runSlug)
      )`);

      this.db.run(`CREATE INDEX IF NOT EXISTS idx_jobs_startedAt ON jobs(startedAt)`);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_jobs_provider_run ON jobs(providerId, runSlug)`);

      // P1-F Target builder. One row per user-owned prospecting definition,
      // provider-independent and referenced by no lead. There is no foreign
      // key by design: a Target is a reusable definition, not a parent of any
      // stored row, and deleting one must never be able to affect a lead. The
      // CSV-style list columns are stored as JSON array text and read back as
      // arrays, mirroring the B6 tags column.
      this.db.run(`CREATE TABLE IF NOT EXISTS targets (
        id TEXT PRIMARY KEY,
        name TEXT,
        industry TEXT,
        businessTypes TEXT,
        locations TEXT,
        requiredFields TEXT,
        optionalFields TEXT,
        exclusions TEXT,
        createdAt TEXT,
        updatedAt TEXT,
        status TEXT DEFAULT '${TARGET_DEFAULT_STATUS}'
      )`);
    } catch (err) {
      this.db = null;
      logger.error('accountStore', 'database init failed, falling back to JSON storage', { error: err.message });
      if (hasExisting) this._quarantineCorrupt(err);
      this.fallbackToJson();
      this._completeStatus('json-fallback', hasExisting ? 'corrupt-open' : 'init-failed');
      return;
    }

    try {
      const migratedColumns = migrateSchema(this.db);
      if (migratedColumns) {
        logger.info('accountStore', 'lead schema migration applied', { columns: migratedColumns });
      }
      // P1-G: the same additive migration for the job ledger, before the first
      // save, so every later read finds the counters.
      const migratedJobColumns = migrateJobSchema(this.db);
      if (migratedJobColumns) {
        logger.info('accountStore', 'job schema migration applied', { columns: migratedJobColumns });
      }
      // B6.4.1: make the stored B6 bytes canonical (NULL -> default) before
      // the first save, so later filters and exports need no NULL special
      // case. Count only, never field values.
      const repairedRows = repairLeadUserFields(this.db);
      if (repairedRows) {
        logger.info('accountStore', 'lead user-owned field repair applied', { rows: repairedRows });
      }
      this.saveDB();
    } catch (err) {
      this.db = null;
      logger.error('accountStore', 'database init failed, falling back to JSON storage', { error: err.message });
      this.fallbackToJson();
      this._completeStatus('json-fallback', 'init-write-failed');
      return;
    }

    this.migrateJsonData();
    logger.info('accountStore', 'database initialized', { dbPath: this.dbPath });
    this._completeStatus('sql', null);
  }

  _quarantineCorrupt(openErr) {
    const target = this.dbPath + '.corrupt-' + Date.now();
    try {
      fs.renameSync(this.dbPath, target);
      this._sessionQuarantine = target;
      logger.error('accountStore', 'unreadable database preserved', { error: openErr.message, preserved: target });
    } catch (renameErr) {
      this._sessionQuarantine = null;
      logger.error('accountStore', 'failed to preserve unreadable database', { error: renameErr.message, dbPath: this.dbPath });
    }
  }

  _scanQuarantine() {
    const prefix = path.basename(this.dbPath) + '.corrupt-';
    try {
      let newest = null;
      let newestM = -1;
      for (const name of fs.readdirSync(path.dirname(this.dbPath))) {
        if (!name.startsWith(prefix)) continue;
        const full = path.join(path.dirname(this.dbPath), name);
        const m = fs.statSync(full).mtimeMs;
        if (m >= newestM) {
          newestM = m;
          newest = full;
        }
      }
      return newest;
    } catch (err) {
      return null;
    }
  }

  _completeStatus(mode, reason) {
    const quarantine = this._sessionQuarantine || this._scanQuarantine();
    this.storageStatus = {
      mode,
      quarantine,
      reason,
      dataMayBeIncomplete: quarantine !== null || (mode === 'json-fallback' && fs.existsSync(this.dbPath))
    };
  }

  async getStorageStatus() {
    await this.ready;
    return { ...this.storageStatus };
  }

  migrateJsonData() {
    const oldNumbers = path.join(DATA_DIR, 'numbers.json');

    if (!fs.existsSync(oldNumbers)) return;
    try {
      const data = JSON.parse(fs.readFileSync(oldNumbers, 'utf-8'));
      if (Array.isArray(data) && data.length) {
        // P1-D ownership: numbers.json is this app's OWN storage, written by
        // this app, not a provider or an import payload. A system-owned
        // companyId already stored there is therefore carried across the
        // migration - exactly as the delete rollback carries it. _addNumbers
        // strips companyId from every payload it receives (no collection,
        // import or provider refresh may set it), so the pointers are read
        // from the local file here and re-applied afterwards. companyKey is
        // NOT restored: it stays derived, and the stripped value is discarded.
        const pointers = new Map();
        for (const row of data) {
          if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
          if (typeof row.companyId !== 'string' || !row.companyId) continue;
          pointers.set(canonicalPhone(row.phone), row.companyId);
        }
        const result = this._addNumbers(data);
        const restoredPointers = this._restoreCompanyIdPointers(pointers);
        logger.info('accountStore', 'legacy JSON data migrated', {
          input: data.length,
          added: result.added,
          duplicates: result.duplicates,
          // A count only: never a company-derived value.
          companyPointersRestored: restoredPointers
        });
      } else {
        logger.info('accountStore', 'legacy JSON file found, no rows to migrate');
      }
      fs.renameSync(oldNumbers, oldNumbers + '.bak');
    } catch (err) {
      logger.error('accountStore', 'legacy JSON migration failed', { error: err.message });
    }
  }

  // Re-apply companyId pointers captured from the app's own numbers.json after
  // the rows have been migrated. Mirrors the delete-rollback rule: a storage
  // transition must never lose an existing pointer. It only ever FILLS a NULL
  // on a row that has no pointer, so it can neither overwrite nor clear one,
  // and it is the single place in P1-D that can move a companyId value - there
  // is no IPC or other write path. Returns the number of rows updated.
  _restoreCompanyIdPointers(pointers) {
    if (!pointers || !pointers.size) return 0;
    let restored = 0;
    if (!this.db) {
      const pending = [];
      for (const row of this._numbers || []) {
        const pointer = pointers.get(canonicalPhone(row.phone));
        if (pointer && !row.companyId) {
          row.companyId = pointer;
          pending.push(row.id);
          restored++;
        }
      }
      if (restored) {
        writeJsonAtomic(path.join(DATA_DIR, 'numbers.json'), JSON.stringify(this._numbers, null, 2));
      }
      return restored;
    }
    const scan = this.db.exec('SELECT * FROM numbers');
    if (!scan.length) return 0;
    for (const values of scan[0].values) {
      const row = rowToObject(scan[0].columns, values);
      const pointer = pointers.get(canonicalPhone(row.phone));
      if (!pointer || row.companyId) continue;
      this.db.run('UPDATE numbers SET companyId = ? WHERE id = ?', [pointer, row.id]);
      restored++;
    }
    if (restored) this.saveDB();
    return restored;
  }

  fallbackToJson() {
    // B4: load the job ledger with the same tolerance as numbers.json —
    // missing file means an empty ledger, unreadable/non-array content is
    // logged and ignored rather than crashing the fallback path. P1-F loads the
    // target definitions the same way: a missing file is an empty list.
    this._jobs = [];
    const jf = path.join(DATA_DIR, 'jobs.json');
    if (fs.existsSync(jf)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(jf, 'utf-8'));
        if (Array.isArray(parsed)) {
          this._jobs = parsed;
        } else {
          logger.warn('accountStore', 'jobs.json is not an array, ignoring');
        }
      } catch (err) {
        logger.error('accountStore', 'failed to read jobs.json', { error: err.message });
      }
    }
    this._targets = [];
    const tf = path.join(DATA_DIR, 'targets.json');
    if (fs.existsSync(tf)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(tf, 'utf-8'));
        if (Array.isArray(parsed)) {
          this._targets = parsed.map(row => normalizeTargetRow(row)).filter(Boolean);
        } else {
          logger.warn('accountStore', 'targets.json is not an array, ignoring');
        }
      } catch (err) {
        logger.error('accountStore', 'failed to read targets.json', { error: err.message });
      }
    }
    this._numbers = [];
    const nf = path.join(DATA_DIR, 'numbers.json');
    if (!fs.existsSync(nf)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(nf, 'utf-8'));
      if (Array.isArray(parsed)) {
        for (const row of parsed) normalizeLeadRow(row);
        this._numbers = parsed;
      } else {
        logger.warn('accountStore', 'numbers.json is not an array, ignoring');
      }
    } catch (err) {
      logger.error('accountStore', 'failed to read numbers.json', { error: err.message });
    }
  }

  saveDB() {
    if (!this.db) return;
    const tmpPath = this.dbPath + '.tmp';
    try {
      const data = this.db.export();
      fs.writeFileSync(tmpPath, Buffer.from(data));
      fs.renameSync(tmpPath, this.dbPath);
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch (cleanupErr) {}
      logger.error('accountStore', 'failed to persist database', { error: err.message });
      throw err;
    }
  }

  // === 号码管理 ===
  async getCollectedNumbers() {
    await this.ready;
    if (!this.db) return this._numbers || [];
    const rows = this.db.exec('SELECT * FROM numbers ORDER BY rowid DESC');
    if (!rows.length) return [];
    return rows[0].values.map(r => rowToObject(rows[0].columns, r));
  }

  // B2 query layer: server-side search/filter/sort/paging over the lead
  // library. Returns { rows, total, limit, offset }. Read-only: never calls
  // saveDB and never mutates stored rows on either storage branch.
  async queryNumbers(query) {
    await this.ready;
    const q = (query && typeof query === 'object' && !Array.isArray(query)) ? query : {};
    const normalized = {
      limit: Number.isInteger(q.limit) && q.limit >= 1 && q.limit <= 100 ? q.limit : 20,
      offset: Number.isInteger(q.offset) && q.offset >= 0 && q.offset <= 100000 ? q.offset : 0,
      search: typeof q.search === 'string' ? q.search.trim() : '',
      filters: {},
      qualityFilters: {},
      sort: typeof q.sort === 'string' && QUERY_SORT_COLUMNS[q.sort] ? q.sort : '',
      order: q.order === 'desc' ? 'desc' : 'asc'
    };
    if (q.filters && typeof q.filters === 'object' && !Array.isArray(q.filters)) {
      for (const field of QUERY_FILTER_FIELDS) {
        const value = q.filters[field];
        if (typeof value === 'string') normalized.filters[field] = value;
      }
      // P1-B: derived quality filters are kept apart from the stored-column
      // filters, because they are computed from column VALUES rather than
      // read from a column. Non-string values are ignored, exactly as above.
      for (const field of LEAD_QUALITY_FILTER_FIELDS) {
        const value = q.filters[field];
        if (typeof value === 'string') normalized.qualityFilters[field] = value;
      }
    }
    // B3 single-lead lookup: an optional exact id predicate. Omitted id
    // keeps list semantics; a provided id must be a non-empty string of at
    // most 100 chars or the lookup short-circuits to an empty envelope, so
    // malformed input behaves identically on both storages and can never be
    // coerced by SQL type affinity.
    if (q.id !== undefined && q.id !== null) {
      const valid = typeof q.id === 'string' && q.id.length > 0 && q.id.length <= 100;
      if (!valid) {
        return { rows: [], total: 0, limit: normalized.limit, offset: normalized.offset };
      }
      normalized.id = q.id;
    }
    if (Object.keys(normalized.qualityFilters).length) {
      return this._queryNumbersWithQuality(normalized);
    }
    if (!this.db) return this._queryNumbersJson(normalized);
    return this._queryNumbersSql(normalized);
  }

  // P1-B: runs only when a derived quality filter is present. The existing
  // branch functions are reused unchanged to obtain the candidate set (stored
  // filters, search and sort already applied, paging lifted), the shared
  // predicate is applied in JavaScript, and the page slice is taken from the
  // filtered result so `total` and `offset` stay correct. Read-only, like the
  // rest of the query layer: no save, no log, no mutation.
  async _queryNumbersWithQuality(normalized) {
    const scan = { ...normalized, limit: LEAD_QUALITY_SCAN_LIMIT, offset: 0 };
    const candidates = this.db
      ? (await this._queryNumbersSql(scan)).rows
      : (await this._queryNumbersJson(scan)).rows;
    const matched = candidates.filter(row => leadMatchesQualityFilters(row, normalized.qualityFilters));
    return {
      rows: matched.slice(normalized.offset, normalized.offset + normalized.limit),
      total: matched.length,
      limit: normalized.limit,
      offset: normalized.offset
    };
  }

  _queryNumbersSql(query) {
    const where = [];
    const params = [];
    if (query.id !== undefined) {
      where.push('id = ?');
      params.push(query.id);
    }
    if (query.search) {
      const pattern = '%' + escapeLikePattern(query.search) + '%';
      where.push('(' + QUERY_SEARCH_FIELDS.map(f => `${f} LIKE ? ESCAPE '\\'`).join(' OR ') + ')');
      for (let i = 0; i < QUERY_SEARCH_FIELDS.length; i++) params.push(pattern);
    }
    for (const field of QUERY_FILTER_FIELDS) {
      const value = query.filters[field];
      if (value === undefined || value === null) continue;
      where.push(`${field} = ?`);
      params.push(value);
    }
    const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const orderSql = query.sort
      ? `ORDER BY ${QUERY_SORT_COLUMNS[query.sort]} ${query.order === 'desc' ? 'DESC' : 'ASC'}, rowid DESC`
      : 'ORDER BY rowid DESC';

    let total = 0;
    const countStmt = this.db.prepare(`SELECT COUNT(*) AS c FROM numbers${whereSql}`);
    try {
      countStmt.bind(params);
      if (countStmt.step()) total = countStmt.getAsObject().c;
    } finally {
      countStmt.free();
    }

    const rowStmt = this.db.prepare(`SELECT * FROM numbers${whereSql} ${orderSql} LIMIT ? OFFSET ?`);
    try {
      rowStmt.bind([...params, query.limit, query.offset]);
      const rows = [];
      let columns = null;
      while (rowStmt.step()) {
        if (!columns) columns = rowStmt.getColumnNames();
        rows.push(rowToObject(columns, rowStmt.get()));
      }
      return { rows, total, limit: query.limit, offset: query.offset };
    } finally {
      rowStmt.free();
    }
  }

  _queryNumbersJson(query) {
    const search = query.search ? asciiFold(query.search) : '';
    const matched = (this._numbers || []).filter((row) => {
      if (query.id !== undefined && row.id !== query.id) return false;
      if (search) {
        let hit = false;
        for (const field of QUERY_SEARCH_FIELDS) {
          const raw = row[field];
          const hay = raw === null || raw === undefined ? '' : asciiFold(String(raw));
          if (hay.includes(search)) {
            hit = true;
            break;
          }
        }
        if (!hit) return false;
      }
      for (const field of QUERY_FILTER_FIELDS) {
        const value = query.filters[field];
        if (value === undefined || value === null) continue;
        if (row[field] !== value) return false;
      }
      return true;
    });
    const total = matched.length;
    let ordered;
    if (query.sort) {
      const dir = query.order === 'desc' ? -1 : 1;
      const indexed = matched.map((row, i) => ({ row, i }));
      indexed.sort((a, b) => {
        const cmp = compareQueryValues(a.row[query.sort], b.row[query.sort]);
        if (cmp !== 0) return cmp * dir;
        return b.i - a.i;
      });
      ordered = indexed.map((entry) => entry.row);
    } else {
      // Default mirrors the SQL branch: newest insert first (rowid DESC).
      ordered = matched.slice().reverse();
    }
    return {
      rows: ordered.slice(query.offset, query.offset + query.limit),
      total,
      limit: query.limit,
      offset: query.offset
    };
  }

  async addNumbers(newNumbers) {
    await this.ready;
    return this._addNumbers(newNumbers);
  }

  _addNumbers(newNumbers) {
    // Ownership boundary: this is the collection/import entry point, so any
    // user-owned key smuggled into a payload is removed before the row can
    // reach either storage. The SQL INSERT below stays limited to the 11
    // provider fields so the column defaults populate the B6 fields.
    for (const n of newNumbers) {
      stripUserOwnedLeadFields(n);
      normalizeLeadRow(n);
    }
    if (!this.db) {
      const backup = (this._numbers || []).map(n => ({ ...n }));
      const byPhone = new Map();
      for (const n of this._numbers || []) {
        const key = canonicalPhone(n.phone);
        if (!byPhone.has(key)) byPhone.set(key, n);
      }
      let added = 0, duplicates = 0;
      for (const n of newNumbers) {
        const key = canonicalPhone(n.phone);
        const existing = byPhone.get(key);
        if (existing) {
          if (mergeEmptyLeadFields(existing, n)) {
            // P1-D: a merge can fill this row's website/title/address, so the
            // derived key is recomputed here instead of being left stale. The
            // in-memory row is what every JSON read returns.
            normalizeLeadCompanyFields(existing);
          }
          duplicates++;
          continue;
        }
        byPhone.set(key, n);
        this._numbers.push(n);
        added++;
      }
      try {
        writeJsonAtomic(path.join(DATA_DIR, 'numbers.json'), JSON.stringify(this._numbers, null, 2));
      } catch (err) {
        this._numbers = backup;
        logger.error('accountStore', 'failed to write numbers.json', { error: err.message });
        throw err;
      }
      const result = { added, duplicates };
      logger.info('collector', 'numbers added', { input: newNumbers.length, added: result.added, duplicates: result.duplicates, storage: 'json' });
      return result;
    }

    let added = 0, duplicates = 0;
    const scan = this.db.exec('SELECT * FROM numbers ORDER BY rowid DESC');
    const byPhone = new Map();
    if (scan.length) {
      for (const r of scan[0].values) {
        const row = rowToObject(scan[0].columns, r);
        byPhone.set(canonicalPhone(row.phone), row);
      }
    }
    const pristine = new Map();
    const mergedIds = new Set();
    const insertedIds = [];
    for (const n of newNumbers) {
      const key = canonicalPhone(n.phone);
      const existing = byPhone.get(key);
      if (existing) {
        if (!pristine.has(existing.id)) {
          pristine.set(existing.id, {
            id: existing.id, source: existing.source, keyword: existing.keyword,
            status: existing.status, collectedAt: existing.collectedAt,
            title: existing.title, website: existing.website, email: existing.email,
            address: existing.address, runSlug: existing.runSlug
          });
        }
        if (mergeEmptyLeadFields(existing, n)) {
          this.db.run(
            'UPDATE numbers SET source = ?, keyword = ?, status = ?, collectedAt = ?, title = ?, website = ?, email = ?, address = ?, runSlug = ? WHERE id = ?',
            [existing.source, existing.keyword, existing.status, existing.collectedAt,
              existing.title, existing.website, existing.email, existing.address, existing.runSlug,
              existing.id]
          );
          mergedIds.add(existing.id);
        }
        duplicates++;
        continue;
      }
      const row = {
        id: n.id || randomUUID(),
        phone: n.phone,
        source: n.source || '',
        keyword: n.keyword || '',
        status: n.status || 'pending',
        collectedAt: n.collectedAt || new Date().toISOString(),
        title: n.title || '',
        website: n.website || '',
        email: n.email || '',
        address: n.address || '',
        runSlug: n.runSlug || ''
      };
      this.db.run(
        'INSERT INTO numbers (id, phone, source, keyword, status, collectedAt, title, website, email, address, runSlug) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [row.id, row.phone, row.source, row.keyword, row.status, row.collectedAt,
          row.title, row.website, row.email, row.address, row.runSlug]
      );
      byPhone.set(key, row);
      insertedIds.push(row.id);
      added++;
    }
    try {
      this.saveDB();
    } catch (err) {
      try {
        for (const id of insertedIds) {
          this.db.run('DELETE FROM numbers WHERE id = ?', [id]);
        }
        for (const id of mergedIds) {
          const prev = pristine.get(id);
          if (prev) {
            this.db.run(
              'UPDATE numbers SET source = ?, keyword = ?, status = ?, collectedAt = ?, title = ?, website = ?, email = ?, address = ?, runSlug = ? WHERE id = ?',
              [prev.source, prev.keyword, prev.status, prev.collectedAt,
                prev.title, prev.website, prev.email, prev.address, prev.runSlug, id]
            );
          }
        }
      } catch (revertErr) {
        logger.error('accountStore', 'in-memory restore after failed persistence incomplete', { error: revertErr.message });
      }
      throw err;
    }
    logger.info('collector', 'numbers added', { input: newNumbers.length, added, duplicates, storage: 'sql' });
    return { added, duplicates };
  }

  async deleteNumbers(ids) {
    await this.ready;
    if (!this.db) {
      const backup = (this._numbers || []).map(n => ({ ...n }));
      const idSet = new Set(ids);
      this._numbers = (this._numbers || []).filter(n => !idSet.has(n.id));
      try {
        writeJsonAtomic(path.join(DATA_DIR, 'numbers.json'), JSON.stringify(this._numbers, null, 2));
      } catch (err) {
        this._numbers = backup;
        logger.error('accountStore', 'failed to write numbers.json', { error: err.message });
        throw err;
      }
      logger.info('collector', 'numbers deleted', { count: ids.length, storage: 'json' });
      return { success: true };
    }
    const idSet = new Set(ids);
    const scan = this.db.exec('SELECT * FROM numbers ORDER BY rowid DESC');
    const removed = scan.length
      ? scan[0].values
          .map(r => rowToObject(scan[0].columns, r))
          .filter(row => idSet.has(row.id))
      : [];
    for (const id of ids) {
      this.db.run('DELETE FROM numbers WHERE id = ?', [id]);
    }
    try {
      this.saveDB();
    } catch (err) {
      try {
        for (const row of removed) {
          // Complete 19-column restore: a partial restore would silently drop
          // the user-owned fields (B6 values, tag text and P1-C statuses) or
          // the nullable P1-D companyId on a failed persist. companyKey is
          // absent by design - it is derived, never stored.
          this.db.run(
            'INSERT INTO numbers (id, phone, source, keyword, status, collectedAt, title, website, email, address, runSlug, qualification, tags, notes, phoneStatus, emailStatus, websiteStatus, businessStatus, companyId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [row.id, row.phone, row.source, row.keyword, row.status, row.collectedAt,
              row.title || '', row.website || '', row.email || '', row.address || '', row.runSlug || '',
              row.qualification || LEAD_B6_DEFAULTS.qualification,
              JSON.stringify(parseLeadTags(row.tags)),
              row.notes || '',
              row.phoneStatus || DEFAULT_LEAD_USER_STATUS,
              row.emailStatus || DEFAULT_LEAD_USER_STATUS,
              row.websiteStatus || DEFAULT_LEAD_USER_STATUS,
              row.businessStatus || DEFAULT_LEAD_USER_STATUS,
              // Restored verbatim; an absent value stays NULL.
              row.companyId === undefined || row.companyId === '' ? null : row.companyId]
          );
        }
      } catch (revertErr) {
        logger.error('accountStore', 'in-memory restore after failed persistence incomplete', { error: revertErr.message });
      }
      throw err;
    }
    logger.info('collector', 'numbers deleted', { count: ids.length, storage: 'sql' });
    return { success: true };
  }

  // === B6 user-owned lead fields ===
  // The only writer of qualification/tags/notes. The collection and import
  // paths cannot reach these fields (see stripUserOwnedLeadFields), so this
  // method is the single boundary between user input and storage. Values are
  // re-validated here, mirrored on both storages, and never logged by value.

  async setLeadUserFields(payload) {
    await this.ready;
    const validated = validateLeadUserFields(payload);
    if (!validated.ok) return { success: false, error: validated.error };
    if (!this.db) return this._setLeadUserFieldsJson(validated.value);
    return this._setLeadUserFieldsSql(validated.value);
  }

  // Raw (un-normalised) single-lead row: the revert path must restore the
  // exact stored text, so this deliberately does not call rowToObject.
  _findLeadSql(id) {
    const stmt = this.db.prepare('SELECT * FROM numbers WHERE id = ?');
    try {
      stmt.bind([id]);
      if (!stmt.step()) return null;
      const columns = stmt.getColumnNames();
      const values = stmt.get();
      const out = {};
      for (let i = 0; i < columns.length; i++) out[columns[i]] = values[i];
      return out;
    } finally {
      stmt.free();
    }
  }

  _setLeadUserFieldsSql(value) {
    const existing = this._findLeadSql(value.id);
    if (!existing) return { success: true, updated: false, reason: 'not-found' };
    const tagsText = JSON.stringify(value.tags);
    // State-change gate: an identical save never persists. Compared on the
    // logical values, so a legacy NULL-raw row is not rewritten needlessly.
    const currentQualification = LEAD_QUALIFICATION_VALUES.includes(existing.qualification)
      ? existing.qualification
      : LEAD_B6_DEFAULTS.qualification;
    const currentNotes = typeof existing.notes === 'string' ? existing.notes : LEAD_B6_DEFAULTS.notes;
    if (currentQualification === value.qualification &&
        tagsText === JSON.stringify(parseLeadTags(existing.tags)) &&
        currentNotes === value.notes) {
      return { success: true, updated: false, reason: 'unchanged' };
    }
    this.db.run(
      'UPDATE numbers SET qualification = ?, tags = ?, notes = ? WHERE id = ?',
      [value.qualification, tagsText, value.notes, value.id]
    );
    try {
      this.saveDB();
    } catch (err) {
      try {
        // Restore the exact stored bytes, not the normalised projection.
        this.db.run(
          'UPDATE numbers SET qualification = ?, tags = ?, notes = ? WHERE id = ?',
          [existing.qualification === null || existing.qualification === undefined ? '' : existing.qualification,
            existing.tags === null || existing.tags === undefined ? '' : existing.tags,
            existing.notes === null || existing.notes === undefined ? '' : existing.notes,
            value.id]
        );
      } catch (revertErr) {
        logger.error('accountStore', 'lead user field restore after failed persistence incomplete', { error: revertErr.message });
      }
      throw err;
    }
    logger.info('collector', 'lead user fields updated', { leadId: value.id, updated: true, storage: 'sql' });
    return { success: true, updated: true };
  }

  _setLeadUserFieldsJson(value) {
    const existing = (this._numbers || []).find(n => n && n.id === value.id);
    if (!existing) return { success: true, updated: false, reason: 'not-found' };
    const current = normalizeLeadB6Fields({ ...existing });
    // State-change gate: an identical save never persists.
    if (current.qualification === value.qualification &&
        JSON.stringify(current.tags) === JSON.stringify(value.tags) &&
        current.notes === value.notes) {
      return { success: true, updated: false, reason: 'unchanged' };
    }
    const backup = { ...existing };
    existing.qualification = value.qualification;
    existing.tags = value.tags.slice();
    existing.notes = value.notes;
    try {
      writeJsonAtomic(path.join(DATA_DIR, 'numbers.json'), JSON.stringify(this._numbers, null, 2));
    } catch (err) {
      Object.assign(existing, backup);
      logger.error('accountStore', 'failed to write numbers.json', { error: err.message });
      throw err;
    }
    logger.info('collector', 'lead user fields updated', { leadId: value.id, updated: true, storage: 'json' });
    return { success: true, updated: true };
  }

  // === P1-C user-owned data-quality status overrides ===
  // The only writer of phoneStatus/emailStatus/websiteStatus/businessStatus.
  // These are user assertions about a lead, never a third-party verification,
  // and they are independent of the P1-A derived signals: setting a status
  // never changes what is computed from the lead's own fields.

  async setLeadUserStatuses(payload) {
    await this.ready;
    const validated = validateLeadUserStatusUpdate(payload);
    if (!validated.ok) return { success: false, error: validated.error };
    if (!this.db) return this._setLeadUserStatusesJson(validated.value);
    return this._setLeadUserStatusesSql(validated.value);
  }

  _setLeadUserStatusesSql(value) {
    const existing = this._findLeadSql(value.id);
    if (!existing) return { success: true, updated: false, reason: 'not-found' };
    // Partial update: only the provided fields are compared and written.
    const provided = LEAD_USER_STATUS_FIELDS.filter(f => Object.prototype.hasOwnProperty.call(value, f));
    if (!provided.length) return { success: true, updated: false, reason: 'unchanged' };
    const current = normalizeLeadUserStatusFields({ ...existing });
    if (provided.every(field => current[field] === value[field])) {
      return { success: true, updated: false, reason: 'unchanged' };
    }
    const assignments = provided.map(field => `${field} = ?`);
    const params = provided.map(field => value[field]);
    params.push(value.id);
    this.db.run(`UPDATE numbers SET ${assignments.join(', ')} WHERE id = ?`, params);
    try {
      this.saveDB();
    } catch (err) {
      try {
        const revertAssignments = [];
        const revertParams = [];
        for (const field of provided) {
          revertAssignments.push(`${field} = ?`);
          revertParams.push(existing[field] === null || existing[field] === undefined
            ? DEFAULT_LEAD_USER_STATUS : existing[field]);
        }
        revertParams.push(value.id);
        this.db.run(`UPDATE numbers SET ${revertAssignments.join(', ')} WHERE id = ?`, revertParams);
      } catch (revertErr) {
        logger.error('accountStore', 'lead status restore after failed persistence incomplete', { error: revertErr.message });
      }
      throw err;
    }
    // Counts and identifiers only: never the status values themselves.
    logger.info('collector', 'lead user statuses updated', {
      leadId: value.id, fields: provided.length, storage: 'sql'
    });
    return { success: true, updated: true };
  }

  _setLeadUserStatusesJson(value) {
    const existing = (this._numbers || []).find(n => n && n.id === value.id);
    if (!existing) return { success: true, updated: false, reason: 'not-found' };
    const provided = LEAD_USER_STATUS_FIELDS.filter(f => Object.prototype.hasOwnProperty.call(value, f));
    if (!provided.length) return { success: true, updated: false, reason: 'unchanged' };
    const current = normalizeLeadUserStatusFields({ ...existing });
    if (provided.every(field => current[field] === value[field])) {
      return { success: true, updated: false, reason: 'unchanged' };
    }
    const backup = { ...existing };
    for (const field of provided) existing[field] = value[field];
    try {
      writeJsonAtomic(path.join(DATA_DIR, 'numbers.json'), JSON.stringify(this._numbers, null, 2));
    } catch (err) {
      Object.assign(existing, backup);
      logger.error('accountStore', 'failed to write numbers.json', { error: err.message });
      throw err;
    }
    logger.info('collector', 'lead user statuses updated', {
      leadId: value.id, fields: provided.length, storage: 'json'
    });
    return { success: true, updated: true };
  }

  async exportNumbers(format = 'csv') {
    await this.ready;
    const numbers = await this.getCollectedNumbers();
    logger.info('collector', 'numbers exported', { format: format === 'json' ? 'json' : 'csv', count: numbers.length });
    if (format === 'csv') {
      // B6.4.1/P1-C: the user-owned columns are appended after the existing
      // thirteen, which stay byte-for-byte unchanged. tags are ';'-joined for
      // CSV only and notes are newline-collapsed by csvNotes; every field
      // still goes through csvField, so formula-like values stay neutralised.
      const header = 'phone,source,keyword,status,collected_at,title,website,email,address,run_slug,qualification,tags,notes,phone_status,email_status,website_status,business_status\n';
      const rows = numbers.map(n =>
        `"${csvField(n.phone)}","${csvField(n.source || '')}","${csvField(n.keyword || '')}","${csvField(n.status || '')}","${csvField(n.collectedAt || '')}","${csvField(n.title || '')}","${csvField(n.website || '')}","${csvField(n.email || '')}","${csvField(n.address || '')}","${csvField(n.runSlug || '')}","${csvField(n.qualification || '')}","${csvField((n.tags || []).join(';'))}","${csvField(csvNotes(n.notes))}","${csvField(n.phoneStatus || '')}","${csvField(n.emailStatus || '')}","${csvField(n.websiteStatus || '')}","${csvField(n.businessStatus || '')}"`
      ).join('\n');
      return header + rows;
    }
    return JSON.stringify(numbers, null, 2);
  }

  // === B4 local collection-job ledger ===
  // Ledger writes are best-effort from the collection handlers' perspective:
  // a persistence failure is reverted in memory, logged and rethrown HERE so
  // the caller (which wraps every ledger call in try/catch) can log it without
  // affecting the already-successful provider result.

  async insertJob(job) {
    await this.ready;
    const validated = validateJobRecord(job);
    if (!validated.ok) return { success: false, error: validated.error };
    return this._insertJob(validated.row);
  }

  async updateJobState(providerId, runSlug, status, errorMessage) {
    await this.ready;
    if (typeof providerId !== 'string' || providerId.length < 1 ||
        providerId.length > MAX_JOB_PROVIDER_ID_LENGTH) {
      return { success: false, error: 'Invalid job: providerId' };
    }
    if (typeof runSlug !== 'string' || !JOB_RUN_SLUG_PATTERN.test(runSlug)) {
      return { success: false, error: 'Invalid job: runSlug' };
    }
    if (status !== 'succeeded' && status !== 'failed') {
      return { success: false, error: 'Invalid job: status' };
    }
    const errorText = typeof errorMessage === 'string' ? errorMessage.slice(0, MAX_JOB_ERROR_LENGTH) : '';
    if (!this.db) return this._updateJobStateJson(providerId, runSlug, status, errorText);
    return this._updateJobStateSql(providerId, runSlug, status, errorText);
  }

  async setJobResultCount(providerId, runSlug, resultCount) {
    await this.ready;
    if (typeof providerId !== 'string' || providerId.length < 1 ||
        providerId.length > MAX_JOB_PROVIDER_ID_LENGTH) {
      return { success: false, error: 'Invalid job: providerId' };
    }
    if (typeof runSlug !== 'string' || !JOB_RUN_SLUG_PATTERN.test(runSlug)) {
      return { success: false, error: 'Invalid job: runSlug' };
    }
    if (!Number.isInteger(resultCount) || resultCount < 0) {
      return { success: false, error: 'Invalid job: resultCount' };
    }
    if (!this.db) return this._setJobResultCountJson(providerId, runSlug, resultCount);
    return this._setJobResultCountSql(providerId, runSlug, resultCount);
  }

  // B5-ready read API: same {rows,total,limit,offset} envelope and paging
  // bounds as the lead library, newest job first. Never an unbounded read.
  async queryJobs(query) {
    await this.ready;
    const q = (query && typeof query === 'object' && !Array.isArray(query)) ? query : {};
    const normalized = {
      limit: Number.isInteger(q.limit) && q.limit >= 1 && q.limit <= 100 ? q.limit : 20,
      offset: Number.isInteger(q.offset) && q.offset >= 0 && q.offset <= 100000 ? q.offset : 0
    };
    if (!this.db) return this._queryJobsJson(normalized);
    return this._queryJobsSql(normalized);
  }

  _findJobSql(providerId, runSlug) {
    const stmt = this.db.prepare('SELECT * FROM jobs WHERE providerId = ? AND runSlug = ?');
    try {
      stmt.bind([providerId, runSlug]);
      if (stmt.step()) {
        return jobRowToObject(stmt.getColumnNames(), stmt.get());
      }
      return null;
    } finally {
      stmt.free();
    }
  }

  _insertJob(row) {
    if (!this.db) return this._insertJobJson(row);
    const existing = this._findJobSql(row.providerId, row.runSlug);
    if (existing) {
      this.db.run(
        'UPDATE jobs SET query = ?, startedAt = ?, completedAt = ?, status = ?, resultCount = ?, error = ? WHERE providerId = ? AND runSlug = ?',
        [row.query, row.startedAt, row.completedAt, row.status, row.resultCount, row.error,
         row.providerId, row.runSlug]
      );
      try {
        this.saveDB();
      } catch (err) {
        try {
          this.db.run(
            'UPDATE jobs SET query = ?, startedAt = ?, completedAt = ?, status = ?, resultCount = ?, error = ? WHERE providerId = ? AND runSlug = ?',
            [existing.query, existing.startedAt, existing.completedAt, existing.status,
             existing.resultCount, existing.error, row.providerId, row.runSlug]
          );
        } catch (revertErr) {
          logger.error('accountStore', 'in-memory job restore after failed persistence incomplete', { error: revertErr.message });
        }
        throw err;
      }
      logger.info('job', 'job recorded', { jobId: existing.id, providerId: row.providerId, status: row.status, storage: 'sql' });
      return { success: true, id: existing.id };
    }
    this.db.run(
      'INSERT INTO jobs (id, runSlug, providerId, query, startedAt, completedAt, status, resultCount, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [row.id, row.runSlug, row.providerId, row.query, row.startedAt, row.completedAt,
       row.status, row.resultCount, row.error]
    );
    try {
      this.saveDB();
    } catch (err) {
      try {
        this.db.run('DELETE FROM jobs WHERE id = ?', [row.id]);
      } catch (revertErr) {
        logger.error('accountStore', 'in-memory job rollback after failed persistence incomplete', { error: revertErr.message });
      }
      throw err;
    }
    logger.info('job', 'job recorded', { jobId: row.id, providerId: row.providerId, status: row.status, storage: 'sql' });
    return { success: true, id: row.id };
  }

  _insertJobJson(row) {
    if (!this._jobs) this._jobs = [];
    const backup = this._jobs.map(j => ({ ...j }));
    const existing = this._jobs.find(j => j.providerId === row.providerId && j.runSlug === row.runSlug);
    let id;
    if (existing) {
      Object.assign(existing, {
        query: row.query, startedAt: row.startedAt, completedAt: row.completedAt,
        status: row.status, resultCount: row.resultCount, error: row.error
      });
      id = existing.id;
    } else {
      this._jobs.push(row);
      id = row.id;
    }
    try {
      writeJsonAtomic(path.join(DATA_DIR, 'jobs.json'), JSON.stringify(this._jobs, null, 2));
    } catch (err) {
      this._jobs = backup;
      logger.error('accountStore', 'failed to write jobs.json', { error: err.message });
      throw err;
    }
    logger.info('job', 'job recorded', { jobId: id, providerId: row.providerId, status: row.status, storage: 'json' });
    return { success: true, id };
  }

  _updateJobStateSql(providerId, runSlug, status, errorText) {
    const existing = this._findJobSql(providerId, runSlug);
    if (!existing) return { success: true, updated: false, reason: 'not-found' };
    // State-change gate: an unchanged canonical status never persists.
    if (existing.status === status) return { success: true, updated: false, reason: 'unchanged' };
    // completedAt is stamped once, on the first terminal transition only.
    const completedAt = existing.completedAt ? existing.completedAt : new Date().toISOString();
    const errorValue = status === 'failed' ? errorText : existing.error;
    this.db.run(
      'UPDATE jobs SET status = ?, completedAt = ?, error = ? WHERE providerId = ? AND runSlug = ?',
      [status, completedAt, errorValue, providerId, runSlug]
    );
    try {
      this.saveDB();
    } catch (err) {
      try {
        this.db.run(
          'UPDATE jobs SET status = ?, completedAt = ?, error = ? WHERE providerId = ? AND runSlug = ?',
          [existing.status, existing.completedAt, existing.error, providerId, runSlug]
        );
      } catch (revertErr) {
        logger.error('accountStore', 'in-memory job state restore after failed persistence incomplete', { error: revertErr.message });
      }
      throw err;
    }
    logger.info('job', 'job state updated', { runSlug, providerId, status, storage: 'sql' });
    return { success: true, updated: true };
  }

  _updateJobStateJson(providerId, runSlug, status, errorText) {
    if (!this._jobs) this._jobs = [];
    const existing = this._jobs.find(j => j.providerId === providerId && j.runSlug === runSlug);
    if (!existing) return { success: true, updated: false, reason: 'not-found' };
    // State-change gate: an unchanged canonical status never persists.
    if (existing.status === status) return { success: true, updated: false, reason: 'unchanged' };
    const backup = { ...existing };
    existing.completedAt = existing.completedAt ? existing.completedAt : new Date().toISOString();
    existing.status = status;
    if (status === 'failed') existing.error = errorText;
    try {
      writeJsonAtomic(path.join(DATA_DIR, 'jobs.json'), JSON.stringify(this._jobs, null, 2));
    } catch (err) {
      Object.assign(existing, backup);
      logger.error('accountStore', 'failed to write jobs.json', { error: err.message });
      throw err;
    }
    logger.info('job', 'job state updated', { runSlug, providerId, status, storage: 'json' });
    return { success: true, updated: true };
  }

  _setJobResultCountSql(providerId, runSlug, resultCount) {
    const existing = this._findJobSql(providerId, runSlug);
    if (!existing) return { success: true, updated: false, reason: 'not-found' };
    // Set-once: an already-finalised count is never overwritten, and an
    // unknown count stays NULL rather than being coerced to zero.
    if (existing.resultCount !== null && existing.resultCount !== undefined) {
      return { success: true, updated: false, reason: 'already-set' };
    }
    this.db.run(
      'UPDATE jobs SET resultCount = ? WHERE providerId = ? AND runSlug = ?',
      [resultCount, providerId, runSlug]
    );
    try {
      this.saveDB();
    } catch (err) {
      try {
        this.db.run(
          'UPDATE jobs SET resultCount = NULL WHERE providerId = ? AND runSlug = ?',
          [providerId, runSlug]
        );
      } catch (revertErr) {
        logger.error('accountStore', 'in-memory job count restore after failed persistence incomplete', { error: revertErr.message });
      }
      throw err;
    }
    logger.info('job', 'job result count recorded', { runSlug, providerId, resultCount, storage: 'sql' });
    return { success: true, updated: true };
  }

  _setJobResultCountJson(providerId, runSlug, resultCount) {
    if (!this._jobs) this._jobs = [];
    const existing = this._jobs.find(j => j.providerId === providerId && j.runSlug === runSlug);
    if (!existing) return { success: true, updated: false, reason: 'not-found' };
    if (existing.resultCount !== null && existing.resultCount !== undefined) {
      return { success: true, updated: false, reason: 'already-set' };
    }
    const previous = existing.resultCount === undefined ? null : existing.resultCount;
    existing.resultCount = resultCount;
    try {
      writeJsonAtomic(path.join(DATA_DIR, 'jobs.json'), JSON.stringify(this._jobs, null, 2));
    } catch (err) {
      existing.resultCount = previous;
      logger.error('accountStore', 'failed to write jobs.json', { error: err.message });
      throw err;
    }
    logger.info('job', 'job result count recorded', { runSlug, providerId, resultCount, storage: 'json' });
    return { success: true, updated: true };
  }

  _queryJobsSql(query) {
    let total = 0;
    const countStmt = this.db.prepare('SELECT COUNT(*) AS c FROM jobs');
    try {
      if (countStmt.step()) total = countStmt.getAsObject().c;
    } finally {
      countStmt.free();
    }
    const rowStmt = this.db.prepare('SELECT * FROM jobs ORDER BY startedAt DESC, rowid DESC LIMIT ? OFFSET ?');
    try {
      rowStmt.bind([query.limit, query.offset]);
      const rows = [];
      let columns = null;
      while (rowStmt.step()) {
        if (!columns) columns = rowStmt.getColumnNames();
        rows.push(jobRowToObject(columns, rowStmt.get()));
      }
      return { rows, total, limit: query.limit, offset: query.offset };
    } finally {
      rowStmt.free();
    }
  }

  _queryJobsJson(query) {
    // P1-G: the same projection the SQL branch applies, so a JSON-fallback
    // session reports the same job shape (including the safe counter defaults).
    const source = (this._jobs || []).map(row => projectJobRow(row));
    const indexed = source.map((row, i) => ({ row, i }));
    // Mirrors SQL: startedAt DESC (NULLs smallest, i.e. last), later insert
    // wins the tie-break exactly like rowid DESC.
    indexed.sort((a, b) => {
      const cmp = compareQueryValues(b.row.startedAt, a.row.startedAt);
      if (cmp !== 0) return cmp;
      return b.i - a.i;
    });
    const ordered = indexed.map(entry => entry.row);
    return {
      rows: ordered.slice(query.offset, query.offset + query.limit),
      total: source.length,
      limit: query.limit,
      offset: query.offset
    };
  }

  // === P1-E identity resolution: duplicate review (read-only) ===
  // The review surface. Read-only by construction: it reads the same columns
  // the library already stores, derives exact keys from them and returns a
  // classification. There is no INSERT/UPDATE/DELETE, no saveDB call and no
  // logger call anywhere below, and nothing here is reachable from a
  // collection, import or provider write path.

  // Every stored lead, newest first, projected to the shared review shape.
  // The SQL and JSON branches differ ONLY in how the rows are read; the
  // projection, the keys and the classification are the same code, which is
  // what makes the two storages agree by construction.
  _duplicateReviewSnapshot() {
    if (!this.db) {
      // Mirrors the SQL branch's newest-first order, so both storages walk
      // the library identically and pick the same "most recent" candidate.
      return (this._numbers || []).slice().reverse();
    }
    const scan = this.db.exec('SELECT * FROM numbers ORDER BY rowid DESC');
    if (!scan.length) return [];
    return scan[0].values.map(values => rowToObject(scan[0].columns, values));
  }

  // One review row per lead. A copy, never the stored object: the review must
  // not be able to alter what it read. companyKey is re-derived here (not read
  // from the row) so a JSON row that was written before a website changed is
  // classified by the same rule the SQL branch uses.
  _duplicateReviewProject(lead) {
    const row = lead && typeof lead === 'object' && !Array.isArray(lead) ? lead : {};
    const out = {};
    for (const field of DUPLICATE_REVIEW_LEAD_FIELDS) {
      const value = row[field];
      out[field] = typeof value === 'string' ? value : '';
    }
    out.companyKey = deriveCompanyKey(row);
    return out;
  }

  // Classify every lead against every other lead. Each lead appears in the
  // result exactly once: with its strongest matching candidate, or as UNIQUE
  // when no rule matches. Building the per-rule index once keeps this linear
  // in the number of leads and makes a missing value unmatchable by
  // construction (an empty key is never inserted into an index).
  _duplicateReviewClassify() {
    const leads = this._duplicateReviewSnapshot().map(lead => this._duplicateReviewProject(lead));
    const index = new Map();
    for (const rule of DUPLICATE_RULE_PRECEDENCE) index.set(rule, new Map());
    for (const lead of leads) {
      for (const rule of DUPLICATE_RULE_PRECEDENCE) {
        const key = duplicateReviewRuleKey(rule, lead);
        if (!key) continue;
        const bucket = index.get(rule);
        if (!bucket.has(key)) bucket.set(key, []);
        bucket.get(key).push(lead.id);
      }
    }
    return leads.map((lead) => {
      for (const rule of DUPLICATE_RULE_PRECEDENCE) {
        const key = duplicateReviewRuleKey(rule, lead);
        if (!key) continue;
        const group = index.get(rule).get(key) || [];
        if (group.length < 2) continue;
        // The snapshot is newest-first, so the first other member of the group
        // is the most recent match: a deterministic pick, never a judgement.
        const other = group.find(id => id !== lead.id);
        if (other === undefined) continue;
        const candidate = leads.find(entry => entry.id === other);
        if (!candidate) continue;
        return {
          lead,
          candidate,
          dupClass: DUPLICATE_RULE_CLASS[rule],
          dupReason: rule
        };
      }
      return { lead, candidate: null, dupClass: DUPLICATE_CLASS_UNIQUE, dupReason: '' };
    });
  }

  // Paginated duplicate review. Returns the {rows,total,limit,offset} envelope
  // every other list read uses. `rule` selects one deterministic rule, or 'all'
  // for every lead that has a candidate at all; UNIQUE leads are never listed,
  // because a lead with no candidate is not a review candidate. No value here
  // is persisted: dupClass and dupReason are derived on every call.
  async reviewDuplicates(query) {
    await this.ready;
    const q = (query && typeof query === 'object' && !Array.isArray(query)) ? query : {};
    const limit = Number.isInteger(q.limit) && q.limit >= 1 && q.limit <= DUPLICATE_REVIEW_MAX_LIMIT
      ? q.limit
      : DUPLICATE_REVIEW_DEFAULT_LIMIT;
    const offset = Number.isInteger(q.offset) && q.offset >= 0 && q.offset <= DUPLICATE_REVIEW_MAX_OFFSET
      ? q.offset
      : 0;
    // The main process rejects an unknown rule; this is the same defensive
    // allowlist the other store methods keep, never a free string.
    const rule = DUPLICATE_REVIEW_RULES.includes(q.rule) ? q.rule : 'all';
    const classified = this._duplicateReviewClassify();
    const matched = rule === 'all'
      ? classified.filter(entry => entry.dupClass !== DUPLICATE_CLASS_UNIQUE)
      : classified.filter(entry => entry.dupReason === rule);
    return {
      rows: matched.slice(offset, offset + limit),
      total: matched.length,
      limit,
      offset
    };
  }

  // The same classification for one lead, for a detail view. Returns the
  // UNIQUE entry when the lead has no candidate. Read-only like the list read.
  async reviewLeadDuplicates(id) {
    await this.ready;
    if (typeof id !== 'string' || !id || id.length > 100) return null;
    const entries = this._duplicateReviewClassify();
    return entries.find(entry => entry.lead.id === id) || null;
  }

  // === P1-F Target builder (user-owned definitions) ===
  // A Target never touches the lead library: none of the methods below read or
  // write a lead row, and no lead method reads a target. Creation order is the
  // read order on both storage branches, so the two agree.

  async listTargets() {
    await this.ready;
    if (!this.db) {
      const rows = (this._targets || []).map(row => normalizeTargetRow(row)).filter(Boolean);
      return { rows, total: rows.length };
    }
    const scan = this.db.exec('SELECT * FROM targets ORDER BY rowid ASC');
    const rows = scan.length
      ? scan[0].values.map(values => {
        const out = {};
        for (let i = 0; i < scan[0].columns.length; i++) out[scan[0].columns[i]] = values[i];
        return normalizeTargetRow(out);
      }).filter(Boolean)
      : [];
    return { rows, total: rows.length };
  }

  // Create when no id is supplied, update when it is. Returns the B4-style
  // {success, id, created} envelope; the row itself is read back by the caller
  // through listTargets, so a save never echoes a value it did not store.
  async saveTarget(payload) {
    await this.ready;
    const existing = this._findTargetForUpdate(payload);
    const validated = validateTargetRecord(payload, existing);
    if (!validated.ok) return { success: false, error: validated.error };
    const created = !existing;
    if (!this.db) return this._saveTargetJson(validated.value, created);
    return this._saveTargetSql(validated.value, created);
  }

  // Archive/activate. The status vocabulary is the approved two-value field;
  // nothing else about the target can change here, so an archive can never
  // rewrite the user's definition.
  async setTargetStatus(payload) {
    await this.ready;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { success: false, error: 'Invalid target update (object required)' };
    }
    if (typeof payload.id !== 'string' || !payload.id || payload.id.length > 100) {
      return { success: false, error: 'Invalid target update: id' };
    }
    if (!TARGET_STATUS_VALUES.includes(payload.status)) {
      return { success: false, error: 'Invalid target update: status' };
    }
    const existing = this._findTargetById(payload.id);
    if (!existing) return { success: true, updated: false, reason: 'not-found' };
    if (existing.status === payload.status) {
      return { success: true, updated: false, reason: 'unchanged' };
    }
    const next = { ...existing, status: payload.status, updatedAt: new Date().toISOString() };
    if (!this.db) return this._saveTargetJson(next, false, true);
    return this._saveTargetSql(next, false, true);
  }

  // Deterministic local exclusion evaluation for one target and one stored
  // lead. Read-only, no model and no external lookup: see
  // evaluateTargetExclusions for the exact rule.
  async evaluateTargetExclusionsForLead(targetId, lead) {
    await this.ready;
    const targets = await this.listTargets();
    const target = targets.rows.find(row => row.id === targetId);
    if (!target) return null;
    return evaluateTargetExclusions(target, lead);
  }

  _findTargetById(id) {
    if (!this.db) {
      return (this._targets || []).map(row => normalizeTargetRow(row)).find(row => row && row.id === id) || null;
    }
    const stmt = this.db.prepare('SELECT * FROM targets WHERE id = ?');
    try {
      stmt.bind([id]);
      if (!stmt.step()) return null;
      const columns = stmt.getColumnNames();
      const values = stmt.get();
      const out = {};
      for (let i = 0; i < columns.length; i++) out[columns[i]] = values[i];
      return normalizeTargetRow(out);
    } finally {
      stmt.free();
    }
  }

  // On an update the stored row is the source of truth for the id and
  // createdAt; a payload can never introduce a new target by naming an id it
  // does not own.
  _findTargetForUpdate(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    if (typeof payload.id !== 'string' || !payload.id || payload.id.length > 100) return null;
    return this._findTargetById(payload.id);
  }

  _saveTargetSql(row, created, statusOnly) {
    const previous = created ? null : this._findTargetById(row.id);
    if (created) {
      this.db.run(
        'INSERT INTO targets (id, name, industry, businessTypes, locations, requiredFields, optionalFields,'
        + ' exclusions, createdAt, updatedAt, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [row.id, row.name, row.industry,
          JSON.stringify(row.businessTypes), JSON.stringify(row.locations),
          JSON.stringify(row.requiredFields), JSON.stringify(row.optionalFields),
          JSON.stringify(row.exclusions),
          row.createdAt, row.updatedAt, row.status]
      );
    } else {
      this.db.run(
        'UPDATE targets SET name = ?, industry = ?, businessTypes = ?, locations = ?, requiredFields = ?,'
        + ' optionalFields = ?, exclusions = ?, createdAt = ?, updatedAt = ?, status = ? WHERE id = ?',
        [row.name, row.industry,
          JSON.stringify(row.businessTypes), JSON.stringify(row.locations),
          JSON.stringify(row.requiredFields), JSON.stringify(row.optionalFields),
          JSON.stringify(row.exclusions),
          row.createdAt, row.updatedAt, row.status, row.id]
      );
    }
    try {
      this.saveDB();
    } catch (err) {
      // Revert: a create is undone by removing the row it just wrote, an update
      // or a status change by restoring the previous values.
      try {
        if (created) {
          this.db.run('DELETE FROM targets WHERE id = ?', [row.id]);
        } else if (previous) {
          this.db.run(
            'UPDATE targets SET name = ?, industry = ?, businessTypes = ?, locations = ?, requiredFields = ?,'
            + ' optionalFields = ?, exclusions = ?, createdAt = ?, updatedAt = ?, status = ? WHERE id = ?',
            [previous.name, previous.industry,
              JSON.stringify(previous.businessTypes), JSON.stringify(previous.locations),
                JSON.stringify(previous.requiredFields), JSON.stringify(previous.optionalFields),
                JSON.stringify(previous.exclusions),
                previous.createdAt, previous.updatedAt, previous.status, row.id]
          );
        }
      } catch (revertErr) {
        logger.error('accountStore', 'target restore after failed persistence incomplete', { error: revertErr.message });
      }
      throw err;
    }
    // Identifiers, counts and the status word only: never the definition text.
    logger.info('targets', statusOnly ? 'target status updated' : (created ? 'target created' : 'target updated'), {
      targetId: row.id, status: row.status, storage: 'sql'
    });
    return { success: true, id: row.id, created: !!created, updated: !created };
  }

  _saveTargetJson(row, created, statusOnly) {
    const rows = this._targets || (this._targets = []);
    const index = rows.findIndex(entry => entry && entry.id === row.id);
    const backup = index === -1 ? null : { ...rows[index] };
    if (index === -1) rows.push(JSON.parse(JSON.stringify(row)));
    else rows[index] = JSON.parse(JSON.stringify(row));
    try {
      writeJsonAtomic(path.join(DATA_DIR, 'targets.json'), JSON.stringify(rows, null, 2));
    } catch (err) {
      if (index === -1) rows.pop();
      else rows[index] = backup;
      logger.error('accountStore', 'failed to write targets.json', { error: err.message });
      throw err;
    }
    logger.info('targets', statusOnly ? 'target status updated' : (created ? 'target created' : 'target updated'), {
      targetId: row.id, status: row.status, storage: 'json'
    });
    return { success: true, id: row.id, created: !!created, updated: !created };
  }

  // === P1-G Collection Quality Report ===
  // One writer for the save counters, and one read-only report. Nothing here can
  // reach a lead row: the counters live on the job, and the report only reads.

  // The local collection save. The three counters are the ones the save really
  // produced: how many selected records were submitted, and the `added` /
  // `duplicates` addNumbers returned. They are CUMULATIVE for the run, so a run
  // saved in several batches reports the run's totals rather than only the last
  // batch. A run with no stored job is reported as not recorded rather than
  // inventing a job row.
  //
  // The job is identified by the existing (providerId, runSlug) identity, which
  // is exactly the UNIQUE key of the jobs table: one provider's run can never
  // be credited to another provider's row that happens to share a runSlug.
  async recordJobSaveMetrics(payload) {
    await this.ready;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { success: false, error: 'Invalid save metrics (object required)' };
    }
    if (typeof payload.providerId !== 'string' || !payload.providerId
        || payload.providerId.length > MAX_JOB_PROVIDER_ID_LENGTH) {
      return { success: false, error: 'Invalid save metrics: providerId' };
    }
    if (typeof payload.runSlug !== 'string' || !JOB_RUN_SLUG_PATTERN.test(payload.runSlug)) {
      return { success: false, error: 'Invalid save metrics: runSlug' };
    }
    const batch = {};
    for (const field of JOB_SAVE_COUNTER_FIELDS) {
      const value = requireJobCounter(payload[field]);
      if (value === null) return { success: false, error: 'Invalid save metrics: ' + field };
      batch[field] = value;
    }
    // A target association is optional and must be a definition this store
    // knows: an unknown id is refused rather than stored.
    let targetId = null;
    if (payload[JOB_TARGET_FIELD] !== undefined && payload[JOB_TARGET_FIELD] !== null
        && payload[JOB_TARGET_FIELD] !== '') {
      if (typeof payload[JOB_TARGET_FIELD] !== 'string' || payload[JOB_TARGET_FIELD].length > 100) {
        return { success: false, error: 'Invalid save metrics: ' + JOB_TARGET_FIELD };
      }
      const targets = await this.listTargets();
      if (!targets.rows.some(row => row.id === payload[JOB_TARGET_FIELD])) {
        return { success: false, error: 'Invalid save metrics: unknown ' + JOB_TARGET_FIELD };
      }
      targetId = payload[JOB_TARGET_FIELD];
    }
    const existing = this._findJobForRun(payload.providerId, payload.runSlug);
    if (!existing) return { success: true, updated: false, reason: 'no-job' };
    // Cumulative: this batch's real counts are added to what the run already
    // recorded. Nothing is reset, and nothing is invented.
    const counters = {};
    for (const field of JOB_SAVE_COUNTER_FIELDS) {
      const total = jobCounterValue(existing, field) + batch[field];
      if (total > MAX_JOB_SAVE_COUNT) {
        return { success: false, error: 'Invalid save metrics: ' + field + ' (out of range)' };
      }
      counters[field] = total;
    }
    const currentTarget = existing[JOB_TARGET_FIELD] || null;
    const nextTarget = targetId === null ? currentTarget : targetId;
    const unchanged = JOB_SAVE_COUNTER_FIELDS.every(field => jobCounterValue(existing, field) === counters[field])
      && currentTarget === nextTarget;
    if (unchanged) return { success: true, updated: false, reason: 'unchanged' };
    return this._writeJobSaveMetrics(existing, counters, nextTarget);
  }

  _writeJobSaveMetrics(existing, counters, targetId) {
    const assignments = [...JOB_SAVE_COUNTER_FIELDS.map(field => `${field} = ?`), `${JOB_TARGET_FIELD} = ?`];
    const params = [...JOB_SAVE_COUNTER_FIELDS.map(field => counters[field]), targetId];
    if (!this.db) {
      const row = (this._jobs || []).find(job => job && job.id === existing.id);
      if (!row) return { success: true, updated: false, reason: 'not-found' };
      const backup = { ...row };
      for (const field of JOB_SAVE_COUNTER_FIELDS) row[field] = counters[field];
      row[JOB_TARGET_FIELD] = targetId;
      try {
        writeJsonAtomic(path.join(DATA_DIR, 'jobs.json'), JSON.stringify(this._jobs, null, 2));
      } catch (err) {
        Object.assign(row, backup);
        logger.error('accountStore', 'failed to write jobs.json', { error: err.message });
        throw err;
      }
    } else {
      // The RAW prior row, captured BEFORE the write: a revert has to restore
      // what was stored, not re-read the already-written value (a legacy NULL
      // counter stays NULL rather than being rewritten as a zero).
      const prior = this._findJobRawForRun(existing.providerId, existing.runSlug);
      this.db.run(
        `UPDATE jobs SET ${assignments.join(', ')} WHERE id = ?`,
        [...params, existing.id]
      );
      try {
        this.saveDB();
      } catch (err) {
        try {
          this.db.run(
            `UPDATE jobs SET ${assignments.join(', ')} WHERE id = ?`,
            [...JOB_SAVE_COUNTER_FIELDS.map(field => (prior && prior[field] !== undefined ? prior[field] : null)),
              prior && prior[JOB_TARGET_FIELD] ? prior[JOB_TARGET_FIELD] : null,
              existing.id]
          );
        } catch (revertErr) {
          logger.error('accountStore', 'save metrics restore after failed persistence incomplete', { error: revertErr.message });
        }
        throw err;
      }
    }
    // Counts and identifiers only: never lead content and never a target name.
    logger.info('collector', 'job save metrics recorded', {
      jobId: existing.id, runSlug: existing.runSlug, storage: this.db ? 'sql' : 'json'
    });
    return { success: true, updated: true };
  }

  // The job identified by the existing (providerId, runSlug) identity - the
  // same pair the jobs table is UNIQUE on, resolved through the same lookup the
  // ledger writes already use, so both storage branches agree. A provider id
  // that does not resolve to a stored job yields nothing at all: one provider's
  // run can never be credited to another provider's row.
  _findJobForRun(providerId, runSlug) {
    if (typeof providerId !== 'string' || !providerId) return null;
    if (!this.db) {
      return (this._jobs || []).find(job => job
        && job.providerId === providerId
        && job.runSlug === runSlug) || null;
    }
    return this._findJobSql(providerId, runSlug) || null;
  }

  // The RAW stored row for the same identity, read only on the failure path so
  // a revert restores the exact prior bytes (a legacy NULL counter stays NULL
  // rather than becoming a zero).
  _findJobRawForRun(providerId, runSlug) {
    if (!this.db) {
      return (this._jobs || []).find(job => job
        && job.providerId === providerId
        && job.runSlug === runSlug) || null;
    }
    const stmt = this.db.prepare('SELECT * FROM jobs WHERE providerId = ? AND runSlug = ?');
    try {
      stmt.bind([providerId, runSlug]);
      if (!stmt.step()) return null;
      const columns = stmt.getColumnNames();
      const values = stmt.get();
      const out = {};
      for (let i = 0; i < columns.length; i++) out[columns[i]] = values[i];
      return out;
    } finally {
      stmt.free();
    }
  }

  // The leads that belong to one run, newest first, from persisted data only.
  _runLeads(runSlug) {
    if (!this.db) {
      return (this._numbers || []).filter(row => row && row.runSlug === runSlug).slice().reverse();
    }
    const scan = this.db.exec('SELECT * FROM numbers WHERE runSlug = ? ORDER BY rowid DESC', [runSlug]);
    if (!scan.length) return [];
    return scan[0].values.map(values => rowToObject(scan[0].columns, values));
  }

  // One report row for one run. Read-only: a SELECT, a deterministic
  // derivation from what is already stored, and no write of any kind.
  //
  // Every number here has exactly one source:
  //   recordsCollected  jobs.resultCount          (existing B4 counter)
  //   submittedCount    the selected count the save actually submitted
  //   addedCount        addNumbers().added
  //   duplicateCount    addNumbers().duplicates
  //   duplicateRate     the two above, or zero when nothing was saved
  //   leadsWith         the run's persisted lead rows
  //   invalidRecords    the existing local P1-B syntax rules (no verification)
  //   companyGrouping   the existing P1-D companyKey derivation
  //   targetRequired    the attached P1-F target's requiredFields, or null
  //
  // Run-scoped and provider-scoped: both the report and the counters are looked
  // up by the (providerId, runSlug) identity, so a shared runSlug across
  // providers can never cross-attribute.
  async collectionQualityReport(query) {
    await this.ready;
    const q = (query && typeof query === 'object' && !Array.isArray(query)) ? query : {};
    const limit = Number.isInteger(q.limit) && q.limit >= 1 && q.limit <= QUALITY_REPORT_MAX_LIMIT
      ? q.limit
      : QUALITY_REPORT_DEFAULT_LIMIT;
    const offset = Number.isInteger(q.offset) && q.offset >= 0 && q.offset <= QUALITY_REPORT_MAX_OFFSET
      ? q.offset
      : 0;
    const runSlug = typeof q.runSlug === 'string' ? q.runSlug : '';
    if (!JOB_RUN_SLUG_PATTERN.test(runSlug)) {
      return { rows: [], total: 0, limit, offset };
    }
    const providerId = typeof q.providerId === 'string' ? q.providerId : '';
    const job = this._findJobForRun(providerId, runSlug);
    if (!job) return { rows: [], total: 0, limit, offset };
    const report = this._buildQualityReport(job, runSlug);
    // One run yields exactly one report, paged with the shared envelope.
    return {
      rows: offset === 0 ? [report] : [],
      total: 1,
      limit,
      offset
    };
  }

  _buildQualityReport(job, runSlug) {
    const leads = this._runLeads(runSlug);
    const resultCount = Number.isInteger(job.resultCount) ? job.resultCount : 0;
    const added = Number.isInteger(job.addedCount) ? job.addedCount : JOB_DEFAULT_SAVE_COUNT;
    const duplicates = Number.isInteger(job.duplicateCount) ? job.duplicateCount : JOB_DEFAULT_SAVE_COUNT;
    const submitted = Number.isInteger(job.submittedCount) ? job.submittedCount : JOB_DEFAULT_SAVE_COUNT;

    // Completeness, counted from the stored values only.
    const leadsWith = {};
    for (const field of QUALITY_REPORT_FIELDS) {
      leadsWith[field] = leads.filter(lead => qualityTrimmed(lead[field])).length;
    }
    // Invalid = the existing deterministic local syntax rules reject the value.
    // 'unknown' (no data) is not invalid, and nothing here claims that any
    // value was verified by a third party.
    const invalidRecords = leads.filter(lead =>
      leadPhoneQuality(lead.phone) === LEAD_QUALITY_INVALID
      || leadEmailQuality(lead.email) === LEAD_QUALITY_INVALID
      || leadWebsiteQuality(lead.website) === LEAD_QUALITY_INVALID
    ).length;

    // Company grouping, from the existing P1-D derivation: how many distinct
    // deterministic keys the run's leads fall into, and how many leads carry
    // none. No company record exists and none is created here.
    const keys = new Set();
    let ungrouped = 0;
    for (const lead of leads) {
      const key = deriveCompanyKey(lead);
      if (key) keys.add(key);
      else ungrouped++;
    }

    return {
      runSlug,
      jobId: typeof job.id === 'string' ? job.id : '',
      providerId: typeof job.providerId === 'string' ? job.providerId : '',
      // Existing B4 counter: what the provider run returned.
      recordsCollected: resultCount,
      // Real save counters.
      submittedCount: submitted,
      addedCount: added,
      duplicateCount: duplicates,
      duplicateRate: jobDuplicateRate(added, duplicates),
      // Derived from the run's stored leads.
      leadsSaved: leads.length,
      leadsWith,
      invalidRecords,
      companyGrouping: { groups: keys.size, leads: leads.length, ungrouped }
    };
  }

  // The target requirements for one run. Read-only, and honest about absence:
  // a run with no attached target reports null instead of an invented metric.
  async collectionQualityTargetReport(query) {
    await this.ready;
    const q = (query && typeof query === 'object' && !Array.isArray(query)) ? query : {};
    const runSlug = typeof q.runSlug === 'string' ? q.runSlug : '';
    if (!JOB_RUN_SLUG_PATTERN.test(runSlug)) return null;
    const providerId = typeof q.providerId === 'string' ? q.providerId : '';
    const job = this._findJobForRun(providerId, runSlug);
    if (!job) return null;
    const targetId = job[JOB_TARGET_FIELD];
    if (typeof targetId !== 'string' || !targetId) return null;
    const targets = await this.listTargets();
    const target = targets.rows.find(row => row.id === targetId);
    // A target that no longer exists is reported as unknown, not as a pass.
    if (!target) return { targetId, targetName: '', requiredFields: null, available: false };
    const leads = this._runLeads(runSlug);
    const required = Array.isArray(target.requiredFields) ? target.requiredFields : [];
    const requiredFields = required.map(field => ({
      field,
      present: leads.filter(lead => qualityTrimmed(lead[field])).length,
      missing: leads.filter(lead => !qualityTrimmed(lead[field])).length
    }));
    return {
      targetId,
      targetName: target.name,
      requiredFields,
      available: true
    };
  }

}

module.exports = { AccountStore, migrateSchema, migrateJobSchema, normalizeLeadRow, evaluateTargetExclusions };
