// Edge inference — where the visual value concentrates.
//
// A list of resources is an inventory. What makes it an architecture is the
// arrows, and nobody writes the arrows down: they are implied by target-group
// attachments, Service selectors, `DATABASE_URL`-shaped environment variables,
// security-group references and Terraform's own reference graph.
//
// Two disciplines keep this honest:
//   1. Every inferred edge carries a confidence and a reason. Low-confidence
//      edges render dashed and say why they exist. Confirming one writes an
//      explicit annotation (`archsim.io/edge`), so the confidence graduates to
//      'declared' permanently and nobody re-litigates it next quarter.
//   2. Dependency direction is not call direction. Terraform says the listener
//      depends on the load balancer; traffic goes the other way. We orient by
//      component tier and record when we flipped an edge, rather than drawing
//      an arrow backwards and letting the user work out why the database is
//      calling the browser.

/** Traffic flows from low rank to high rank. Same rank: keep the declared direction. */
export const TIER_RANK = {
  client: 0, dns: 1, gslb: 1, cdn: 2, edge: 2, waf: 3, lb: 4, k8sgw: 4, gateway: 5, graphql: 5,
  ratelimiter: 5, grpcgw: 5, bff: 6, mesh: 6, web: 7, app: 7, micro: 7, grpc: 7, ws: 7, fastapi: 7,
  saga: 8, worker: 8, scheduler: 8, stream: 8, batch: 8, etl: 8, transcode: 8,
  cache: 9, queue: 9, kafka: 9, mq: 9, registry: 9, config: 9, zk: 9, secrets: 9, crypto: 9,
  ml: 10, llm: 10, embed: 10, vector: 10, guard: 10, ledger: 11,
  sql: 12, nosql: 12, search: 12, graph: 12, blob: 12, lake: 12, warehouse: 13, analytics: 13, bi: 14,
  monitor: 20, tracing: 20, logs: 20, otel: 20, apm: 20, siem: 20, // observability: sinks, never on the path
}

const rankOf = (kind) => TIER_RANK[kind] ?? 7

/**
 * Build IR edges from raw dependency hints.
 *
 * @param hints  [{from, to, confidence, reason, protocol?}] using *addresses*
 * @param nodesByAddress Map<address, IRNode>
 * @param structural Set<address> — real infrastructure that is not a component
 * @param deps  Map<address, Set<address>> — full dependency graph, for hopping
 *              through structural resources (lb → target group → instance)
 */
export function inferEdges(hints, nodesByAddress, connectors, deps, mkEdge, opts = {}) {
  const adj = bidirectional(deps)
  // A connector carries traffic between *two* things. Something referenced by
  // twenty resources is not carrying traffic between them — it is a hub, and
  // hopping through it connects everything to everything. Real Terraform is full
  // of these: a `module "vpc"` block whose outputs every resource consumes turned
  // a six-component example into a near-complete graph, which is exactly as
  // useless as an empty one.
  //
  // The test is not raw degree but how many *components* it touches directly.
  // A target group is referenced by a listener and six attachments — seven
  // neighbours, zero of them components, and genuinely a traffic path. A shared
  // `module "vpc"` touches four components directly and is carrying nothing
  // between them.
  const maxComponents = opts.maxConnectorComponents ?? 2
  const maxDegree = opts.maxConnectorDegree ?? 12
  const hub = new Set()
  for (const [addr, peers] of adj) {
    if (nodesByAddress.has(addr)) continue
    let components = 0
    for (const p of peers) if (nodesByAddress.has(p)) components++
    if (components > maxComponents || peers.size > maxDegree) hub.add(addr)
  }
  const out = new Map()
  const add = (fromAddr, toAddr, confidence, reason, protocol, inferred = false) => {
    const a = nodesByAddress.get(fromAddr)
    const b = nodesByAddress.get(toAddr)
    if (!a || !b || a.id === b.id) return
    // Two unmapped components referencing each other tells us nothing about
    // traffic. We do not know what either of them *is*, so we certainly do not
    // know that one calls the other — and a family of unmapped resources that
    // all reference each other (AWS Cloud WAN, a vendor's Snowflake module)
    // otherwise renders as a complete graph, which is an invention.
    // An explicit hint from a mapping rule still counts; a graph walk does not.
    if (inferred && a.kind === 'custom' && b.kind === 'custom') return
    const [src, dst, flipped] = orient(a, b)
    const key = `${src.id}->${dst.id}`
    const prev = out.get(key)
    const conf = flipped ? weaken(confidence) : confidence
    if (prev && rankConfidence(prev.confidence) >= rankConfidence(conf)) return
    out.set(key, mkEdge({
      from: src.id, to: dst.id, confidence: conf,
      protocol: protocol || protocolFor(dst.kind),
      callSemantics: callSemanticsFor(dst.kind),
      attrs: { reason: flipped ? `${reason} (direction inferred from component tier)` : reason },
    }))
  }

  for (const h of hints) {
    if (h.from && h.to) { add(h.from, h.to, h.confidence, h.reason, h.protocol); continue }
  }

  // Hop through connectors: `aws_lb → listener → target group → attachment →
  // aws_instance` is one architectural edge wearing four Terraform resources.
  // Traversal is bidirectional because Terraform's dependency arrows point the
  // opposite way to the traffic (a listener depends on its load balancer), and
  // it is confined to connectors because hopping through a VPC would connect
  // every resource in the repo to every other one.
  for (const [addr, node] of nodesByAddress) {
    if (!node) continue
    for (const reached of reachThroughConnectors(addr, adj, nodesByAddress, connectors, hub)) {
      // Every intermediate hop is a connector by construction — a listener or an
      // attachment is an explicit statement about traffic, not a coincidence —
      // so a short chain is as trustworthy as a direct reference. Longer chains
      // drop to medium and render dashed until a human confirms them.
      add(addr, reached.address, reached.hops <= 2 ? 'high' : reached.hops <= 4 ? 'medium' : 'low',
        reached.hops === 1 ? 'direct reference in the plan graph' : `reference through ${reached.via.join(' → ')}`,
        undefined, true)
    }
  }

  return [...out.values()]
}

/** Union of the dependency graph and its reverse, for connector traversal. */
function bidirectional(deps) {
  const adj = new Map()
  const push = (a, b) => { if (!adj.has(a)) adj.set(a, new Set()); adj.get(a).add(b) }
  for (const [from, tos] of deps) for (const to of tos) { push(from, to); push(to, from) }
  return adj
}

function reachThroughConnectors(start, deps, nodesByAddress, structural, hub = new Set(), maxHops = 4) {
  const found = []
  const seen = new Set([start])
  let frontier = [{ addr: start, hops: 0, via: [] }]
  while (frontier.length) {
    const next = []
    for (const cur of frontier) {
      for (const d of deps.get(cur.addr) || []) {
        if (seen.has(d)) continue
        seen.add(d)
        const hops = cur.hops + 1
        if (nodesByAddress.has(d)) { found.push({ address: d, hops, via: cur.via }); continue }
        if (structural.has(d) && !hub.has(d) && hops < maxHops) next.push({ addr: d, hops, via: [...cur.via, shortType(d)] })
      }
    }
    frontier = next
  }
  return found
}

/** Orient by tier. Returns [from, to, flipped]. */
export function orient(a, b) {
  const ra = rankOf(a.kind), rb = rankOf(b.kind)
  if (ra <= rb) return [a, b, false]
  return [b, a, true]
}

export function protocolFor(kind) {
  if (['sql', 'ledger', 'warehouse', 'graph'].includes(kind)) return 'sql'
  if (['kafka'].includes(kind)) return 'kafka'
  if (['queue', 'mq'].includes(kind)) return 'amqp'
  if (['grpc', 'ml', 'embed'].includes(kind)) return 'grpc'
  return 'http'
}

/**
 * A queue on the receiving end of an edge is the definition of an async call:
 * the caller does not wait, which is why the worker behind it can be slow
 * without holding anyone's thread. Getting this wrong is how a model claims a
 * fan-out is free.
 */
export function callSemanticsFor(kind) {
  return ['queue', 'kafka', 'mq', 'stream'].includes(kind) ? 'async' : 'sync'
}

const rankConfidence = (c) => ({ high: 3, medium: 2, low: 1 }[c] || 0)
const weaken = (c) => (c === 'high' ? 'medium' : 'low')
const shortType = (addr) => String(addr).split('.').slice(-2, -1)[0] || addr

/**
 * Explicit annotations beat every inference. When a user confirms a dashed edge
 * on the canvas we write `archsim.io/edge` into the code, and from then on it
 * arrives as a declared fact rather than a guess that has to be re-made.
 */
export function annotationEdges(objects, nodesByAddress, mkEdge) {
  const out = []
  for (const { address, annotations } of objects) {
    const decl = annotations?.['archsim.io/edge']
    if (!decl) continue
    for (const target of String(decl).split(',').map((s) => s.trim()).filter(Boolean)) {
      const a = nodesByAddress.get(address)
      const b = [...nodesByAddress.values()].find((n) => n.label === target || n.id === target || (n.bindings || []).some((x) => x.address.endsWith(target)))
      if (a && b) out.push(mkEdge({ from: a.id, to: b.id, confidence: 'high', attrs: { reason: 'archsim.io/edge annotation (confirmed by a human)' }, protocol: protocolFor(b.kind), callSemantics: callSemanticsFor(b.kind) }))
    }
  }
  return out
}
