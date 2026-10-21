// Baut aus dem Obsidian-Vault eine statische Lese-Website:
// links der Ordnerbaum, rechts der Notiztext. Nur lesen, nichts bearbeiten.
//
//   node .site/build.mjs            -> .site/dist/
//   OUT_DIR=_site node build.mjs    -> eigenes Zielverzeichnis (GitHub Actions)

import { Marked } from 'marked';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE_DIR = path.dirname(fileURLToPath(import.meta.url));
const VAULT = path.resolve(SITE_DIR, '..');
const OUT = process.env.OUT_DIR ? path.resolve(process.env.OUT_DIR) : path.join(SITE_DIR, 'dist');
const TEMPLATE = path.join(SITE_DIR, 'template');

const SITE_TITLE = 'Theologie';
// Ordner, die nie auf die Seite kommen (zusätzlich zu allem, was mit "." beginnt).
const EXCLUDE = new Set(['Privat', 'node_modules']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif']);

const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });
const nfc = (s) => s.normalize('NFC');

function slugify(s) {
  return (
    nfc(s)
      .toLowerCase()
      .replace(/ä/g, 'ae')
      .replace(/ö/g, 'oe')
      .replace(/ü/g, 'ue')
      .replace(/ß/g, 'ss')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'x'
  );
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------------------------------------------------------------- Vault lesen

const notes = []; // { name, rel, dir, slug, src }
const attachments = new Map(); // dateiname (klein) -> { abs, url }
const usedSlugs = new Set();

function uniqueSlug(base) {
  let slug = base;
  for (let i = 2; usedSlugs.has(slug); i++) slug = `${base}-${i}`;
  usedSlugs.add(slug);
  return slug;
}

function walk(absDir, relParts) {
  const entries = fs
    .readdirSync(absDir, { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.') && !EXCLUDE.has(nfc(e.name)));

  const folders = [];
  const files = [];

  for (const e of entries) {
    const name = nfc(e.name);
    const abs = path.join(absDir, e.name);
    if (e.isDirectory()) {
      const children = walk(abs, [...relParts, name]);
      if (children.length) folders.push({ n: name, c: children });
      continue;
    }
    const ext = path.extname(name).toLowerCase();
    if (ext === '.md') {
      const src = nfc(fs.readFileSync(abs, 'utf8'));
      if (!src.trim()) continue; // leere Platzhalter-Notizen nicht anzeigen
      const title = name.slice(0, -3);
      const note = {
        name: title,
        rel: [...relParts, title].join('/'),
        dir: relParts.join('/'),
        slug: uniqueSlug([...relParts, title].map(slugify).join('/')),
        src,
      };
      notes.push(note);
      files.push({ n: title, s: note.slug });
    } else if (IMAGE_EXT.has(ext)) {
      const url = `files/${uniqueSlug('files/' + slugify(name.slice(0, -ext.length))).slice(6)}${ext}`;
      attachments.set(name.toLowerCase(), { abs, url });
    }
  }

  folders.sort((a, b) => collator.compare(a.n, b.n));
  files.sort((a, b) => collator.compare(a.n, b.n));
  return [...folders, ...files];
}

const tree = walk(VAULT, []);

// ---------------------------------------------------------- Links auflösen

const byName = new Map();
const byPath = new Map();
for (const n of notes) {
  const key = n.name.toLowerCase();
  if (!byName.has(key)) byName.set(key, []);
  byName.get(key).push(n);
  byPath.set(n.rel.toLowerCase(), n);
}

function resolve(target, from) {
  const t = nfc(target).split('#')[0].trim().replace(/\.md$/i, '');
  if (!t) return from;
  const lower = t.toLowerCase();
  if (byPath.has(lower)) return byPath.get(lower);
  if (lower.includes('/')) {
    const hit = notes.find((n) => n.rel.toLowerCase().endsWith('/' + lower));
    if (hit) return hit;
  }
  const cands = byName.get(lower.split('/').pop()) || [];
  if (cands.length <= 1) return cands[0];
  return cands.find((n) => from && n.dir === from.dir) || [...cands].sort((a, b) => a.rel.length - b.rel.length)[0];
}

// In Tabellen schreibt Obsidian den Alias-Trenner als "\|".
function splitAlias(inner) {
  const s = inner.replace(/\\\|/g, '|');
  const i = s.indexOf('|');
  return i < 0 ? [s.trim(), ''] : [s.slice(0, i).trim(), s.slice(i + 1).trim()];
}

function displayName(target) {
  const [file, ...heading] = target.split('#');
  const base = file.split('/').pop();
  return heading.length ? `${base} › ${heading.join(' › ')}` : base;
}

const linkTo = (note, label) => `<a class="internal-link" href="#/${note.slug}">${label}</a>`;

// ------------------------------------------------------------ Markdown

const ctx = { note: null, depth: 0 };

function renderEmbed(inner, block) {
  const [target, alias] = splitAlias(inner);
  const file = target.split('#')[0].trim();
  const ext = path.extname(file).toLowerCase();

  if (IMAGE_EXT.has(ext)) {
    const att = attachments.get(file.split('/').pop().toLowerCase());
    if (!att) return `<span class="unresolved">${esc(file)}</span>`;
    const size = /^(\d+)(x\d+)?$/.exec(alias);
    const width = size ? ` width="${size[1]}"` : '';
    const alt = alias && !size ? esc(alias) : '';
    return `<img src="${att.url}" alt="${alt}" loading="lazy"${width}>`;
  }

  const note = resolve(target, ctx.note);
  const label = esc(alias || displayName(target));
  if (!note) return `<span class="unresolved">${label}</span>`;
  if (!block || ctx.depth >= 2 || note === ctx.note) return linkTo(note, label);

  ctx.depth++;
  const body = renderNote(note);
  ctx.depth--;
  return (
    `<div class="embed"><div class="embed-title">${linkTo(note, esc(note.name))}</div>` +
    `<div class="embed-body">${body}</div></div>`
  );
}

const CALLOUT_ICON = {
  note: 'pencil', abstract: 'list', summary: 'list', tldr: 'list', info: 'info', todo: 'check',
  tip: 'flame', hint: 'flame', important: 'flame', success: 'check', check: 'check', done: 'check',
  question: 'help', help: 'help', faq: 'help', warning: 'alert', caution: 'alert', attention: 'alert',
  failure: 'x', fail: 'x', missing: 'x', danger: 'zap', error: 'zap', bug: 'bug',
  example: 'list', quote: 'quote', cite: 'quote',
};

const md = new Marked({ gfm: true, breaks: true });
md.use({
  extensions: [
    {
      name: 'callout',
      level: 'block',
      start(src) {
        const m = src.match(/^ {0,3}> ?\[!/m);
        return m ? m.index : undefined;
      },
      tokenizer(src) {
        const m = /^ {0,3}> ?\[!([^\]\s]+)\]([+-]?)[ \t]*([^\n]*)(?:\n|$)((?: {0,3}>[^\n]*(?:\n|$))*)/.exec(src);
        if (!m) return;
        const kind = m[1].toLowerCase();
        const title = m[3].trim() || kind.charAt(0).toUpperCase() + kind.slice(1);
        const token = { type: 'callout', raw: m[0], kind, fold: m[2], tokens: [], titleTokens: [] };
        this.lexer.blockTokens(m[4].replace(/^ {0,3}> ?/gm, ''), token.tokens);
        this.lexer.inline(title, token.titleTokens);
        return token;
      },
      renderer(t) {
        const icon = CALLOUT_ICON[t.kind] || 'pencil';
        const head =
          `<span class="callout-icon" data-icon="${icon}"></span>` +
          `<span class="callout-title-inner">${this.parser.parseInline(t.titleTokens)}</span>`;
        const body = `<div class="callout-content">${this.parser.parse(t.tokens)}</div>`;
        const kind = esc(t.kind);
        if (t.fold) {
          return (
            `<details class="callout" data-callout="${kind}"${t.fold === '+' ? ' open' : ''}>` +
            `<summary class="callout-title">${head}<span class="callout-fold"></span></summary>${body}</details>\n`
          );
        }
        return `<div class="callout" data-callout="${kind}"><div class="callout-title">${head}</div>${body}</div>\n`;
      },
      childTokens: ['titleTokens'],
    },
    {
      name: 'embedBlock',
      level: 'block',
      start(src) {
        const m = src.match(/^!\[\[/m);
        return m ? m.index : undefined;
      },
      tokenizer(src) {
        const m = /^!\[\[([^\]\n]+)\]\][ \t]*(?:\n+|$)/.exec(src);
        if (m) return { type: 'embedBlock', raw: m[0], inner: m[1] };
      },
      renderer(t) {
        return renderEmbed(t.inner, true) + '\n';
      },
    },
    {
      name: 'embedInline',
      level: 'inline',
      start(src) {
        const i = src.indexOf('![[');
        return i < 0 ? undefined : i;
      },
      tokenizer(src) {
        const m = /^!\[\[([^\]\n]+)\]\]/.exec(src);
        if (m) return { type: 'embedInline', raw: m[0], inner: m[1] };
      },
      renderer(t) {
        return renderEmbed(t.inner, false);
      },
    },
    {
      name: 'wikilink',
      level: 'inline',
      start(src) {
        const i = src.indexOf('[[');
        return i < 0 ? undefined : i;
      },
      tokenizer(src) {
        const m = /^\[\[([^\]\n]+)\]\]/.exec(src);
        if (!m) return;
        const [target, alias] = splitAlias(m[1]);
        return { type: 'wikilink', raw: m[0], target, alias };
      },
      renderer(t) {
        const note = resolve(t.target, ctx.note);
        const label = esc(t.alias || displayName(t.target));
        return note ? linkTo(note, label) : `<span class="unresolved">${label}</span>`;
      },
    },
    {
      name: 'highlight',
      level: 'inline',
      start(src) {
        const i = src.indexOf('==');
        return i < 0 ? undefined : i;
      },
      tokenizer(src) {
        const m = /^==(?=\S)([\s\S]*?\S)==(?!=)/.exec(src);
        if (m) return { type: 'highlight', raw: m[0], tokens: this.lexer.inlineTokens(m[1]) };
      },
      renderer(t) {
        return `<mark>${this.parser.parseInline(t.tokens)}</mark>`;
      },
    },
  ],
  hooks: {
    preprocess: (src) => src.replace(/%%[\s\S]*?%%/g, ''), // Obsidian-Kommentare
    postprocess: (html) =>
      html
        .replace(/<table>/g, '<div class="table-wrap"><table>')
        .replace(/<\/table>/g, '</table></div>')
        .replace(/<a href="(https?:\/\/[^"]+)"/g, '<a href="$1" target="_blank" rel="noopener"'),
  },
});

function renderNote(note) {
  const prev = ctx.note;
  ctx.note = note;
  try {
    return md.parse(note.src);
  } finally {
    ctx.note = prev;
  }
}

// ------------------------------------------------------------ Ausgabe

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'n'), { recursive: true });

for (const note of notes) {
  const file = path.join(OUT, 'n', `${note.slug}.html`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, renderNote(note));
}

for (const { abs, url } of attachments.values()) {
  fs.mkdirSync(path.join(OUT, path.dirname(url)), { recursive: true });
  fs.copyFileSync(abs, path.join(OUT, url));
}

const css = fs.readFileSync(path.join(TEMPLATE, 'style.css'), 'utf8');
const js = fs.readFileSync(path.join(TEMPLATE, 'app.js'), 'utf8');
const version = crypto.createHash('sha1').update(css + js).digest('hex').slice(0, 8);
fs.writeFileSync(path.join(OUT, 'style.css'), css);
fs.writeFileSync(path.join(OUT, 'app.js'), js);

const html = fs
  .readFileSync(path.join(TEMPLATE, 'index.html'), 'utf8')
  .replaceAll('{{TITLE}}', esc(SITE_TITLE))
  .replaceAll('{{V}}', version)
  .replace('{{TREE}}', () => JSON.stringify(tree).replace(/</g, '\\u003c'));
fs.writeFileSync(path.join(OUT, 'index.html'), html);
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

console.log(`${notes.length} Notizen, ${attachments.size} Bilder -> ${path.relative(process.cwd(), OUT) || OUT}`);
