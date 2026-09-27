'use strict';

// ZTech-authored. Batch 1 deliverable: the real Lead Library field map, derived from
// Step 0 inspection of ZTech's own `numbers` table (src/main/accountStore.js:1161).
//
// The module's DEFAULT_LEAD_FIELD_MAP in contracts/leadView.js lists generic
// candidates. These are the real column names. Leads are read as flat rows via
// `SELECT *`, and the module's getPath() (core/objects.js) bails on any non-object
// segment, so dotted paths only work for genuinely nested values - ZTech has none.
//
// Fields with no column are mapped to an empty array on purpose. That makes pick()
// return undefined, toLeadView() produce null, and every downstream rule treat them
// as UNKNOWN rather than guessing. Do not add columns to fit this map.

const LEAD_FIELD_MAP = Object.freeze({
  id: ['id'],
  name: ['title'], // there is no `name` column; `title` is the company/site name
  phone: ['phone'],
  email: ['email'],
  website: ['website'],
  address: ['address'],
  city: [], // UNKNOWN: no column
  country: [], // UNKNOWN: no column
  industry: [], // UNKNOWN: no column
  business_type: [], // UNKNOWN: no column
  // Flat TEXT column ('unqualified' | 'qualified'). The module default
  // 'qualification.status' cannot work here: getPath() requires an object segment.
  qualification_status: ['qualification'],
  data_quality: [] // UNKNOWN: derived at render time only, never stored
});

module.exports = { LEAD_FIELD_MAP };
