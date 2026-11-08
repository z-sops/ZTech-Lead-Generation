'use strict';

/**
 * A small, dependency-free HTML reader for the website checks.
 *
 * It is NOT a full HTML parser and does not pretend to be: it finds start
 * tags and their attributes, the document title and the visible text, which
 * is all the checks need. Every check that uses it is written so that a page
 * the reader cannot understand produces NO finding (an unknown is never
 * reported as a problem): see checks.js.
 */

const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©' };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    const v = ENTITY[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

const ATTR = /([^\s=/"'<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+)))?/g;

function parseAttributes(raw) {
  const attrs = {};
  if (!raw) return attrs;
  for (const m of raw.matchAll(ATTR)) {
    const name = m[1].toLowerCase();
    if (Object.prototype.hasOwnProperty.call(attrs, name)) continue;
    const value = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : '';
    attrs[name] = decodeEntities(value);
  }
  return attrs;
}

/**
 * @param {string} html
 * @returns {{
 *   tags: Array<{name: string, attrs: object, index: number}>,
 *   title: string|null,
 *   text: string,
 *   scripts: Array<{attrs: object, body: string}>,
 *   h1: string[],
 *   links: Array<{href: string, text: string}>,
 *   looksLikeHtml: boolean,
 * }}
 */
function readHtml(html) {
  const source = String(html || '');
  const noComments = source.replace(/<!--[\s\S]*?-->/g, ' ');

  // Script and style bodies are set aside: their contents are not page text,
  // and a "<" inside a script must not be read as a tag.
  const scripts = [];
  const withoutRaw = noComments.replace(/<(script|style|noscript|template)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi, (m, name, attrs, body) => {
    if (name.toLowerCase() === 'script') scripts.push({ attrs: parseAttributes(attrs), body });
    return `<${name}${attrs}></${name}>`;
  });

  const tags = [];
  const tagRe = /<([a-zA-Z][a-zA-Z0-9:-]*)((?:\s+[^<>]*?)?)\s*\/?>/g;
  for (const m of withoutRaw.matchAll(tagRe)) {
    tags.push({ name: m[1].toLowerCase(), attrs: parseAttributes(m[2]), index: m.index });
  }

  const titleMatch = withoutRaw.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim() : null;

  const h1 = [];
  for (const m of withoutRaw.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/gi)) {
    h1.push(decodeEntities(m[1].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim());
  }

  const links = [];
  for (const m of withoutRaw.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const attrs = parseAttributes(m[1]);
    if (typeof attrs.href !== 'string') continue;
    links.push({
      href: attrs.href.trim(),
      text: decodeEntities(m[2].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 200),
    });
  }

  const bodyMatch = withoutRaw.match(/<body\b[^>]*>([\s\S]*)$/i);
  const text = decodeEntities((bodyMatch ? bodyMatch[1] : withoutRaw).replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

  const looksLikeHtml = /<html[\s>]/i.test(source) || /<body[\s>]/i.test(source) || /<head[\s>]/i.test(source);

  return { tags, title, text, scripts, h1, links, looksLikeHtml };
}

/** The value of <meta name|property="key" content="..."> (first match), or null. */
function metaContent(doc, key) {
  const k = key.toLowerCase();
  for (const t of doc.tags) {
    if (t.name !== 'meta') continue;
    const n = (t.attrs.name || t.attrs.property || t.attrs['http-equiv'] || '').toLowerCase();
    if (n === k) return typeof t.attrs.content === 'string' ? t.attrs.content.trim() : '';
  }
  return null;
}

module.exports = { readHtml, metaContent, decodeEntities, parseAttributes };
