#!/usr/bin/env node
// The 1,000-scenario benchmark.
//
// 100 templates × 10 operating conditions, every one of them actually
// simulated. This is the version of "a thousand" that is worth having: the
// thousand *templates* would have been 877 renames of the same queueing
// problem, but a thousand simulation runs over architectures that already
// exist produce a thousand answers nobody has yet.
//
// What it is for: the matrix says which shapes survive which failures. A
// template that passes nominal and dies at 3× peak is a different thing from
// one that dies only when it loses a region, and until now nothing said which
// was which.
//
// The load multipliers and the faults are the engine's own — no packet-loss
// knob is invented here that the simulator does not model. A profile is a load
// factor plus a fault the fault catalogue already defines, and node-scoped
// faults are left untargeted so the engine picks the node it would pick in the
// studio, rather than a kind guessed here that half the templates lack.
//
//   node test/benchmark.mjs            summary
//   node test/benchmark.mjs --json out.json    full matrix
//   node test/benchmark.mjs --runs 40  more Monte-Carlo samples per cell

import { writeFileSync } from 'node:fs'
import { TEMPLATES, template } from '@archsim/templates'
import { runMonteCarlo, evaluateSLOs, compileFaults } from '@archsim/core'

/**
 * Ten operating conditions, designed so each cell isolates one variable.
 *
 * The first draft did not, and the result was useless: retry-storm ran at 2.5×
 * load and cache-stampede at 4×, so those cells measured the load, not the
 * fault, and 98% of the library failed both. A benchmark where almost
 * everything fails carries the same amount of information as one where almost
 * everything passes.
 *
 * So: three profiles vary load with no faults, seven hold load at the design
 * point and vary the fault.
 *
 * The load multipliers are derived rather than chosen. `calibrate-templates`
 * sizes every template to TARGET_UTIL = 0.65 at its diurnal peak, so
 * 1 / 0.65 ≈ 1.54 is exactly where utilisation reaches 100% — the knee. 1× is
 * the design point, KNEE is the knee, and 2× KNEE is comfortably past it. A
 * number picked to make the table look interesting would be worth nothing.
 *
 * @typedef {object} Profile
 * @property {string} id
 * @property {string} name
 * @property {number} rpsMul   multiplier on every workload's arrival rate
 * @property {{fault: string}[]} faults
 * @property {string} asks     the question this profile puts to a design
 */

/** The sizing target templates are calibrated to; see test/calibrate-templates.mjs. */
export const TARGET_UTIL = 0.65
/** Where utilisation reaches 100% for a correctly sized template. */
export const KNEE = Number((1 / TARGET_UTIL).toFixed(2))

/** @type {Profile[]} */
export const PROFILES = [
  { id: 'nominal', name: 'Design point', rpsMul: 1, faults: [],
    asks: 'Does it work at all, on a good day?' },
  { id: 'knee', name: `At the knee, ${KNEE}×`, rpsMul: KNEE, faults: [],
    asks: 'What happens exactly where utilisation reaches 100%?' },
  { id: 'overload', name: `Overload, ${(KNEE * 2).toFixed(1)}×`, rpsMul: KNEE * 2, faults: [],
    asks: 'Well past the knee, what breaks first?' },

  // The rest hold load at the design point so the fault is the only variable.
  { id: 'az-loss', name: 'Zone loss', rpsMul: 1, faults: [{ fault: 'az' }],
    asks: 'Does losing a third of every tier stay inside the budget?' },
  { id: 'region-loss', name: 'Region loss', rpsMul: 1, faults: [{ fault: 'region' }],
    asks: 'Can the surviving half carry the whole load?' },
  { id: 'grey-failure', name: 'Grey failure', rpsMul: 1, faults: [{ fault: 'slow' }],
    asks: 'Does one instance answering slowly but passing health checks poison the pool?' },
  { id: 'retry-storm', name: 'Retry storm', rpsMul: 1, faults: [{ fault: 'retry' }],
    asks: 'Do retries amplify a small failure into a large one?' },
  { id: 'cache-stampede', name: 'Cache stampede', rpsMul: 1, faults: [{ fault: 'stampede' }],
    asks: 'What reaches the origin when the cache stops absorbing?' },
  { id: 'partition', name: 'Network partition', rpsMul: 1, faults: [{ fault: 'partition' }],
    asks: 'Do calls fail fast, or hold a worker for the whole timeout?' },
  { id: 'thundering-herd', name: 'Thundering herd', rpsMul: 1, faults: [{ fault: 'thunder' }],
    asks: 'Does everything reconnecting at once finish the job the outage started?' },
]

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name)
  return i === -1 ? fallback : process.argv[i + 1]
}
const RUNS = Number(arg('--runs', 24))
const SEED = Number(arg('--seed', 42))

/** Scale every workload's arrival rate, leaving the shape of the day alone. */
const scaled = (ir, mul) => (ir.workloads || []).map((w) => ({
  ...w,
  arrival: { ...w.arrival, rps: (w.arrival?.rps ?? 0) * mul },
}))

/** pass | risk | fail — the worst verdict any SLO reached. */
const worst = (rows) => (rows.some((r) => r.verdict === 'fail') ? 'fail'
  : rows.some((r) => r.verdict === 'risk') ? 'risk' : 'pass')

export function runBenchmark({ runs = RUNS, seed = SEED, onCell } = {}) {
  const cells = []
  for (const t of TEMPLATES) {
    const ir = template(t.id)
    for (const p of PROFILES) {
      // Discover what the engine binds a node-scoped fault to, so a failing
      // cell can name the component rather than just the profile.
      const fx = compileFaults(p.faults, ir)
      const scenario = { id: p.id, faults: p.faults }
      const mc = runMonteCarlo(ir, {
        runs, seed,
        scenarios: [scenario],
        workloads: scaled(ir, p.rpsMul),
      })
      const rows = evaluateSLOs(ir, mc).results
      const cell = {
        template: t.id, templateName: t.name, category: t.category,
        profile: p.id, profileName: p.name,
        verdict: worst(rows),
        breached: rows.filter((r) => r.verdict === 'fail').map((r) => r.slo.metric),
        at: fx.applied.map((a) => a.targetLabel).filter(Boolean),
      }
      cells.push(cell)
      onCell?.(cell)
    }
  }
  return cells
}

/* ── report ───────────────────────────────────────────────────────────────── */

if (import.meta.url === `file://${process.argv[1]}`) {
  const started = Date.now()
  let n = 0
  const cells = runBenchmark({
    onCell: () => { if (++n % 100 === 0) process.stdout.write('.') },
  })
  process.stdout.write('\n\n')

  const total = cells.length
  const by = (k) => (v) => cells.filter((c) => c[k] === v)
  const rate = (rows, v) => `${((rows.filter((c) => c.verdict === v).length / rows.length) * 100).toFixed(0)}%`

  console.log(`${total} simulations — ${TEMPLATES.length} architectures × ${PROFILES.length} conditions`)
  console.log(`${RUNS} Monte-Carlo samples each, seed ${SEED}, ${((Date.now() - started) / 1000).toFixed(1)}s\n`)

  console.log('Which conditions the library survives')
  console.log('condition            pass   risk   fail   the question it asks')
  for (const p of PROFILES) {
    const rows = by('profile')(p.id)
    console.log(
      `  ${p.name.padEnd(18)} ${rate(rows, 'pass').padStart(4)}  ${rate(rows, 'risk').padStart(5)}  ${rate(rows, 'fail').padStart(5)}   ${p.asks}`,
    )
  }

  // The architectures that hold up, and the ones that do not. This is the
  // output worth reading: it is a ranking nobody could produce by inspection.
  const perTemplate = TEMPLATES.map((t) => {
    const rows = by('template')(t.id)
    return { id: t.id, name: t.name, category: t.category, survived: rows.filter((c) => c.verdict === 'pass').length }
  }).sort((a, b) => b.survived - a.survived || a.name.localeCompare(b.name))

  const show = (rows) => rows.forEach((r) => console.log(`  ${String(r.survived).padStart(2)}/10  ${r.name} — ${r.category}`))
  console.log('\nMost resilient')
  show(perTemplate.slice(0, 8))
  console.log('\nLeast resilient')
  show(perTemplate.slice(-8).reverse())

  const never = perTemplate.filter((r) => r.survived === 0)
  if (never.length) console.log(`\n${never.length} architecture(s) pass no condition at all.`)
  const always = perTemplate.filter((r) => r.survived === PROFILES.length)
  console.log(`${always.length} pass all ten.`)

  // Which SLO actually does the failing.
  const breaches = {}
  for (const c of cells) for (const b of c.breached) breaches[b] = (breaches[b] || 0) + 1
  console.log('\nWhat breaks, across all 1,000 runs')
  for (const [id, count] of Object.entries(breaches).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${id.padEnd(18)} ${String(count).padStart(4)} breaches`)
  }

  const out = arg('--json', null)
  if (out) { writeFileSync(out, JSON.stringify({ runs: RUNS, seed: SEED, profiles: PROFILES, cells }, null, 0)); console.log(`\nwrote ${out}`) }
}
