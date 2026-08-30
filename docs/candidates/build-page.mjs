// Renders the candidate list as a page.
//
// Two outputs from one source. Without a flag it emits the body fragment the
// Artifact viewer wants (it supplies its own document skeleton). With
// --standalone it emits a complete document for the GitHub Pages site, so the
// list is reachable from the same place as the studio rather than only from a
// private link.
//
//   node docs/candidates/build-page.mjs --standalone --out apps/canvas/dist/candidates/index.html

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const rows = JSON.parse(readFileSync(new URL('./candidates.json', import.meta.url), 'utf8'))
const cats = [...new Set(rows.map((r) => r.category))]
const variants = [...new Set(rows.map((r) => r.variant))]
const shapes = new Set()
for (const r of rows) {
  const k = `${r.archetype}|${r.variant}`
  r.first = !shapes.has(k)
  shapes.add(k)
}
const distinct = shapes.size

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const html = `<title>The Thousand Architectures</title>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;450;500&family=Space+Grotesk:wght@500;600&display=swap">
<style>
:root {
  --ground: #FCFBFA;
  --raised: #FFFFFF;
  --sunk:   #F4F2EF;
  --ink:    #1B1917;
  --muted:  #6E6A65;
  --faint:  #9A958E;
  --line:   #E5E1DB;
  --accent: #FC470D;
  --accent-soft: #FFF0E9;

  --sans: 'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  --display: 'Space Grotesk', 'IBM Plex Sans', system-ui, sans-serif;
  --mono: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --ground: #131211; --raised: #1B1A18; --sunk: #201E1C;
    --ink: #EDEAE5; --muted: #A29C94; --faint: #766F67;
    --line: #2E2B28; --accent: #FF6A38; --accent-soft: #2A1810;
  }
}
:root[data-theme="dark"] {
  --ground: #131211; --raised: #1B1A18; --sunk: #201E1C;
  --ink: #EDEAE5; --muted: #A29C94; --faint: #766F67;
  --line: #2E2B28; --accent: #FF6A38; --accent-soft: #2A1810;
}

* { box-sizing: border-box; }
body {
  margin: 0; background: var(--ground); color: var(--ink);
  font-family: var(--sans); font-size: 15px; line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 1080px; margin: 0 auto; padding: 40px 24px 80px; }

.eyebrow {
  font-family: var(--mono); font-size: 11px; text-transform: uppercase;
  letter-spacing: .09em; color: var(--accent); margin: 0 0 10px;
}
h1 {
  font-family: var(--display); font-weight: 600; font-size: clamp(28px, 4.5vw, 40px);
  line-height: 1.12; margin: 0 0 14px; text-wrap: balance; letter-spacing: -.015em;
}
.lede { font-size: 17px; color: var(--muted); max-width: 62ch; margin: 0 0 28px; }

/* The honest note. Not a decoration — the reason the filter below exists. */
.note {
  border-left: 3px solid var(--accent); background: var(--accent-soft);
  padding: 14px 18px; border-radius: 0 10px 10px 0; margin: 0 0 30px; max-width: 74ch;
}
.note p { margin: 0 0 8px; font-size: 14.5px; }
.note p:last-child { margin: 0; }

.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 1px;
  background: var(--line); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; margin: 0 0 30px; }
.stat { background: var(--raised); padding: 14px 16px; }
.stat b { display: block; font-family: var(--display); font-size: 26px; font-weight: 600;
  font-variant-numeric: tabular-nums; line-height: 1.1; }
.stat span { font-family: var(--mono); font-size: 10.5px; text-transform: uppercase;
  letter-spacing: .08em; color: var(--faint); }

.controls { position: sticky; top: 0; z-index: 5; background: var(--ground);
  padding: 14px 0 12px; border-bottom: 1px solid var(--line); margin-bottom: 4px; }
.searchrow { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
input[type="search"] {
  flex: 1; min-width: 220px; font: inherit; font-size: 15px; color: var(--ink);
  background: var(--raised); border: 1px solid var(--line); border-radius: 10px; padding: 9px 12px;
}
input[type="search"]:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.toggle { display: flex; align-items: center; gap: 8px; font-size: 14px; color: var(--muted);
  background: var(--raised); border: 1px solid var(--line); border-radius: 10px; padding: 8px 12px; cursor: pointer; }
.toggle input { accent-color: var(--accent); }

.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.chip {
  font-family: var(--mono); font-size: 11px; text-transform: uppercase; letter-spacing: .07em;
  background: var(--raised); border: 1px solid var(--line); color: var(--muted);
  border-radius: 999px; padding: 5px 11px; cursor: pointer;
}
.chip:hover { border-color: var(--accent); color: var(--accent); }
.chip[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: #fff; }

.count { font-family: var(--mono); font-size: 11.5px; color: var(--faint);
  text-transform: uppercase; letter-spacing: .08em; padding: 14px 0 8px; }

h2 { font-family: var(--mono); font-size: 11.5px; font-weight: 500; text-transform: uppercase;
  letter-spacing: .09em; color: var(--faint); margin: 26px 0 8px; }

.row { border-top: 1px solid var(--line); }
.row > summary {
  list-style: none; cursor: pointer; padding: 11px 4px 11px 0;
  display: grid; grid-template-columns: 1fr auto; gap: 6px 16px; align-items: baseline;
}
.row > summary::-webkit-details-marker { display: none; }
.row > summary:hover .nm { color: var(--accent); }
.row:focus-within > summary { outline: 2px solid var(--accent); outline-offset: -2px; border-radius: 6px; }
.nm { font-weight: 500; }
.nm .var { color: var(--muted); font-weight: 400; }
.why { grid-column: 1; color: var(--muted); font-size: 14px; }
.tags { display: flex; gap: 6px; align-items: center; grid-row: 1; grid-column: 2; }
.tag { font-family: var(--mono); font-size: 10px; text-transform: uppercase; letter-spacing: .07em;
  color: var(--faint); border: 1px solid var(--line); border-radius: 5px; padding: 2px 6px; white-space: nowrap; }
.tag.new { color: var(--accent); border-color: var(--accent); }

.detail { padding: 4px 0 18px; display: grid; gap: 12px; }
.detail p { margin: 0; font-size: 14px; color: var(--muted); max-width: 74ch; }
.detail .k { font-family: var(--mono); font-size: 10px; text-transform: uppercase;
  letter-spacing: .08em; color: var(--faint); display: block; margin-bottom: 3px; }
pre { margin: 0; background: var(--sunk); border: 1px solid var(--line); border-radius: 8px;
  padding: 11px 13px; overflow-x: auto; font-family: var(--mono); font-size: 12px; line-height: 1.6; }

.empty { padding: 40px 0; color: var(--muted); }
footer { margin-top: 50px; padding-top: 20px; border-top: 1px solid var(--line);
  color: var(--faint); font-size: 13.5px; }
@media (max-width: 640px) {
  .row > summary { grid-template-columns: 1fr; }
  .tags { grid-row: auto; grid-column: 1; }
}
</style>

<div class="wrap">
  <p class="eyebrow">ArchSim · candidate library</p>
  <h1>The Thousand Architectures</h1>
  <p class="lede">A thousand systems you could add as ArchSim templates, built as 250 real
  systems crossed with four constraints each — because a template is only worth having if it
  poses a different queueing problem, not a different logo.</p>

  <div class="note">
    <p><strong>Read this before adding any of them.</strong> There are 1,000 rows here and
    ${distinct} structurally distinct shapes. The rest are the same simulation wearing a
    different name — worth having as a starting point someone recognises, worthless as
    engineering.</p>
    <p>The <em>Distinct shapes only</em> filter collapses the list to those ${distinct}. That is
    the set that teaches the simulator something new. Everything beyond it is catalogue.</p>
  </div>

  <div class="stats">
    <div class="stat"><b>1,000</b><span>candidates</span></div>
    <div class="stat"><b>250</b><span>real systems</span></div>
    <div class="stat"><b>${distinct}</b><span>distinct shapes</span></div>
    <div class="stat"><b>10</b><span>categories</span></div>
    <div class="stat"><b>100</b><span>already built</span></div>
  </div>

  <div class="controls">
    <div class="searchrow">
      <input type="search" id="q" placeholder="Search 1,000 candidates — try “replication lag”, “burst”, “ledger”" aria-label="Search candidates">
      <label class="toggle"><input type="checkbox" id="only"> Distinct shapes only</label>
    </div>
    <div class="chips" id="cats" role="group" aria-label="Filter by category"></div>
    <div class="chips" id="vars" role="group" aria-label="Filter by constraint"></div>
  </div>

  <p class="count" id="count"></p>
  <div id="list"></div>

  <footer>
    Each row carries a component sketch in ArchSim's template notation —
    <code>kind:label</code> for nodes, <code>a&gt;b&gt;c</code> for chains — so a candidate
    can go straight into <code>packages/templates/src/specs.js</code>. Load, cost and
    availability targets are deliberately absent: those are derived by the calibrator from the
    sized design, not written by hand.
  </footer>
</div>

<script>
const ROWS = ${JSON.stringify(rows)};
const CATS = ${JSON.stringify(cats)};
const VARS = ${JSON.stringify(variants)};
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

let q = '', cat = null, vari = null, only = false;

const chip = (host, label, get, set) => {
  const b = document.createElement('button');
  b.className = 'chip'; b.textContent = label; b.type = 'button';
  b.setAttribute('aria-pressed', String(get() === label));
  b.onclick = () => { set(get() === label ? null : label); render(); };
  host.appendChild(b);
};

function chips() {
  const c = document.getElementById('cats'), v = document.getElementById('vars');
  c.textContent = ''; v.textContent = '';
  CATS.forEach((x) => chip(c, x, () => cat, (n) => { cat = n; }));
  VARS.forEach((x) => chip(v, x, () => vari, (n) => { vari = n; }));
}

function matches(r) {
  if (cat && r.category !== cat) return false;
  if (vari && r.variant !== vari) return false;
  if (only && !r.first) return false;
  if (!q) return true;
  const hay = (r.name + ' ' + r.category + ' ' + r.why + ' ' + r.constraint + ' ' + r.shape + ' ' + r.nodes).toLowerCase();
  return hay.includes(q);
}

function render() {
  chips();
  const hits = ROWS.filter(matches);
  document.getElementById('count').textContent =
    hits.length + ' of 1,000' + (only ? ' — one exemplar per distinct shape' : '');
  const list = document.getElementById('list');
  if (!hits.length) { list.innerHTML = '<p class="empty">Nothing matches. The search covers names, categories, the reason a system is its own problem, and the components in its sketch.</p>'; return; }

  const byCat = new Map();
  for (const r of hits) { if (!byCat.has(r.category)) byCat.set(r.category, []); byCat.get(r.category).push(r); }

  let out = '';
  for (const [c, rs] of byCat) {
    out += '<h2>' + esc(c) + ' · ' + rs.length + '</h2>';
    for (const r of rs) {
      const varLabel = r.variant === 'base' ? '' : ' <span class="var">— ' + esc(r.variant) + '</span>';
      out += '<details class="row"><summary>'
        + '<span class="nm">' + esc(r.base) + varLabel + '</span>'
        + '<span class="tags">'
        + (r.first ? '<span class="tag new">distinct shape</span>' : '')
        + '<span class="tag">' + esc(r.archetype) + '</span>'
        + '<span class="tag">' + r.components + ' parts</span>'
        + '</span>'
        + '<span class="why">' + esc(r.why) + '</span>'
        + '</summary><div class="detail">'
        + '<p><span class="k">What the constraint changes</span>' + esc(r.constraint) + '</p>'
        + '<p><span class="k">What the shape is about</span>' + esc(r.shape) + '</p>'
        + '<div><span class="k">Components</span><pre>' + esc(r.nodes.split(',').join('\\n')) + '</pre></div>'
        + '<div><span class="k">Connections</span><pre>' + esc(r.edges.split(',').join('\\n')) + '</pre></div>'
        + '</div></details>';
    }
  }
  list.innerHTML = out;
}

document.getElementById('q').addEventListener('input', (e) => { q = e.target.value.trim().toLowerCase(); render(); });
document.getElementById('only').addEventListener('change', (e) => { only = e.target.checked; render(); });
render();
</script>
`

const args = process.argv.slice(2)
const standalone = args.includes('--standalone')
const outIdx = args.indexOf('--out')
const out = outIdx !== -1 ? args[outIdx + 1] : new URL('./thousand.html', import.meta.url).pathname

const doc = standalone
  ? `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="1,000 candidate ArchSim templates — 250 real systems crossed with four constraints each — and the 123 that are structurally distinct.">
<link rel="icon" href="data:,">
<style>body{margin:0}</style>
</head>
<body>
${html}
</body>
</html>
`
  : html

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, doc)
console.log(`${out} — ${(doc.length / 1024).toFixed(0)} kB, ${rows.length} rows, ${distinct} distinct shapes${standalone ? ', standalone' : ''}`)
