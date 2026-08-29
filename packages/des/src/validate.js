// Validation — the reason to believe the DES.
//
// v1's differentiator was never the canvas; it was that every claim was a check.
// A discrete-event engine invites the same discipline, in three layers:
//
//   1. Closed-form agreement. For M/M/c the queueing delay has an exact answer
//      (Erlang-C). Where theory exists, the engine is held to it.
//   2. Cross-engine consistency. Below the knee, the DES and the analytic engine
//      must agree within the jitter band. Divergence *beyond* the knee is
//      expected and documented — that divergence is the DES's reason to exist.
//   3. Metamorphic properties. Relations that must hold whatever the numbers:
//      doubling workers at fixed λ never raises p99; a retry budget never raises
//      steady-state error rate; an open breaker never raises upstream p99.

import { runDES, meanServiceMs } from './engine.js'
import { simulate } from '@archsim/core'

/** Erlang-C: probability an arrival has to wait, in an M/M/c queue. */
export function erlangC(c, a) {
  if (a >= c) return 1
  let sum = 0
  let term = 1
  for (let k = 0; k < c; k++) {
    if (k > 0) term *= a / k
    sum += term
  }
  const last = term * (a / c)
  const tail = last * (c / (c - a))
  return tail / (sum + tail)
}

/** Mean waiting time in queue for M/M/c, in the same time unit as serviceTime. */
export function mmcWaitTime(lambda, mu, c) {
  const a = lambda / mu
  if (a >= c) return Infinity
  return erlangC(c, a) / (c * mu - lambda)
}

/** Mean sojourn time (queue + service) for M/M/c. */
export const mmcSojourn = (lambda, mu, c) => mmcWaitTime(lambda, mu, c) + 1 / mu

/**
 * A single-node M/M/c IR, for holding the engine to theory.
 * @param serviceMeanMs mean service time
 */
export function mmcFixture({ serviceMeanMs = 20, capacityRps = 100, rps = 60 } = {}) {
  const client = {
    id: 'src', kind: 'client', label: 'load', attrs: {}, bindings: [],
    capacity: { replicas: 1, capPerReplica: Infinity, latencyMs: { dist: 'const', p50: 0, cv: 0 }, availability: 1, concurrency: 0, queueDepth: 0, source: true, provenance: { cls: 'benchmark', basis: 'test fixture', refs: [] }, jitter: { capPct: 0, latPct: 0 } },
  }
  const server = {
    id: 'srv', kind: 'app', label: 'server', attrs: {}, bindings: [],
    capacity: {
      replicas: 1, capPerReplica: capacityRps,
      // stated as a median, because that is what the IR carries
      latencyMs: { dist: 'exponential', p50: serviceMeanMs * Math.LN2, cv: 1 },
      availability: 1, concurrency: 0, queueDepth: 100000,
      provenance: { cls: 'benchmark', basis: 'test fixture', refs: [] }, jitter: { capPct: 0, latPct: 0 },
    },
  }
  return {
    irVersion: '2.0', meta: { name: 'mmc', createdBy: 'validation', updatedAt: '1970-01-01T00:00:00.000Z' },
    nodes: [client, server],
    edges: [{ id: 'e1', from: 'src', to: 'srv', callSemantics: 'sync' }],
    workloads: [{ id: 'w', arrival: { dist: 'const', rps } }],
    slos: [], deployments: [], passthrough: [],
  }
}

/**
 * A three-tier chain — gateway → app → database — which is the smallest shape
 * that can actually exhibit the interesting behaviours: a worker held across a
 * sync call, a breaker with something to protect, a retry with somewhere to
 * amplify. The metamorphic properties run against this rather than a single
 * node, because a single node cannot starve on a dependency it does not have.
 */
export function chainFixture({ rps = 500, appCap = 1000, dbCap = 800 } = {}) {
  const cap = (capPerReplica, p50, replicas = 2, extra = {}) => ({
    replicas, capPerReplica,
    latencyMs: { dist: 'lognormal', p50, cv: 0.5 },
    availability: 0.999, concurrency: 0, queueDepth: 2000,
    provenance: { cls: 'benchmark', basis: 'test fixture', refs: [] },
    jitter: { capPct: 0, latPct: 0 }, ...extra,
  })
  const node = (id, kind, label, capacity) => ({ id, kind, label, capacity, bindings: [], attrs: {} })
  return {
    irVersion: '2.0', meta: { name: 'chain', createdBy: 'validation', updatedAt: '1970-01-01T00:00:00.000Z' },
    nodes: [
      node('src', 'client', 'load', { ...cap(Infinity, 0, 1), source: true }),
      node('gw', 'gateway', 'gateway', cap(20000, 2)),
      node('app', 'app', 'app', cap(appCap, 20)),
      node('db', 'sql', 'db', cap(dbCap, 8)),
    ],
    edges: [
      { id: 'e1', from: 'src', to: 'gw', callSemantics: 'sync' },
      { id: 'e2', from: 'gw', to: 'app', callSemantics: 'sync' },
      { id: 'e3', from: 'app', to: 'db', callSemantics: 'sync', protocol: 'sql' },
    ],
    workloads: [{ id: 'w', arrival: { dist: 'const', rps } }],
    slos: [], deployments: [], passthrough: [],
  }
}

/**
 * Compare the engine's mean sojourn time against Erlang-C.
 * Returns {theory, observed, relErr, workers, ok}.
 */
export function checkErlangC({ serviceMeanMs = 20, capacityRps = 100, rps = 60, horizonMs = 600000, seed = 7, tolerance = 0.2 } = {}) {
  const ir = mmcFixture({ serviceMeanMs, capacityRps, rps })
  const res = runDES(ir, { horizonMs, seed, frameMs: horizonMs })
  const node = res.nodes.srv
  const mu = 1000 / serviceMeanMs           // per second
  const theory = mmcSojourn(rps, mu, node.workers) * 1000
  const observed = node.latency.mean
  const relErr = Math.abs(observed - theory) / theory
  return { theory, observed, relErr, workers: node.workers, utilization: node.utilization, ok: relErr <= tolerance, samples: node.latency.count }
}

/**
 * Cross-engine consistency below the knee. Both engines are given the same IR
 * and the same offered load; their medians must land within `tolerance`.
 */
export function checkCrossEngine(ir, rps, { horizonMs = 120000, seed = 11, tolerance = 0.35 } = {}) {
  const des = runDES(ir, { horizonMs, seed, workload: { id: 'x', arrival: { dist: 'const', rps } } })
  const ana = simulate(ir, rps)
  // Compare means, not medians. The analytic engine's latency is a mean-shaped
  // quantity (a base service time scaled by an M/M/1 queueing factor); its
  // "p50" label is a convenience. Holding a mean against a median would be
  // comparing two different statistics and calling the gap a bug.
  const desMean = des.latency.mean
  const relErr = Math.abs(desMean - ana.p50) / Math.max(1e-9, ana.p50)
  return { des: desMean, desP50: des.p50_ms, analytic: ana.p50, relErr, ok: relErr <= tolerance, maxUtil: Math.max(0, ...Object.values(des.nodes).map((n) => n.utilization)) }
}

/**
 * Metamorphic properties. Each returns {ok, detail} and each is a relation that
 * must hold for *any* seeded run, which is what makes them cheap to check and
 * hard to satisfy by accident.
 */
export const METAMORPHIC = {
  /** Doubling worker count at fixed λ never raises p99. */
  moreWorkersNeverWorse(ir, rps, seed = 3) {
    const base = runDES(ir, { seed, horizonMs: 60000, workload: w(rps) })
    const doubled = runDES(scaleReplicas(ir, 2), { seed, horizonMs: 60000, workload: w(rps) })
    return { ok: doubled.p99_ms <= base.p99_ms * 1.05, base: base.p99_ms, doubled: doubled.p99_ms }
  },

  /** Adding a retry budget never raises the steady-state error rate. */
  retryBudgetNeverWorse(ir, rps, seed = 5) {
    const unbudgeted = withRetry(ir, { max: 2, backoffMs: 40, jitter: 'full', budgetPct: 0 })
    const budgeted = withRetry(ir, { max: 2, backoffMs: 40, jitter: 'full', budgetPct: 10 })
    const a = runDES(unbudgeted, { seed, horizonMs: 60000, workload: w(rps) })
    const b = runDES(budgeted, { seed, horizonMs: 60000, workload: w(rps) })
    return { ok: b.errorRate <= a.errorRate + 0.02, unbudgeted: a.errorRate, budgeted: b.errorRate }
  },

  /** An open breaker never raises upstream p99: fail-fast beats waiting. */
  breakerNeverRaisesUpstreamP99(ir, rps, seed = 9) {
    const noBreaker = withTimeouts(ir, 200)
    const breakered = withBreaker(withTimeouts(ir, 200), { windowSec: 5, errThreshold: 0.3, minSamples: 20, halfOpenProbes: 1, cooloffMs: 3000 })
    const fx = failLastHop(ir)
    const a = runDES(noBreaker, { seed, horizonMs: 60000, workload: w(rps), fx })
    const b = runDES(breakered, { seed, horizonMs: 60000, workload: w(rps), fx })
    return { ok: b.p99_ms <= a.p99_ms * 1.05, without: a.p99_ms, with: b.p99_ms }
  },
}

const w = (rps) => ({ id: 'w', arrival: { dist: 'const', rps } })

export function scaleReplicas(ir, factor) {
  return { ...ir, nodes: ir.nodes.map((n) => (n.capacity.source ? n : { ...n, capacity: { ...n.capacity, replicas: Math.max(1, Math.round(n.capacity.replicas * factor)) } })) }
}
export function withRetry(ir, retry) {
  return { ...ir, edges: ir.edges.map((e) => ({ ...e, timeoutMs: e.timeoutMs ?? 250, retry })) }
}
export function withTimeouts(ir, timeoutMs) {
  return { ...ir, edges: ir.edges.map((e) => ({ ...e, timeoutMs })) }
}
export function withBreaker(ir, breaker) {
  return { ...ir, edges: ir.edges.map((e) => ({ ...e, breaker })) }
}
/** Make the deepest node fail, so there is something for a breaker to catch. */
export function failLastHop(ir) {
  const hasOut = new Set(ir.edges.map((e) => e.from))
  const leaf = ir.nodes.find((n) => !hasOut.has(n.id) && !n.capacity.source)
  return leaf ? { node: { [leaf.id]: { capMul: 0.2, latMul: 6, drop: 0.6, dup: 0, noCache: false } }, cut: new Set(), rpsMul: 1 } : { node: {}, cut: new Set(), rpsMul: 1 }
}
