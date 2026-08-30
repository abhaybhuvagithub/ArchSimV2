// The PR comment — the product surface.
//
// Everything the gate knows has to survive the trip through a reviewer with
// thirty seconds and eleven other notifications. So: the verdict in the title,
// the change on line one, one table, the priced repair, and the reproduce
// command. Anything that does not change a decision goes in a fold.
//
// The last line is the moat. Every competitor's bot can say a check failed;
// this one says what the repair costs.

import { label } from '@archsim/core'
import { verdictDeltas } from './gate.js'

export function markdownReport(result, opts = {}) {
  const rows = verdictDeltas(result)
  const failed = rows.filter((r) => r.verdict === 'fail')
  const risky = rows.filter((r) => r.verdict === 'risk')
  const title = failed.length
    ? `❌ ${failed.length} violation${failed.length > 1 ? 's' : ''}`
    : risky.length ? `⚠️ ${risky.length} risk${risky.length > 1 ? 's' : ''}` : '✅ all gates hold'
  const riskSuffix = failed.length && risky.length ? ` · ⚠️ ${risky.length} risk${risky.length > 1 ? 's' : ''}` : ''

  const out = []
  out.push(`## 🏗️ ArchSim Architecture Gate — ${title}${riskSuffix}`)

  if (result.diff && !result.diff.empty) {
    out.push(`**Change:** ${result.diff.summary.slice(0, 6).map((s) => `\`${s}\``).join(' · ')}${result.diff.summary.length > 6 ? ` · +${result.diff.summary.length - 6} more` : ''}`)
  } else if (result.diff) {
    out.push('**Change:** no architectural change detected — this PR does not move any modelled quantity.')
  }

  out.push('')
  out.push('| SLO | main | this PR | verdict |')
  out.push('|---|---|---|---|')
  for (const r of rows) {
    out.push(`| ${label(r.slo)}${scenarioNote(r)} | ${cell(r.was, r.slo.metric)} | ${bold(cell(r, r.slo.metric))} | ${icon(r.verdict)}${reason(r, result)} |`)
  }

  if (result.quickFix?.steps?.length) {
    const q = result.quickFix
    const steps = collapseSteps(q.steps)
    const delta = q.costDelta
    const saving = result.baseline ? result.baseline.mc.cost.total - result.mc.cost.total : 0
    const pct = saving > 0 ? ` — ${Math.round((100 * delta) / saving)}% of the savings this PR banks` : ''
    out.push('')
    out.push(`**Cheapest fix found** (convergent, from the quick-fix engine): ${steps.join(', then ')}`)
    out.push(`${q.fullyResolved ? 'restores every gate' : q.resolved ? 'clears the violations (one risk remains)' : 'improves but does not clear every gate'} at **${money(delta, true)}/mo**${pct}.`)
  } else if (result.quickFix && !result.quickFix.steps?.length) {
    out.push('')
    out.push('**No cheap fix found.** Scaling the busiest tiers does not recover these SLOs — the shape of the design is the constraint, not its size.')
  }

  if (result.risks.length) {
    out.push('')
    out.push('<details><summary>Structural risks the numbers do not show</summary>')
    out.push('')
    for (const r of result.risks) out.push(`- ${r.msg}`)
    out.push('')
    out.push('</details>')
  }

  // Never print "you could save money by shrinking X" next to "the fix is to
  // grow X". One of the two is wrong, and the reader should not have to work out
  // which — the scenarios the fix answers to are the stricter test, so they win.
  const touched = new Set((result.quickFix?.steps || []).map((s) => s.nodeId).filter(Boolean))
  const savings = result.savings.filter((s) => !touched.has(s.nodeId))
  if (savings.length) {
    const top = savings.slice(0, 3)
    out.push('')
    out.push(`<details><summary>Headroom you are paying for (${money(top.reduce((a, x) => a + x.saving, 0))}/mo)</summary>`)
    out.push('')
    for (const s of top) out.push(`- \`${s.label}\` ${s.from}→${s.to} replicas saves ${money(s.saving)}/mo${s.caveat ? ` — ${s.caveat}` : ''}`)
    out.push('')
    out.push('</details>')
  }

  const warn = result.validation.warnings
  if (warn.length) {
    out.push('')
    out.push(`<details><summary>What this verdict is standing on (${warn.length} caveat${warn.length > 1 ? 's' : ''})</summary>`)
    out.push('')
    out.push(`Provenance of the ${Object.values(result.meta.provenanceMix).reduce((a, b) => a + b, 0)} components simulated: ${Object.entries(result.meta.provenanceMix).map(([k, v]) => `${v} ${k}`).join(', ')}.`)
    out.push('')
    for (const w of warn.slice(0, 12)) out.push(`- ${w.msg}`)
    if (warn.length > 12) out.push(`- …and ${warn.length - 12} more`)
    out.push('')
    out.push('</details>')
  }

  out.push('')
  out.push(`<sub>${result.meta.runs} runs · seed ${result.meta.seed} · scenarios: ${result.meta.scenarios.join(', ')} · ${result.meta.elapsedMs}ms · IR \`${result.irHash}\` · reproduce: \`archsim replay --seed ${result.meta.seed}\`</sub>`)
  return out.join('\n') + '\n'
}

function scenarioNote(r) {
  if (r.slo.scenarios) return ` <sub>(${r.slo.scenarios.join('/')})</sub>`
  if (r.drivingScenario && r.drivingScenario !== 'nominal') return ` <sub>(worst: ${r.drivingScenario})</sub>`
  return ''
}

function cell(r, metric) {
  if (!r) return '—'
  // A cost is a number, not a proportion of worlds: it does not vary between
  // sampled worlds, so reporting it as "100% of runs" would be true and useless.
  const m = metric || r.slo?.metric
  if (m === 'monthly_cost_usd') return money(r.observed)
  if (r.holdPct === null || r.holdPct === undefined) return '—'
  return `${fmtPct(r.holdPct)} of runs`
}

/** "checkout 3→4, then 4→5, then 5→6" is one decision, not three. */
function collapseSteps(steps) {
  // `match` starts as an exec result and is then rewritten as a plain array of
  // the same four captures, so the type is those four captures — not "whatever
  // exec happened to return".
  /** @type {{text: string, match: string[]|null}[]} */
  const out = []
  for (const s of steps) {
    const m = /^(.*?) (\d+)→(\d+) replicas$/.exec(s.describe)
    const prev = out[out.length - 1]
    if (m && prev?.match && prev.match[1] === m[1] && prev.match[3] === m[2]) {
      prev.match = [prev.match[0], m[1], prev.match[2], m[3]]
      prev.text = `${m[1]} ${prev.match[2]}→${m[3]} replicas`
      continue
    }
    out.push({ text: s.describe, match: m })
  }
  return out.map((o) => o.text)
}

function reason(r, result) {
  if (r.verdict === 'pass') return ''
  const spof = result.risks.find((x) => x.kind === 'spof' && r.slo.metric === 'availability')
  if (spof) return ` SPOF: \`${spof.label}\``
  if (r.drivingScenario && r.drivingScenario !== 'nominal') return ` under \`${r.drivingScenario}\``
  return ''
}

const icon = (v) => ({ pass: '✅', fail: '❌', risk: '⚠️', skip: '—' }[v] || '—')
const bold = (s) => `**${s}**`
const fmtPct = (v) => (v === null || v === undefined ? '—' : `${v.toFixed(0)}%`)
const money = (v, signed = false) =>
  `${signed && v > 0 ? '+' : v < 0 ? '−' : ''}$${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}`

// ── JSON ────────────────────────────────────────────────────────────────────

export function jsonReport(result) {
  return JSON.stringify({
    ok: result.ok,
    exitCode: result.exitCode,
    irHash: result.irHash,
    meta: result.meta,
    slos: verdictDeltas(result).map((r) => ({
      id: r.slo.id, metric: r.slo.metric, op: r.slo.op, threshold: r.slo.threshold,
      under: r.slo.under, scenarios: r.slo.scenarios || null,
      verdict: r.verdict, holdPct: r.holdPct, observed: r.observed,
      drivingScenario: r.drivingScenario || null,
      was: r.was, regressed: r.regressed || false,
      perScenario: r.perScenario?.map((p) => ({ workload: p.workload, scenario: p.scenario, holdPct: p.holdPct, median: p.median, worst: p.worst })),
    })),
    diff: result.diff ? { empty: result.diff.empty, summary: result.diff.summary } : null,
    risks: result.risks,
    quickFix: result.quickFix && {
      steps: result.quickFix.steps?.map((s) => ({ describe: s.describe, costDelta: s.costDelta })),
      costDelta: result.quickFix.costDelta,
      resolved: result.quickFix.fullyResolved,
    },
    cost: { total: result.mc.cost.total, fixed: result.mc.cost.fixed, usage: result.mc.cost.usage, pricedAt: result.mc.cost.pricedAt },
    savings: result.savings,
    warnings: result.validation.warnings,
  }, null, 2) + '\n'
}

// ── SARIF ───────────────────────────────────────────────────────────────────

/**
 * SARIF so violations land in the "Files changed" view next to the line of
 * Terraform that caused them, rather than only in a comment. A finding attached
 * to `main.tf:112` gets fixed; a finding in a comment gets scrolled past.
 */
export function sarifReport(result) {
  const rows = verdictDeltas(result)
  const results = []
  for (const r of rows) {
    if (r.verdict === 'pass' || r.verdict === 'skip') continue
    const loc = locationFor(result, r)
    results.push({
      ruleId: `archsim/slo/${r.slo.metric}`,
      level: r.verdict === 'fail' ? 'error' : 'warning',
      message: { text: `${label(r.slo)} holds in ${r.holdPct?.toFixed(0) ?? '—'}% of ${result.meta.runs} sampled worlds${r.drivingScenario && r.drivingScenario !== 'nominal' ? ` (worst scenario: ${r.drivingScenario})` : ''}${r.was ? `. On main: ${r.was.holdPct?.toFixed(0)}%.` : ''}${result.quickFix?.steps?.length ? ` Cheapest fix: ${result.quickFix.steps[0].describe} (${result.quickFix.costDelta >= 0 ? '+' : '−'}$${Math.abs(result.quickFix.costDelta).toFixed(0)}/mo).` : ''}` },
      locations: loc ? [loc] : [],
      partialFingerprints: { archsimSlo: `${r.slo.id}:${result.irHash}` },
    })
  }
  for (const risk of result.risks) {
    const node = result.ir.nodes.find((n) => n.id === risk.nodeId)
    const loc = node ? locationForNode(node) : null
    results.push({
      ruleId: `archsim/risk/${risk.kind}`,
      level: 'note',
      message: { text: strip(risk.msg) },
      locations: loc ? [loc] : [],
    })
  }
  return JSON.stringify({
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: { driver: {
        name: 'ArchSim Architecture Gate',
        informationUri: 'https://github.com/abhaybhuvagithub/ArchSimV2',
        version: '2.0.0',
        rules: ruleDefinitions(),
      } },
      results,
      properties: { seed: result.meta.seed, runs: result.meta.runs, irHash: result.irHash },
    }],
  }, null, 2) + '\n'
}

function ruleDefinitions() {
  return [
    { id: 'archsim/slo/p99_ms', name: 'LatencySLO', shortDescription: { text: 'Tail latency SLO' }, help: { text: 'The p99 latency target did not hold in enough sampled worlds.' } },
    { id: 'archsim/slo/error_rate', name: 'ErrorRateSLO', shortDescription: { text: 'Error rate SLO' } },
    { id: 'archsim/slo/availability', name: 'AvailabilitySLO', shortDescription: { text: 'Availability SLO' } },
    { id: 'archsim/slo/monthly_cost_usd', name: 'CostBudget', shortDescription: { text: 'Monthly cost budget' } },
    { id: 'archsim/risk/spof', name: 'SinglePointOfFailure', shortDescription: { text: 'A single-replica component on the traffic path' } },
    { id: 'archsim/risk/unbudgeted-retry', name: 'UnbudgetedRetry', shortDescription: { text: 'Retries with no budget amplify under load' } },
    { id: 'archsim/risk/unmeasured-hotspot', name: 'UnmeasuredHotspot', shortDescription: { text: 'The busiest tier runs on a modelled prior, not a measurement' } },
  ]
}

function locationFor(result, r) {
  if (typeof r.slo.scope === 'object' && r.slo.scope.node) {
    const node = result.ir.nodes.find((n) => n.id === r.slo.scope.node)
    if (node) return locationForNode(node)
  }
  // System-scoped: point at the bottleneck the runs actually blamed.
  const cell = result.mc.cells.find((c) => c.scenario === (r.drivingScenario || 'nominal'))
  const top = cell?.metrics?.bottleneckCounts?.[0]?.[0]
  const node = top && result.ir.nodes.find((n) => n.id === top)
  return node ? locationForNode(node) : null
}

function locationForNode(node) {
  const b = node.bindings?.[0]
  if (!b) return null
  return {
    physicalLocation: {
      artifactLocation: { uri: b.file },
      ...(b.range ? { region: { charOffset: b.range.startByte, charLength: Math.max(1, b.range.endByte - b.range.startByte) } } : { region: { startLine: 1 } }),
    },
    logicalLocations: [{ name: b.address, kind: 'resource' }],
  }
}

const strip = (s) => String(s).replace(/`/g, '')

// ── terminal ────────────────────────────────────────────────────────────────

export function terminalReport(result) {
  const rows = verdictDeltas(result)
  const out = []
  const bar = '─'.repeat(64)
  out.push(bar)
  out.push(`ArchSim gate — ${result.ok ? (result.evaluation.risky.length ? 'PASS with risk' : 'PASS') : 'FAIL'}   (${result.meta.runs} runs · seed ${result.meta.seed})`)
  out.push(bar)
  if (result.diff && !result.diff.empty) for (const s of result.diff.summary.slice(0, 8)) out.push(`  change  ${s}`)
  out.push('')
  for (const r of rows) {
    const mark = { pass: 'PASS', fail: 'FAIL', risk: 'RISK', skip: 'SKIP' }[r.verdict]
    const was = r.was ? `  (main: ${fmtPct(r.was.holdPct)})` : ''
    out.push(`  ${mark.padEnd(5)} ${label(r.slo).padEnd(34)} ${cell(r, r.slo.metric).padStart(14)}${was}`)
  }
  if (result.quickFix?.steps?.length) {
    out.push('')
    out.push(`  cheapest fix: ${collapseSteps(result.quickFix.steps).map(strip).join(', then ')}`)
    out.push(`                ${money(result.quickFix.costDelta, true)}/mo`)
  }
  for (const risk of result.risks.slice(0, 5)) out.push(`  risk    ${strip(risk.msg)}`)
  out.push('')
  out.push(`  cost ${money(result.mc.cost.total)}/mo · IR ${result.irHash} · ${result.meta.elapsedMs}ms`)
  out.push(bar)
  return out.join('\n')
}
