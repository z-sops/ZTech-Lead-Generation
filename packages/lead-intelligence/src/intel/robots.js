'use strict';

/**
 * robots.txt, as RFC 9309 describes it: the group for our product token if
 * there is one, otherwise the "*" group; the longest matching rule wins and,
 * on a tie, Allow wins; "*" and "$" are supported in paths.
 *
 * A site that says "do not fetch this" is not inspected. That decision is
 * recorded as evidence of WHY nothing was inspected, never as a finding
 * against the business.
 */

const PRODUCT_TOKEN = 'ztechresearchbot';

function parseRobots(text) {
  const groups = [];
  const sitemaps = [];
  let current = null;
  let lastWasAgent = false;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (key === 'sitemap') {
      if (value) sitemaps.push(value);
      continue;
    }
    if (!current) continue;
    if (key === 'allow' || key === 'disallow') {
      current.rules.push({ allow: key === 'allow', path: value });
    }
  }
  return { groups, sitemaps };
}

function ruleMatches(rulePath, path) {
  if (rulePath === '') return false; // "Disallow:" with nothing means allow all
  const anchored = rulePath.endsWith('$');
  const body = anchored ? rulePath.slice(0, -1) : rulePath;
  const pattern = body.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${pattern}${anchored ? '$' : ''}`).test(path);
}

/**
 * @param {{groups: Array}} robots parsed robots.txt
 * @param {string} path the URL path (with query) to fetch
 * @returns {{allowed: boolean, rule: string|null, group: string|null}}
 */
function isAllowed(robots, path, token = PRODUCT_TOKEN) {
  const groups = robots && robots.groups ? robots.groups : [];
  let group = groups.find((g) => g.agents.some((a) => a !== '*' && token.includes(a)));
  let groupName = group ? token : null;
  if (!group) {
    group = groups.find((g) => g.agents.includes('*'));
    groupName = group ? '*' : null;
  }
  if (!group) return { allowed: true, rule: null, group: null };
  let best = null;
  for (const rule of group.rules) {
    if (!ruleMatches(rule.path, path)) continue;
    if (!best || rule.path.length > best.path.length || (rule.path.length === best.path.length && rule.allow && !best.allow)) {
      best = rule;
    }
  }
  if (!best) return { allowed: true, rule: null, group: groupName };
  return { allowed: best.allow, rule: `${best.allow ? 'Allow' : 'Disallow'}: ${best.path}`, group: groupName };
}

module.exports = { parseRobots, isAllowed, PRODUCT_TOKEN };
