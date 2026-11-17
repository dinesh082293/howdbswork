#!/usr/bin/env node
// Prerender the Staff Path levels and the Reference atlas into
// staff-path/index.html so crawlers see the content without JavaScript.
//
// It reuses the real renderers from assets/js/main.js: it slices out the
// LEVELS / renderPair / REFS / REF_EXTRA / renderRefs code, evaluates it
// against a minimal DOM stub, and injects the rendered markup into the
// page. The browser JavaScript keeps working unchanged: the levels
// renderer skips its work when the container already has children, and
// renderRefs() clears and re-renders the atlas on load and on every
// search/filter input, so the prerendered markup is replaced by identical
// markup the moment the script runs.
//
// Idempotent: re-running replaces the previously prerendered markup.
// Run from the site root: node scripts/prerender.js
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const mainJs = fs.readFileSync(path.join(root, 'assets/js/main.js'), 'utf8');

function slice(from, to) {
  const a = mainJs.indexOf(from);
  if (a === -1) throw new Error('marker not found: ' + from);
  const b = mainJs.indexOf(to, a + from.length);
  if (b === -1) throw new Error('end marker not found: ' + to);
  return mainJs.slice(a, b);
}

// The exact code the browser runs, extracted by markers.
const code = [
  slice('var LEVELS=[', '\n];\nvar done=') + '\n];',
  "var done={}; var levelsEl=document.getElementById('levels');",
  slice('var LEVEL_MINS=', '\nif(levelsEl){'),
  slice('function renderPair(P){', '\nvar LEVEL_MINS='),
  slice('if(levelsEl){', '\nvar PAGES='),
  slice('var REFS=[', '\n];\nvar REF_EXTRA=') + '\n];',
  slice('var REF_EXTRA={', '\n};\nvar refFilter=') + '\n};',
  "var refFilter='all';",
  slice('function renderRefs(){', "\n}\nif(document.getElementById('refGrid'))") + '\n}',
  slice("if(document.getElementById('refGrid')){", '\nvar QUIZ='),
].join('\n');

// Minimal DOM stub: only what the two renderers touch.
function makeEl() {
  const el = {
    children: [],
    _innerHTML: '',
    className: '',
    id: '',
    textContent: '',
    value: '',
    style: {},
    set innerHTML(v) { this._innerHTML = v; if (v === '') this.children = []; },
    get innerHTML() { return this._innerHTML; },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener() {},
    setAttribute() {},
    getAttribute() { return null; },
    classList: { add() {}, toggle() {}, contains() { return false; } },
    querySelectorAll() { return []; },
    closest() { return null; },
    parentElement: null,
  };
  return el;
}
const elements = {};
const documentStub = {
  getElementById(id) {
    if (!elements[id]) { elements[id] = makeEl(); elements[id].id = id; }
    return elements[id];
  },
  createElement() { return makeEl(); },
  querySelectorAll() { return []; },
};

new Function('document', code)(documentStub);

function serialize(children) {
  return children.map((c) => {
    const cls = c.className ? ' class="' + c.className + '"' : '';
    const id = c.id ? ' id="' + c.id + '"' : '';
    return '<div' + cls + id + '>' + c.innerHTML + '</div>';
  }).join('\n');
}

const levelsHtml = serialize(elements.levels.children);
const refsHtml = serialize(elements.refGrid.children);
const refCount = elements.refCount.textContent;
if (!levelsHtml || !refsHtml || !refCount) {
  throw new Error('prerender produced nothing: levels=' + levelsHtml.length +
    ' refs=' + refsHtml.length + ' count=' + JSON.stringify(refCount));
}

// Replace a <div ... id="...">...</div> block by depth counting, so the
// script works whether the container is empty or already prerendered.
function replaceDiv(html, id, inner) {
  const openRe = new RegExp('<div[^>]*\\bid="' + id + '"[^>]*>');
  const m = openRe.exec(html);
  if (!m) throw new Error('container not found: #' + id);
  const start = m.index;
  const openEnd = start + m[0].length;
  let depth = 1;
  const tagRe = /<\/?div\b[^>]*>/g;
  tagRe.lastIndex = openEnd;
  let t;
  let closeStart = -1;
  while ((t = tagRe.exec(html)) !== null) {
    if (t[0].startsWith('</')) {
      depth -= 1;
      if (depth === 0) { closeStart = t.index; break; }
    } else {
      depth += 1;
    }
  }
  if (closeStart === -1) throw new Error('no matching close for #' + id);
  const closeEnd = html.indexOf('>', closeStart) + 1;
  return html.slice(0, openEnd) + '\n' + inner + '\n' +
    html.slice(closeStart, closeEnd) + html.slice(closeEnd);
}

const pagePath = path.join(root, 'staff-path/index.html');
let page = fs.readFileSync(pagePath, 'utf8');
page = replaceDiv(page, 'levels', levelsHtml);
page = replaceDiv(page, 'refGrid', refsHtml);
page = page.replace(
  /<p class="mono" id="refCount"[^>]*><\/p>/,
  (match) => match.replace(/><\/p>$/, '>' + refCount + '</p>'),
);
fs.writeFileSync(pagePath, page);
console.log('prerendered staff-path/index.html: ' +
  elements.levels.children.length + ' levels, ' +
  elements.refGrid.children.length + ' ref cards, count="' + refCount + '"');
