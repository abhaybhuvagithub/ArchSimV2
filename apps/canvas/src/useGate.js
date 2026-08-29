// The gate, run for the studio.
//
// The first version of this app hid the gate behind a button. That was the
// product's whole argument sitting one click away from anyone who opened the
// page, and it made the studio look like a diagram editor with a tab. Here the
// verdict computes on load and re-computes when the design changes, so the
// question the tool exists to answer — *will this hold up?* — is answered before
// anybody asks it.
//
// It runs on the main thread deliberately: 200 sampled worlds across four
// scenarios is roughly a second, and a worker would mean a second copy of the
// engine to keep in step. The trade is revisited if the corpus grows.

import { useEffect, useRef, useState } from 'react'
import { runMonteCarlo, evaluateSLOs, structuralRisks, findCheapestFix } from '@archsim/core'

export function gateOnce(ir, config) {
  const mcOpts = { runs: config.runs, seed: config.seed, scenarios: config.scenarios }
  const mc = runMonteCarlo(ir, mcOpts)
  const evaluation = evaluateSLOs(ir, mc, { thresholds: config.thresholds })
  const risks = structuralRisks(ir, mc)
  const quickFix = evaluation.ok && !evaluation.risky.length
    ? null
    : findCheapestFix(ir, { mcOpts: { ...mcOpts, runs: Math.min(config.runs, 100) }, thresholds: config.thresholds })
  return { mc, evaluation, risks, quickFix, verdict: verdictOf(evaluation) }
}

export function verdictOf(evaluation) {
  if (!evaluation.ok) return 'fail'
  return evaluation.risky.length ? 'risk' : 'pass'
}

/**
 * @param ir        the design to judge
 * @param baseline  the IR of `main`, so a row can say "was 97%"
 */
export function useGate(ir, config, baseline = null) {
  const [state, setState] = useState({ busy: true, result: null, base: null })
  const baseCache = useRef(new Map())
  const token = useRef(0)

  useEffect(() => {
    const mine = ++token.current
    setState((s) => ({ ...s, busy: true }))
    // Yield a frame first so the busy state paints before the run takes the
    // thread — otherwise the UI appears to hang rather than to be working.
    const t = setTimeout(() => {
      let result = null
      let base = null
      try {
        result = gateOnce(ir, config)
        if (baseline) {
          const key = baseline.__hash || baseline
          if (!baseCache.current.has(key)) baseCache.current.set(key, gateOnce(baseline, config))
          base = baseCache.current.get(key)
        }
      } catch (err) {
        result = { error: err.message }
      }
      if (token.current === mine) setState({ busy: false, result, base })
    }, 30)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ir, baseline, config.runs, config.seed])

  return state
}

/** Pair each SLO with what it was on main, for the "was 97%" column. */
export function rowsWithBaseline(result, base) {
  if (!result?.evaluation) return []
  const before = new Map((base?.evaluation?.results || []).map((r) => [r.slo.id, r]))
  return result.evaluation.results.map((r) => ({ ...r, was: before.get(r.slo.id) || null }))
}
