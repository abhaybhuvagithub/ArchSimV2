// Command dispatch.
//
// Exit codes are part of the contract, because a CI job reads them and a human
// does not:
//   0  pass
//   1  SLO violation
//   2  error-budget risk (warn; configurable to 0 with --no-warn-exit)
//   3  the tool itself failed — which must never be confused with a clean pass

import { parseIR, serializeIR, validateIR, irHash, normalizeIR, fromV1, threeWayMerge, diffIR } from '@archsim/ir'
import { kinds, capacityFor, simulate, capacityReport, costReport, runMonteCarlo, evaluateSLOs, compileFaults, FAULTS } from '@archsim/core'
import { planJsonToIR, k8sToIR, k8sObjects, hclToIR, parseYamlDocs, emitChanges, applyEdits, coverage } from '@archsim/iac'
import { runDES, escalate, analyzeStorm, analyzeStarvation, analyzeBreakers, checkErlangC } from '@archsim/des'
import { TEMPLATES, CATEGORIES, template as templateIR } from '@archsim/templates'
import { parseConfig, EXAMPLE_CONFIG, DEFAULT_CONFIG_PATH, DEFAULT_SCENARIOS } from './config.js'
import { runGate } from './gate.js'
import { markdownReport, jsonReport, sarifReport, terminalReport } from './report.js'

const VERSION = '2.0.0'

export async function main(argv, env) {
  const { fs, cwd, stdout, stderr } = env
  const cmd = argv[0]
  const flags = parseFlags(argv.slice(1))
  const write = (s) => stdout.write(s.endsWith('\n') ? s : `${s}\n`)
  const warn = (s) => stderr.write(`${s}\n`)

  if (!cmd || cmd === 'help' || flags.help) { write(USAGE); return 0 }
  if (cmd === 'version' || flags.version) { write(VERSION); return 0 }

  switch (cmd) {
    case 'ingest': return cmdIngest(flags, env, write, warn)
    case 'gate': return cmdGate(flags, env, write, warn)
    case 'simulate': return cmdSimulate(flags, env, write, warn)
    case 'des': return cmdDes(flags, env, write, warn)
    case 'emit': return cmdEmit(flags, env, write, warn)
    case 'merge': return cmdMerge(flags, env, write, warn)
    case 'diff': return cmdDiff(flags, env, write, warn)
    case 'validate': return cmdValidate(flags, env, write, warn)
    case 'replay': return cmdReplay(flags, env, write, warn)
    case 'migrate': return cmdMigrate(flags, env, write, warn)
    case 'init': return cmdInit(flags, env, write, warn)
    case 'templates': return cmdTemplates(flags, env, write, warn)
    case 'faults': return cmdFaults(write)
    case 'coverage': return cmdCoverage(write)
    case 'selftest': return cmdSelftest(write, warn)
    default:
      warn(`archsim: unknown command '${cmd}'\n`)
      write(USAGE)
      return 3
  }
}

// ── ingest ──────────────────────────────────────────────────────────────────

function loadIRFromFlags(flags, env, warn) {
  const { fs, path } = env
  if (flags.ir) return { ir: parseIR(fs.readFileSync(flags.ir, 'utf8')), report: null, sources: [] }
  if (flags.plan) {
    const plan = JSON.parse(fs.readFileSync(flags.plan, 'utf8'))
    return { ...planJsonToIR(plan, { file: flags.plan, name: flags.name, managed: flags.managed }), sources: [] }
  }
  if (flags.k8s) {
    const files = expand(flags.k8s, env)
    const objects = []
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8')
      if (f.endsWith('.json')) objects.push(...k8sObjects(JSON.parse(text)))
      else objects.push(...parseYamlDocs(text, f).map((d) => d.value).filter(Boolean))
    }
    return { ...k8sToIR(objects, { file: files[0], name: flags.name, managed: flags.managed }), sources: files.map((f) => ({ path: f, text: fs.readFileSync(f, 'utf8') })) }
  }
  if (flags.hcl) {
    const files = expand(flags.hcl, env)
    const sources = files.map((f) => ({ path: f, text: fs.readFileSync(f, 'utf8') }))
    return { ...hclToIR(sources, { name: flags.name, managed: flags.managed || 'partial' }), sources }
  }
  throw new Error('give me something to read: --plan tfplan.json, --k8s manifests/, --hcl infra/ or --ir archsim.lock.json')
}

function expand(spec, env) {
  const { fs, path } = env
  const out = []
  for (const entry of String(spec).split(',')) {
    const p = entry.trim()
    if (!p) continue
    const st = fs.statSync(p)
    if (st.isDirectory()) {
      for (const f of fs.readdirSync(p)) {
        if (/\.(tf|ya?ml|json)$/.test(f)) out.push(path.join(p, f))
      }
    } else out.push(p)
  }
  if (!out.length) throw new Error(`no files matched '${spec}'`)
  return out.sort()
}

async function cmdIngest(flags, env, write, warn) {
  const { fs } = env
  const { ir, report } = loadIRFromFlags(flags, env, warn)
  if (report) {
    warn(`ingested ${report.mapped} mapped, ${report.structural} structural, ${report.unmapped} unmapped (rendered as custom, never dropped)`)
    for (const u of report.unresolved || []) warn(`  unresolved: ${u.address}.${u.attr} = ${String(u.raw).trim()} — shown as 1×; run with --plan for the evaluated count`)
    for (const w of (report.warnings || []).slice(0, 10)) warn(`  ${w.msg}`)
  }
  const text = serializeIR(ir)
  if (flags.out) { fs.writeFileSync(flags.out, text); warn(`wrote ${flags.out} (${ir.nodes.length} nodes, ${ir.edges.length} edges, hash ${irHash(ir)})`) }
  else write(text)
  return 0
}

// ── gate ────────────────────────────────────────────────────────────────────

async function cmdGate(flags, env, write, warn) {
  const { fs } = env
  const { ir } = loadIRFromFlags(flags, env, warn)
  const configPath = flags.slo || (fs.existsSync(DEFAULT_CONFIG_PATH) ? DEFAULT_CONFIG_PATH : null)

  // An IR that carries its own SLOs — a template, or a lockfile written by a
  // team that keeps its thresholds with the design — is already gateable. Making
  // it fail on a missing config file would be the tool insisting on its own
  // filing system.
  if (!configPath && !(ir.slos || []).length) {
    throw new Error(`no SLO file, and this IR declares none of its own. Run \`archsim init\` to write ${DEFAULT_CONFIG_PATH}, or pass --slo <file>`)
  }
  const config = configPath
    ? parseConfig(fs.readFileSync(configPath, 'utf8'), configPath)
    : { ...parseConfig(''), scenarios: DEFAULT_SCENARIOS }
  if (!configPath) warn(`no SLO file — gating on the ${ir.slos.length} SLOs this IR carries, under the default scenarios (${DEFAULT_SCENARIOS.map((s) => s.id).join(', ')})`)
  if (config.errors.length) {
    // A typo in an SLO file must never degrade quietly into "no SLO".
    for (const e of config.errors) warn(`${configPath}: ${e}`)
    throw new Error(`${config.errors.length} problem(s) in ${configPath} — refusing to run a gate on thresholds I do not understand`)
  }
  if (flags.runs) config.runs = Number(flags.runs)
  if (flags.seed !== undefined) config.seed = Number(flags.seed)
  if (flags['no-quick-fix']) config.quickFix = false

  const base = flags.base && fs.existsSync(flags.base) ? parseIR(fs.readFileSync(flags.base, 'utf8')) : null
  if (flags.base && !base) warn(`base lockfile '${flags.base}' not found — reporting absolute verdicts with no comparison to main`)

  const result = runGate({ ir, base, config })

  const formats = String(flags.format || 'md').split(',').map((s) => s.trim())
  const outBase = flags.out || null
  for (const f of formats) {
    const body = f === 'json' ? jsonReport(result) : f === 'sarif' ? sarifReport(result) : markdownReport(result)
    if (outBase) {
      const file = outBase.includes('.') ? outBase.replace(/\.[^.]+$/, `.${f === 'md' ? 'md' : f}`) : `${outBase}.${f}`
      fs.writeFileSync(file, body)
      warn(`wrote ${file}`)
    } else if (formats.length === 1) write(body)
    else { write(`--- ${f} ---`); write(body) }
  }
  if (outBase || flags.quiet) warn(terminalReport(result))

  if (result.exitCode === 2 && flags['no-warn-exit']) return 0
  return result.exitCode
}

// ── simulate / des ──────────────────────────────────────────────────────────

async function cmdSimulate(flags, env, write, warn) {
  const { ir } = loadIRFromFlags(flags, env, warn)
  const rps = Number(flags.rps || ir.workloads?.[0]?.arrival?.rps || 1000)
  const faults = parseScenarioFlag(flags.scenario)
  const fx = compileFaults(faults, ir, simulate(ir, rps))
  const sim = simulate(ir, rps, { fx })
  const cap = capacityReport(ir, sim)
  const cost = costReport(ir, sim)
  write(`offered ${rps} rps${faults.length ? ` · faults: ${fx.applied.map((a) => a.name).join(', ')}` : ''}`)
  write(`p50 ${sim.p50.toFixed(1)}ms · p95 ${sim.p95.toFixed(1)}ms · p99 ${sim.p99.toFixed(1)}ms · availability ${(sim.sysAvail * 100).toFixed(3)}% · dropped ${sim.totalDropped.toFixed(0)} rps`)
  write('')
  write('  util  replicas  need  component')
  for (const r of cap.rows.slice(0, 20)) {
    write(`  ${(r.util * 100).toFixed(0).padStart(4)}%  ${String(r.replicas).padStart(8)}  ${String(r.needed).padStart(4)}  ${r.label} (${r.kind}, ${r.provenance})`)
  }
  write('')
  write(`cost $${cost.total.toFixed(0)}/mo (list prices as of ${cost.pricedAt}, escalated ~3%/yr)`)
  return 0
}

async function cmdDes(flags, env, write, warn) {
  const { ir } = loadIRFromFlags(flags, env, warn)
  const rps = Number(flags.rps || ir.workloads?.[0]?.arrival?.rps || 1000)
  const workload = { id: 'cli', arrival: { dist: flags.dist || 'const', rps, params: {} } }
  const faults = parseScenarioFlag(flags.scenario)
  const out = escalate(ir, {
    scenario: { id: faults.map((f) => f.fault).join('+') || 'nominal', faults },
    workload,
    seed: Number(flags.seed ?? 42),
    horizonMs: Number(flags.horizon || 60) * 1000,
    anchorSim: simulate(ir, rps),
  })
  const r = out.result
  write(`DES · ${r.horizonMs / 1000}s horizon · ${r.events.toLocaleString()} events · seed ${r.seed} · scenario ${out.scenario}`)
  write(`offered ${r.offeredRps.toFixed(0)} rps · served ${r.throughputRps.toFixed(0)} rps · errors ${(r.errorRate * 100).toFixed(2)}% (shed ${(r.shedRate * 100).toFixed(2)}%)`)
  write(`p50 ${r.p50_ms.toFixed(1)}ms · p95 ${r.p95_ms.toFixed(1)}ms · p99 ${r.p99_ms.toFixed(1)}ms`)
  write('')
  write('  util  held  workers  queue  p99      component')
  for (const n of Object.values(r.nodes).sort((a, b) => b.utilization - a.utilization).slice(0, 20)) {
    write(`  ${(n.utilization * 100).toFixed(0).padStart(4)}%  ${(n.heldFraction * 100).toFixed(0).padStart(3)}%  ${String(n.workers).padStart(7)}  ${n.avgQueue.toFixed(0).padStart(5)}  ${n.latency.p99.toFixed(0).padStart(6)}ms  ${n.label}`)
  }
  write('')
  write(`storm:      ${out.storm.verdict}`)
  write(`starvation: ${out.starvation.verdict}`)
  write(`breakers:   ${out.breakers.verdict}`)
  if (r.invariants.length) {
    write('')
    warn(`⚠ ${r.invariants.length} invariant violation(s) — Little's law did not hold, so treat these numbers as suspect:`)
    for (const i of r.invariants) warn(`   ${i.label}: L=${i.L.toFixed(2)} vs λW=${i.LW.toFixed(2)} (${(i.relErr * 100).toFixed(0)}% apart)`)
  }
  if (flags.frames) {
    env.fs.writeFileSync(flags.frames, JSON.stringify(r.frames, null, 2))
    warn(`wrote ${flags.frames} (${r.frames.length} telemetry frames — same shape the twin emits, so the canvas replays them unchanged)`)
  }
  return 0
}

// ── emit / merge / diff ─────────────────────────────────────────────────────

async function cmdEmit(flags, env, write, warn) {
  const { fs } = env
  if (!flags.base) throw new Error('--base <archsim.lock.json> is required: emission is a diff against the IR that was ingested from these files')
  const base = parseIR(fs.readFileSync(flags.base, 'utf8'))
  const target = parseIR(fs.readFileSync(flags.ir || flags.target, 'utf8'))
  const sources = expand(flags.hcl || flags.k8s || flags.sources, env).map((p) => ({ path: p, text: fs.readFileSync(p, 'utf8') }))
  const out = emitChanges(base, target, sources)

  for (const p of out.patches) {
    write(`--- ${p.file}`)
    for (const e of p.edits) write(`    ${e.why}`)
    if (flags.write) { fs.writeFileSync(p.file, p.after); warn(`patched ${p.file} (${p.edits.length} edit${p.edits.length > 1 ? 's' : ''}, every other byte untouched)`) }
  }
  for (const g of out.generated) {
    write(`--- generated ${g.file}`)
    write(g.text)
    if (flags.write) { fs.appendFileSync(g.file, `\n${g.text}`); warn(`appended to ${g.file}`) }
  }
  for (const r of out.removals) {
    write(`--- removal proposal: ${r.proposal}`)
    write(`    ${r.note}`)
  }
  for (const u of out.unpatchable) warn(`not written: ${u.reason}`)
  if (!flags.write && (out.patches.length || out.generated.length)) warn('(dry run — pass --write to apply)')
  return 0
}

async function cmdMerge(flags, env, write, warn) {
  const { fs } = env
  const base = parseIR(fs.readFileSync(flags.base, 'utf8'))
  const canvas = parseIR(fs.readFileSync(flags.canvas, 'utf8'))
  const code = parseIR(fs.readFileSync(flags.code, 'utf8'))
  const { merged, conflicts, decisions } = threeWayMerge(base, canvas, code)
  for (const d of decisions) write(`  ${d.action.padEnd(18)} ${d.what || `${d.field}: ${d.from} → ${d.to}`}`)
  for (const c of conflicts) {
    warn(`CONFLICT ${c.kind} ${c.label || c.id} ${c.field}: base=${c.base} canvas=${c.canvas} code=${c.code}${c.costly ? '  (costs money — not auto-resolved)' : ''}`)
  }
  if (flags.out) { fs.writeFileSync(flags.out, serializeIR(merged)); warn(`wrote ${flags.out}`) }
  else write(serializeIR(merged))
  return conflicts.length ? 1 : 0
}

async function cmdDiff(flags, env, write, warn) {
  const { fs } = env
  const before = parseIR(fs.readFileSync(flags.base, 'utf8'))
  const { ir: after } = loadIRFromFlags(flags, env, warn)
  const d = diffIR(before, after)
  if (d.empty) { write('no architectural change'); return 0 }
  for (const s of d.summary) write(`  ${s}`)
  return 0
}

// ── misc ────────────────────────────────────────────────────────────────────

async function cmdValidate(flags, env, write, warn) {
  const { ir } = loadIRFromFlags(flags, env, warn)
  const v = validateIR(ir, { kinds: kinds() })
  for (const e of v.errors) write(`error  ${e.path}: ${e.msg}`)
  for (const w of v.warnings) write(`warn   ${w.path}: ${w.msg}`)
  write(`${v.ok ? 'valid' : 'INVALID'} — ${ir.nodes.length} nodes, ${ir.edges.length} edges, ${v.errors.length} errors, ${v.warnings.length} warnings, hash ${irHash(ir)}`)
  return v.ok ? 0 : 1
}

async function cmdReplay(flags, env, write, warn) {
  const { ir } = loadIRFromFlags(flags, env, warn)
  const seed = Number(flags.seed ?? 42)
  const runs = Number(flags.runs || 500)
  const scenarios = parseScenarioFlag(flags.scenario).map((f) => ({ id: f.fault, faults: [f] }))
  const mc = runMonteCarlo(ir, { seed, runs, scenarios })
  const which = flags.run !== undefined ? Number(flags.run) : null
  for (const cell of mc.cells) {
    if (which === null) {
      const m = cell.metrics
      write(`${cell.workload}/${cell.scenario}: p99 median ${m.p99_ms.p50.toFixed(0)}ms, p90 ${m.p99_ms.p90.toFixed(0)}ms · errors median ${(m.error_rate.p50 * 100).toFixed(2)}%`)
    } else {
      const run = cell.runs[which]
      if (!run) { warn(`run ${which} is out of range (0..${cell.runs.length - 1})`); continue }
      write(`${cell.workload}/${cell.scenario} run ${which} (seed ${seed}):`)
      write(`  p50 ${run.p50_ms.toFixed(1)}ms · p95 ${run.p95_ms.toFixed(1)}ms · p99 ${run.p99_ms.toFixed(1)}ms · errors ${(run.error_rate * 100).toFixed(2)}% · availability ${(run.availability * 100).toFixed(3)}%`)
      const bn = ir.nodes.find((n) => n.id === run.bottleneck)
      write(`  bottleneck: ${bn ? bn.label : '—'} at ${(run.maxUtil * 100).toFixed(0)}% utilization`)
    }
  }
  return 0
}

async function cmdMigrate(flags, env, write, warn) {
  const { fs } = env
  const raw = fs.readFileSync(flags.in || flags.v1, 'utf8')
  const payload = JSON.parse(raw)
  const ir = fromV1(payload, capacityFor, { name: flags.name })
  const text = serializeIR(ir)
  if (flags.out) { fs.writeFileSync(flags.out, text); warn(`wrote ${flags.out}`) }
  else write(text)
  return 0
}

async function cmdInit(flags, env, write, warn) {
  const { fs, path } = env
  const dir = '.archsim'
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'slo.yaml')
  if (fs.existsSync(file) && !flags.force) { warn(`${file} already exists (pass --force to overwrite)`); return 1 }
  fs.writeFileSync(file, EXAMPLE_CONFIG)
  write(`wrote ${file}`)
  write('next: `archsim ingest --plan tfplan.json --out archsim.lock.json`, commit the lockfile, then run `archsim gate`.')
  return 0
}

/**
 * The template library, from the terminal.
 *
 * Without `--id` it lists; with one it writes that architecture's IR to stdout
 * or `--out`, which makes `archsim templates --id checkout-flow --out lock.json
 * && archsim gate --ir lock.json` a two-line way to see the gate work on a real
 * design before pointing it at your own.
 */
function cmdTemplates(flags, env, write, warn) {
  const { fs } = env
  if (!flags.id) {
    let group = null
    for (const t of TEMPLATES) {
      if (t.category !== group) { group = t.category; write(`\n${group}`) }
      write(`  ${t.id.padEnd(24)} ${String(t.components).padStart(2)} components  ${String(t.rps).padStart(6)} rps  p99<=${String(t.p99).padStart(6)}ms  $${String(Math.round(t.cost)).padStart(7)}/mo`)
    }
    write(`\n${TEMPLATES.length} templates in ${CATEGORIES.length} categories. Open one with --id <name>.`)
    return 0
  }
  const ir = templateIR(flags.id)
  if (!ir) {
    warn(`no template called '${flags.id}'`)
    const near = TEMPLATES.filter((t) => t.id.includes(flags.id) || flags.id.includes(t.id.split('-')[0])).slice(0, 5)
    if (near.length) warn(`did you mean: ${near.map((t) => t.id).join(', ')}`)
    return 3
  }
  const text = serializeIR(ir)
  if (flags.out) { fs.writeFileSync(flags.out, text); write(`wrote ${flags.out}`); return 0 }
  write(text)
  return 0
}

function cmdFaults(write) {
  let group = null
  for (const f of FAULTS) {
    if (f.group !== group) { group = f.group; write(`\n${group}`) }
    write(`  ${f.id.padEnd(12)} ${f.icon} ${f.name.padEnd(28)} ${f.scope === 'node' ? '(targetable)' : ''}`)
    write(`  ${' '.repeat(12)} ${f.desc}`)
  }
  write('\ntarget selectors: kind:sql · label:checkout · address:aws_db_instance.main · <node-id>')
  return 0
}

function cmdCoverage(write) {
  const c = coverage()
  write(`mapping rules: ${c.rules} (${Object.entries(c.byProvider).map(([k, v]) => `${k} ${v}`).join(', ')})`)
  write(`structural resources recognised: ${c.structural}, of which traffic-carrying connectors: ${c.connectors}`)
  write('')
  write('Anything not in the tables renders as a custom component with full passthrough:')
  write('it is simulated conservatively and re-emitted byte for byte, never dropped.')
  return 0
}

/** A gate on an airgapped runner should be able to prove itself before it votes. */
function cmdSelftest(write, warn) {
  const checks = []
  for (const rho of [0.3, 0.6, 0.85]) {
    const r = checkErlangC({ serviceMeanMs: 20, capacityRps: 100, rps: 100 * rho, horizonMs: 300000, seed: 7 })
    checks.push({ name: `Erlang-C agreement at ρ=${rho}`, ok: r.ok, detail: `theory ${r.theory.toFixed(2)}ms vs observed ${r.observed.toFixed(2)}ms (${(r.relErr * 100).toFixed(1)}% apart)` })
  }
  let failed = 0
  for (const c of checks) {
    write(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name} — ${c.detail}`)
    if (!c.ok) failed++
  }
  return failed ? 1 : 0
}

// ── flags ───────────────────────────────────────────────────────────────────

export function parseFlags(args) {
  const out = { _: [] }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (!a.startsWith('--')) { out._.push(a); continue }
    const eq = a.indexOf('=')
    if (eq > 0) { out[a.slice(2, eq)] = a.slice(eq + 1); continue }
    const key = a.slice(2)
    const next = args[i + 1]
    if (next === undefined || next.startsWith('--')) out[key] = true
    else { out[key] = next; i++ }
  }
  return out
}

/** `--scenario az,retry:kind:sql` */
function parseScenarioFlag(spec) {
  if (!spec || spec === true) return []
  return String(spec).split(',').map((s) => {
    const [fault, ...rest] = s.trim().split(':')
    return { fault, ...(rest.length ? { target: rest.join(':') } : {}) }
  }).filter((f) => f.fault)
}

const USAGE = `archsim ${VERSION} — architecture simulation as a build step

USAGE
  archsim <command> [options]

INPUTS (any command that needs an architecture)
  --plan <tfplan.json>     Terraform plan JSON (exact — every count expanded)
  --hcl <dir|files>        raw .tf files (best-effort; dynamic counts degrade loudly)
  --k8s <dir|files>        Kubernetes manifests (.yaml) or \`kubectl get -o json\`
  --ir <archsim.lock.json> a committed IR
  --managed <mode>         observed (default) | partial | full

COMMANDS
  init                     write .archsim/slo.yaml to start from
  ingest                   read infrastructure, write the IR ("twin lockfile")
      --out <file>
  gate                     the CI gate: Monte-Carlo, SLOs, priced repair
      --slo <file>         default .archsim/slo.yaml
      --base <lock>        main's IR, for "was 99%, now 61%"
      --runs N --seed N
      --format md,json,sarif   --out gate-report.md
      --no-quick-fix       skip the repair search
      --no-warn-exit       exit 0 instead of 2 on error-budget risk
  simulate                 one steady-state run
      --rps N --scenario az,retry:kind:sql
  des                      discrete-event run: storms, starvation, breakers
      --rps N --horizon <seconds> --dist const|diurnal|spike
      --scenario <list> --seed N --frames <file>
  diff --base <lock>       what changed against a committed IR
  emit --base <lock> --ir <edited> --hcl <dir> [--write]
                           surgical patches back into the source files
  merge --base --canvas --code [--out]
                           three-way reconciliation; conflicts are never auto-resolved
  validate                 check an IR and report what the numbers rest on
  replay --seed N [--run N]
                           reproduce a sampled world exactly
  migrate --in <v1.json>   ArchSim 1.x share payload → IR 2.0
  templates                the 100-architecture library
      --id <name>          write that architecture's IR (use with --out)
  faults                   the chaos library
  coverage                 what the mapping tables know
  selftest                 hold the DES against closed-form theory

EXIT CODES
  0 pass · 1 SLO violation · 2 error-budget risk · 3 the tool itself failed
`
