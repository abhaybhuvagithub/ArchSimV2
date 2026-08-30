// The analytic steady-state engine — the fast path.
//
// Ported from ArchSim 1.8 (`src/sim.js`) and re-pointed at the IR. The physics
// is unchanged, deliberately: this is the code the 998-check suite has been
// holding honest, and the Monte-Carlo runner needs a model that answers in
// about a millisecond so a PR can afford five hundred worlds.
//
// What it answers: steady state. Capacity, utilization, drops, a queueing-delay
// latency estimate, availability composition. What it cannot answer: anything
// time-dependent — a storm that feeds back, a breaker that flaps, a queue that
// drains after a burst. That is what @archsim/des is for. The two are a
// fidelity ladder, not rivals.

import { CATALOG, specOf } from './catalog.js'
import { physicalEffects, capacitySplit, effectiveCapacity, readFractionOf } from './physics.js'
import { availabilityOf } from './replication.js'

const NOFX = { capMul: 1, latMul: 1, drop: 0, noCache: false, dup: 0 }

/**
 * @param ir       ArchIR (normalized)
 * @param totalRps offered load at the sources
 *
 * @typedef {object} SimOpts
 * @property {Set<string>} [down]  replicas killed, one each
 * @property {any} [fx]     injected chaos: {node:{id:{capMul,latMul,drop,dup,noCache}}, cut:Set<edgeId>, rpsMul}
 * @property {any} [sample] per-node parameter sample from the Monte-Carlo runner,
 *                          {id: {capMul, latMul}} — the honesty band, drawn
 *
 * @param {SimOpts} [opts]
 */
export function simulate(ir, totalRps, opts = {}) {
  const { down = new Set(), fx = null, sample = null } = opts
  const nodes = ir.nodes
  const edges = ir.edges
  const fxOf = (id) => (fx?.node?.[id] ? { ...NOFX, ...fx.node[id] } : NOFX)
  const isCut = (e) => !!fx?.cut?.has(e.id)
  const rps = totalRps * (fx?.rpsMul || 1)

  const byId = new Map(nodes.map((n) => [n.id, n]))
  const out = {}, incoming = {}, incomingReads = {}
  for (const n of nodes) { out[n.id] = []; incoming[n.id] = 0; incomingReads[n.id] = 0 }
  const liveEdges = edges.filter((e) => !isCut(e) && byId.has(e.from) && byId.has(e.to))
  for (const e of liveEdges) out[e.from].push(e.to)

  const sources = nodes.filter((n) => isSourceNode(n))
  const wSum = sources.reduce((a, s) => a + (s.attrs?.weight ?? 1), 0) || 1
  for (const s of sources) {
    incoming[s.id] = rps * (s.attrs?.weight ?? 1) / wSum
    incomingReads[s.id] = incoming[s.id] * 0.5
  }

  const stats = {}
  const flowOnEdge = {}
  const order = topoOrder(nodes, liveEdges)

  for (const id of order) {
    const n = byId.get(id)
    if (!n) continue
    const cap0 = effectiveCap(n)
    const inRps = incoming[id]
    const isDown = down.has(id)
    const f = fxOf(id)
    const smp = sample?.[id] || null
    const replicas = isDown ? Math.max(0, cap0.replicas - 1) : cap0.replicas

    const ph = physicalEffects(n)
    const readMix = inRps > 0 ? incomingReads[id] / inRps : 0.5
    const perReplica = cap0.capPerReplica * (smp?.capMul ?? 1)
    const split = capacitySplit(n, perReplica, Math.max(replicas, 0))
    const rawCap = isSourceNode(n) ? Infinity : effectiveCapacity(split.readCap, split.writeCap, readMix)
    const capacity = rawCap === Infinity ? Infinity : rawCap * f.capMul

    // Retry storms duplicate demand: the node sees more than true traffic, and
    // everything downstream of it inherits the duplicates too.
    const inflated = inRps * (1 + (f.dup || 0))
    const faultDrop = inflated * f.drop
    const offered = inflated - faultDrop
    const processed = Math.min(offered, capacity)
    const dropped = Math.max(0, offered - processed)
    const util = capacity === Infinity ? 0 : capacity === 0 ? (offered > 0 ? 999 : 0) : offered / capacity

    // M/M/1-flavoured queueing delay, clamped: past the knee the analytic model
    // stops being a model of anything and the DES should take over.
    const qFactor = util >= 1 ? 20 : 1 / Math.max(0.05, 1 - util)
    const baseLat = cap0.latencyMs.p50 * (smp?.latMul ?? 1)
    const latency = baseLat * Math.min(qFactor, 20) * f.latMul * ph.latMul

    const availOne = cap0.availability
    let avail = replicas <= 0 ? 0 : availabilityOf(availOne, replicas, cap0.replication)
    if (f.drop > 0) avail *= (1 - f.drop)
    if (f.capMul < 1) avail *= (0.5 + 0.5 * f.capMul)

    stats[id] = {
      in: inRps, processed, dropped, util, latency, avail, replicas,
      capacity, dupIn: inflated - inRps, readMix,
      readCap: split.readCap, writeCap: split.writeCap, writesScale: split.writesScale,
      down: isDown, faulted: f !== NOFX, faultDrop, tailMul: ph.tailMul,
    }

    // caches/CDN forward only misses (a stampede sends everything through)
    let fwd = processed
    const hit = f.noCache ? 0 : (cap0.cacheHit || 0)
    if (hit && out[id].length) fwd = processed * (1 - hit)
    const targets = out[id]
    if (targets.length) {
      const edgesFrom = liveEdges.filter((e) => e.from === id)
      const wTotal = edgesFrom.reduce((a, e) => a + (e.weight ?? 1), 0) || 1
      for (const e of edgesFrom) {
        const share = fwd * (e.weight ?? 1) / wTotal
        incoming[e.to] += share
        incomingReads[e.to] += share * readFractionOf(e)
        flowOnEdge[e.id] = (flowOnEdge[e.id] || 0) + share
      }
    }
  }

  // end-to-end estimate: longest latency path from any source
  const memo = {}
  const pathLat = (id, seen) => {
    if (memo[id] !== undefined) return memo[id]
    if (seen.has(id)) return 0
    seen.add(id)
    const own = stats[id]?.latency || 0
    let best = 0
    for (const t of out[id] || []) best = Math.max(best, pathLat(t, seen))
    seen.delete(id)
    return (memo[id] = own + best)
  }
  let p50 = 0
  for (const s of sources) p50 = Math.max(p50, pathLat(s.id, new Set()))

  // Tail spread widens with load: a busy system has a much longer tail than an
  // idle one at the same median. At ~20% utilization this lands near 3× p99.
  const busiest = Math.min(1, Math.max(0, ...Object.values(stats).map((s) => s.util || 0), 0))
  const p95 = p50 * (1.5 + 0.8 * busiest)
  const p99 = p50 * (2.4 + 2.6 * busiest)

  let sysAvail = 1
  for (const n of nodes) {
    if (isSourceNode(n)) continue
    if ((stats[n.id]?.in ?? 0) > 0) sysAvail *= stats[n.id].avail
  }

  const totalIn = sources.length ? rps : 0
  const totalDropped = Object.values(stats).reduce((a, s) => a + s.dropped, 0)
  const successRate = totalIn ? Math.max(0, 1 - totalDropped / totalIn) : 1

  return {
    stats, flowOnEdge, p50, p95, p99, sysAvail, totalDropped, successRate,
    errorRate: 1 - successRate,
    throughput: Object.entries(stats).filter(([id]) => isSourceNode(byId.get(id))).reduce((a, [, s]) => a + s.processed, 0) || totalIn,
    offeredRps: rps,
  }
}

/** capacity + overrides (user or telemetry calibration wins over the seed). */
export function effectiveCap(node) {
  const c = node.capacity
  const o = node.overrides || {}
  return {
    ...c, ...o,
    latencyMs: { ...c.latencyMs, ...(o.latencyMs || {}) },
    cacheHit: o.cacheHit ?? c.cacheHit ?? specOf(node.kind)?.cacheHit ?? 0,
  }
}

export const isSourceNode = (n) => !!(n.capacity?.source || CATALOG[n.kind]?.source)

/** Capacity report with bottleneck detection. */
export function capacityReport(ir, sim) {
  const rows = ir.nodes
    .filter((n) => !isSourceNode(n))
    .map((n) => {
      const s = sim.stats[n.id] || { in: 0, util: 0, replicas: n.capacity.replicas }
      const per = effectiveCap(n).capPerReplica
      return {
        id: n.id, label: n.label, kind: n.kind, in: s.in, util: s.util,
        replicas: s.replicas, needed: per ? Math.ceil(s.in / per) : 1, down: s.down,
        provenance: n.capacity.provenance?.cls,
      }
    })
    .sort((a, b) => b.util - a.util)
  return { rows, bottlenecks: rows.filter((r) => r.util > 0.8) }
}

function topoOrder(nodes, edges) {
  const indeg = {}, adj = {}
  for (const n of nodes) { indeg[n.id] = 0; adj[n.id] = [] }
  for (const e of edges) if (adj[e.from] && indeg[e.to] !== undefined) { adj[e.from].push(e.to); indeg[e.to]++ }
  const q = nodes.filter((n) => indeg[n.id] === 0).map((n) => n.id)
  const order = []
  while (q.length) {
    const id = q.shift()
    order.push(id)
    for (const t of adj[id]) if (--indeg[t] === 0) q.push(t)
  }
  const seen = new Set(order)
  for (const n of nodes) if (!seen.has(n.id)) order.push(n.id) // cycle leftovers
  return order
}
