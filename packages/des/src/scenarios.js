// The findings a discrete-event trace can support that a steady-state model
// cannot: amplification, starvation, breaker behaviour, partitions.
//
// Each of these is written as an *analysis of a trace*, not a claim bolted onto
// the model. The analytic engine asserts that a retry storm multiplies demand by
// `dup`; here the multiplication is measured from the calls that actually
// happened, which is why the number is allowed to surprise you.

import { runDES } from './engine.js'
import { compileFaults } from '@archsim/core'

/**
 * Retry storms — the amplification recurrence.
 *
 *   λ_eff(t) = λ(t) + Σ_k p_fail(t − d_k) · λ_retry_k(t − d_k),   d_k = timeout + backoff_k
 *
 * Timeouts raise p_fail, which raises λ_eff after delay d, which raises
 * utilization → latency → more timeouts. With naive retries the fixed point is
 * saturation; with a budget the loop damps. This function reports which of the
 * two actually happened.
 */
export function analyzeStorm(result) {
  const edges = Object.entries(result.edges)
    .map(([id, e]) => ({ id, ...e, amplification: e.calls > 0 ? e.calls / Math.max(1, e.calls - e.retries) : 1 }))
    .filter((e) => e.retries > 0)
    .sort((a, b) => b.amplification - a.amplification)
  if (!edges.length) return { amplifying: false, edges: [], verdict: 'no retries were issued in this run' }

  // Self-sustaining if the retry share is still climbing at the end of the run:
  // a storm that damps shows its retries concentrated early.
  const worst = edges[0]
  const selfSustaining = worst.amplification > 1.5 && worst.errRate > 0.2
  return {
    amplifying: worst.amplification > 1.1,
    selfSustaining,
    edges,
    verdict: selfSustaining
      ? `retries on ${short(worst.from)}→${short(worst.to)} multiplied demand ${worst.amplification.toFixed(2)}× while the error rate stayed at ${(worst.errRate * 100).toFixed(0)}% — the loop is feeding itself, not recovering`
      : worst.amplification > 1.1
        ? `retries multiplied demand ${worst.amplification.toFixed(2)}× and the loop damped`
        : 'retries stayed within noise',
  }
}

/**
 * Thread starvation — the quiet cascade channel.
 *
 *   ρ = λ · E[hold] / c
 *
 * With sync calls a worker is held for `service + downstream_wait`, so a
 * downstream slowdown inflates E[hold] and a node can starve at *unchanged λ and
 * healthy CPU*. That is the grey failure that pages nobody until the front door
 * drowns; it is invisible to a steady-state model that never held a worker.
 */
export function analyzeStarvation(result) {
  const rows = Object.entries(result.nodes)
    .map(([id, n]) => ({
      id, label: n.label, kind: n.kind,
      workers: n.workers,
      utilization: n.utilization,
      heldFraction: n.heldFraction,
      ownServiceMs: n.latency.p50 * (1 - n.heldFraction),
      holdMs: n.latency.mean,
      throughputRps: n.throughputRps,
    }))
    .filter((n) => n.heldFraction > 0.5 && n.utilization > 0.7)
    .sort((a, b) => b.heldFraction - a.heldFraction)

  return {
    starving: rows.length > 0,
    rows,
    verdict: rows.length
      ? `\`${rows[0].label}\` is ${(rows[0].utilization * 100).toFixed(0)}% utilized but ${(rows[0].heldFraction * 100).toFixed(0)}% of that is workers *waiting on a downstream call*, not doing work. Its CPU looks fine. Adding replicas buys headroom; capping E[hold] with a timeout and a breaker fixes the cause.`
      : 'no node is starving on held workers',
  }
}

/** Breaker behaviour over the run: opens, closes, and what fail-fast bought. */
export function analyzeBreakers(result) {
  const rows = Object.entries(result.edges)
    .filter(([, e]) => e.breakerState !== null)
    .map(([id, e]) => ({ id, ...e }))
  const flapping = rows.filter((r) => r.breakerOpens > 2)
  return {
    any: rows.length > 0,
    rows,
    flapping,
    verdict: flapping.length
      ? `${flapping.length} breaker(s) opened more than twice — the cooloff is shorter than the recovery, so traffic is being let back into a service that has not recovered`
      : rows.some((r) => r.breakerOpens > 0)
        ? `breaker opened and held; ${rows.reduce((a, r) => a + r.shortCircuited, 0)} calls failed fast instead of waiting for a timeout`
        : 'no breaker opened in this run',
  }
}

/**
 * Network partition as an edge predicate over time.
 *
 * Affected calls resolve as *timeouts*, not instant errors — which is the
 * expensive kind of failure: the worker is held for the full timeout, feeding
 * starvation and retry amplification at the same time. A partition modelled as
 * a fast error would flatter the design.
 */
export function partitionScenario(ir, { targetKind, timeoutMs = 2000 } = {}) {
  const victims = ir.nodes.filter((n) => (targetKind ? n.kind === targetKind : false))
  const node = {}
  for (const v of victims) node[v.id] = { capMul: 0.15, latMul: 10, drop: 0.5, dup: 0, noCache: false }
  return {
    fx: { node, cut: new Set(), rpsMul: 1, applied: victims.map((v) => ({ fault: 'partition', name: 'Network partition', target: v.id, targetLabel: v.label })) },
    ir: { ...ir, edges: ir.edges.map((e) => (victims.some((v) => v.id === e.to) ? { ...e, timeoutMs: e.timeoutMs ?? timeoutMs } : e)) },
  }
}

/**
 * Escalation from the analytic ladder. The Monte-Carlo runner flags a world as
 * interesting — a breaker flapping, a storm feeding back, utilization past the
 * knee — and this runs that exact world through the DES for a time-resolved
 * trace. The two engines are rungs, and this is the rung change.
 */
export function escalate(ir, { scenario = { id: 'nominal', faults: [] }, workload, seed = 42, horizonMs = 60000, anchorSim = null } = {}) {
  const fx = compileFaults(scenario.faults || [], ir, anchorSim)
  const result = runDES(ir, { fx, workload, seed, horizonMs })
  return {
    scenario: scenario.id,
    result,
    storm: analyzeStorm(result),
    starvation: analyzeStarvation(result),
    breakers: analyzeBreakers(result),
  }
}

/** Worth escalating? Cheap heuristics over an analytic Monte-Carlo cell. */
export function worthEscalating(cell) {
  const m = cell.metrics
  if (!m) return false
  if (m.maxUtil.p90 > 0.85) return { why: 'utilization past the knee in the upper decile — the analytic queueing term stops being a model of anything here' }
  if (m.error_rate.p90 > 0.01) return { why: 'errors in the upper decile: worth seeing whether they compound over time' }
  if (cell.applied?.some((a) => a.fault === 'retry')) return { why: 'a retry scenario: the analytic engine asserts the multiplier, the DES produces it' }
  return false
}

const short = (id) => String(id).slice(0, 6)
