// SLO evaluation over a distribution of sampled worlds.
//
// The verdict is deliberately not "p99 = 812ms, fail". It is "p99 ≤ 800ms holds
// in 61% of sampled worlds, and held in 99% on main". A point estimate from a
// model built on ±40% priors is a number with false precision stapled to it;
// a proportion of worlds is what the model can actually support.
//
// Three verdicts, so the gate can distinguish "this breaks" from "this is now
// eating the error budget":
//   pass  — holds in >= passPct of worlds
//   risk  — holds in >= riskPct (exit 2 by default: warn, do not block)
//   fail  — below that (exit 1)

import { isSourceNode } from './simulate.js'

export const DEFAULT_THRESHOLDS = { passPct: 95, riskPct: 80 }

export function evaluateSLOs(ir, mc, opts = {}) {
  const { passPct, riskPct } = { ...DEFAULT_THRESHOLDS, ...(opts.thresholds || {}) }
  const results = []

  for (const slo of ir.slos || []) {
    if (slo.metric === 'monthly_cost_usd') {
      const observed = mc.cost.total
      const held = compare(observed, slo.op, slo.threshold)
      results.push({
        slo, kind: 'deterministic', observed, holdPct: held ? 100 : 0,
        verdict: held ? 'pass' : 'fail',
        detail: `$${fmtMoney(observed)}/mo vs ${slo.op} $${fmtMoney(slo.threshold)}`,
        perScenario: [],
      })
      continue
    }

    const cells = mc.cells.filter((c) =>
      (slo.under === 'all' || c.workload === slo.under) &&
      (!slo.scenarios || slo.scenarios.includes(c.scenario)))
    if (!cells.length) {
      results.push({ slo, kind: 'skipped', holdPct: null, verdict: 'skip', detail: `no runs matched workload '${slo.under}'${slo.scenarios ? ` and scenarios ${slo.scenarios.join('/')}` : ''}`, perScenario: [] })
      continue
    }

    const perScenario = cells.map((c) => {
      const values = c.runs.map((r) => extract(r, slo, ir))
      const holds = values.filter((v) => v !== null && compare(v, slo.op, slo.threshold)).length
      const usable = values.filter((v) => v !== null).length || 1
      return {
        workload: c.workload, scenario: c.scenario, applied: c.applied,
        holdPct: (100 * holds) / usable,
        median: median(values.filter((v) => v !== null)),
        worst: slo.op === '<=' ? Math.max(...values.filter((v) => v !== null)) : Math.min(...values.filter((v) => v !== null)),
      }
    })

    // The system is only as good as its worst declared scenario: an SLO that
    // holds at nominal and collapses in the AZ-loss scenario has not held.
    const worstCell = perScenario.slice().sort((a, b) => a.holdPct - b.holdPct)[0]
    const holdPct = worstCell.holdPct
    results.push({
      slo, kind: 'distribution', holdPct,
      observed: worstCell.median,
      verdict: holdPct >= passPct ? 'pass' : holdPct >= riskPct ? 'risk' : 'fail',
      drivingScenario: worstCell.scenario,
      detail: `${label(slo)} holds in ${holdPct.toFixed(0)}% of worlds (worst scenario: ${worstCell.scenario})`,
      perScenario,
    })
  }

  const failed = results.filter((r) => r.verdict === 'fail')
  const risky = results.filter((r) => r.verdict === 'risk')
  return {
    results, failed, risky,
    ok: failed.length === 0,
    exitCode: failed.length ? 1 : risky.length ? 2 : 0,
    thresholds: { passPct, riskPct },
  }
}

/** Pull the metric this SLO scopes to out of one run summary. */
function extract(run, slo, ir) {
  const m = slo.metric
  if (slo.scope === 'system' || !slo.scope) return run[m] ?? null
  if (typeof slo.scope === 'object' && slo.scope.node) {
    const s = run.perNode?.[slo.scope.node]
    if (!s) return null
    switch (m) {
      case 'p50_ms': return s.latency
      case 'p95_ms': return s.latency * 1.8
      case 'p99_ms': return s.latency * 3
      case 'error_rate': return s.dropped > 0 ? s.dropped / Math.max(1e-9, s.dropped + (s.util || 0)) : 0
      case 'availability': return s.avail
      case 'throughput_rps': return Math.max(0, (s.util || 0))
      default: return null
    }
  }
  return run[m] ?? null
}

export function compare(value, op, threshold) {
  if (value === null || value === undefined || Number.isNaN(value)) return false
  return op === '<=' ? value <= threshold : value >= threshold
}

export function label(slo) {
  const t = slo.metric === 'error_rate' || slo.metric === 'availability'
    ? `${(slo.threshold * 100).toFixed(slo.threshold < 0.01 ? 2 : 3)}%`
    : slo.metric === 'monthly_cost_usd'
      ? `$${slo.threshold.toLocaleString('en-US')}`
      : `${slo.threshold}${slo.metric.endsWith('_ms') ? 'ms' : ''}`
  const scope = slo.scope === 'system' ? '' : typeof slo.scope === 'object' && slo.scope.node ? ` @${slo.scope.node.slice(0, 6)}` : ''
  return `${slo.metric}${scope} ${slo.op} ${t}`
}

/**
 * Structural risks the simulator alone will not surface. A single-replica
 * stateful node is a SPOF whether or not this month's traffic happens to fit
 * on it — the gate says so in the availability row, because "it passed" and
 * "it is safe" are different claims.
 */
export function structuralRisks(ir, mc) {
  const risks = []
  for (const n of ir.nodes) {
    if (isSourceNode(n)) continue
    const inRps = mc.anchor?.stats?.[n.id]?.in || 0
    if (inRps <= 0) continue
    if (n.capacity.replicas <= 1) {
      risks.push({ nodeId: n.id, kind: 'spof', label: n.label,
        msg: `SPOF: \`${n.label}\` runs ${n.capacity.replicas} replica — its availability is the system's ceiling (${pct(n.capacity.availability)})` })
    }
    if (n.capacity.provenance?.cls === 'modeled' && (mc.anchor.stats[n.id]?.util || 0) > 0.7) {
      risks.push({ nodeId: n.id, kind: 'unmeasured-hotspot', label: n.label,
        msg: `\`${n.label}\` is the busiest tier (${pct(mc.anchor.stats[n.id].util)} utilized) but its capacity is a modelled prior, not a measurement — calibrate it from telemetry before trusting this verdict` })
    }
  }
  for (const e of ir.edges) {
    if (e.retry?.max > 0 && !(e.retry.budgetPct > 0)) {
      risks.push({ edgeId: e.id, kind: 'unbudgeted-retry', msg: `unbudgeted retries on ${short(e.from)}→${short(e.to)}: under load this amplifies rather than recovers (run \`--engine des --scenario retry\`)` })
    }
  }
  return risks
}

const median = (xs) => {
  if (!xs.length) return 0
  const s = xs.slice().sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const pct = (v) => `${(v * 100).toFixed(2)}%`
const short = (id) => String(id).slice(0, 6)
const fmtMoney = (v) => v.toLocaleString('en-US', { maximumFractionDigits: 0 })
