// What connects to what, and — just as importantly — what does not.
//
// A component dropped on a canvas with no edges simulates as dead weight: it
// costs money, contributes no latency, and cannot fail anything. That is never
// what the person meant. So the studio wires a new component in for them.
//
// The hard part is not proposing an edge. It is refusing to propose the wrong
// one. Two refusals are load-bearing here:
//
//   · **Observability and platform components get no automatic edge.** A metrics
//     sink, a log pipeline, a secrets manager and an audit trail are all real
//     dependencies of a real system, but they are not on the request path. Wire
//     a monitor downstream of an app server and the simulator will faithfully
//     route every request through it, invent queueing delay that does not exist,
//     and price a component the traffic never touches. An edge the engine will
//     treat as traffic must correspond to traffic.
//
//   · **Nothing is proposed between two components whose roles have no
//     relationship.** Two databases do not talk to each other because they were
//     the only two things on the canvas.
//
// Everything proposed is marked `inferred` with a medium confidence and a
// sentence saying why, exactly like an edge the IaC compiler infers from
// Terraform. It draws dashed. The person can see it is the tool's guess.

import { CATALOG, specOf } from './catalog.js'

/* ── roles ────────────────────────────────────────────────────────────────
   117 kinds, twelve roles. The role is what wiring reasons about; the kind is
   what the physics reasons about. Anything not named here falls back to a role
   derived from its catalog shape, so a kind added later still wires sensibly
   without being listed twice. */

export const ROLES = {
  source: ['client', 'synthetic', 'load', 'devicefarm', 'partner'],
  edge: ['dns', 'gslb', 'cdn', 'edge', 'waf'],
  balancer: ['lb', 'mesh'],
  gateway: ['gateway', 'k8sgw', 'grpcgw', 'graphql', 'ratelimiter', 'bff', 'esb', 'apitest'],
  compute: [
    'web', 'app', 'micro', 'grpc', 'ws', 'fastapi', 'saga', 'sandbox', 'tenant',
    'erp', 'crm', 'mainframe', 'billing', 'ledger', 'aiagent', 'agentgraph',
  ],
  cache: ['cache'],
  store: [
    'sql', 'nosql', 'blob', 'graph', 'tsdb', 'lake', 'warehouse', 'ledger',
    'geoidx', 'featurestore', 'testdata', 'containerreg', 'mft',
  ],
  search: ['search', 'vector'],
  ai: [
    'llm', 'ml', 'embed', 'vertexai', 'gemini3', 'gemini2', 'gemmaos', 'imagen',
    'veo', 'astra', 'mariner', 'notebooklm', 'antigravity', 'duetai', 'finetune',
  ],
  async: ['queue', 'kafka', 'mq', 'stream', 'cdc'],
  consumer: ['worker', 'batch', 'etl', 'transcode', 'llmworker', 'scheduler', 'beam'],
  external: ['push', 'e2e'],

  // Present in every real system, absent from every request path the simulator
  // models. Listed so the refusal is explicit rather than a gap in the table.
  support: [
    'monitor', 'tracing', 'logs', 'otel', 'apm', 'slo', 'alert', 'llmobs',
    'iam', 'secrets', 'pii', 'audit', 'siem', 'hsm', 'tls', 'crypto', 'hash',
    'digest', 'sign', 'e2ee', 'config', 'registry', 'zk', 'featureflag',
    'cicd', 'backup', 'bastion', 'qgate', 'contract', 'mock', 'dast',
    'testops', 'k8s', 'analytics', 'bi',
  ],
}

const ROLE_OF = new Map()
for (const [role, kinds] of Object.entries(ROLES)) for (const k of kinds) ROLE_OF.set(k, role)

/**
 * The role of a kind. Unlisted kinds are classified from their catalog shape
 * rather than dumped in one bucket: a source is a source, something with a
 * cache hit rate is a cache, something slow and wide is a consumer.
 */
export function roleOf(kind) {
  const named = ROLE_OF.get(kind)
  if (named) return named
  const spec = specOf(kind)
  if (spec?.source) return 'source'
  if (spec?.cacheHit != null) return 'cache'
  if ((spec?.lat ?? 0) >= 200) return 'consumer'
  return 'compute'
}

/* ── the adjacency table ──────────────────────────────────────────────────
   For each role, which roles may point into it and which it may point at, in
   preference order. First role with an existing component on the canvas wins;
   `support` appears in nobody's lists, which is the whole point. */

const WIRING = {
  source: { up: [], down: ['edge', 'balancer', 'gateway', 'compute'] },
  edge: { up: ['source'], down: ['balancer', 'gateway', 'compute'] },
  balancer: { up: ['edge', 'source'], down: ['gateway', 'compute'] },
  gateway: { up: ['balancer', 'edge', 'source'], down: ['compute', 'ai'] },
  compute: { up: ['gateway', 'balancer', 'edge', 'source'], down: ['cache', 'store', 'search', 'async', 'ai'] },
  cache: { up: ['compute', 'gateway'], down: ['store'] },
  store: { up: ['compute', 'consumer', 'cache', 'gateway'], down: [] },
  search: { up: ['compute', 'gateway'], down: [] },
  ai: { up: ['compute', 'gateway'], down: ['store', 'search'] },
  async: { up: ['compute', 'gateway'], down: ['consumer'] },
  consumer: { up: ['async', 'compute'], down: ['store', 'external', 'ai'] },
  external: { up: ['consumer', 'compute'], down: [] },
  support: { up: [], down: [] },
}

/** Why a role is left alone, in words the studio can show. */
export const REFUSALS = {
  support: (label) =>
    `${label} is a platform component, not a request-path one. An automatic edge would make the simulator route traffic through it and price it as if it served requests. Connect it yourself if your system really does call it inline.`,
}

/* ── candidate scoring ────────────────────────────────────────────────────── */

const degree = (ir, id) => ir.edges.reduce((n, e) => n + (e.from === id || e.to === id ? 1 : 0), 0)
const outDegree = (ir, id) => ir.edges.reduce((n, e) => n + (e.from === id ? 1 : 0), 0)
const at = (n) => n.layout || { x: 0, y: 0 }

/**
 * Among candidates of one role, the best partner for `node`.
 *
 * Nearest wins, because on a canvas proximity is how people express intent —
 * you drop a database under the service that will read it. Out-degree breaks
 * ties, so a second worker attaches to the queue that has fewer consumers
 * rather than piling onto the first. The id breaks the rest, so the same canvas
 * always produces the same wiring.
 */
function best(ir, node, candidates) {
  let winner = null
  let bestKey = null
  for (const c of candidates) {
    const dx = at(c).x - at(node).x
    const dy = at(c).y - at(node).y
    const key = [Math.round(Math.hypot(dx, dy)), outDegree(ir, c.id), c.id]
    if (!bestKey || key[0] < bestKey[0] || (key[0] === bestKey[0] && (key[1] < bestKey[1] || (key[1] === bestKey[1] && key[2] < bestKey[2])))) {
      winner = c
      bestKey = key
    }
  }
  return winner
}

function pick(ir, node, roles, exclude) {
  for (const role of roles) {
    const pool = ir.nodes.filter((n) => n.id !== node.id && !exclude.has(n.id) && roleOf(n.kind) === role)
    if (pool.length) return { node: best(ir, node, pool), role }
  }
  return null
}

const has = (ir, a, b) => ir.edges.some((e) => (e.from === a && e.to === b) || (e.from === b && e.to === a))

/* ── suggestions ──────────────────────────────────────────────────────────── */

/**
 * How one component should be wired into the design around it.
 *
 * Returns `{ edges, refusal }`. `edges` are proposals, not IR: the caller
 * decides whether to apply them, and applying is one undoable step.
 */
export function suggestFor(ir, nodeId, opts = {}) {
  const node = ir.nodes.find((n) => n.id === nodeId)
  if (!node) return { edges: [], refusal: null }

  const role = roleOf(node.kind)
  const rule = WIRING[role] || WIRING.compute
  if (!rule.up.length && !rule.down.length) {
    return { edges: [], refusal: REFUSALS[role]?.(node.label) || null }
  }

  const exclude = new Set([nodeId])
  const edges = []

  const upstream = pick(ir, node, rule.up, exclude)
  if (upstream?.node && !has(ir, upstream.node.id, nodeId)) {
    edges.push(proposal(upstream.node, node, opts))
    exclude.add(upstream.node.id)
  }

  // A component that already has something feeding it does not also need
  // something to feed, unless it is a relay whose whole job is to pass traffic
  // on — a queue with no consumer is a design mistake worth fixing on sight.
  const relay = role === 'async' || role === 'edge' || role === 'balancer' || role === 'gateway'
  if (relay || !edges.length || opts.both) {
    const downstream = pick(ir, node, rule.down, exclude)
    if (downstream?.node && !has(ir, nodeId, downstream.node.id)) {
      edges.push(proposal(node, downstream.node, opts))
    }
  }

  return { edges, refusal: null }
}

function proposal(from, to, opts = {}) {
  const fromRole = roleOf(from.kind)
  const toRole = roleOf(to.kind)
  // A queue is written to and read from asynchronously; everything else the
  // wiring proposes is a synchronous call, which is what the engine charges
  // latency for.
  const async = fromRole === 'async' || toRole === 'async'
  return {
    from: from.id,
    to: to.id,
    callSemantics: async ? 'async' : 'sync',
    confidence: 'medium',
    inferred: true,
    describe: `${from.label} → ${to.label}`,
    why: `${CATALOG[to.kind]?.name || to.kind} sits downstream of ${CATALOG[from.kind]?.name || from.kind} in this design. Inferred, not read from your code.`,
    ...(opts.attrs ? { attrs: opts.attrs } : {}),
  }
}

/** Every component nothing points at and that points at nothing. */
export const orphans = (ir) => ir.nodes.filter((n) => degree(ir, n.id) === 0)

/**
 * Wiring for a whole design, resolved against a canvas that is changing as it
 * goes: each accepted proposal is folded in before the next orphan is
 * considered, so two orphans dropped side by side can connect to each other
 * rather than both reaching past one another for the same third node.
 */
export function suggestOrphans(ir) {
  let working = ir
  const edges = []
  const refused = []
  for (const n of orphans(ir)) {
    const { edges: found, refusal } = suggestFor(working, n.id)
    if (refusal) { refused.push({ id: n.id, label: n.label, why: refusal }); continue }
    if (!found.length) continue
    edges.push(...found)
    working = { ...working, edges: [...working.edges, ...found.map((e) => ({ ...e, id: `pending:${e.from}->${e.to}` }))] }
  }
  return { edges, refused }
}

/**
 * Where a newly dropped component belongs, if the person did not choose. Tier
 * rank left to right, which is the same ordering the layered layout uses, so an
 * auto-placed node lands where a hand-placed one would have.
 */
const COLUMN = {
  source: 0, edge: 1, balancer: 1, gateway: 2, compute: 3,
  cache: 4, async: 4, ai: 4, search: 5, consumer: 5, store: 6, external: 6, support: 6,
}

export function suggestPlacement(ir, kind, colW = 210, rowH = 96) {
  const col = COLUMN[roleOf(kind)] ?? 3
  const x = 60 + col * colW
  const taken = ir.nodes.filter((n) => Math.abs(at(n).x - x) < colW / 2).map((n) => at(n).y)
  let y = 60
  while (taken.some((t) => Math.abs(t - y) < rowH * 0.8)) y += rowH
  return { x, y }
}
