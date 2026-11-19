#!/usr/bin/env node
// howdbswork MCP server: lets an AI assistant answer database design questions
// from the design docs, formulas and lessons on howdbswork.com.
// No dependencies. Speaks MCP over stdio (newline-delimited JSON-RPC 2.0).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = JSON.parse(readFileSync(join(HERE, 'data.json'), 'utf8'));
const VERSION = '0.2.0';

// The Estimate it formulas, loaded from the same file the site uses.
function loadEstimates() {
  const ctx = { window: {}, document: { querySelectorAll: () => [], getElementById: () => null },
    location: { hash: '', pathname: '', search: '', origin: '' }, history: {}, navigator: {}, setTimeout, clearTimeout };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(join(HERE, 'estimate.js'), 'utf8'), ctx);
  return ctx.window.HDW_ESTIMATES || {};
}
const EST = loadEstimates();

// The query coach rules, loaded from the same file the Query coach page uses.
function loadCoach() {
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(join(HERE, 'querycoach.js'), 'utf8'), ctx);
  return ctx.window.HDW_COACH;
}
const COACH = loadCoach();

const STOP = new Set('a an and are as at be but by can do does for from how i if in into is it its my of on or our should so that the their them then there these this to use we what when where which who why will with would you your want need app application database db store data'.split(' '));
function words(s) { return (s || '').toLowerCase().match(/[a-z0-9][a-z0-9-]*/g)?.filter(w => !STOP.has(w) && w.length > 1) || []; }
function stripHtml(s) { return String(s).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim(); }
function table(rows, head) {
  if (!rows || !rows.length) return '';
  return '| ' + head.join(' | ') + ' |\n|' + head.map(() => '---').join('|') + '|\n' + rows.map(r => '| ' + r.join(' | ') + ' |').join('\n');
}

function scoreDesign(d, q) {
  const kw = new Set(words(d.keywords)), title = new Set(words(d.title + ' ' + d.question));
  let s = 0;
  for (const w of q) { if (kw.has(w)) s += 3; else if (title.has(w)) s += 2; else if ([...kw].some(k => k.length > 4 && (k.startsWith(w) || w.startsWith(k)))) s += 1; }
  return s;
}

function designText(d, full) {
  let t = `# ${d.title}\n${d.question}\n\n**Short answer:** ${d.short_answer}\n\n## What goes where\n${table(d.placement, ['Data', 'Where it goes', 'Why'])}\n`;
  if (full) {
    t += `\n## Workload\n${table(d.workload, ['Dimension', 'This application'])}\n`;
    t += `\n## What breaks first\n${table(d.breaks, ['What happens', 'What you see', 'What to do'])}\n`;
    t += `\n## Where to run it\n${table(d.where_to_run, ['Stage', 'Where it runs'])}\n`;
  } else if (d.breaks?.length) {
    t += `\n## What breaks first\n${d.breaks.map(b => `- ${b[0]}: ${b[2]}`).join('\n')}\n`;
  }
  return t + `\nFull design doc, with growth stages and live estimates: ${d.url}\n`;
}

const TOOLS = [
  {
    name: 'recommend_store',
    description: 'Given a description of an application or workload, return the matching howdbswork.com design doc: which database each kind of data goes in and why, what breaks first, and a link. Use it when someone asks which database to use, or how to lay out data for an application.',
    inputSchema: { type: 'object', properties: { workload: { type: 'string', description: 'The application and its workload in plain words, e.g. "agent with long-term memory for 50k users" or "ticket sales for concerts".' } }, required: ['workload'] }
  },
  {
    name: 'get_design',
    description: 'Return one howdbswork.com design doc in full: workload, what goes where, what breaks first, where to run it.',
    inputSchema: { type: 'object', properties: { design: { type: 'string', enum: DATA.designs.map(d => d.slug) } }, required: ['design'] }
  },
  {
    name: 'estimate',
    description: 'Back-of-the-envelope numbers for one design (peak rates, storage, memory), using the same formulas as the Estimate it section on howdbswork.com. Call with only "design" to see its inputs and defaults; pass "inputs" to override them. Constants measured in the site\'s lab notebooks are labelled.',
    inputSchema: { type: 'object', properties: {
      design: { type: 'string', enum: Object.keys(EST) },
      inputs: { type: 'object', description: 'Input name to number. Unknown names are ignored; values are clamped to the slider range.', additionalProperties: { type: 'number' } } }, required: ['design'] }
  },
  {
    name: 'review_query',
    description: 'Review SQL before running it: the howdbswork.com Query coach rules. Flags risky statements (UPDATE without WHERE, NOT IN with NULLs, lost updates, locking migrations), slow shapes (functions on indexed columns, OFFSET paging, leading wildcards), and, given table definitions or an EXPLAIN plan, missing indexes, type mismatches and plan red flags. Each finding has the reason, the fix and a lesson link. Pattern checks, not an optimizer.',
    inputSchema: { type: 'object', properties: {
      sql: { type: 'string', description: 'One or more SQL statements.' },
      engine: { type: 'string', enum: ['postgresql', 'mysql'], description: 'Defaults to postgresql.' },
      schema: { type: 'string', description: 'Optional CREATE TABLE and CREATE INDEX statements for the tables involved.' },
      plan: { type: 'string', description: 'Optional EXPLAIN output: PostgreSQL text format, MySQL table or tree format.' } }, required: ['sql'] }
  },
  {
    name: 'find_lesson',
    description: 'Find the howdbswork.com lessons that explain a database topic (MVCC, vacuum, replication lag, isolation, indexes, failover, cost and so on). Returns titles, one-line summaries and links.',
    inputSchema: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] }
  }
];

function call(name, a) {
  if (name === 'recommend_store') {
    const q = words(a.workload);
    const ranked = DATA.designs.map(d => [scoreDesign(d, q), d]).sort((x, y) => y[0] - x[0]);
    if (!ranked[0] || ranked[0][0] === 0) {
      return 'No design doc matched closely. These are the ones on howdbswork.com; pick the nearest with get_design:\n' +
        DATA.designs.map(d => `- ${d.slug}: ${d.question}`).join('\n') + `\n\nOr write your own from the template: ${DATA.site}designs/template/`;
    }
    const [top, ...rest] = ranked.filter(r => r[0] > 0);
    let t = designText(top[1], false);
    if (rest.length) t += '\nAlso related: ' + rest.slice(0, 2).map(r => `${r[1].title} (${r[1].url})`).join('; ') + '\n';
    return t;
  }
  if (name === 'get_design') {
    const d = DATA.designs.find(x => x.slug === a.design);
    if (!d) throw new Error('Unknown design. Choose one of: ' + DATA.designs.map(x => x.slug).join(', '));
    return designText(d, true);
  }
  if (name === 'estimate') {
    const S = EST[a.design];
    if (!S) throw new Error('No estimate for that design. Choose one of: ' + Object.keys(EST).join(', '));
    const v = {}, given = a.inputs || {};
    for (const i of S.inputs) {
      const x = typeof given[i[0]] === 'number' && isFinite(given[i[0]]) ? given[i[0]] : i[5];
      v[i[0]] = Math.min(i[3], Math.max(i[2], x));
    }
    const R = S.calc(v);
    const d = DATA.designs.find(x => x.slug === a.design);
    const link = (d ? d.url : DATA.site + 'designs/' + a.design + '/') + '#estimate?' + S.inputs.map(i => i[0] + '=' + v[i[0]]).join('&');
    return `Inputs (name = value, allowed range):\n` + S.inputs.map(i => `- ${i[0]} = ${v[i[0]]}${i[6]} (${i[1]}; ${i[2]} to ${i[3]})`).join('\n') +
      `\n\nResults:\n` + R.r.map(r => `- ${stripHtml(r[0])}: ${stripHtml(r[1])}${r[2] ? '  <- worth a closer look' : ''}`).join('\n') +
      `\n\nNote: ${stripHtml(R.note)}\n\nThe same numbers, live with sliders: ${link}\n`;
  }
  if (name === 'review_query') {
    const R = COACH.review({ engine: a.engine === 'mysql' ? 'my' : 'pg', sql: a.sql || '', schema: a.schema || '', plan: a.plan || '' });
    const abs = h => DATA.site + h.replace(/^(\.\.\/)+/, '').replace('index.html', '');
    if (!R.findings.length) return 'No findings from the Query coach rules (' + R.statements + ' statement(s)' + (R.tables.length ? ', tables: ' + R.tables.join(', ') : '') + '). That does not make it fast: check the plan with EXPLAIN ANALYZE on real data. ' + (a.schema ? '' : 'Pass the table definitions as "schema" to check indexes. ') + `Coach: ${DATA.site}coach/`;
    return R.findings.map((f, i) => `${i + 1}. [${f.sev.toUpperCase()}] ${f.title}\n   Why: ${f.why}\n   Fix: ${f.fix}` + (f.link ? `\n   Read: ${f.link[1]} (${abs(f.link[0])})` : '')).join('\n\n') + `\n\nThe same checks, in the browser: ${DATA.site}coach/`;
  }
  if (name === 'find_lesson') {
    const q = words(a.topic);
    const ranked = DATA.lessons.map(l => {
      const hay = words(l.title + ' ' + l.description + ' ' + l.headings.join(' '));
      const set = new Set(hay); let s = 0;
      for (const w of q) if (set.has(w)) s += words(l.title).includes(w) ? 3 : 1;
      return [s, l];
    }).filter(r => r[0] > 0).sort((x, y) => y[0] - x[0]).slice(0, 4);
    if (!ranked.length) return `Nothing matched. All lessons, in reading order: ${DATA.site}sitemap/`;
    return ranked.map(([, l]) => `- ${l.title} (${l.section}): ${l.description}\n  ${l.url}`).join('\n');
  }
  throw new Error('Unknown tool: ' + name);
}

function reply(id, result, error) {
  process.stdout.write(JSON.stringify(error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result }) + '\n');
}

function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // a notification
  try {
    if (method === 'initialize') {
      return reply(id, {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'howdbswork', version: VERSION },
        instructions: 'Database design answers from howdbswork.com, written by a database engineer. Use recommend_store for "which database for X", estimate for sizing, review_query before running SQL, find_lesson to explain an internal. Cite the links you get back.'
      });
    }
    if (method === 'ping') return reply(id, {});
    if (method === 'tools/list') return reply(id, { tools: TOOLS });
    if (method === 'tools/call') {
      try { return reply(id, { content: [{ type: 'text', text: call(params.name, params.arguments || {}) }] }); }
      catch (e) { return reply(id, { content: [{ type: 'text', text: String(e.message || e) }], isError: true }); }
    }
    return reply(id, null, { code: -32601, message: 'Method not found: ' + method });
  } catch (e) {
    return reply(id, null, { code: -32603, message: String(e.message || e) });
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { reply(null, null, { code: -32700, message: 'Parse error' }); continue; }
    if (Array.isArray(msg)) msg.forEach(handle); else handle(msg);
  }
});
process.stdin.on('end', () => process.exit(0));
