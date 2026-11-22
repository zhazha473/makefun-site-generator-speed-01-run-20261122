// Single-pass makefun-site-exact builder.
//
// A faster drop-in for makefun-site 1.0.0: same output tree, byte for byte,
// for every case. The whole build is fused instead of the reference's
// 8-plugin pipeline with an intermediate token tree:
//   - front matter is parsed by scanning line boundaries (no full split);
//   - Markdown is lexed and rendered in one pass, blocks emitted straight
//     into an output array (no token objects, no per-character escaping);
//   - templates are compiled once per case into flat instruction lists and
//     rendered into an output array joined once at the end;
//   - slugs use an ASCII fast path (no NFKD / \p{M} work) with the slow
//     path only when non-ASCII appears, and slug results are cached;
//   - a post's card is computed once and reused by index, tag and
//     recent lists.
// The dialect is implemented generally from the makefun-site spec; nothing
// here hardcodes the generator's template shapes.

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
const SPECIAL_TEST = /[\\`*[]/;
const WORDS_RE = /\S+/g;
const MARK_RE = /\p{M}/gu;
const NON_ASCII = /[^\x00-\x7F]/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const RESERVED = ['posts', 'tags', 'page'];
const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const INCLUDE_DEPTH = 8;

function esc(s) {
  if (s.indexOf('&') === -1 && s.indexOf('<') === -1 && s.indexOf('>') === -1 && s.indexOf('"') === -1 && s.indexOf("'") === -1) return s;
  return s.replace(ESC_RE, (c) => ESC_MAP[c]);
}

function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

function isWSCode(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 160 || c === 5760 ||
    (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279;
}

// words: runs of non-whitespace, as /\S+/g counts them.
function wordsOf(text) {
  let n = 0, inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (isWSCode(text.charCodeAt(i))) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

function slugFromPlain(plain) {
  let out = '', gap = false;
  for (let i = 0; i < plain.length; i++) {
    const code = plain.charCodeAt(i);
    let keep = 0;
    if (code >= 65 && code <= 90) keep = code + 32;
    else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = code;
    if (keep === 0) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  if (out.length > 64) out = out.slice(0, 64);
  let e = out.length;
  while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
  if (e < out.length) out = out.slice(0, e);
  return out === '' ? 'untitled' : out;
}

function slugifyRaw(text) {
  if (NON_ASCII.test(text)) return slugFromPlain(text.normalize('NFKD').replace(MARK_RE, ''));
  return slugFromPlain(text);
}

function slugify(text, cache) {
  let s = cache.get(text);
  if (s === undefined) { s = slugifyRaw(text); cache.set(text, s); }
  return s;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = slug + '-' + n;
  taken.add(out);
  return out;
}

function longDate(date) {
  const y = date.slice(0, 4), m = Number(date.slice(5, 7)), d = Number(date.slice(8, 10));
  return d + ' ' + MONTHS[m - 1] + ' ' + y;
}

function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

// ---------------------------------------------------------------- front matter

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) { // '"'
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' }; // '['
  return { value: raw };
}

function valueOf(key, raw) {
  if (key === 'title' || key === 'summary') {
    const s = stringOf(raw);
    return 'error' in s ? { error: 'key "' + key + '": ' + s.error } : s;
  }
  if (key === 'date') {
    const m = DATE_RE.exec(raw);
    const y = m ? Number(m[1]) : 0, mo = m ? Number(m[2]) : 0, d = m ? Number(m[3]) : 0;
    if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo))
      return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    return { value: raw };
  }
  if (key === 'tags') {
    if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
    const inner = raw.slice(1, -1);
    if (inner.trim() === '') return { value: [] };
    const tags = inner.split(',').map((t) => t.trim());
    for (let k = 0; k < tags.length; k++) {
      const t = tags[k];
      if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1)
        return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
    }
    return { value: tags };
  }
  if (key === 'draft') {
    if (raw === 'true') return { value: true };
    if (raw === 'false') return { value: false };
    return { error: 'key "draft": true or false' };
  }
  if (key === 'layout') {
    // /^[a-z0-9-]+$/
    if (raw.length === 0) return { error: 'key "layout": not a template name' };
    for (let i = 0; i < raw.length; i++) {
      const c = raw.charCodeAt(i);
      if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' };
    }
    return { value: raw };
  }
  if (key === 'slug') {
    if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
    // /^[a-z0-9]+(?:-[a-z0-9]+)*$/
    let i = 0;
    while (i < raw.length) {
      let j = i;
      while (j < raw.length) {
        const c = raw.charCodeAt(j);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57))) break;
        j++;
      }
      if (j === i) return { error: 'key "slug": not a slug' };
      i = j;
      if (i < raw.length) {
        if (raw.charCodeAt(i) !== 45) return { error: 'key "slug": not a slug' };
        i++;
        if (i >= raw.length) return { error: 'key "slug": not a slug' };
      }
    }
    return { value: raw };
  }
  return { error: 'unknown key "' + key + '"' };
}

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Parse front matter by scanning line boundaries; returns {data, body} or {error}.
function parseFrontMatter(text) {
  let p0 = text.indexOf('\n');
  if (p0 === -1) p0 = text.length;
  if (text.slice(0, p0) !== '---') return { error: 'no front matter' };
  // Find the closing '---' line.
  let pos = p0 + 1, closeStart = -1, closeEnd = -1, lineIdx = 1;
  while (pos <= text.length) {
    let e = text.indexOf('\n', pos);
    if (e === -1) e = text.length;
    if (text.slice(pos, e) === '---') { closeStart = pos; closeEnd = e; break; }
    if (e === text.length) break;
    pos = e + 1;
    lineIdx++;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let lp = p0 + 1, li = 1; // line index (0-based) of the line starting at lp
  while (lp < closeStart) {
    let e = text.indexOf('\n', lp);
    if (e === -1 || e > closeStart) e = closeStart;
    const line = text.slice(lp, e);
    // line index li corresponds to lines[li]; error numbers are li+1.
    if (!isBlankLine(line) && line.charCodeAt(0) !== 35) { // '#'
      // /^([a-z_]+):(?: (.*))?$/
      let j = 0;
      while (j < line.length) {
        const c = line.charCodeAt(j);
        if (!((c >= 97 && c <= 122) || c === 95)) break;
        j++;
      }
      if (j === 0 || j >= line.length || line.charCodeAt(j) !== 58)
        return { error: 'line ' + (li + 1) + ' is not "key: value"' };
      const key = line.slice(0, j);
      let raw;
      if (j + 1 === line.length) raw = '';
      else if (line.charCodeAt(j + 1) === 32) raw = line.slice(j + 2);
      else return { error: 'line ' + (li + 1) + ' is not "key: value"' };
      let r = raw.length;
      while (r > 0) {
        const c = raw.charCodeAt(r - 1);
        if (c !== 32 && c !== 9) break;
        r--;
      }
      if (r < raw.length) raw = raw.slice(0, r);
      if (!FM_KEYS.has(key)) return { error: 'unknown key "' + key + '"' };
      if (Object.hasOwn(data, key)) return { error: 'key "' + key + '" is given twice' };
      if (raw === '') return { error: 'key "' + key + '" has no value' };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    lp = e + 1;
    li++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd >= text.length ? '' : text.slice(closeEnd + 1) };
}

// ---------------------------------------------------------------- Markdown

function trimLine(line) {
  let a = 0, b = line.length;
  while (a < b) { const c = line.charCodeAt(a); if (c !== 32 && c !== 9) break; a++; }
  while (b > a) { const c = line.charCodeAt(b - 1); if (c !== 32 && c !== 9) break; b--; }
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

function isLangChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
}

// Fence open: /^```([A-Za-z0-9_+-]*)[ \t]*$/ -> language or '' ; null if not a fence.
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length && isLangChar(line.charCodeAt(j))) j++;
  const lang = line.slice(3, j);
  while (j < line.length) { const c = line.charCodeAt(j); if (c !== 32 && c !== 9) return null; j++; }
  return lang;
}

function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let j = 3; j < line.length; j++) { const c = line.charCodeAt(j); if (c !== 32 && c !== 9) return false; }
  return true;
}

// Heading: /^(#{1,6})[ \t]+(.*?)[ \t]*$/ with non-empty text, or null.
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  let j = n;
  if (j >= line.length || (line.charCodeAt(j) !== 32 && line.charCodeAt(j) !== 9)) return null;
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  let b = line.length;
  while (b > j) { const c = line.charCodeAt(b - 1); if (c !== 32 && c !== 9) break; b--; }
  if (b === j) return null;
  return { depth: n, text: line.slice(j, b) };
}

function isHr(line) {
  let p = 0;
  if (line.startsWith('---')) p = 3;
  else if (line.startsWith('***')) p = 3;
  else return false;
  for (let j = p; j < line.length; j++) { const c = line.charCodeAt(j); if (c !== 32 && c !== 9) return false; }
  return true;
}

function endsParagraph(line) {
  if (isBlankLine(line)) return true;
  if (fenceLang(line) !== null) return true;
  if (headingOf(line) !== null) return true;
  if (isHr(line)) return true;
  return false;
}

function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
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

// Inline rendering into `out` (an array of strings). `env` has link(target).
function inlineInto(out, s, env) {
  if (!SPECIAL_TEST.test(s)) { out.push(esc(s)); return; }
  let i = 0;
  const n = s.length;
  while (i < n) {
    let best = n;
    let j = s.indexOf('\\', i); if (j !== -1 && j < best) best = j;
    j = s.indexOf('`', i); if (j !== -1 && j < best) best = j;
    j = s.indexOf('*', i); if (j !== -1 && j < best) best = j;
    j = s.indexOf('[', i); if (j !== -1 && j < best) best = j;
    if (best > i) {
      const seg = s.slice(i, best);
      out.push(seg.replace(ESC_RE, (c) => ESC_MAP[c]));
    }
    if (best === n) break;
    const c = s[best];
    if (c === '\\') {
      const nx = s[best + 1];
      if (nx !== undefined && ESCAPABLE.has(nx)) { out.push(nx === '>' ? '&gt;' : nx); i = best + 2; }
      else { out.push('\\'); i = best + 1; }
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', best + 1);
      if (k > best + 1) {
        out.push('<code>', esc(s.slice(best + 1, k)), '</code>');
        i = k + 1;
      } else { out.push('`'); i = best + 1; }
      continue;
    }
    if (c === '*') {
      if (s[best + 1] === '*') {
        const k = findUnescaped(s, '**', best + 2);
        if (k > best + 2) {
          out.push('<strong>');
          inlineInto(out, s.slice(best + 2, k), env);
          out.push('</strong>');
          i = k + 2;
        } else { out.push('**'); i = best + 2; }
        continue;
      }
      const k = findSingleStar(s, best + 1);
      if (k > best + 1) {
        out.push('<em>');
        inlineInto(out, s.slice(best + 1, k), env);
        out.push('</em>');
        i = k + 1;
      } else { out.push('*'); i = best + 1; }
      continue;
    }
    // '['
    const k = findUnescaped(s, ']', best + 1);
    const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = m === -1 ? '' : s.slice(k + 2, m);
    if (target !== '' && !/\s/.test(target)) {
      out.push('<a href="', esc(env.link(target)), '">');
      inlineInto(out, s.slice(best + 1, k), env);
      out.push('</a>');
      i = m + 1;
      continue;
    }
    out.push('[');
    i = best + 1;
  }
}

function inlineStr(s, env) {
  const out = [];
  inlineInto(out, s, env);
  return out.join('');
}

// Render one body; returns {html, toc, excerpt}. Fused lex+render: blocks are
// streamed straight into one output array (inline parts included), so no
// per-block string is built except a heading's HTML (needed for the toc)
// and the first paragraph's (needed for the excerpt).
function renderMarkdown(src, env, slugCache) {
  const lines = src.split('\n');
  const out = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  const L = lines.length;
  while (i < L) {
    const line = lines[i];
    if (isBlankLine(line)) { i++; continue; }
    const lang = fenceLang(line);
    if (lang !== null) {
      out.push('<pre><code');
      if (lang !== '') { out.push(' class="language-', esc(lang), '"'); }
      out.push('>');
      i++;
      while (i < L && !isFenceClose(lines[i])) { out.push(esc(lines[i]), '\n'); i++; }
      i++;
      out.push('</code></pre>', '\n');
      continue;
    }
    const hd = headingOf(line);
    if (hd !== null) {
      const id = uniqueSlug(slugify(hd.text, slugCache), ids);
      const html = inlineStr(hd.text, env);
      out.push('<h', String(hd.depth), ' id="', id, '">', html, '</h', String(hd.depth), '>', '\n');
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) { out.push('<hr>', '\n'); i++; continue; }
    if (line.charCodeAt(0) === 62) { // '>'
      const body = [];
      while (i < L && lines[i].charCodeAt(0) === 62) {
        let l = lines[i].slice(1);
        if (l.charCodeAt(0) === 32) l = l.slice(1);
        body.push(l);
        i++;
      }
      const kept = [];
      for (let k = 0; k < body.length; k++) { const t = trimLine(body[k]); if (t !== '') kept.push(t); }
      if (kept.length === 0) out.push('<blockquote>\n</blockquote>', '\n');
      else {
        out.push('<blockquote>\n<p>');
        inlineInto(out, kept.join('\n'), env);
        out.push('</p>\n</blockquote>', '\n');
      }
      continue;
    }
    const c0 = line.charCodeAt(0);
    let bullet = null, ordered = null;
    if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) bullet = line.slice(2);
    else {
      // ordered: 1-9 digits, '. '
      let d = 0, num = 0;
      while (d < 9 && d < line.length) {
        const cc = line.charCodeAt(d);
        if (cc < 48 || cc > 57) break;
        num = num * 10 + (cc - 48);
        d++;
      }
      if (d > 0 && line.charCodeAt(d) === 46 && line.charCodeAt(d + 1) === 32) ordered = { start: num, text: line.slice(d + 2) };
    }
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      const firstText = isOrdered ? ordered.text : bullet;
      items.push([trimLine(firstText)]);
      let start = isOrdered ? ordered.start : 1;
      i++;
      while (i < L) {
        const ln = lines[i];
        if (isOrdered) {
          let d = 0, num = 0;
          while (d < 9 && d < ln.length) {
            const cc = ln.charCodeAt(d);
            if (cc < 48 || cc > 57) break;
            num = num * 10 + (cc - 48);
            d++;
          }
          if (d > 0 && ln.charCodeAt(d) === 46 && ln.charCodeAt(d + 1) === 32) {
            items.push([trimLine(ln.slice(d + 2))]);
            i++;
            continue;
          }
        } else if ((ln.charCodeAt(0) === 45 || ln.charCodeAt(0) === 42) && ln.charCodeAt(1) === 32) {
          items.push([trimLine(ln.slice(2))]);
          i++;
          continue;
        }
        // continuation: /^ {2,}\S/
        let sp = 0;
        while (sp < ln.length && ln.charCodeAt(sp) === 32) sp++;
        if (sp >= 2 && sp < ln.length && !isWSCode(ln.charCodeAt(sp))) {
          items[items.length - 1].push(trimLine(ln));
          i++;
          continue;
        }
        break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? '<ol start="' + start + '">' : '<' + tag + '>';
      out.push(open, '\n');
      for (let k = 0; k < items.length; k++) {
        out.push('<li>');
        inlineInto(out, items[k].join('\n'), env);
        out.push('</li>\n');
      }
      out.push('</', tag, '>', '\n');
      continue;
    }
    // paragraph
    const body = [trimLine(line)];
    i++;
    while (i < L && !endsParagraph(lines[i])) { body.push(trimLine(lines[i])); i++; }
    const text = body.join('\n');
    if (excerpt === null) {
      excerpt = inlineStr(text, env);
      out.push('<p>', excerpt, '</p>', '\n');
    } else {
      out.push('<p>');
      inlineInto(out, text, env);
      out.push('</p>', '\n');
    }
  }
  return { html: out.join(''), toc, excerpt: excerpt === null ? '' : excerpt };
}

// ---------------------------------------------------------------- templates

// Memoization analysis: which names a template (transitively, through
// includes) reads from outside its own `for` bodies, and whether it reads
// `loop` from an enclosing loop. A template may be cached only when every
// such name is case-constant: not a render variable (page/posts/pager/tag)
// and not any template's loop variable. The analysis is computed per
// (template, enclosing loop-variable set) and cached per case.
const CONST_KEY = {};

function analyzeRange(ops, start, end, templates, enclosing, internal, hasEnclosingFor, visiting, out) {
  if (!out.ok) return;
  for (let pc = start; pc < end; pc++) {
    const op = ops[pc];
    if (op[0] === 0) continue;
    if (op[0] === 1) {
      const first = op[1][0];
      if (first === 'loop') {
        if (internal.size === 0 && hasEnclosingFor) out.usesLoop = true;
      } else if (internal.has(first)) {
        // bound by a `for` inside this template: pure.
      } else if (enclosing.has(first)) out.usedEnclosing.add(first);
      else out.ext.add(first);
      continue;
    }
    if (op[0] === 3) {
      const first = op[1][0];
      if (first === 'loop') {
        if (internal.size === 0 && hasEnclosingFor) out.usesLoop = true;
      } else if (internal.has(first)) {
        // pure
      } else if (enclosing.has(first)) out.usedEnclosing.add(first);
      else out.ext.add(first);
      analyzeRange(ops, op[3], op[4], templates, enclosing, internal, hasEnclosingFor, visiting, out);
      if (op[5] !== -1) analyzeRange(ops, op[5], op[6], templates, enclosing, internal, hasEnclosingFor, visiting, out);
      pc = (op[5] !== -1 ? op[6] : op[4]) - 1;
      continue;
    }
    if (op[0] === 4) {
      const first = op[2][0];
      if (first === 'loop') {
        if (internal.size === 0 && hasEnclosingFor) out.usesLoop = true;
      } else if (internal.has(first)) {
        // pure
      } else if (enclosing.has(first)) out.usedEnclosing.add(first);
      else out.ext.add(first);
      const inner = new Set(internal);
      inner.add(op[1]);
      analyzeRange(ops, op[3], op[4], templates, enclosing, inner, hasEnclosingFor, visiting, out);
      pc = op[4] - 1;
      continue;
    }
    // include
    const t = templates.get(op[1]);
    if (t === undefined) continue;
    if (visiting.has(op[1])) { out.ok = false; return; }
    visiting.add(op[1]);
    analyzeRange(t, 0, t.length, templates, enclosing, internal, hasEnclosingFor, visiting, out);
    visiting.delete(op[1]);
  }
}

function analyzeTemplate(name, templates, analysisCache, enclosing) {
  const key = name + '\0' + [...enclosing].sort().join('\0');
  if (analysisCache.has(key)) return analysisCache.get(key);
  const ops = templates.get(name);
  let res = null;
  if (ops !== undefined) {
    const out = { ext: new Set(), usedEnclosing: new Set(), usesLoop: false, ok: true };
    analyzeRange(ops, 0, ops.length, templates, enclosing, new Set(), enclosing.size > 0, new Set([name]), out);
    if (out.ok) res = out;
  }
  analysisCache.set(key, res);
  return res;
}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError('template "' + name + '": ' + JSON.stringify(text) + ' is not a path');
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) { text += src.slice(i); break; }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') { text += src.slice(i, open + 1); i = open + 1; continue; }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError('template "' + name + '": a ' + (raw ? '{{{' : '{{') + ' is not closed');
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError('template "' + name + '": a {% is not closed');
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    let standalone = true;
    for (let k = lineStart; k < open; k++) { const c = src.charCodeAt(k); if (c !== 32 && c !== 9) { standalone = false; break; } }
    if (standalone) for (let k = end; k < lineEnd; k++) { const c = src.charCodeAt(k); if (c !== 32 && c !== 9) { standalone = false; break; } }
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

// Compile to flat ops:
//   [0, text]  [1, path, raw?]  [3, path, not, thenStart, thenEnd, elseStart, elseEnd]
//   [4, varName, path, bodyStart, bodyEnd]  [5, includeName]
function compileTemplate(name, src) {
  const ops = [];
  const stack = [];
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') ops.push([0, tok.text]);
    else if (tok.t === 'var' || tok.t === 'raw') ops.push([1, tok.path, tok.t === 'raw']);
    else {
      const tag = tok.tag;
      const top = stack.length ? stack[stack.length - 1] : null;
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const op = [4, m[1], pathOf(name, m[2]), ops.length + 1, -1];
        ops.push(op);
        stack.push({ kind: 'for', op });
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const op = [3, pathOf(name, m[2]), m[1] !== undefined, ops.length + 1, -1, -1, -1];
        ops.push(op);
        stack.push({ kind: 'if', op });
      } else if (tag === 'else') {
        if (top === null || top.kind !== 'if' || top.op[5] !== -1)
          throw new TemplateError('template "' + name + '": an else outside an if');
        top.op[4] = ops.length; // then ends here
        top.op[5] = ops.length; // else starts here
      } else if (tag === 'endfor' || tag === 'endif') {
        const want = tag === 'endfor' ? 'for' : 'if';
        if (top === null || top.kind !== want)
          throw new TemplateError('template "' + name + '": an ' + tag + ' with no open ' + tag.slice(3));
        if (want === 'for') top.op[4] = ops.length;
        else if (top.op[5] !== -1) top.op[6] = ops.length;
        else top.op[4] = ops.length;
        stack.pop();
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) ops.push([5, m[1]]);
      else throw new TemplateError('template "' + name + '": {% ' + tag + ' %} is not a tag');
    }
  }
  if (stack.length > 0) throw new TemplateError('template "' + name + '": a ' + stack[stack.length - 1].kind + ' is not closed');
  return ops;
}

function lookup(frames, path) {
  const first = path[0];
  for (let f = frames.length - 1; f >= 0; f--) {
    const vars = frames[f];
    if (Object.hasOwn(vars, first)) {
      let v = vars[first];
      for (let k = 1; k < path.length; k++) {
        if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
        v = v[path[k]];
      }
      return v;
    }
  }
  return undefined;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let k = 0; k < v.length; k++) { if (k > 0) s += ', '; s += textOf(v[k]); }
    return s;
  }
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function renderOps(ops, start, end, frames, templates, out, depth, ctx) {
  for (let pc = start; pc < end; pc++) {
    const op = ops[pc];
    switch (op[0]) {
      case 0:
        out.push(op[1]);
        break;
      case 1: {
        const v = lookup(frames, op[1]);
        if (op[2]) { if (v !== undefined && v !== null) out.push(textOf(v)); }
        else if (typeof v === 'string') out.push(esc(v));
        else if (typeof v === 'number' || typeof v === 'boolean') out.push(String(v));
        else if (Array.isArray(v)) out.push(esc(textOf(v)));
        break;
      }
      case 3: {
        const v = truthy(lookup(frames, op[1]));
        if (v !== op[2]) {
          renderOps(ops, op[3], op[4], frames, templates, out, depth, ctx);
          pc = (op[5] !== -1 ? op[6] : op[4]) - 1;
        } else if (op[5] !== -1) {
          renderOps(ops, op[5], op[6], frames, templates, out, depth, ctx);
          pc = op[6] - 1;
        } else pc = op[4] - 1;
        break;
      }
      case 4: {
        const xs = lookup(frames, op[2]);
        if (Array.isArray(xs)) {
          const len = xs.length;
          for (let k = 0; k < len; k++) {
            const vars = { [op[1]]: xs[k], loop: { index: k + 1, first: k === 0, last: k === len - 1, length: len } };
            frames.push(vars);
            renderOps(ops, op[3], op[4], frames, templates, out, depth, ctx);
            frames.pop();
          }
        }
        pc = op[4] - 1;
        break;
      }
      case 5: {
        const t = templates.get(op[1]);
        if (t === undefined || depth >= INCLUDE_DEPTH) break;
        // Memoize the include when the included template provably depends
        // only on case-constant values, or only on the innermost loop's
        // object: then its output is a pure function of that key.
        const enclosing = new Set();
        let topLoopVar = null, topLoopObj = null;
        for (let f = 2; f < frames.length; f++) {
          const fr = frames[f];
          if (Object.hasOwn(fr, 'loop')) {
            const ks = Object.keys(fr);
            const vn = ks[0] === 'loop' ? ks[1] : ks[0];
            enclosing.add(vn);
            if (f === frames.length - 1) { topLoopVar = vn; topLoopObj = fr[vn]; }
          }
        }
        const res = analyzeTemplate(op[1], templates, ctx.analysisCache, enclosing);
        let memoKey = null;
        if (res !== null && !res.usesLoop) {
          let extVolatile = false;
          for (const n of res.ext) if (ctx.volatileNames.has(n)) { extVolatile = true; break; }
          if (!extVolatile) {
            if (res.usedEnclosing.size === 0) memoKey = CONST_KEY;
            else if (topLoopVar !== null && res.usedEnclosing.size === 1 && res.usedEnclosing.has(topLoopVar)) memoKey = topLoopObj;
          }
        }
        if (memoKey !== null) {
          let perName = ctx.memo.get(op[1]);
          if (perName === undefined) { perName = new Map(); ctx.memo.set(op[1], perName); }
          let perObj = perName.get(memoKey);
          if (perObj === undefined) { perObj = new Map(); perName.set(memoKey, perObj); }
          let s = perObj.get(depth + 1);
          if (s === undefined) {
            const tmp = [];
            renderOps(t, 0, t.length, frames, templates, tmp, depth + 1, ctx);
            s = tmp.join('');
            perObj.set(depth + 1, s);
          }
          out.push(s);
          break;
        }
        renderOps(t, 0, t.length, frames, templates, out, depth + 1, ctx);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- build

export function run(input) {
  const slugCache = new Map();
  const base = input.site.base_url.replace(/\/+$/, '');
  const report = [];
  const templates = new Map();
  const names = Object.keys(input.templates).sort(cmp);
  for (let k = 0; k < names.length; k++) {
    const name = names[k];
    try {
      templates.set(name, compileTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  // 1. Sources, sorted by path.
  const files = [...input.files].sort((x, y) => cmp(x.path, y.path));
  const sources = [];
  const statics = [];
  for (let k = 0; k < files.length; k++) {
    const f = files[k];
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter + checks, in order.
  const kept = [];
  for (let k = 0; k < sources.length; k++) {
    const s = sources[k];
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) { report.push('refused ' + s.path + ': ' + fm.error); continue; }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = undefined;
    for (let d = 0; d < RESERVED.length; d++) {
      if (RESERVED[d] !== 'posts' && s.path.startsWith(RESERVED[d] + '/')) { own = RESERVED[d]; break; }
    }
    if (own !== undefined) { report.push('refused ' + s.path + ': ' + own + '/ is the generator\'s own'); continue; }
    if (s.post && !Object.hasOwn(s.data, 'date')) { report.push('refused ' + s.path + ': a post needs a date'); continue; }
    const layout = s.data.layout !== undefined ? s.data.layout : (s.post ? 'post' : 'page');
    if (!templates.has(layout)) { report.push('refused ' + s.path + ': layout "' + layout + '" is no template that parses'); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push('draft ' + s.path); continue; }
    kept.push(s);
  }

  // 3. Permalinks.
  const takenByDir = new Map();
  const bySource = new Map();
  for (let k = 0; k < kept.length; k++) {
    const s = kept[k];
    const dir = s.post ? 'posts' : dirOf(s.path);
    let taken = takenByDir.get(dir);
    if (taken === undefined) { taken = new Set(dir === '' ? RESERVED : []); takenByDir.set(dir, taken); }
    const slug = uniqueSlug(s.data.slug !== undefined ? s.data.slug : slugify(s.data.title, slugCache), taken);
    s.slug = slug;
    s.outDir = dir === '' ? slug : dir + '/' + slug;
    s.url = base + '/' + s.outDir + '/';
    bySource.set(s.path, s);
  }

  // 4. Markdown + link resolution.
  const staticPaths = new Set();
  for (let k = 0; k < statics.length; k++) staticPaths.add(statics[k].path);
  const broken = new Set();
  for (let k = 0; k < kept.length; k++) {
    const s = kept[k];
    const dir = dirOf(s.path);
    const spath = s.path;
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null) {
          const pg = bySource.get(path);
          if (pg !== undefined) return pg.url + frag;
          if (staticPaths.has(path)) return base + '/' + path + frag;
        }
        broken.add('broken-link ' + spath + ' -> ' + target);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections.
  const posts = [];
  for (let k = 0; k < kept.length; k++) if (kept[k].post) posts.push(kept[k]);
  posts.sort((x, y) => cmp(y.data.date, x.data.date) || cmp(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. Tags.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const tags = s.data.tags !== undefined ? s.data.tags : [];
    const out = [];
    for (let k = 0; k < tags.length; k++) {
      const sl = slugify(tags[k], slugCache);
      if (!seen.has(sl)) { seen.add(sl); out.push(tags[k]); }
    }
    return out;
  };
  for (let k = 0; k < posts.length; k++) {
    const p = posts[k];
    p.tagRefs = [];
    const names2 = ownTags(p);
    for (let j = 0; j < names2.length; j++) {
      const name = names2[j];
      const slug = slugify(name, slugCache);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: base + '/tags/' + slug + '/', posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (let k = 0; k < kept.length; k++) {
    const s = kept[k];
    if (s.post) continue;
    const names2 = ownTags(s);
    s.tagRefs = [];
    for (let j = 0; j < names2.length; j++) {
      const name = names2[j];
      const slug = slugify(name, slugCache);
      const t = bySlug.get(slug);
      s.tagRefs.push(t !== undefined ? t : { name, slug, url: '', posts: [] });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || cmp(x.slug, y.slug));

  // Cards (computed once, reused by pages, index, tags, recent).
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date !== undefined ? s.data.date : '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary !== undefined ? s.data.summary : '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map();
  for (let k = 0; k < kept.length; k++) cards.set(kept[k], cardOf(kept[k]));

  // 7. Layouts.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const baseFrame = { site, tags: allTags, recent };
  // Names whose value can change between renders: the render variables and
  // every template's loop variable. A memoized include must not read one.
  const volatileNames = new Set(['page', 'posts', 'pager', 'tag']);
  for (const ops of templates.values()) {
    for (let k = 0; k < ops.length; k++) if (ops[k][0] === 4) volatileNames.add(ops[k][1]);
  }
  const ctx = { volatileNames, analysisCache: new Map(), memo: new Map() };
  const render = (name, vars) => {
    const ops = templates.get(name);
    if (ops === undefined) return null;
    const out = [];
    renderOps(ops, 0, ops.length, [baseFrame, vars], templates, out, 0, ctx);
    return out.join('');
  };
  const linkOf = (s) => s === null ? null : {
    title: s.data.title, url: s.url,
    date: s.data.date !== undefined ? s.data.date : '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
  };
  for (let k = 0; k < kept.length; k++) {
    const s = kept[k];
    const card = cards.get(s);
    const page = {
      title: card.title, url: card.url, date: card.date, date_long: card.date_long,
      summary: card.summary, excerpt: card.excerpt, reading_minutes: card.reading_minutes, tags: card.tags,
      slug: s.slug, content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer !== undefined ? s.newer : null),
      older: linkOf(s.older !== undefined ? s.older : null),
      is_post: s.post,
    };
    output[s.outDir + '/index.html'] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => k === 1 ? base + '/' : base + '/page/' + k + '/';
  for (let k = 1; k <= pages; k++) {
    const slice = posts.slice((k - 1) * per, k * per).map((p) => cards.get(p));
    const html = render('index', {
      posts: slice,
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = html;
  }
  for (let k = 0; k < tags.length; k++) {
    const t = tags[k];
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) },
    });
    if (html !== null) output['tags/' + t.slug + '/index.html'] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (let k = 0; k < statics.length; k++) {
    const f = statics[k];
    if (Object.hasOwn(output, f.path)) report.push('shadowed ' + f.path + ': a built page has its path');
    else output[f.path] = f.content;
  }

  // 8. Report.
  const lines = [...report, ...broken].sort(cmp);
  let pageCount = 0;
  for (let k = 0; k < kept.length; k++) if (!kept[k].post) pageCount++;
  lines.push('built ' + pageCount + ' pages, ' + posts.length + ' posts, ' + tags.length + ' tags and ' + statics.length + ' static files');
  output['build-report.txt'] = lines.join('\n') + '\n';
  return output;
}
