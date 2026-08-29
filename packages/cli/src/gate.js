// The CI Architecture Gate.
//
//   plan → IR → diff against main's lockfile → Monte-Carlo across workloads and
//   scenarios → SLOs evaluated on the resulting distributions → a verdict, a
//   priced repair, and an exit code.
//
// The two design decisions that make this worth a status check rather than a
// dashboard:
//
//   1. The verdict is a probability, not a point estimate. "Holds in 61% of
//      sampled worlds" is a claim the model can support; "p99 = 812ms" is not.
//   2. It prices the fix. Failing a pull request is cheap and slightly rude.
//      Failing it with "sql.main 1→2 replicas restores both gates at +$410/mo,
//      6% of the savings this PR banks" is a decision someone can act on in the
//      thirty seconds they have.

import { runMonteCarlo, evaluateSLOs, structuralRisks, findCheapestFix, rightSizePlan, kinds } from '@archsim/core'
import { diffIR, validateIR, irHash, normalizeIR } from '@archsim/ir'

export function runGate({ ir, base = null, config, now = new Date() }) {
  const started = Date.now()
  const target = normalizeIR({
    ...ir,
    workloads: config.workloads.length ? config.workloads : ir.workloads,
    slos: config.slos.length ? config.slos : ir.slos,
  })

  const validation = validateIR(target, { kinds: kinds() })
  const mcOpts = { runs: config.runs, seed: config.seed, scenarios: config.scenarios, workloads: target.workloads }

  const mc = runMonteCarlo(target, mcOpts)
  const evaluation = evaluateSLOs(target, mc, { thresholds: config.thresholds })
  const risks = structuralRisks(target, mc)

  // Baseline: the same analysis against the committed IR of main, so the comment
  // can say what *changed* rather than only what is true. A p99 that was always
  // marginal is a different conversation from one this PR broke.
  let baseline = null
  let diff = null
  if (base) {
    const baseTarget = normalizeIR({ ...base, workloads: target.workloads, slos: target.slos })
    const baseMc = runMonteCarlo(baseTarget, mcOpts)
    baseline = { mc: baseMc, evaluation: evaluateSLOs(baseTarget, baseMc, { thresholds: config.thresholds }) }
    diff = diffIR(baseTarget, target)
  }

  let quickFix = null
  if (config.quickFix && (evaluation.failed.length || evaluation.risky.length)) {
    quickFix = findCheapestFix(target, { mcOpts: { ...mcOpts, runs: Math.min(config.runs, 150) }, thresholds: config.thresholds })
  }

  const savings = rightSizePlan(target, mc)

  return {
    ok: evaluation.ok,
    exitCode: evaluation.exitCode,
    ir: target,
    irHash: irHash(target),
    validation,
    mc,
    evaluation,
    risks,
    baseline,
    diff,
    quickFix,
    savings,
    meta: {
      seed: config.seed,
      runs: config.runs,
      scenarios: mc.scenarios,
      workloads: mc.workloads,
      elapsedMs: Date.now() - started,
      generatedAt: now.toISOString(),
      provenanceMix: mc.provenanceMix,
    },
  }
}

/**
 * Which SLO rows changed verdict between main and this PR. This is the list a
 * reviewer actually reads.
 */
export function verdictDeltas(result) {
  if (!result.baseline) return result.evaluation.results.map((r) => ({ ...r, was: null, changed: false }))
  const before = new Map(result.baseline.evaluation.results.map((r) => [r.slo.id, r]))
  return result.evaluation.results.map((r) => {
    const b = before.get(r.slo.id)
    return {
      ...r,
      was: b ? { verdict: b.verdict, holdPct: b.holdPct, observed: b.observed } : null,
      changed: !!b && b.verdict !== r.verdict,
      regressed: !!b && rank(r.verdict) > rank(b.verdict),
    }
  })
}

const rank = (v) => ({ pass: 0, risk: 1, fail: 2, skip: 0 }[v] ?? 0)
