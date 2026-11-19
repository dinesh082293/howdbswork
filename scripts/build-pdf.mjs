// Printable PDFs of the cheat sheet, one per engine, in assets/pdf/.
// Uses the page's own print styles (body[data-print]) and Playwright's Chromium.
// Serve the site first: python3 -m http.server 8765, then run from the site root:
//   node scripts/build-pdf.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = new URL('..', import.meta.url).pathname;
const BASE = process.env.SITE_URL || 'http://localhost:8765/';
const NAMES = { pg: 'PostgreSQL', my: 'MySQL', mo: 'MongoDB' };
const b = await chromium.launch();
const p = await b.newPage();
await p.emulateMedia({ media: 'print', colorScheme: 'light' });
for (const e of Object.keys(NAMES)) {
  await p.goto(BASE + 'cheat-sheet/index.html', { waitUntil: 'load' });
  await p.evaluate(e => {
    document.body.setAttribute('data-print', e);
    document.querySelectorAll('.secnav,.crumbs,.continue,.goals,.tocbtn,.readbar,#siteSearchResults,.hero .learn,.hero .readtime,.hero .qline,aside.myth,#cheatsheet > .wrap > .kicker,#cheatsheet > .wrap > h2,#cheatsheet > .wrap > p,.cs-jump,footer,.printbar').forEach(n => n.remove());
    document.querySelectorAll('.hero').forEach(n => n.remove());
    // links in the PDF point at the live site, not the local server
    document.querySelectorAll('a[href]').forEach(a => { const u = new URL(a.href); if (u.hostname === location.hostname) a.href = 'https://howdbswork.com' + u.pathname + u.hash; });
    const st = document.createElement('style'); st.textContent = '@media print{.cs-panel{break-inside:auto !important}.cs-rule{break-inside:avoid}section{padding:0 !important}}'; document.head.appendChild(st);
  }, e);
  await p.pdf({
    path: `${ROOT}assets/pdf/cheat-sheet-${e}.pdf`, format: 'A4', printBackground: true, scale: 0.82,
    margin: { top: '14mm', bottom: '16mm', left: '12mm', right: '12mm' },
    displayHeaderFooter: true, headerTemplate: '<span></span>',
    footerTemplate: `<div style="font:8px sans-serif;width:100%;padding:0 12mm;display:flex;justify-content:space-between;color:#555"><span>${NAMES[e]} cheat sheet · Real databases, simply · howdbswork.com/cheat-sheet/</span><span><span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`
  });
}
await b.close();
console.log('cheat sheet PDFs written');
