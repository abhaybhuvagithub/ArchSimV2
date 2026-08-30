// The Monte-Carlo runner — where v1's honesty band becomes arithmetic.
//
// v1 shipped a disclaimer: every number carries roughly ±40%. That was true and
// useless, because a disclaimer cannot fail a build. Here the band is a prior
// per node, and each run draws a world from it. A verdict is then a probability
// over worlds, not a point estimate dressed as a fact:
//
//   "p99 ≤ 800ms holds in 86% of sampled worlds (was 99% on main)"
//
// Each run samples three things:
//   parameters — every node's capPerReplica and latency, from its jitter prior
//   workload   — an arrival realization from the declared distribution
//   scenario   — the fault(s), applied through the same fx mechanism as v1
//
// The analytic engine answers in about a millisecond, so 500 runs × 4 scenarios
// lands inside PR-comment latency. Runs flagged interesting are escalated to
// the DES for a time-resolved trace: a fidelity ladder, not rivals.

import { simulate, effectiveCap, isSourceNode } from './simulate.js'
import { compileFaults } from './faults.js'
import { costReport } from './pricing.js'
import { streamFor, bandDraw, poisson, percentile, mean } from './rng.js'

export const BASELINE_SCENARIO = { id: 'nominal', faults: [] }

/**
 * @param ir        ArchIR
 *
 * @typedef {object} McOpts
 * @property {number}  [runs]      number of sampled worlds (default 500)
 * @property {number}  [seed]      integer seed (default 42)
 * @property {any[]}   [scenarios] [{id, faults:[{fault, target?}]}] — 'nominal' is always included
 * @property {any[]}   [workloads] override ir.workloads
 * @property {boolean} [jitter]    false to disable parameter sampling (point estimate)
 *
 * @param {McOpts} [opts]
 */
export function runMonteCarlo(ir, opts = {}) {
  const runs = Math.max(1, opts.runs ?? 500)
  const seed = opts.seed ?? 42
  const workloads = (opts.workloads?.length ? opts.workloads : ir.workloads) || []
  const wl = workloads.length ? workloads : [{ id: 'default', arrival: { dist: 'const', rps: 1000 } }]
  const scenarios = dedupeScenarios([BASELINE_SCENARIO, ...(opts.scenarios || [])])
  const useJitter = opts.jitter !== false

  // A nominal, unsampled run first: it resolves fault targets (chaos aimed at
  // an idle node proves nothing) and anchors the cost model.
  const anchor = simulate(ir, wl[0].arrival.rps, {})

  const cells = []
  for (const w of wl) {
    for (const s of scenarios) {
      const fx = compileFaults(s.faults || [], ir, anchor)
      const samples = []
      for (let run = 0; run < runs; run++) {
        const r = streamFor(seed, run, hash(`${w.id}|${s.id}`))
        const sample = useJitter ? drawParameters(ir, r) : null
        const rps = drawArrival(w, r)
        const sim = simulate(ir, rps, { fx, sample })
        samples.push(summarize(sim, ir, run))
      }
      cells.push({
        workload: w.id, scenario: s.id, applied: fx.applied,
        runs: samples,
        metrics: aggregate(samples),
      })
    }
  }

  const cost = costReport(ir, anchor)
  return {
    seed, runs, irNodes: ir.nodes.length, irEdges: ir.edges.length,
    scenarios: scenarios.map((s) => s.id),
    workloads: wl.map((w) => w.id),
    cells,
    cost,
    anchor,
    provenanceMix: provenanceMix(ir),
  }
}

/** Draw every node's capacity and latency multipliers from its own prior. */
export function drawParameters(ir, r) {
  const out = {}
  for (const n of ir.nodes) {
    if (isSourceNode(n)) continue
    const c = effectiveCap(n)
    out[n.id] = {
      capMul: Math.max(0.05, bandDraw(r, c.jitter?.capPct ?? 40)),
      latMul: Math.max(0.05, bandDraw(r, c.jitter?.latPct ?? 40)),
    }
  }
  return out
}

/** Arrival realization for one run. */
export function drawArrival(w, r) {
  const a = w.arrival || { dist: 'const', rps: 100 }
  const base = a.rps
  switch (a.dist) {
    case 'poisson': return Math.max(1, poisson(r, base))
    case 'diurnal': {
      // The gate cares about the peak of the day, not its average: a design
      // that only holds at 3am is not a design that holds.
      const peak = a.params?.peakFactor ?? 3
      const phase = r() // where in the day this world is sampled
      const shape = 0.5 + 0.5 * Math.sin(2 * Math.PI * (phase - 0.25))
      return Math.max(1, base * (1 + (peak - 1) * Math.pow(shape, 3)))
    }
    case 'spike': {
      const p = a.params?.probability ?? 0.15
      const factor = a.params?.factor ?? 5
      return r() < p ? base * factor : base
    }
    default: return base
  }
}

function summarize(sim, ir, run) {
  const worst = Object.entries(sim.stats)
    .filter(([id]) => !isSourceNode(ir.nodes.find((n) => n.id === id) || {}))
    .sort((a, b) => (b[1].util || 0) - (a[1].util || 0))[0]
  return {
    run,
    p50_ms: sim.p50, p95_ms: sim.p95, p99_ms: sim.p99,
    error_rate: sim.errorRate,
    availability: sim.sysAvail,
    throughput_rps: sim.offeredRps - sim.totalDropped,
    maxUtil: worst ? worst[1].util : 0,
    bottleneck: worst ? worst[0] : null,
    perNode: Object.fromEntries(Object.entries(sim.stats).map(([id, s]) => [id, { util: s.util, latency: s.latency, dropped: s.dropped, avail: s.avail }])),
  }
}

function aggregate(samples) {
  const pick = (k) => samples.map((s) => s[k])
  const stat = (k) => {
    const xs = pick(k)
    return { mean: mean(xs), p50: percentile(xs, 50), p90: percentile(xs, 90), p99: percentile(xs, 99), min: Math.min(...xs), max: Math.max(...xs) }
  }
  const bn = {}
  for (const s of samples) if (s.bottleneck) bn[s.bottleneck] = (bn[s.bottleneck] || 0) + 1
  return {
    p50_ms: stat('p50_ms'), p95_ms: stat('p95_ms'), p99_ms: stat('p99_ms'),
    error_rate: stat('error_rate'), availability: stat('availability'),
    throughput_rps: stat('throughput_rps'), maxUtil: stat('maxUtil'),
    bottleneckCounts: Object.entries(bn).sort((a, b) => b[1] - a[1]),
  }
}

function provenanceMix(ir) {
  const m = {}
  for (const n of ir.nodes) {
    const cls = n.capacity?.provenance?.cls || 'modeled'
    m[cls] = (m[cls] || 0) + 1
  }
  return m
}

function dedupeScenarios(list) {
  const seen = new Set()
  const out = []
  for (const s of list) {
    const id = s.id || (s.faults || []).map((f) => f.fault || f).join('+') || 'nominal'
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ ...s, id })
  }
  return out
}

function hash(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0
  return h >>> 0
}
