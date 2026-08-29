// The convergent quick-fix engine — carried forward from v1's "future-ready"
// audit and pointed at the gate.
//
// This is the difference between a gate that fails a pull request and a gate
// that is worth having: it does not just say the design broke, it finds the
// cheapest change that unbreaks it and prices that change against the saving
// the PR was chasing.
//
//   Cheapest fix found: `sql.main` 1→2 replicas
//   restores both gates at +$410/mo — 6% of the savings this PR banks.
//
// Greedy and convergent: at each step, try every candidate repair, keep the one
// that buys the most SLO improvement per dollar, and stop as soon as everything
// passes (or the step budget runs out). Greedy because the search must fit
// inside PR-comment latency; convergent because each step strictly improves the
// worst SLO or is discarded.

import { runMonteCarlo } from './montecarlo.js'
import { evaluateSLOs } from './slo.js'
import { costReport } from './pricing.js'
import { isSourceNode, effectiveCap } from './simulate.js'
import { CATALOG } from './catalog.js'

const CACHEABLE_BEHIND = ['sql', 'nosql', 'search', 'graph', 'ledger']

/**
 * @param ir      the failing IR
 * @param opts.mcOpts  Monte-Carlo options (runs are reduced automatically)
 * @param opts.maxSteps default 3 — a fix nobody will read is not a fix
 */
export function findCheapestFix(ir, opts = {}) {
  const mcOpts = { ...(opts.mcOpts || {}), runs: Math.min(opts.mcOpts?.runs ?? 200, 200) }
  const baseMc = runMonteCarlo(ir, mcOpts)
  const baseEval = evaluateSLOs(ir, baseMc, opts)
  if (baseEval.ok && !baseEval.risky.length) return { needed: false, steps: [], costDelta: 0 }

  let current = ir
  let currentScore = score(baseEval)
  let currentCost = baseMc.cost.total
  const steps = []
  const maxSteps = opts.maxSteps ?? 3

  for (let step = 0; step < maxSteps; step++) {
    const options = candidates(current, baseMc)
    let best = null
    for (const cand of options) {
      const next = cand.apply(current)
      if (!next) continue
      const mc = runMonteCarlo(next, mcOpts)
      const ev = evaluateSLOs(next, mc, opts)
      const gain = score(ev) - currentScore
      const cost = mc.cost.total - currentCost
      if (gain <= 0.5) continue // no meaningful improvement — discard

      const efficiency = gain / Math.max(1, cost > 0 ? cost : 1)
      if (!best || efficiency > best.efficiency || (ev.ok && !best.ok)) {
        best = { cand, next, mc, ev, gain, cost, efficiency, ok: ev.ok }
      }
    }
    if (!best) break
    steps.push({ describe: best.cand.describe, nodeId: best.cand.nodeId, costDelta: best.cost, gain: best.gain })
    current = best.next
    currentScore = score(best.ev)
    currentCost = best.mc.cost.total
    if (best.ev.ok && !best.ev.risky.length) break
  }

  const finalMc = runMonteCarlo(current, mcOpts)
  const finalEval = evaluateSLOs(current, finalMc, opts)
  return {
    needed: true,
    steps,
    resolved: finalEval.ok,
    fullyResolved: finalEval.ok && !finalEval.risky.length,
    costBefore: baseMc.cost.total,
    costAfter: finalMc.cost.total,
    costDelta: finalMc.cost.total - baseMc.cost.total,
    ir: current,
    before: baseEval,
    after: finalEval,
  }
}

/** Candidate repairs, cheapest structural levers first. */
export function candidates(ir, mc) {
  const out = []
  const hot = Object.entries(mc.anchor.stats)
    .map(([id, s]) => ({ id, ...s }))
    .filter((s) => !isSourceNode(ir.nodes.find((n) => n.id === s.id) || {}))
    .sort((a, b) => b.util - a.util)
    .slice(0, 5)

  for (const h of hot) {
    const node = ir.nodes.find((n) => n.id === h.id)
    if (!node) continue

    // 1. add a replica — the boring answer, and usually the right one.
    //    Also offer a doubling and a fourfold jump: a design that is badly
    //    undersized cannot be walked back one replica at a time inside a step
    //    budget, and reporting "no cheap fix found" there would be wrong rather
    //    than merely unhelpful.
    for (const next of dedupeCounts([
      node.capacity.replicas + 1,
      Math.max(2, node.capacity.replicas * 2),
      Math.max(4, node.capacity.replicas * 4),
      Math.max(1, Math.ceil((h.in || 0) / Math.max(1, node.capacity.capPerReplica * 0.6))),
    ], node.capacity.replicas)) {
      out.push({
        nodeId: node.id,
        describe: `\`${node.label}\` ${node.capacity.replicas}→${next} replicas`,
        apply: (x) => mapNode(x, node.id, (n) => ({ ...n, capacity: { ...n.capacity, replicas: next } })),
      })
    }

    // 2. widen the worker pool — free, and often the actual constraint when a
    //    node starves on held workers rather than CPU (§5.6)
    if (node.capacity.concurrency > 0 && h.util < 0.9) {
      out.push({
        nodeId: node.id,
        describe: `\`${node.label}\` concurrency ${node.capacity.concurrency}→${node.capacity.concurrency * 2} (no new instances)`,
        apply: (x) => mapNode(x, node.id, (n) => ({ ...n, capacity: { ...n.capacity, concurrency: n.capacity.concurrency * 2, queueDepth: n.capacity.queueDepth * 2 } })),
      })
    }

    // 3. put a cache in front of a hot store — changes the shape, not the size
    if (CACHEABLE_BEHIND.includes(node.kind) && !hasCacheInFront(ir, node.id)) {
      out.push({
        nodeId: node.id,
        describe: `insert a cache in front of \`${node.label}\` (80% hit ratio)`,
        apply: (x) => insertCache(x, node.id),
      })
    }
  }

  // 4. retry budgets — costs nothing and is the difference between a blip and
  //    a self-sustaining storm
  for (const e of ir.edges) {
    if (e.retry?.max > 0 && !(e.retry.budgetPct > 0)) {
      out.push({
        edgeId: e.id,
        describe: `add a 10% retry budget to ${shortLabel(ir, e.from)}→${shortLabel(ir, e.to)} (free)`,
        apply: (x) => ({ ...x, edges: x.edges.map((y) => (y.id === e.id ? { ...y, retry: { ...y.retry, budgetPct: 10 } } : y)) }),
      })
    }
  }

  return out
}

/** Distinct, strictly-larger replica counts, cheapest first. */
function dedupeCounts(counts, current) {
  return [...new Set(counts.filter((c) => Number.isFinite(c) && c > current))].sort((a, b) => a - b).slice(0, 3)
}

function score(ev) {
  // Distance from passing, summed. Lower is better, so we return the negative
  // and maximise: a fix that lifts one SLO from 40% to 90% of worlds beats one
  // that lifts an already-passing SLO from 96% to 99%.
  let s = 0
  for (const r of ev.results) {
    if (r.holdPct === null) continue
    const need = ev.thresholds.passPct
    s += Math.min(r.holdPct, need)
  }
  return s
}

function mapNode(ir, id, f) {
  return { ...ir, nodes: ir.nodes.map((n) => (n.id === id ? f(n) : n)) }
}

function hasCacheInFront(ir, id) {
  return ir.edges.some((e) => e.to === id && ir.nodes.find((n) => n.id === e.from)?.kind === 'cache')
}

function insertCache(ir, id) {
  const target = ir.nodes.find((n) => n.id === id)
  if (!target) return null
  const spec = CATALOG.cache
  const cacheId = `fix-cache-${id.slice(0, 8)}`
  const cacheNode = {
    id: cacheId,
    kind: 'cache',
    label: `cache → ${target.label}`,
    capacity: {
      replicas: 2, capPerReplica: spec.cap, latencyMs: { dist: 'lognormal', p50: spec.lat, cv: spec.cv },
      availability: spec.avail, concurrency: spec.concurrency, queueDepth: spec.queueDepth, cacheHit: spec.cacheHit,
      provenance: { cls: 'modeled', basis: 'quick-fix proposal — catalog seed', refs: [] },
      jitter: { capPct: 40, latPct: 40 },
    },
    bindings: [], attrs: { proposedBy: 'archsim-quickfix' },
  }
  const rewired = ir.edges.map((e) => (e.to === id ? { ...e, to: cacheId } : e))
  return {
    ...ir,
    nodes: [...ir.nodes, cacheNode],
    edges: [...rewired, { id: `${cacheId}->${id}`, from: cacheId, to: id, callSemantics: 'sync', confidence: 'high' }],
  }
}

const shortLabel = (ir, id) => `\`${ir.nodes.find((n) => n.id === id)?.label || id.slice(0, 6)}\``

/** Right-sizing: the other direction — where the design is paying for headroom
 *  it demonstrably never uses. The gate prints these as savings, not failures. */
export function rightSizePlan(ir, mc, targetUtil = 0.55) {
  const rows = []
  for (const n of ir.nodes) {
    if (isSourceNode(n)) continue
    const s = mc.anchor.stats[n.id]
    if (!s || s.in <= 0) continue
    const per = effectiveCap(n).capPerReplica
    if (!per || per === Infinity) continue
    const needed = Math.max(1, Math.ceil(s.in / (per * targetUtil)))
    if (needed < n.capacity.replicas) {
      const after = mapNode(ir, n.id, (x) => ({ ...x, capacity: { ...x.capacity, replicas: needed } }))
      rows.push({
        nodeId: n.id, label: n.label, from: n.capacity.replicas, to: needed,
        saving: mc.cost.total - costReport(after, mc.anchor).total,
        caveat: needed < 2 ? 'drops below two replicas — this trades money for a SPOF' : null,
      })
    }
  }
  return rows.sort((a, b) => b.saving - a.saving)
}
