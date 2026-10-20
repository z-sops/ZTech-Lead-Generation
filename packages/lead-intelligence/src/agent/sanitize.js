'use strict';

/**
 * Untrusted-text handling for website-derived content (titles, excerpts, anchors...).
 *
 * Website text is DATA. It may contain instructions aimed at an AI ("ignore previous
 * instructions", fake "system:" turns, hidden prompt tags). This module:
 *   1. normalises and truncates the text,
 *   2. removes control / zero-width / bidi characters,
 *   3. flags instruction-like content so callers can WITHHOLD it entirely.
 * Flagged text is never placed in a prompt, a statement or a pitch.
 */

const INJECTION_PATTERNS = [
  /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|your)\b[^.\n]{0,20}\b(instructions?|prompts?|rules?|directions?)/i,
  /\byou\s+are\s+(now|no\s+longer)\b/i,
  /\b(act|behave|respond)\s+as\s+(an?\s+)?(assistant|ai|system|developer|admin|root)/i,
  /\b(system|developer|assistant)\s*(prompt|message|instructions?)\b/i,
  /(^|\n|\s)(system|assistant|developer|user)\s*:/i,
  /<\/?\s*(system|instructions?|prompt|assistant|tool|im_start|im_end)\b[^>]*>/i,
  /\[\/?(INST|SYS)\]/,
  /\b(reveal|print|show|output|leak|exfiltrate)\b[^.\n]{0,40}\b(prompt|instructions|api[\s_-]?key|secret|password|token|credentials?)\b/i,
  /\b(do\s+not|don't)\s+(follow|obey)\b/i,
  /\bnew\s+instructions?\b/i,
  /\bBEGIN\s+(PROMPT|INSTRUCTIONS|SYSTEM)\b/i,
  /```/,
  /\bcall\s+(the\s+)?(tool|function)\b/i,
  /\bsend\s+(an?\s+)?(email|message)\s+to\b/i,
];

const INVISIBLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁠-⁤﻿]/g;

/**
 * @returns {{text: string, flagged: boolean, patterns: number[]}}
 */
function sanitizeUntrusted(input, maxLength = 500) {
  if (input === null || input === undefined) return { text: '', flagged: false, patterns: [] };
  let s = String(input).normalize('NFKC').replace(INVISIBLE, ' ').replace(/[\r\t]/g, ' ').replace(/\s{2,}/g, ' ').trim();
  const patterns = [];
  INJECTION_PATTERNS.forEach((re, i) => { if (re.test(s)) patterns.push(i); });
  if (s.length > maxLength) s = `${s.slice(0, maxLength - 1)}…`;
  return { text: s, flagged: patterns.length > 0, patterns };
}

const WITHHELD = '[withheld: website text contained instruction-like content]';

module.exports = { sanitizeUntrusted, INJECTION_PATTERNS, WITHHELD };
