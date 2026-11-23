// solve.js — a fast drop-in for makefun-site 1.0.0.
//
// Own implementation, written from the reference's documented behaviour:
// same front matter, same template dialect, same Markdown subset, same
// slug rule, same report — byte for byte. Where the reference wastes CPU
// (per-character escaping, regexes per line, token objects, recursive
// template interpretation) this build uses bulk runs, a single-pass
// renderer and templates compiled to functions.

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;

// Escape HTML by scanning for the next special character in native code
// and copying the plain stretches between them in bulk.
function esc(s) {
  let out = '';
  let start = 0;
  let m;
  ESC_RE.lastIndex = 0;
  while ((m = ESC_RE.exec(s)) !== null) {
    out += s.slice(start, m.index) + ESC_MAP[m[0]];
    start = m.index + 1;
  }
  return start === 0 ? s : out + s.slice(start);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function longDate(d) {
  const y = d.slice(0, 4);
  const mo = Number(d.slice(5, 7));
  const day = Number(d.slice(8, 10));
  return `${day} ${MONTHS[mo - 1]} ${y}`;
}

function byCodeUnits(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

function wordsOf(text) {
  const m = text.match(/\S+/g);
  return m === null ? 0 : m.length;
}

// --- slugs ---------------------------------------------------------------

const SLUG_CACHE = new Map();

function slugify(text) {
  const hit = SLUG_CACHE.get(text);
  if (hit !== undefined) return hit;
  const s = slugifySlow(text);
  SLUG_CACHE.set(text, s);
  return s;
}

function slugifySlow(text) {
  // Non-ASCII text must go through the exact NFKD + mark-strip step.
  if (/[^\x00-\x7F]/.test(text)) {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    return finishSlug(plain);
  }
  return finishSlug(text);
}

function finishSlug(plain) {
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

function uniqueSlug(slug, taken) {
  if (!taken.has(slug)) { taken.add(slug); return slug; }
  let k = 2;
  while (taken.has(slug + '-' + k)) k++;
  const u = slug + '-' + k;
  taken.add(u);
  return u;
}

// --- line helpers ---------------------------------------------------------

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function isLangChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
    (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
}

// '```' + optional language, then only spaces/tabs. Returns the language
// or null when the line is not a fence opener.
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length && isLangChar(line.charCodeAt(i))) i++;
  const lang = line.slice(3, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// { depth, text } or null.
function headingOf(line) {
  let d = 0;
  while (d < line.length && line.charCodeAt(d) === 35) d++;
  if (d === 0 || d > 6 || d >= line.length) return null;
  const c = line.charCodeAt(d);
  if (c !== 32 && c !== 9) return null;
  let s = d;
  while (s < line.length && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
  let e = line.length;
  while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  if (e === s) return null;
  return { depth: d, text: line.slice(s, e) };
}

function isHR(line) {
  const p = line.slice(0, 3);
  if (p !== '---' && p !== '***') return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Bullet item text or null ('- ' or '* ' prefix).
function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

// { num, text } or null ('N. ' prefix, 1-9 digits).
function orderedOf(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) i++;
  if (i === 0 || i > 9) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  return { num: Number(line.slice(0, i)), text: line.slice(i + 2) };
}

const CONTINUED = /^ {2,}\S/;

function endsParagraph(line) {
  return isBlank(line) || fenceOpen(line) !== null || headingOf(line) !== null || isHR(line);
}

function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

// --- front matter ----------------------------------------------------------

const FM_KEYS = new Set(['title', 'date', 'layout', 'tags', 'draft', 'slug', 'summary']);
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_BLANK = /^[ \t]*$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TAG_RE = /^[^"[\]]+$/;

function stringOf(raw) {
  if (!raw.startsWith('"')) {
    if (raw.startsWith('[')) throw new Error('a bare string opens on [');
    return raw;
  }
  if (raw.length < 2 || !raw.endsWith('"')) throw new Error('a quoted string is not closed');
  let out = '';
  for (let i = 1; i < raw.length - 1; i++) {
    const c = raw[i];
    if (c === '\\') {
      const n = raw[i + 1];
      if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) {
        throw new Error('a quoted string holds an escape other than \\" or \\');
      }
      out += n;
      i++;
      continue;
    }
    if (c === '"') throw new Error('a quoted string holds a stray quote');
    out += c;
  }
  return out;
}

function daysIn(y, mo) {
  if (mo === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return mo === 4 || mo === 6 || mo === 9 || mo === 11 ? 30 : 31;
}

function dateOf(raw) {
  const m = DATE_RE.exec(raw);
  if (m === null) throw new Error('key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)');
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
    throw new Error('key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)');
  }
  return raw;
}

function tagsOf(raw) {
  if (!raw.startsWith('[') || !raw.endsWith(']')) throw new Error('key "tags": not a list [a, b]');
  const inner = raw.slice(1, -1);
  if (inner.trim() === '') return [];
  const tags = inner.split(',').map(t => t.trim());
  for (const t of tags) {
    if (t === '' || !TAG_RE.test(t)) throw new Error('key "tags": an empty tag, or one holding " [ or ]');
  }
  return tags;
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary':
      try {
        return stringOf(raw);
      } catch (e) {
        throw new Error(`key "${key}": ${e.message}`);
      }
    case 'date': return dateOf(raw);
    case 'layout':
      if (!NAME_RE.test(raw)) throw new Error('key "layout": not a template name');
      return raw;
    case 'tags': return tagsOf(raw);
    case 'draft':
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      throw new Error('key "draft": true or false');
    case 'slug':
      if (!SLUG_RE.test(raw) || raw.length > 64) throw new Error('key "slug": not a slug');
      return raw;
    default: return raw;
  }
}

function fmLine(line, num, data) {
  if (FM_BLANK.test(line) || line.startsWith('#')) return;
  const m = FM_LINE.exec(line);
  if (m === null) throw new Error(`line ${num} is not "key: value"`);
  const key = m[1];
  if (!FM_KEYS.has(key)) throw new Error(`unknown key "${key}"`);
  if (Object.hasOwn(data, key)) throw new Error(`key "${key}" is given twice`);
  const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
  if (raw === '') throw new Error(`key "${key}" has no value`);
  data[key] = valueOf(key, raw);
}

// Returns { data, body }. Scans line boundaries by index so the body is
// one slice instead of a split + join of the whole file.
function parseFrontMatter(text) {
  let nl = text.indexOf('\n');
  let end = nl === -1 ? text.length : nl;
  if (text.slice(0, end) !== '---') throw new Error('no front matter');
  const data = {};
  let pos = end + 1;
  let lineNo = 1;
  let closed = false;
  let body = '';
  while (pos <= text.length) {
    nl = text.indexOf('\n', pos);
    end = nl === -1 ? text.length : nl;
    const line = text.slice(pos, end);
    if (line === '---') {
      body = nl === -1 ? '' : text.slice(nl + 1);
      closed = true;
      break;
    }
    fmLine(line, lineNo + 1, data);
    if (nl === -1) break;
    pos = end + 1;
    lineNo++;
  }
  if (!closed) throw new Error('the front matter is not closed');
  if (data.title === undefined) throw new Error('no title');
  return { data, body };
}

// --- Markdown --------------------------------------------------------------
//
// Single pass over the body: blocks are classified by char codes and
// rendered straight into the output, no token objects. Inline markup is
// handled run-based: plain stretches are escaped in bulk, and only the
// constructs (\ ` ** * [) break the run.

const ESCAPABLE = new Set('\\`*_[]()#+-.!>');

function findUnescaped(s, what, from) {
  const wlen = what.length;
  for (let j = from; j <= s.length - wlen; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (c !== '*') continue;
    if (s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}

const WS_RE = /\s/;

function inlineInto(s, link, out) {
  let i = 0;
  let run = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 92) { // backslash
      if (i + 1 < n && ESCAPABLE.has(s[i + 1])) {
        if (i > run) out.push(esc(s.slice(run, i)));
        out.push(s[i + 1]);
        i += 2;
        run = i;
      } else {
        i++;
      }
      continue;
    }
    if (c === 96) { // backtick — code span
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (i > run) out.push(esc(s.slice(run, i)));
        out.push('<code>', esc(s.slice(i + 1, j)), '</code>');
        i = j + 1;
        run = i;
      } else {
        i++;
      }
      continue;
    }
    if (c === 42) { // star — strong or emphasis
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          if (i > run) out.push(esc(s.slice(run, i)));
          out.push('<strong>');
          inlineInto(s.slice(i + 2, j), link, out);
          out.push('</strong>');
          i = j + 2;
          run = i;
        } else {
          i += 2;
        }
      } else {
        const j = findSingleStar(s, i + 1);
        if (j > i + 1) {
          if (i > run) out.push(esc(s.slice(run, i)));
          out.push('<em>');
          inlineInto(s.slice(i + 1, j), link, out);
          out.push('</em>');
          i = j + 1;
          run = i;
        } else {
          i++;
        }
      }
      continue;
    }
    if (c === 91) { // [ — link
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !WS_RE.test(target)) {
        if (i > run) out.push(esc(s.slice(run, i)));
        out.push('<a href="', esc(link(target)), '">');
        inlineInto(s.slice(i + 1, k), link, out);
        out.push('</a>');
        i = m + 1;
        run = i;
      } else {
        i++;
      }
      continue;
    }
    i++;
  }
  if (n > run) out.push(esc(s.slice(run)));
}

function inline(s, link) {
  const out = [];
  inlineInto(s, link, out);
  return out.join('');
}

// Returns { html, toc, excerpt }.
function renderMarkdown(body, link) {
  const lines = body.split('\n');
  const n = lines.length;
  const blocks = [];
  const toc = [];
  let excerpt = null;
  const ids = new Set();
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const fence = fenceOpen(line);
    if (fence !== null) {
      i++;
      let code = '';
      while (i < n && !isFenceClose(lines[i])) code += esc(lines[i++]) + '\n';
      i++;
      const cls = fence === '' ? '' : ` class="language-${esc(fence)}"`;
      blocks.push(`<pre><code${cls}>${code}</code></pre>`);
      continue;
    }
    const hd = headingOf(line);
    if (hd !== null) {
      const id = uniqueSlug(slugify(hd.text), ids);
      const html = inline(hd.text, link);
      blocks.push(`<h${hd.depth} id="${id}">${html}</h${hd.depth}>`);
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
      i++;
      continue;
    }
    if (isHR(line)) { blocks.push('<hr>'); i++; continue; }
    if (line.charCodeAt(0) === 62) { // blockquote
      const q = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        q.push(trimLine(l.startsWith('> ') ? l.slice(2) : l.slice(1)));
      }
      const inner = q.filter(l => l !== '');
      if (inner.length === 0) blocks.push('<blockquote>\n</blockquote>');
      else blocks.push(`<blockquote>\n<p>${inline(inner.join('\n'), link)}</p>\n</blockquote>`);
      continue;
    }
    const bl = bulletOf(line);
    const ol = bl === null ? orderedOf(line) : null;
    if (bl !== null || ol !== null) {
      const isOrd = ol !== null;
      const items = [];
      let start = 1;
      if (isOrd) start = ol.num;
      while (i < n) {
        const m = isOrd ? orderedOf(lines[i]) : bulletOf(lines[i]);
        if (m !== null) { items.push([trimLine(isOrd ? m.text : m)]); i++; }
        else if (CONTINUED.test(lines[i])) { items[items.length - 1].push(trimLine(lines[i])); i++; }
        else break;
      }
      const tag = isOrd ? 'ol' : 'ul';
      const open = isOrd && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      let b = open + '\n';
      for (const parts of items) b += `<li>${inline(parts.join('\n'), link)}</li>\n`;
      blocks.push(b + `</${tag}>`);
      continue;
    }
    // Paragraph: swallows following lines until a blank line, a fence, a
    // heading or a rule. (Quotes and list lines do NOT end a paragraph.)
    const p = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) p.push(trimLine(lines[i++]));
    const html = inline(p.join('\n'), link);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.map(b => b + '\n').join(''), toc, excerpt: excerpt ?? '' };
}

// --- templates -------------------------------------------------------------
//
// The dialect is parsed once and compiled to a function with new Function.
// At render time a template is just: fn(F, V, H, D, O) — F is a flat
// frames array [name, value, name, value, ...] pushed and popped per
// for-iteration, V is the page variables, H the helpers, D the include
// depth, O the output array. No interpreter, no scope objects per loop.

class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

function pathOf(text, name) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let i = 0;
  let text = '';
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1) { text += src.slice(i); break; }
    const c = src[open + 1];
    if (c !== '{' && c !== '%') { text += src.slice(i, open + 1); i = open + 1; continue; }
    text += src.slice(i, open);
    if (c === '{') {
      const raw = src[open + 2] === '{';
      const close = raw ? src.indexOf('}}}', open + 3) : src.indexOf('}}', open + 2);
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      tokens.push({ type: 'text', text });
      tokens.push({ type: raw ? 'raw' : 'var', text: src.slice(open + (raw ? 3 : 2), close).trim() });
      text = '';
      i = close + (raw ? 3 : 2);
    } else {
      const end = src.indexOf('%}', open + 2);
      if (end === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
      const after = end + 2;
      const lineStart = src.lastIndexOf('\n', open - 1) + 1;
      const nl = src.indexOf('\n', after);
      const lineEnd = nl === -1 ? src.length : nl;
      const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(after, lineEnd));
      if (standalone) text = text.slice(0, text.length - (open - lineStart));
      tokens.push({ type: 'text', text });
      tokens.push({ type: 'ctrl', text: src.slice(open + 2, end).trim() });
      text = '';
      i = standalone ? (nl === -1 ? src.length : nl + 1) : after;
    }
  }
  if (text !== '') tokens.push({ type: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const tokens = tokenize(name, src);
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const t of tokens) {
    if (t.type === 'text') {
      if (t.text !== '') body.push({ kind: 'text', text: t.text });
      continue;
    }
    if (t.type === 'var' || t.type === 'raw') {
      body.push({ kind: t.type, path: pathOf(t.text, name) });
      continue;
    }
    const text = t.text;
    let m;
    if ((m = FOR_RE.exec(text)) !== null) {
      const node = { kind: 'for', name: m[1], path: pathOf(m[2], name), body: [] };
      body.push(node);
      stack.push(node);
      body = node.body;
    } else if ((m = IF_RE.exec(text)) !== null) {
      const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(m[2], name), then: [], else: null };
      body.push(node);
      stack.push(node);
      body = node.then;
    } else if (text === 'else') {
      const top = stack[stack.length - 1];
      if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
      top.else = [];
      body = top.else;
    } else if (text === 'endfor' || text === 'endif') {
      const top = stack[stack.length - 1];
      if (top.kind !== text.slice(3)) throw new TemplateError(`template "${name}": an ${text} with no open ${text.slice(3)}`);
      stack.pop();
      const parent = stack[stack.length - 1];
      body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : (parent.else ?? parent.then);
    } else if ((m = INCLUDE_RE.exec(text)) !== null) {
      body.push({ kind: 'include', name: m[1] });
    } else {
      throw new TemplateError(`template "${name}": {% ${text} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// --- template runtime helpers (passed as H to compiled functions) ---------

function txt(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let i = 0; i < v.length; i++) {
      if (i > 0) s += ', ';
      s += txt(v[i]);
    }
    return s;
  }
  return '';
}

function ev(v) { return esc(txt(v)); }
function rv(v) { return txt(v); }

function tr(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function lk(F, V, name) {
  for (let i = F.length - 2; i >= 0; i -= 2) if (F[i] === name) return F[i + 1];
  return Object.hasOwn(V, name) ? V[name] : undefined;
}

// --- template compiler -----------------------------------------------------

function compileTemplate(name, src) {
  const nodes = parseTemplate(name, src);
  let tmp = 0;
  let code = '';
  const lookup = (v, path) => {
    code += `let ${v}=H.lk(F,V,${JSON.stringify(path[0])});`;
    for (let i = 1; i < path.length; i++) {
      const seg = JSON.stringify(path[i]);
      code += `${v}=(${v}!==null&&typeof ${v}==='object'&&Object.hasOwn(${v},${seg})?${v}[${seg}]:undefined);`;
    }
  };
  const gen = (list) => {
    for (const node of list) {
      if (node.kind === 'text') {
        code += `O.push(${JSON.stringify(node.text)});`;
        continue;
      }
      if (node.kind === 'var' || node.kind === 'raw') {
        const v = 'v' + (tmp++);
        lookup(v, node.path);
        code += node.kind === 'var' ? `O.push(H.ev(${v}));` : `O.push(H.rv(${v}));`;
        continue;
      }
      if (node.kind === 'if') {
        const v = 'v' + (tmp++);
        lookup(v, node.path);
        code += `if (${node.not ? '!' : ''}H.tr(${v})){`;
        gen(node.then);
        code += '}';
        if (node.else !== null) {
          code += 'else{';
          gen(node.else);
          code += '}';
        }
        continue;
      }
      if (node.kind === 'for') {
        const v = 'v' + (tmp++);
        const n = 'n' + (tmp++);
        const k = 'k' + (tmp++);
        lookup(v, node.path);
        code += `if(Array.isArray(${v})){const ${n}=${v}.length;for(let ${k}=0;${k}<${n};${k}++){F.push(${JSON.stringify(node.name)},${v}[${k}],"loop",{index:${k}+1,first:${k}===0,last:${k}===${n}-1,length:${n}});`;
        gen(node.body);
        code += 'F.length-=4;}}';
        continue;
      }
      if (node.kind === 'include') {
        const f = 'f' + (tmp++);
        code += `const ${f}=H.t.get(${JSON.stringify(node.name)});if(${f}!==undefined&&D<8)${f}(F,V,H,D+1,O);`;
        continue;
      }
    }
  };
  gen(nodes);
  return new Function('F', 'V', 'H', 'D', 'O', code);
}

// --- build pipeline --------------------------------------------------------

const RESERVED = ['posts', 'tags', 'page'];

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join('/');
}

function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: s.reading_minutes,
    tags: s.tagRefs.map(t => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

function linkOf(s) {
  if (s === null) return null;
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
  };
}

function pageOf(s) {
  return {
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map(t => ({ level: t.level, id: t.id, html: t.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

function build(inp, base, compiled, h, parseErrors) {
  const report = [...parseErrors];
  const broken = new Set();

  // 1. Read sources: Markdown sources and static files, sorted by path.
  const files = [...inp.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      sources.push({
        path: f.path,
        text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n'),
      });
    } else {
      statics.push(f);
    }
  }

  // 2. Front matter: refuse bad sources, keep the rest.
  const kept = [];
  for (const s of sources) {
    try {
      const fm = parseFrontMatter(s.text);
      s.data = fm.data;
      s.body = fm.body;
    } catch (e) {
      report.push(`refused ${s.path}: ${e.message}`);
      continue;
    }
    const reserved = RESERVED.find(d => d !== 'posts' && s.path.startsWith(d + '/'));
    if (reserved !== undefined) {
      report.push(`refused ${s.path}: ${reserved}/ is the generator's own`);
      continue;
    }
    s.post = s.path.startsWith('posts/');
    if (s.post && s.data.date === undefined) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    s.layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!compiled.has(s.layout)) {
      report.push(`refused ${s.path}: layout "${s.layout}" is no template that parses`);
      continue;
    }
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Permalinks: unique slug per directory, url from the site base.
  const bySource = new Map();
  const taken = new Map();
  taken.set('', new Set(RESERVED));
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let seen = taken.get(dir);
    if (seen === undefined) { seen = new Set(); taken.set(dir, seen); }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), seen);
    s.slug = slug;
    s.outDir = dir === '' ? slug : dir + '/' + slug;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown: render each kept source, resolving links against the
  //    kept sources and the static files.
  const staticPaths = new Set(statics.map(f => f.path));
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) return bySource.get(path).url + frag;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const r = renderMarkdown(s.body, link);
    s.html = r.html;
    s.toc = r.toc;
    s.excerpt = r.excerpt;
    s.reading_minutes = Math.max(1, Math.ceil(wordsOf(s.body) / 200));
  }

  // 5. Collections: posts newest first, ties by slug.
  const posts = kept.filter(s => s.post);
  posts.sort((a, b) => byCodeUnits(b.data.date, a.data.date) || byCodeUnits(a.slug, b.slug));
  posts.forEach((s, i) => {
    s.newer = i > 0 ? posts[i - 1] : null;
    s.older = i < posts.length - 1 ? posts[i + 1] : null;
  });

  // 6. Tags: grouped by slug, each named as first met in the posts'
  //    order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  // A page's tags link to the posts' tag of the same slug, and to nothing
  // (url "") where no post has it.
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
    }
  }
  const tags = [...bySlug.values()].sort((a, b) => (b.posts.length - a.posts.length) || byCodeUnits(a.slug, b.slug));

  // 7. Layouts: render every page, the index pages, the tag pages and the
  //    tags page, then copy the static files.
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const site = { title: inp.site.title, base_url: base };
  const allTags = tags.map(t => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, inp.site.recent).map(p => cards.get(p));
  const output = {};
  const render = (name, vars) => {
    const fn = compiled.get(name);
    if (fn === undefined) return null;
    const V = { site, tags: allTags, recent, ...vars };
    const O = [];
    fn([], V, h, 0, O);
    return O.join('');
  };
  for (const s of kept) {
    output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  }
  const per = inp.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = k => k === 1 ? `${base}/` : `${base}/page/${k}/`;
  for (let k = 1; k <= pages; k++) {
    const pager = {
      number: k,
      total: pages,
      url: indexUrl(k),
      newer_url: k === 1 ? '' : indexUrl(k - 1),
      older_url: k === pages ? '' : indexUrl(k + 1),
    };
    const html = render('index', { posts: posts.slice((k - 1) * per, k * per).map(p => cards.get(p)), pager });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const tag = { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map(p => cards.get(p)) };
    const html = render('tag', { tag });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. Report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter(s => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = lines.join('\n') + '\n';
  return output;
}

export function run(input) {
  // One case's input: { site, templates, files }. Templates are compiled
  // once for this case; a parse error lands in the case's report.
  const base = input.site.base_url.replace(/\/+$/, '');
  const parseErrors = [];
  const compiled = new Map();
  for (const name of Object.keys(input.templates).sort()) {
    try {
      compiled.set(name, compileTemplate(name, input.templates[name]));
    } catch (e) {
      if (e instanceof TemplateError) parseErrors.push(e.message);
      else throw e;
    }
  }
  const h = { t: compiled, esc, txt, ev, rv, tr, lk };
  return build(input, base, compiled, h, parseErrors);
}
