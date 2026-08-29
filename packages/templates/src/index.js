// @archsim/templates — 100 architectures, as IR.
//
// A template is not a picture. Every one of these builds a real ArchIR 2.0
// document with capacity seeds, a workload, SLOs and scenarios, so the moment
// it opens the gate has an opinion about it — and several of them fail their own
// budget, which is the point. A template that always passes teaches nothing.
//
// The build is deterministic: same spec in, byte-identical IR out, including
// node ids, so a template's `irHash` is stable across machines and a diff
// against one is meaningful.

import { createIR, irNode, irEdge, normalizeIR, ulidFrom } from '@archsim/ir'
import { capacityFor, roleOf } from '@archsim/core'
import { SPECS, CATEGORIES } from './specs.js'

export { CATEGORIES }

const COL_W = 230
const ROW_H = 96

/** `kind:label*replicas` — label and replicas both optional. */
function parseNodes(src) {
  return src.split(',').map((chunk) => {
    const s = chunk.trim()
    const [head, rep] = s.split('*')
    const [kind, label] = head.split(':')
    return {
      kind: kind.trim(),
      label: (label || kind).trim(),
      replicas: rep ? Number(rep) : 1,
    }
  })
}

/** `a>b>c; d>e` — chains, so a linear path is written the way it is drawn. */
function parseEdges(src) {
  const out = []
  for (const chain of src.split(';')) {
    const hops = chain.split('>').map((h) => h.trim()).filter(Boolean)
    for (let i = 0; i + 1 < hops.length; i++) out.push([hops[i], hops[i + 1]])
  }
  return out
}

/**
 * Column by role, row by arrival order within the column. The same ordering the
 * canvas's layered layout uses, so a template opens looking laid out rather than
 * looking generated.
 */
function place(nodes) {
  const rows = new Map()
  const COLUMN = {
    source: 0, edge: 1, balancer: 1, gateway: 2, compute: 3,
    cache: 4, async: 4, ai: 4, search: 5, consumer: 5, store: 6, external: 7, support: 7,
  }
  return nodes.map((n) => {
    const col = COLUMN[roleOf(n.kind)] ?? 3
    const row = rows.get(col) ?? 0
    rows.set(col, row + 1)
    return { ...n, layout: { x: 60 + col * COL_W, y: 60 + row * ROW_H } }
  })
}

/**
 * Build one template's IR.
 *
 * Ids are derived from the template id and the node label rather than minted
 * fresh, so the document is reproducible — and because an id derived from a
 * label is only safe when the label is fixed by the spec, which here it is.
 */
export function buildTemplate(spec) {
  const [id, name, category, rps, p99, avail, cost, nodesSrc, edgesSrc, about] = spec
  const placed = place(parseNodes(nodesSrc))
  const byLabel = new Map()

  const nodes = placed.map((n) => {
    const node = irNode({
      id: ulidFrom(`template:${id}:${n.label}`),
      kind: n.kind,
      label: n.label,
      capacity: { replicas: n.replicas },
      layout: n.layout,
      attrs: { template: id },
    }, capacityFor)
    byLabel.set(n.label, node.id)
    return node
  })

  const edges = []
  for (const [from, to] of parseEdges(edgesSrc)) {
    const a = byLabel.get(from)
    const b = byLabel.get(to)
    // A spec that names a node it never declared is a typo, and a typo that
    // silently drops an edge produces a template that simulates as something
    // other than what it says. The check suite treats this as a failure.
    if (!a || !b) throw new Error(`template ${id}: edge '${from}>${to}' names an undeclared component`)
    const toKind = placed.find((n) => n.label === to)?.kind
    const fromKind = placed.find((n) => n.label === from)?.kind
    const async = roleOf(toKind) === 'async' || roleOf(fromKind) === 'async'
    edges.push(irEdge({ from: a, to: b, callSemantics: async ? 'async' : 'sync', confidence: 'high' }))
  }

  const ir = {
    ...createIR({ name, createdBy: 'archsim-template', template: id, category, about }),
    nodes,
    edges,
    // `rps` is the quiet hour; the day peaks at twice it. A design judged only
    // at its trough is not judged.
    workloads: [{ id: 'peak', arrival: { dist: 'diurnal', rps, params: { peakFactor: 2 } }, mix: { readPct: 80 } }],

    // Latency and availability are promises about normal operation, which is how
    // teams write them. The error budget is the one gate that must survive a bad
    // day, so it is evaluated under every scenario — and that is where several of
    // these templates stop passing.
    slos: [
      { id: 'latency', scope: 'system', metric: 'p99_ms', op: '<=', threshold: p99, under: 'peak', scenarios: ['nominal'] },
      { id: 'availability', scope: 'system', metric: 'availability', op: '>=', threshold: avail, under: 'all', scenarios: ['nominal'] },
      { id: 'errors', scope: 'system', metric: 'error_rate', op: '<=', threshold: 0.01, under: 'all' },
      { id: 'budget', scope: 'system', metric: 'monthly_cost_usd', op: '<=', threshold: cost, under: 'all' },
    ],
  }
  return normalizeIR(ir)
}

/** Everything a chooser needs, without building a hundred IR documents. */
export const TEMPLATES = SPECS.map((s) => ({
  id: s[0],
  name: s[1],
  category: s[2],
  rps: s[3],
  p99: s[4],
  availability: s[5],
  cost: s[6],
  about: s[9],
  components: s[7].split(',').length,
  kinds: [...new Set(s[7].split(',').map((c) => c.trim().split('*')[0].split(':')[0]))],
}))

const BY_ID = new Map(SPECS.map((s) => [s[0], s]))

export function template(id) {
  const spec = BY_ID.get(id)
  if (!spec) return null
  return buildTemplate(spec)
}

/** The scenario set every template is gated under. */
export const TEMPLATE_SCENARIOS = [
  { id: 'az', faults: [{ fault: 'az' }] },
  { id: 'retry', faults: [{ fault: 'retry', target: 'kind:sql' }] },
  { id: 'crash', faults: [{ fault: 'crash', target: 'kind:app' }] },
]

/** Substring search over name, category, description and component kinds. */
export function searchTemplates(query) {
  const q = (query || '').trim().toLowerCase()
  if (!q) return TEMPLATES
  return TEMPLATES.filter((t) =>
    t.name.toLowerCase().includes(q) ||
    t.category.toLowerCase().includes(q) ||
    t.about.toLowerCase().includes(q) ||
    t.id.includes(q) ||
    t.kinds.some((k) => k.includes(q)))
}
