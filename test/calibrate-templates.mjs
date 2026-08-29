// Size the templates, then set their SLOs from what the sized design does.
//
// Replica counts are derived, not authored. A hand-written count is a guess
// about capacity, and a template that saturates the moment it opens teaches the
// reader that the tool is wrong rather than that the design is. So this pass
// raises each component's count until nothing sits above 65% utilisation at the
// peak of the declared day — which makes every template a *sized* design, and
// makes the sizes reproducible from the catalog rather than from memory.
//
// The thresholds are then set the way a team actually sets them: measure what
// the design does at nominal, promise a round number slightly worse than that,
// and let the failure scenarios decide whether the promise survives contact.
// The error budget is deliberately *not* nominal-only — it is the one gate the
// az-loss and crash scenarios are allowed to break, which is what makes opening
// a template worth doing.
//
// Run: node test/calibrate-templates.mjs --write

import { readFileSync, writeFileSync } from 'node:fs'
import { SPECS } from '../packages/templates/src/specs.js'
import { buildTemplate, TEMPLATE_SCENARIOS } from '../packages/templates/src/index.js'
import { simulate, capacityReport, runMonteCarlo, evaluateSLOs } from '../packages/core/src/index.js'

const PEAK_FACTOR = 2
const TARGET_UTIL = 0.65
const AVAIL_TIERS = [0.99, 0.995, 0.999, 0.9995, 0.9999, 0.99995, 0.99999]

const nice = (v) => {
  // Round up to one of 1/1.5/2/2.5/3/4/5/6/8/10 × a power of ten, so a threshold
  // reads like a number a person chose.
  const mags = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(v, 1))))
  for (const m of mags) if (m * p >= v) return m * p
  return 10 * p
}
const tier = (v) => [...AVAIL_TIERS].reverse().find((t) => t <= v) || AVAIL_TIERS[0]

function sizeSpec(spec) {
  const [id, , , rps, , , , nodesSrc] = spec
  const authored = new Map()
  for (const chunk of nodesSrc.split(',')) {
    const [head, rep] = chunk.trim().split('*')
    authored.set(head.split(':').slice(1).join(':') || head.split(':')[0], Number(rep) || 1)
  }

  let current = new Map(authored)
  let ir = buildTemplate(spec)
  for (let pass = 0; pass < 8; pass++) {
    ir = buildTemplate(withReplicas(spec, current))
    const sim = simulate(ir, rps * PEAK_FACTOR)
    const rows = capacityReport(ir, sim).rows
    let changed = false
    for (const r of rows) {
      if (r.util <= TARGET_UTIL) continue
      // A ceiling, because past a point more replicas is not the answer and a
      // template that says otherwise is teaching a bad habit.
      const want = Math.min(64, Math.max(r.replicas + 1, Math.ceil(r.replicas * (r.util / TARGET_UTIL))))
      if (want !== current.get(r.label)) { current.set(r.label, want); changed = true }
    }
    if (!changed) break
  }
  return current
}

function withReplicas(spec, replicas) {
  const nodesSrc = spec[7].split(',').map((chunk) => {
    const s = chunk.trim()
    const [head] = s.split('*')
    const label = head.split(':').slice(1).join(':') || head.split(':')[0]
    const n = replicas.get(label) || 1
    return n > 1 ? `${head}*${n}` : head
  }).join(', ')
  const out = spec.slice()
  out[7] = nodesSrc
  return out
}

function calibrate(spec) {
  const sized = withReplicas(spec, sizeSpec(spec))
  const ir = buildTemplate(sized)
  const mc = runMonteCarlo(ir, { runs: 60, seed: 42, scenarios: [{ id: 'nominal', faults: [] }] })
  const cell = mc.cells[0]
  const p99s = cell.runs.map((r) => r.p99_ms).filter(Number.isFinite).sort((a, b) => a - b)
  const avails = cell.runs.map((r) => r.availability).filter(Number.isFinite)
  const p99 = p99s[Math.floor(p99s.length * 0.95)] ?? p99s[p99s.length - 1] ?? 500
  const avail = Math.min(...avails)
  const cost = mc.cost.total

  const out = sized.slice()
  out[4] = nice(p99 * 1.1)
  out[5] = tier(avail)
  out[6] = nice(cost * 1.15)
  return out
}

const rows = SPECS.map(calibrate)

// Report, then optionally rewrite the numeric and node columns in place.
const tally = { pass: 0, risk: 0, fail: 0 }
for (const spec of rows) {
  const ir = buildTemplate(spec)
  const mc = runMonteCarlo(ir, { runs: 40, seed: 42, scenarios: TEMPLATE_SCENARIOS })
  const ev = evaluateSLOs(ir, mc)
  const v = ev.results.some((r) => r.verdict === 'fail') ? 'fail'
    : ev.results.some((r) => r.verdict === 'risk') ? 'risk' : 'pass'
  tally[v]++
  if (process.argv.includes('--verbose')) console.log(v.padEnd(5), spec[0])
}
console.log(JSON.stringify(tally))

if (process.argv.includes('--write')) {
  const path = new URL('../packages/templates/src/specs.js', import.meta.url)
  let src = readFileSync(path, 'utf8')
  for (let i = 0; i < SPECS.length; i++) {
    const before = SPECS[i]
    const after = rows[i]
    // Rewrite only the four numeric columns of the header line, leaving the
    // authored quoting and prose exactly as written.
    const head = new RegExp(`(\\['${before[0]}', '[^']*', '[^']*', )\\d+, [\\d.]+, [\\d.]+, \\d+,`)
    if (!head.test(src)) { console.error('no match for', before[0]); continue }
    src = src.replace(head, `$1${after[3]}, ${after[4]}, ${after[5]}, ${after[6]},`)
    if (before[7] !== after[7]) {
      const oldNodes = `    '${before[7]}',`
      const newNodes = `    '${after[7]}',`
      if (src.includes(oldNodes)) src = src.replace(oldNodes, newNodes)
      else console.error('no node match for', before[0])
    }
  }
  writeFileSync(path, src)
  console.log('specs.js rewritten')
}
