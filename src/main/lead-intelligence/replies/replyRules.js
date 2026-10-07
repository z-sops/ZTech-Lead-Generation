'use strict';

/**
 * F29 - the Reply Router's deterministic rules (D2). PURE: no I/O, no logging, no network.
 *
 * D1 settled on the fallback (live Step 1 probe, 8 Oct 2026): Gmail returns no snippet under the
 * gmail.metadata scope, so a category is decided from the SUBJECT and the HEADERS only. ZTech
 * cannot see anything written in the reply body - a stop request written only in the body is
 * NOT detected here, and nothing here claims otherwise.
 *
 * The result holds closed codes only ({ category, ruleId, input, confidence }): never any text.
 *
 * Priority (the first match wins): unsubscribe > out_of_office > not_interested >
 * meeting_request > pricing_request > later > interested > unknown.
 *
 * Our own words never count: the first email's subject is removed from the reply's subject
 * before matching, and a subject that is only "Re: <our subject>" is `unknown` (subject_echo) -
 * the normal case for a reply.
 */

const PREFIX_RE = /^\s*(?:(?:re|fw|fwd|aw|wg|sv|vs|antw|rv|tr|ref)\s*(?:\[\d+\])?\s*[:：]\s*|\[(?:ext|external)\]\s*)/i;
const MAX_SUBJECT = 500;

/** Lower-case, strip reply/forward prefixes, keep letters, digits and apostrophes, collapse spaces. */
function normalizeSubject(subject) {
  let s = typeof subject === 'string' ? subject.slice(0, MAX_SUBJECT) : '';
  for (let i = 0; i < 10 && PREFIX_RE.test(s); i += 1) s = s.replace(PREFIX_RE, '');
  return s.toLowerCase().replace(/[’`]/g, "'").replace(/[^a-z0-9'\s]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// A negation within the three words before a phrase cancels that phrase ("no need to call").
const NEGATION_BEFORE = /\b(?:no|not|don't|dont|do not|never|without|nahi|nahin|na|mat)\s+(?:\S+\s+){0,2}$/;

const phrases = (list) => list.map((p) => new RegExp(`(?:^|\\s)${p}(?=\\s|$)`, 'g'));

/** Rules in priority order. `negatable` phrases are skipped when a negation precedes them. */
const RULES = Object.freeze([
  {
    category: 'unsubscribe', ruleId: 'subject_opt_out', confidence: 'high', negatable: false,
    re: phrases([
      'unsubscribe', 'remove me', 'opt ?out', 'stop emailing', 'stop sending', 'stop contacting',
      "don't (?:email|contact|message) me", 'do not (?:email|contact|message)', 'dont (?:email|contact|message)',
      'no more emails?', 'take me off', 'email na (?:karein|karen|kren|karo|bhejein|bhejen)', 'email mat (?:karein|karen|karo|bhejo|bhejein)',
      'mujhe email na', 'rabta na (?:karein|karen)',
    ]),
  },
  {
    category: 'out_of_office', ruleId: 'subject_out_of_office', confidence: 'high', negatable: false,
    re: phrases(['out of (?:the )?office', 'automatic reply', 'auto ?reply', 'auto ?response', 'autoreply', 'ooo', 'away from (?:the )?office', 'on (?:annual )?leave', 'on vacation', 'on holiday']),
  },
  {
    category: 'not_interested', ruleId: 'subject_not_interested', confidence: 'high', negatable: false,
    re: phrases([
      'not interested', 'no longer interested', 'not really interested', 'no thanks?', 'no thank you', "we're all set", 'we are all set', 'all set',
      'already have', 'no need', 'not needed', "don't need", 'dont need', 'do not need', 'not required', 'not for us',
      'zaroorat nahi', 'zarurat nahi', 'zaroorat nahin', 'zarurat nahin', 'dilchaspi nahi', 'dilchaspi nahin', 'nahi chahiye', 'nahin chahiye',
    ]),
  },
  {
    category: 'meeting_request', ruleId: 'subject_meeting', confidence: 'high', negatable: true,
    re: phrases([
      'call', 'a call', 'quick call', 'meeting', 'meet', 'schedule', 'calendar', 'book a time', 'available on', 'availability',
      'zoom', 'google meet', 'teams', 'demo', 'baat karte', 'baat karein', 'baat karen', 'mulaqat', 'mil (?:lete|sakte)',
    ]),
  },
  {
    category: 'pricing_request', ruleId: 'subject_pricing', confidence: 'high', negatable: true,
    re: phrases([
      'price', 'prices', 'pricing', 'cost', 'costs', 'quote', 'quotation', 'how much', 'rates?', 'rate card', 'charges', 'fees?', 'budget',
      'kitne ka', 'kitne ki', 'kitna', 'qeemat', 'keemat', 'qimat',
    ]),
  },
  {
    category: 'later', ruleId: 'subject_later', confidence: 'low', negatable: false,
    re: phrases([
      'next (?:week|month|quarter|year)', 'later', 'not now', 'not right now', 'maybe later', 'in a few (?:weeks|months)', 'after (?:eid|ramadan|the holidays)',
      'follow up (?:in|after|next)', 'baad (?:mein|me|main)', 'abhi nahi', 'abhi nahin',
    ]),
  },
  {
    category: 'interested', ruleId: 'subject_interested', confidence: 'high', negatable: true,
    re: phrases(['interested', 'very interested']),
  },
  {
    category: 'interested', ruleId: 'subject_positive', confidence: 'low', negatable: true,
    re: phrases(['sounds good', 'tell me more', 'send (?:me )?(?:the )?details', 'more (?:info|information|details)', 'yes please', "let's talk", 'lets talk', 'zaroor', 'haan ji', 'ji haan']),
  },
]);

function matches(rule, s) {
  for (const re of rule.re) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s)) !== null) {
      if (!rule.negatable || !NEGATION_BEFORE.test(s.slice(0, m.index + (m[0].startsWith(' ') ? 1 : 0)))) return true;
      if (m[0].length === 0) re.lastIndex += 1;
    }
  }
  return false;
}

/**
 * @param {{kind: 'reply'|'unsubscribe'|'away', subject?: string, firstSubject?: string|null}} input
 *   `subject` is the reply's Subject header, `firstSubject` the subject of the email it answered.
 *   Both are read in memory and dropped; neither is returned.
 * @returns {{category: string, ruleId: string, input: 'subject'|'headers', confidence: 'high'|'low'}}
 */
function classifyReply({ kind, subject, firstSubject } = {}) {
  // D4: an automatic reply (Auto-Submitted / X-Autoreply / X-Autorespond / Precedence auto_reply).
  if (kind === 'away') return { category: 'out_of_office', ruleId: 'header_auto_reply', input: 'headers', confidence: 'high' };
  // The trust intake already recorded it as an unsubscribe (its subject said so).
  if (kind === 'unsubscribe') return { category: 'unsubscribe', ruleId: 'subject_unsubscribe', input: 'subject', confidence: 'high' };
  let s = normalizeSubject(subject);
  const ours = normalizeSubject(firstSubject);
  if (!s) return { category: 'unknown', ruleId: 'no_subject', input: 'subject', confidence: 'low' };
  if (ours && s === ours) return { category: 'unknown', ruleId: 'subject_echo', input: 'subject', confidence: 'low' };
  // Our own words never count: drop the first email's subject wherever it appears.
  if (ours && ours.length >= 3) s = s.split(ours).join(' ').replace(/\s+/g, ' ').trim();
  if (!s) return { category: 'unknown', ruleId: 'subject_echo', input: 'subject', confidence: 'low' };
  for (const rule of RULES) {
    if (matches(rule, s)) return { category: rule.category, ruleId: rule.ruleId, input: 'subject', confidence: rule.confidence };
  }
  return { category: 'unknown', ruleId: 'no_signal', input: 'subject', confidence: 'low' };
}

module.exports = { classifyReply, normalizeSubject, RULE_IDS: Object.freeze([...new Set(RULES.map((r) => r.ruleId)), 'header_auto_reply', 'subject_unsubscribe', 'no_subject', 'subject_echo', 'no_signal']) };
