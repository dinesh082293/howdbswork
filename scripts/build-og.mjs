// Share images (1200 x 630) for every page in assets/data/sitemap.json, plus
// the home page, written to assets/og/<slug>.png. Uses Playwright's Chromium.
// Run from the site root after adding or retitling a page:
//   node scripts/build-og.mjs            (only pages without an image)
//   node scripts/build-og.mjs --all      (redo every image)
// The images are then reduced to 64 colours with Pillow to keep them small:
//   python3 -c "from PIL import Image;import glob;[Image.open(f).convert('RGB').quantize(64).save(f,optimize=True) for f in glob.glob('assets/og/*.png')]"
// scripts/build-seo.py points each page's og:image at its file.
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = new URL('..', import.meta.url).pathname;
const sm = JSON.parse(readFileSync(ROOT + 'assets/data/sitemap.json', 'utf8'));
const all = process.argv.includes('--all');
const COL = { learn: '#2f6da3', practice: '#0f766e', design: '#b96a12', operate: '#c2185b', about: '#5b6b62' };
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const unesc = s => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
function info(rel) {
  const s = readFileSync(ROOT + rel, 'utf8');
  const h1 = (s.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [, ''])[1].replace(/<[^>]+>/g, '').trim();
  const q = (s.match(/class="(?:qline|lede)">([\s\S]*?)<\/p>/) || [, ''])[1].replace(/<[^>]+>/g, '').trim();
  return { h1: unesc(h1), q: unesc(q) };
}
const jobs = [['index.html', 'Real databases, simply', null, 0]];
let n = 0;
for (const sec of sm.sections) for (const [rel, title] of sec.pages) { if (sec.id !== 'about') n++; jobs.push([rel, title, sec, sec.id !== 'about' ? n : 0]); }
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1200, height: 630 } });
let made = 0;
for (const [rel, title, sec, num] of jobs) {
  const slug = rel === 'index.html' ? 'index' : rel.replace(/\/index\.html$/, '').replace(/\//g, '-');
  const out = ROOT + 'assets/og/' + slug + '.png';
  if (!all && existsSync(out)) continue;
  const { h1, q } = info(rel);
  const col = sec ? COL[sec.id] : '#131a17';
  const kick = sec ? sec.name : 'PostgreSQL · MySQL · MongoDB · Redis · Cassandra · vector search';
  const head = rel === 'index.html' ? 'How databases really work, from the files on disk up' : (h1 || title);
  const sub = rel === 'index.html' ? 'Internals, measured numbers, design docs for real applications, and what to do when it breaks.' : q;
  const size = head.length > 60 ? 54 : head.length > 36 ? 64 : 76;
  await p.setContent(`<html><body style="margin:0;width:1200px;height:630px;background:#fbfbf9;font-family:Inter,sans-serif;color:#131a17;position:relative;overflow:hidden">
  <div style="position:absolute;left:0;top:0;bottom:0;width:22px;background:${col}"></div>
  <div style="position:absolute;left:84px;right:84px;top:70px">
    <div style="font:600 22px/1.2 'DejaVu Sans Mono',monospace;letter-spacing:.06em;text-transform:uppercase;color:${col}">${esc(kick)}</div>
    <div style="font:700 ${size}px/1.08 Gelasio,Georgia,serif;margin-top:26px;letter-spacing:-.01em">${esc(head)}</div>
    <div style="font:400 30px/1.35 Inter,sans-serif;color:#5b6b62;margin-top:26px;max-width:960px">${esc(sub)}</div>
  </div>
  <div style="position:absolute;left:84px;right:84px;bottom:56px;display:flex;justify-content:space-between;align-items:center;font:600 24px Inter,sans-serif">
    <span><span style="color:${col}">▦</span> Real databases, simply</span><span style="color:#5b6b62;font-weight:500">howdbswork.com</span></div>
  </body></html>`);
  await p.screenshot({ path: out });
  made++;
}
await b.close();
console.log(`share images: ${made} written, ${jobs.length} pages`);
