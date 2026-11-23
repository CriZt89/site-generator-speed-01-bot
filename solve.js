// site-generator-speed-01: my own drop-in for makefun-site 1.0.0 (optimized version).
// Written from the vendor README + vendor code as the spec; structure, function
// layout and hot paths are my own. run(input) answers one case, no state kept
// between calls, no clock/env/random/file reads.
//
// Speed notes: inline Markdown renders plain runs in one escaped slice instead
// of one push per character; word counting and ordered-list matching are manual
// char scans (no regex, no per-word array); slugify skips NFKD for pure ASCII;
// blocks are joined, not mapped; every memo lives inside one run() call.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const RESERVED = ['posts', 'tags', 'page'];
const KNOWN_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const INCLUDE_MAX = 8;

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** HTML-escape: fast path returns the input untouched when nothing needs it. */
function esc(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep === null) continue;
    out += s.slice(start, i) + rep;
    start = i + 1;
  }
  return start === 0 ? s : out + s.slice(start);
}

/** JavaScript \s whitespace, by code unit (covers the \u00a0-class spaces too). */
function isWS(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 160
    || c === 5760 || (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239
    || c === 8287 || c === 12288 || c === 65279;
}

function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** Slug factory: per-run memo so repeated titles/tags/headings cost one pass. */
function makeSlug() {
  const cache = new Map();
  return function slug(text) {
    const hit = cache.get(text);
    if (hit !== undefined) return hit;
    let ascii = true;
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) > 127) {
        ascii = false;
        break;
      }
    }
    const plain = ascii ? text : text.normalize('NFKD').replace(/\p{M}/gu, '');
    let out = '';
    let gap = false;
    for (let i = 0; i < plain.length; i++) {
      const code = plain.charCodeAt(i);
      let keep = -1;
      if (code >= 65 && code <= 90) keep = code + 32;
      else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = code;
      if (keep === -1) {
        if (out.length > 0) gap = true;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += String.fromCharCode(keep);
    }
    if (out.length > 64) {
      out = out.slice(0, 64);
      let e = out.length;
      while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
      out = out.slice(0, e);
    }
    const v = out === '' ? 'untitled' : out;
    cache.set(text, v);
    return v;
  };
}

function uniqueSlug(slug, taken) {
  if (!taken.has(slug)) {
    taken.add(slug);
    return slug;
  }
  let n = 2;
  let out = `${slug}-2`;
  while (taken.has(out)) {
    n++;
    out = `${slug}-${n}`;
  }
  taken.add(out);
  return out;
}

// ------------------------------------------------------------ front matter

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringVal(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return 'a quoted string is not closed';
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return 'a quoted string holds an escape other than \\" or \\\\';
        out += n;
        i++;
      } else if (c === '"') return 'a quoted string holds a stray quote';
      else out += c;
    }
    return { v: out };
  }
  if (raw.charCodeAt(0) === 91) return 'a bare string opens on [';
  return { v: raw };
}

function keyVal(key, raw) {
  if (key === 'title' || key === 'summary') {
    const s = stringVal(raw);
    return typeof s === 'string' ? `key "${key}": ${s}` : s;
  }
  if (key === 'date') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    const y = m ? +m[1] : 0;
    const mo = m ? +m[2] : 0;
    const d = m ? +m[3] : 0;
    if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
      return 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)';
    }
    return { v: raw };
  }
  if (key === 'tags') {
    if (!raw.startsWith('[') || !raw.endsWith(']')) return 'key "tags": not a list [a, b]';
    const inner = raw.slice(1, -1);
    if (inner.trim() === '') return { v: [] };
    const tags = inner.split(',').map((t) => t.trim());
    for (const t of tags) {
      if (t === '' || t.includes('"') || t.includes('[') || t.includes(']')) {
        return 'key "tags": an empty tag, or one holding " [ or ]';
      }
    }
    return { v: tags };
  }
  if (key === 'draft') {
    if (raw === 'true') return { v: true };
    if (raw === 'false') return { v: false };
    return 'key "draft": true or false';
  }
  if (key === 'layout') {
    return /^[a-z0-9-]+$/.test(raw) ? { v: raw } : 'key "layout": not a template name';
  }
  // slug
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw) && raw.length <= 64 ? { v: raw } : 'key "slug": not a slug';
}

/** { data, body } or { error } — first refusal reason wins. */
function parseFm(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (/^[ \t]*$/.test(line) || line.charCodeAt(0) === 35) continue;
    const m = /^([a-z_]+):(?: (.*))?$/.exec(line);
    if (!m) return { error: `line ${i + 1} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!KNOWN_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = keyVal(key, raw);
    if (typeof v === 'string') return { error: v };
    data[key] = v.v;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: lines.slice(close + 1).join('\n') };
}

// ------------------------------------------------------------ markdown

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function trimST(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

/** Fence opener: ``` + optional lang, then spaces/tabs only. Returns lang or null. */
function fenceLang(line) {
  if (!line.startsWith('```')) return null;
  let i = 3;
  const start = i;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    const ok = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
    if (!ok) break;
    i++;
  }
  const lang = line.slice(start, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

function isFenceClose(line) {
  if (!line.startsWith('```')) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Heading: 1-6 #, space/tab, non-empty text (trailing spaces/tabs dropped). */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  const text = trimST(line.slice(n + 1));
  if (text === '') return null;
  return { depth: n, text };
}

function isHr(line) {
  if (!line.startsWith('---') && !line.startsWith('***')) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Ordered-list marker: 1-9 digits, ". ", rest. Returns { num, text } or null. */
function orderedOf(line) {
  let i = 0;
  while (i < 9 && i < line.length) {
    const c = line.charCodeAt(i);
    if (c < 48 || c > 57) break;
    i++;
  }
  if (i === 0) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  return { num: line.slice(0, i), text: line.slice(i + 2) };
}

/** List continuation: 2+ spaces, then a non-whitespace character. */
function isContinued(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  return i >= 2 && i < line.length && !isWS(line.charCodeAt(i));
}

function endsPara(line) {
  return isBlank(line) || (line.startsWith('```') && fenceLang(line) !== null) || headingOf(line) !== null || isHr(line);
}

/** First index >= from where `what` occurs outside a backslash escape, or -1. */
function findUnesc(s, what, from) {
  const last = s.length - what.length;
  for (let j = from; j <= last; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** First single * from `from` (one whose neighbour is not *), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.charCodeAt(j) !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * Inline rendering into `out` (array of strings). Plain runs — everything that is
 * not a backslash escape, code span, strong, emphasis or link — are flushed as one
 * escaped slice; unmatched `*`, backticks and `[` just stay inside the run.
 */
function inlineInto(s, link, out) {
  let i = 0;
  const n = s.length;
  let plain = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < n && ESCAPABLE.has(s[i + 1])) {
      if (i > plain) out.push(esc(s.slice(plain, i)));
      out.push(esc(s[i + 1]));
      i += 2;
      plain = i;
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (i > plain) out.push(esc(s.slice(plain, i)));
        out.push('<code>', esc(s.slice(i + 1, j)), '</code>');
        i = j + 1;
        plain = i;
      } else i++;
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnesc(s, '**', i + 2);
        if (j > i + 2) {
          if (i > plain) out.push(esc(s.slice(plain, i)));
          out.push('<strong>');
          inlineInto(s.slice(i + 2, j), link, out);
          out.push('</strong>');
          i = j + 2;
          plain = i;
        } else i += 2;
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        if (i > plain) out.push(esc(s.slice(plain, i)));
        out.push('<em>');
        inlineInto(s.slice(i + 1, j), link, out);
        out.push('</em>');
        i = j + 1;
        plain = i;
      } else i++;
      continue;
    }
    if (c === 91) {
      const k = findUnesc(s, ']', i + 1);
      const m = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !/\s/.test(target)) {
        if (i > plain) out.push(esc(s.slice(plain, i)));
        out.push('<a href="', esc(link(target)), '">');
        inlineInto(s.slice(i + 1, k), link, out);
        out.push('</a>');
        i = m + 1;
        plain = i;
      } else i++;
      continue;
    }
    i++;
  }
  if (n > plain) out.push(esc(s.slice(plain, n)));
}

const MD_SPECIAL = /[\\`*[]/;

function inline(s, link) {
  if (!MD_SPECIAL.test(s)) return esc(s);
  const out = [];
  inlineInto(s, link, out);
  return out.join('');
}

/** Render one body: { html, toc, excerpt }. */
function renderMd(src, link, slug) {
  const lines = src.split('\n');
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('```')) {
      const lang = fenceLang(line);
      if (lang !== null) {
        const body = [];
        i++;
        while (i < lines.length && !isFenceClose(lines[i])) body.push(lines[i++]);
        i++;
        let code = '<pre><code';
        if (lang !== '') code += ` class="language-${esc(lang)}"`;
        code += '>';
        for (const l of body) code += `${esc(l)}\n`;
        blocks.push(`${code}</code></pre>`);
        continue;
      }
    }
    const hd = headingOf(line);
    if (hd !== null) {
      const id = uniqueSlug(slug(hd.text), ids);
      const html = inline(hd.text, link);
      blocks.push(`<h${hd.depth} id="${id}">${html}</h${hd.depth}>`);
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < lines.length && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(trimST(l.startsWith('> ') ? l.slice(2) : l.slice(1)));
      }
      const kept = body.filter((l) => l !== '');
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(kept.join('\n'), link)}</p>\n</blockquote>`);
      continue;
    }
    const bullet = (line.startsWith('- ') || line.startsWith('* ')) ? line.slice(2) : null;
    const ordered = bullet === null ? orderedOf(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrd = ordered !== null;
      const firstNum = isOrd ? Number(ordered.num) : 1;
      const items = [];
      while (i < lines.length) {
        const l = lines[i];
        if (!isOrd && (l.startsWith('- ') || l.startsWith('* '))) {
          items.push([trimST(l.slice(2))]);
          i++;
        } else if (isOrd) {
          const m = orderedOf(l);
          if (m !== null) {
            items.push([trimST(m.text)]);
            i++;
          } else if (isContinued(l)) {
            items[items.length - 1].push(trimST(l));
            i++;
          } else break;
        } else if (isContinued(l)) {
          items[items.length - 1].push(trimST(l));
          i++;
        } else break;
      }
      const tag = isOrd ? 'ol' : 'ul';
      const open = isOrd && firstNum !== 1 ? `<ol start="${firstNum}">` : `<${tag}>`;
      let html = `${open}\n`;
      for (const parts of items) html += `<li>${inline(parts.join('\n'), link)}</li>\n`;
      blocks.push(`${html}</${tag}>`);
      continue;
    }
    const body = [trimST(line)];
    i++;
    while (i < lines.length && !endsPara(lines[i])) body.push(trimST(lines[i++]));
    const html = inline(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length === 0 ? '' : `${blocks.join('\n')}\n`, toc, excerpt: excerpt ?? '' };
}

// ------------------------------------------------------------ templates

class TplError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INC_RE = /^include "([a-z0-9-]+)"$/;

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TplError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const nx = src[open + 1];
    if (nx !== '{' && nx !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (nx === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TplError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 0, text });
      text = '';
      tokens.push({ t: raw ? 2 : 1, path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TplError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 0, text });
    text = '';
    tokens.push({ t: 3, tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 0, text });
  return tokens;
}

function parseTpl(name, src) {
  const root = { k: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 0) body.push({ k: 't', text: tok.text });
    else if (tok.t === 1 || tok.t === 2) body.push({ k: tok.t === 1 ? 'v' : 'r', path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { k: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { k: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], els: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.k !== 'if' || top.els !== null) throw new TplError(`template "${name}": an else outside an if`);
        top.els = [];
        body = top.els;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.k !== (tag === 'endfor' ? 'for' : 'if')) throw new TplError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.k === 'root' ? parent.body : parent.k === 'for' ? parent.body : parent.els ?? parent.then;
      } else if ((m = INC_RE.exec(tag)) !== null) body.push({ k: 'inc', name: m[1] });
      else throw new TplError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TplError(`template "${name}": a ${stack[stack.length - 1].k} is not closed`);
  return root.body;
}

function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.v, path[0])) s = s.p;
  if (s === null) return undefined;
  let v = s.v[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function renderNodes(nodes, scope, templates, out, depth) {
  for (const n of nodes) {
    if (n.k === 't') out.push(n.text);
    else if (n.k === 'v') out.push(esc(textOf(lookup(scope, n.path))));
    else if (n.k === 'r') out.push(textOf(lookup(scope, n.path)));
    else if (n.k === 'if') {
      const v = truthy(lookup(scope, n.path));
      const branch = v !== n.not ? n.then : n.els;
      if (branch !== null) renderNodes(branch, scope, templates, out, depth);
    } else if (n.k === 'for') {
      const xs = lookup(scope, n.path);
      if (!Array.isArray(xs)) continue;
      for (let k = 0; k < xs.length; k++) {
        const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
        renderNodes(n.body, { v: vars, p: scope }, templates, out, depth);
      }
    } else if (n.k === 'inc') {
      const t = templates.get(n.name);
      if (t !== undefined && depth < INCLUDE_MAX) renderNodes(t, scope, templates, out, depth + 1);
    }
  }
}

// ------------------------------------------------------------ build

function resolveRel(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/** Words: runs of non-whitespace, counted without building an array. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13) inWord = false;
    else if (c < 128) {
      if (!inWord) {
        inWord = true;
        n++;
      }
    } else if (c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

export function run(input) {
  const slug = makeSlug();
  const base = input.site.base_url.replace(/\/+$/, '');
  const report = [];
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort(cmp)) {
    try {
      templates.set(name, parseTpl(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TplError)) throw err;
      report.push(err.message);
    }
  }
  const files = [...input.files].sort((x, y) => cmp(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }
  const kept = [];
  for (const s of sources) {
    const fm = parseFm(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let ownDir = null;
    for (const d of RESERVED) {
      if (d !== 'posts' && s.path.startsWith(`${d}/`)) {
        ownDir = d;
        break;
      }
    }
    if (ownDir !== null) {
      report.push(`refused ${s.path}: ${ownDir}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    s.slug = uniqueSlug(s.data.slug ?? slug(s.data.title), set);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const schemeRe = /^[A-Za-z][A-Za-z0-9+.-]*:/;
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (schemeRe.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolveRel(dir, rel);
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMd(s.body, link, slug);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => cmp(y.data.date, x.data.date) || cmp(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });
  const byTagSlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const sg = slug(name);
      if (seen.has(sg)) continue;
      seen.add(sg);
      out.push(name);
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const sg = slug(name);
      let tag = byTagSlug.get(sg);
      if (tag === undefined) {
        tag = { name, slug: sg, url: `${base}/tags/${sg}/`, posts: [] };
        byTagSlug.set(sg, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => byTagSlug.get(slug(name)) ?? { name, slug: slug(name), url: '', posts: [] });
  }
  const tags = [...byTagSlug.values()].sort((x, y) => y.posts.length - x.posts.length || cmp(x.slug, y.slug));
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map();
  for (const s of kept) {
    s.card = cardOf(s);
    if (s.post) cards.set(s, s.card);
  }
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const output = {};
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { v: { site, tags: allTags, recent, ...vars }, p: null }, templates, out, 0);
    return out.join('');
  };
  for (const s of kept) {
    const page = { ...s.card, slug: s.slug, content: s.html, toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })), newer: linkOf(s.newer ?? null), older: linkOf(s.older ?? null), is_post: s.post };
    output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }
  const lines = [...report, ...broken].sort(cmp);
  const nPages = kept.filter((s) => !s.post).length;
  lines.push(`built ${nPages} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
