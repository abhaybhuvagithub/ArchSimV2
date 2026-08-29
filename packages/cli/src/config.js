// `.archsim/slo.yaml` — the thresholds that become PR law.
//
// This file is the interface between an architecture and a build. Everything in
// it is a claim someone is willing to have a pull request blocked over, which is
// why the loader is strict about what it does not understand: a typo in a metric
// name must not silently become "no SLO", or the gate passes for the wrong
// reason and nobody notices for a quarter.

import { parseYamlDocs } from '@archsim/iac'
import { SLO_METRICS, ARRIVAL_DISTS } from '@archsim/ir'
import { FAULTS } from '@archsim/core'

export const DEFAULT_CONFIG_PATH = '.archsim/slo.yaml'

/**
 * The scenarios a gate runs when nobody has said which. Not a substitute for a
 * declared set — an estate has its own failure modes — but a design that has
 * never been asked what happens when an availability zone goes away has not
 * been gated at all.
 */
export const DEFAULT_SCENARIOS = [
  { id: 'az', faults: [{ fault: 'az' }] },
  { id: 'retry', faults: [{ fault: 'retry', target: 'kind:sql' }] },
  { id: 'crash', faults: [{ fault: 'crash', target: 'kind:app' }] },
]

export function parseConfig(text, file = DEFAULT_CONFIG_PATH) {
  const docs = parseYamlDocs(text, file)
  const raw = docs.find((d) => d.value && typeof d.value === 'object')?.value || {}
  const errors = []

  const slos = (raw.slos || []).map((s, i) => {
    const id = s.id || `${s.metric}-${i}`
    if (!SLO_METRICS.includes(s.metric)) errors.push(`slos[${i}]: unknown metric '${s.metric}' (expected one of ${SLO_METRICS.join(', ')})`)
    if (!['<=', '>='].includes(String(s.op))) errors.push(`slos[${i}]: op must be "<=" or ">=", got ${JSON.stringify(s.op)}`)
    if (typeof s.threshold !== 'number') errors.push(`slos[${i}]: threshold must be a number, got ${JSON.stringify(s.threshold)}`)
    return {
      id,
      scope: s.node ? { node: s.node } : s.edge ? { edge: s.edge } : 'system',
      metric: s.metric,
      op: String(s.op),
      threshold: Number(s.threshold),
      under: s.under || 'all',
      ...(s.scenarios ? { scenarios: [].concat(s.scenarios) } : {}),
    }
  })

  const workloads = (raw.workloads || []).map((w, i) => {
    const arrival = w.arrival || {}
    if (!ARRIVAL_DISTS.includes(arrival.dist)) errors.push(`workloads[${i}]: unknown arrival dist '${arrival.dist}'`)
    if (!(Number(arrival.rps) > 0)) errors.push(`workloads[${i}]: arrival.rps must be > 0`)
    return {
      id: w.id || `w${i}`,
      arrival: { dist: arrival.dist, rps: Number(arrival.rps), params: arrival.params || {} },
      ...(w.mix ? { mix: { readPct: Number(w.mix.readPct) } } : {}),
    }
  })

  const scenarios = (raw.scenarios || []).map((s, i) => {
    const faults = [].concat(s.fault ? [{ fault: s.fault, target: s.target }] : (s.faults || []))
    for (const f of faults) {
      if (!FAULTS.some((x) => x.id === f.fault)) errors.push(`scenarios[${i}]: unknown fault '${f.fault}' (see \`archsim faults\`)`)
    }
    return { id: s.id || faults.map((f) => f.fault).join('+') || `scenario${i}`, faults }
  })

  const gate = raw.gate || {}
  return {
    slos, workloads, scenarios, errors,
    thresholds: {
      passPct: num(gate.passPct, 95),
      riskPct: num(gate.riskPct, 80),
    },
    runs: num(gate.runs, 500),
    seed: num(gate.seed, 42),
    quickFix: gate.quickFix !== false,
    escalate: gate.escalate === true,
  }
}

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)

export const EXAMPLE_CONFIG = `# .archsim/slo.yaml — the thresholds that become pull-request law.
#
# Every entry here is something you are willing to block a merge over. Scope an
# SLO to specific scenarios when it only means something in steady state;
# leave scenarios off and it must survive all of them.

gate:
  runs: 500        # sampled worlds per workload × scenario
  seed: 42         # same seed, same comment — reruns must be reproducible
  passPct: 95      # holds in >= 95% of worlds -> pass
  riskPct: 80      # holds in >= 80% -> warn (exit 2), below -> fail (exit 1)
  quickFix: true   # price the cheapest repair when something fails

slos:
  - id: latency
    metric: p99_ms
    op: "<="
    threshold: 800
    under: peak

  - id: errors
    metric: error_rate
    op: "<="
    threshold: 0.001
    under: all

  - id: availability
    metric: availability
    op: ">="
    threshold: 0.999
    scenarios: [nominal]

  - id: budget
    metric: monthly_cost_usd
    op: "<="
    threshold: 42000

workloads:
  - id: peak
    arrival: {dist: diurnal, rps: 12000, params: {peakFactor: 4}}
    mix: {readPct: 80}

scenarios:
  - fault: az          # one availability zone dark
  - fault: retry       # duplicate storm on the hottest write path
    target: "kind:sql"
  - fault: crash
    target: "kind:sql"
`
