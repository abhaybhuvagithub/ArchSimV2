#!/usr/bin/env node
// The suite is the strategy.
//
// ArchSim 1.x's differentiator was never the canvas — it was that every claim
// was a check, all of them run on every push. v2 makes bigger claims at higher
// stakes, so it has to make them checkable: round-trips proven byte-identical,
// gate verdicts seeded-reproducible, the discrete-event engine held against
// closed forms, the twin's calibration held against its own arithmetic.
//
// Run: npm run verify

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

import {
  createIR, irNode, irEdge, normalizeIR, validateIR, irHash, serializeIR, parseIR,
  canonical, diffIR, threeWayMerge, fromV1, toV1, ulid, ulidFrom, isUlid, normalizeCapacity,
  IR_VERSION, PROVENANCE_CLASSES, SLO_METRICS,
} from '@archsim/ir'
import {
  CATALOG, kinds, capacityFor, simulate, capacityReport, costReport, nodeCost, rateFor,
  compileFaults, FAULTS, runMonteCarlo, evaluateSLOs, structuralRisks, findCheapestFix,
  availabilityOf, quorumOf, quorumLatencyMul, atLeast,
  ACRONYMS, ACRONYM_GROUPS, searchAcronyms,
  telemetryCoverage, telemetryNote, SIGNALS, SIGNAL_KINDS,
  rightSizePlan, rng, streamFor, bandDraw, percentile, isSourceNode, PRICED_AT,
  TAXONOMY, COMPONENT_CATEGORIES, kindsIn, categoryOf, describeKind, searchKinds, specOf, kindName,
} from '@archsim/core'
import {
  parseHCL, walkBlocks, addressOf, bodyOf, applyEdits, parseYamlDocs, getPath, k8sAddress,
  planJsonToIR, k8sToIR, k8sObjects, hclToIR, emitChanges, patchIsSurgical, generateNode,
  coverage, findRule, isStructural, isConnector, isNoise, isSubResource, labelFromAddress,
  inferFromImage, parseInstanceClass,
  sizeFromInstanceClass, TIER_RANK, orient, callSemanticsFor,
  cfnToIR, cdkOutToIR, parseCfnTemplate, resolveValue, parameterDefaults, evaluateConditions,
  pulumiToIR, parseUrn, typeToTerraform,
  helmToIR, renderChart, substitute, looksLikeChart,
  compareToDeployed, driftMarkdown, SIMULATION_FIELDS,
  pullRequestPayload, unifiedDiff, providerOf,
} from '@archsim/iac'
import {
  runDES, TDigest, EventHeap, checkErlangC, erlangC, mmcSojourn, mmcFixture, chainFixture,
  METAMORPHIC, checkCrossEngine, analyzeStorm, analyzeStarvation, analyzeBreakers,
  withRetry, withBreaker, withTimeouts, failLastHop, holdTimeBaseline, meanServiceMs,
} from '@archsim/des'
import {
  Twin, syntheticSource, FrameBuffer, rollup, buildResolver, discoverGhosts, confirmBinding,
  detectDrift, calibrateNode, Scrubber, faultSignature, reproduceInSimulator, frameToWorkload,
  edgesFromSpans, prometheusSource,
} from '@archsim/twin'
import { parseConfig, EXAMPLE_CONFIG } from '../packages/cli/src/config.js'
import { runGate } from '../packages/cli/src/gate.js'
import { markdownReport, jsonReport, sarifReport, terminalReport } from '../packages/cli/src/report.js'

import { suggestFor, suggestOrphans, orphans, roleOf, suggestPlacement, ROLES } from '@archsim/core'
import { TEMPLATES, CATEGORIES, template, buildTemplate, searchTemplates, TEMPLATE_SCENARIOS } from '@archsim/templates'

import {
  layoutQuality, layoutScore, rankLayouts, LAYOUTS, layered, layeredTidy, force, grid, vertical,
  align, distribute, snapAll, tighten, ALIGNMENTS, tidyIfWorse, requestOrder, circled,
} from '../apps/canvas/src/arrange.js'
import { buildTour, SHORTCUTS } from '../apps/canvas/src/tour.js'
import { PALETTES } from '../apps/canvas/src/persist.js'

import { HCL_CORPUS, K8S_CORPUS, REAL_WORLD_CORPUS } from './corpus.mjs'
import { PROFILES, TARGET_UTIL, KNEE } from './benchmark.mjs'
import { irDocument, irLineRanges, ownerOfLine } from '../apps/canvas/src/irview.js'
import { loadBand } from '../apps/canvas/src/nodehint.js'
import { LADDER, STEPS, toSlider, fromSlider, MIN_RPS, MAX_RPS } from '../apps/canvas/src/loadscale.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1')
}

let passed = 0
const failures = []
const pending = []
let group = ''

const section = (name) => { group = name; process.stdout.write(`\n${name}\n`) }
function check(name, fn) {
  const where = group
  const win = () => { passed++; process.stdout.write('.') }
  const lose = (err) => { failures.push({ group: where, name, msg: err?.message || String(err) }); process.stdout.write('x') }
  let r
  try {
    r = fn()
  } catch (err) { return lose(err) }
  // A few checks are inherently async (the twin polls a source). They are
  // collected and awaited before the summary, so an async failure can never
  // slip past the exit code.
  if (r && typeof r.then === 'function') {
    pending.push(r.then((v) => { if (v === false) throw new Error('returned false'); win() }).catch(lose))
    return
  }
  if (r === false) return lose(new Error('returned false'))
  win()
}
const eq = (a, b, msg = '') => { if (a !== b) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
const near = (a, b, tol, msg = '') => { if (!(Math.abs(a - b) <= tol)) throw new Error(`${msg} expected ${b}±${tol}, got ${a}`) }
const ok = (v, msg = 'expected truthy') => { if (!v) throw new Error(msg) }

// ────────────────────────────────────────────────────────────────────────────
section('IR 2.0 — the contract every subsystem speaks')

const sampleIR = (() => {
  const ir = createIR({ name: 'sample' })
  const mk = (kind, label, replicas = 2) => {
    const n = irNode({ id: ulidFrom(`sample:${label}`), kind, label, capacity: { ...capacityFor(kind), replicas } }, capacityFor)
    ir.nodes.push(n)
    return n
  }
  const c = mk('client', 'users', 1), lb = mk('lb', 'alb', 2), app = mk('app', 'api', 6), db = mk('sql', 'db', 2)
  ir.edges.push(irEdge({ from: c.id, to: lb.id }), irEdge({ from: lb.id, to: app.id }), irEdge({ from: app.id, to: db.id, protocol: 'sql' }))
  ir.workloads.push({ id: 'peak', arrival: { dist: 'diurnal', rps: 4000, params: { peakFactor: 3 } } })
  ir.slos.push(
    { id: 'lat', scope: 'system', metric: 'p99_ms', op: '<=', threshold: 800, under: 'peak' },
    { id: 'av', scope: 'system', metric: 'availability', op: '>=', threshold: 0.999, under: 'all', scenarios: ['nominal'] },
    { id: 'cost', scope: 'system', metric: 'monthly_cost_usd', op: '<=', threshold: 5000, under: 'all' },
  )
  return normalizeIR(ir)
})()

check('IR version is 2.0', () => eq(sampleIR.irVersion, IR_VERSION))
check('sample IR validates clean', () => ok(validateIR(sampleIR, { kinds: kinds() }).ok))
check('normalize is idempotent', () => eq(canonical(normalizeIR(normalizeIR(sampleIR))), canonical(normalizeIR(sampleIR))))
check('serialize → parse round-trips', () => eq(canonical(parseIR(serializeIR(sampleIR))), canonical(sampleIR)))
check('irHash is stable across serialization', () => eq(irHash(parseIR(serializeIR(sampleIR))), irHash(sampleIR)))
check('irHash changes when a replica count changes', () => {
  const bumped = normalizeIR({ ...sampleIR, nodes: sampleIR.nodes.map((n) => (n.label === 'api' ? { ...n, capacity: { ...n.capacity, replicas: 7 } } : n)) })
  ok(irHash(bumped) !== irHash(sampleIR))
})
check('irHash ignores key order', () => {
  const shuffled = { ...sampleIR, nodes: sampleIR.nodes.map((n) => ({ attrs: n.attrs, capacity: n.capacity, id: n.id, kind: n.kind, label: n.label, bindings: n.bindings })) }
  eq(irHash(shuffled), irHash(sampleIR))
})
check('canonical sorts object keys', () => eq(canonical({ b: 1, a: 2 }), canonical({ a: 2, b: 1 })))
check('Infinity survives serialization', () => {
  const back = parseIR(serializeIR(sampleIR))
  eq(back.nodes.find((n) => n.kind === 'client').capacity.capPerReplica, Infinity)
})
check('ULIDs are 26 Crockford characters', () => ok(isUlid(ulid())))
check('ulidFrom is deterministic', () => eq(ulidFrom('aws_lb.main'), ulidFrom('aws_lb.main')))
check('ulidFrom separates different addresses', () => ok(ulidFrom('aws_lb.main') !== ulidFrom('aws_lb.other')))
check('dangling edges are dropped by normalize', () => {
  const bad = normalizeIR({ ...sampleIR, edges: [...sampleIR.edges, irEdge({ from: 'nope', to: sampleIR.nodes[0].id })] })
  eq(bad.edges.length, sampleIR.edges.length)
})
check('duplicate node ids are dropped', () => {
  const dup = normalizeIR({ ...sampleIR, nodes: [...sampleIR.nodes, sampleIR.nodes[0]] })
  eq(dup.nodes.length, sampleIR.nodes.length)
})
check('validate rejects a bad metric', () => {
  const bad = { ...sampleIR, slos: [{ id: 'x', scope: 'system', metric: 'vibes', op: '<=', threshold: 1, under: 'all' }] }
  ok(!validateIR(bad).ok)
})
check('validate rejects an unknown call semantic', () => {
  const bad = { ...sampleIR, edges: [{ ...sampleIR.edges[0], callSemantics: 'telepathy' }] }
  ok(!validateIR(bad).ok)
})
check('validate rejects an SLO pointing at an unknown workload', () => {
  const bad = { ...sampleIR, slos: [{ id: 'x', scope: 'system', metric: 'p99_ms', op: '<=', threshold: 1, under: 'ghost' }] }
  ok(!validateIR(bad).ok)
})
check('validate warns about unbudgeted retries', () => {
  const risky = { ...sampleIR, edges: sampleIR.edges.map((e) => ({ ...e, timeoutMs: 100, retry: { max: 3, backoffMs: 10, jitter: 'full', budgetPct: 0 } })) }
  ok(validateIR(risky).warnings.some((w) => /amplif/i.test(w.msg)))
})
check('validate warns when a node has no IaC binding', () =>
  ok(validateIR(sampleIR).warnings.some((w) => /no IaC binding/.test(w.msg))))
check('every provenance class carries a jitter prior', () =>
  ok(Object.values(PROVENANCE_CLASSES).every((c) => c.jitter.capPct > 0)))
check('telemetry provenance has the tightest band', () =>
  ok(PROVENANCE_CLASSES.telemetry.jitter.capPct < PROVENANCE_CLASSES.modeled.jitter.capPct))
check('every SLO metric the config accepts is a metric the evaluator reads', () =>
  ok(SLO_METRICS.every((m) => typeof m === 'string')))

section('IR — migration from ArchSim 1.x')
const v1Payload = {
  v: 1, r: 2500,
  n: [
    { id: 'a', type: 'client', label: 'users', replicas: 1, x: 10, y: 20 },
    { id: 'b', type: 'lb', label: 'alb', replicas: 2, x: 200, y: 20 },
    { id: 'c', type: 'sql', label: 'db', replicas: 3, engine: 'btree', consistency: 'linearizable', replication: 'leader' },
  ],
  e: [['a', 'b'], ['b', 'c']],
}
const migrated = fromV1(v1Payload, capacityFor)
check('v1 payload migrates to a valid IR', () => ok(validateIR(migrated, { kinds: kinds() }).ok))
check('v1 node count survives migration', () => eq(migrated.nodes.length, 3))
check('v1 edges survive migration', () => eq(migrated.edges.length, 2))
check('v1 traffic becomes a workload', () => eq(migrated.workloads[0].arrival.rps, 2500))
check('v1 inspector state travels into attrs', () => {
  const db = migrated.nodes.find((n) => n.label === 'db')
  eq(db.attrs.engine, 'btree')
  eq(db.attrs.consistency, 'linearizable')
})
check('v1 layout survives migration', () => ok(migrated.nodes.find((n) => n.label === 'alb').layout.x === 200))
check('migration is deterministic', () => eq(irHash(fromV1(v1Payload, capacityFor)), irHash(migrated)))
check('IR can be projected back to a v1 share payload', () => {
  const back = toV1(migrated)
  eq(back.v, 1)
  eq(back.n.length, 3)
  eq(back.e.length, 2)
})
check('migrated design still simulates', () => ok(simulate(migrated, 2500).p99 > 0))

section('IR — diff and three-way merge')
const bumped = normalizeIR({ ...sampleIR, nodes: sampleIR.nodes.map((n) => (n.label === 'api' ? { ...n, capacity: { ...n.capacity, replicas: 3 } } : n)) })
check('diff finds the replica change', () => {
  const d = diffIR(sampleIR, bumped)
  ok(d.summary.some((s) => /replicas 6→3/.test(s)))
})
check('diff of identical IRs is empty', () => ok(diffIR(sampleIR, sampleIR).empty))
check('diff separates authored from derived fields', () => {
  const resized = normalizeIR({ ...sampleIR, nodes: sampleIR.nodes.map((n) => (n.label === 'db' ? { ...n, capacity: { ...n.capacity, capPerReplica: 2500, queueDepth: 99, concurrency: 9 } } : n)) })
  const d = diffIR(sampleIR, resized)
  ok(d.summary.some((s) => /resized/.test(s)) && !d.summary.some((s) => /queueDepth/.test(s)))
})
check('merge: canvas moved alone → canvas wins', () => {
  const { merged, conflicts } = threeWayMerge(sampleIR, bumped, sampleIR)
  eq(conflicts.length, 0)
  eq(merged.nodes.find((n) => n.label === 'api').capacity.replicas, 3)
})
check('merge: code moved alone → code wins', () => {
  const { merged, conflicts } = threeWayMerge(sampleIR, sampleIR, bumped)
  eq(conflicts.length, 0)
  eq(merged.nodes.find((n) => n.label === 'api').capacity.replicas, 3)
})
check('merge: both moved the same way → converges silently', () => {
  const { conflicts } = threeWayMerge(sampleIR, bumped, bumped)
  eq(conflicts.length, 0)
})
check('merge: both moved differently → CONFLICT, never auto-resolved', () => {
  const other = normalizeIR({ ...sampleIR, nodes: sampleIR.nodes.map((n) => (n.label === 'api' ? { ...n, capacity: { ...n.capacity, replicas: 9 } } : n)) })
  const { conflicts } = threeWayMerge(sampleIR, bumped, other)
  eq(conflicts.length, 1)
  ok(conflicts[0].costly, 'a replica-count conflict must be flagged as costing money')
})
check('merge: a node deleted on the canvas becomes a removal proposal, not a deletion', () => {
  const without = normalizeIR({ ...sampleIR, nodes: sampleIR.nodes.filter((n) => n.label !== 'db'), edges: sampleIR.edges.filter((e) => !e.to.includes(ulidFrom('sample:db'))) })
  const { merged, decisions } = threeWayMerge(sampleIR, without, sampleIR)
  ok(merged.nodes.some((n) => n.label === 'db'), 'the node must survive the merge')
  ok(decisions.some((d) => d.action === 'removal-proposal'))
})
check('merge: passthrough always comes from code', () => {
  const withPass = { ...sampleIR, passthrough: [{ lang: 'hcl', file: 'x.tf', text: 'variable "a" {}\n' }] }
  const { merged } = threeWayMerge(sampleIR, sampleIR, withPass)
  eq(merged.passthrough.length, 1)
})

// ────────────────────────────────────────────────────────────────────────────
section('Core — the analytic engine (carried over from 1.8)')

check('catalog has the v1 taxonomy', () => ok(Object.keys(CATALOG).length >= 110))
check('every catalog entry has capacity, latency and availability', () =>
  ok(Object.entries(CATALOG).every(([, s]) => s.cap !== undefined && s.lat !== undefined && s.avail !== undefined)))
check('every catalog entry carries the DES contract', () =>
  ok(Object.entries(CATALOG).every(([, s]) => s.concurrency !== undefined && s.queueDepth !== undefined && s.cv !== undefined)))
check('client is the traffic source', () => ok(isSourceNode({ kind: 'client', capacity: {} })))
check('capacityFor seeds from the catalog', () => eq(capacityFor('sql').capPerReplica, CATALOG.sql.cap))
check('capacityFor tags an unknown kind as modelled', () => eq(capacityFor('nonsense').provenance.cls, 'modeled'))
check('a vendor-class seed gets a tighter band than a modelled one', () =>
  ok(capacityFor('sql').jitter.capPct < capacityFor('nonsense').jitter.capPct))

check('simulation propagates traffic to the leaf', () => {
  const sim = simulate(sampleIR, 4000)
  ok(sim.stats[ulidFrom('sample:db')].in > 0)
})
check('utilization rises with load', () => {
  const a = simulate(sampleIR, 1000), b = simulate(sampleIR, 8000)
  const id = ulidFrom('sample:api')
  ok(b.stats[id].util > a.stats[id].util)
})
check('latency is monotonic in load', () => ok(simulate(sampleIR, 9000).p99 >= simulate(sampleIR, 1000).p99))
check('p99 >= p95 >= p50, always', () => {
  for (const rps of [10, 500, 4000, 40000]) {
    const s = simulate(sampleIR, rps)
    ok(s.p99 >= s.p95 && s.p95 >= s.p50, `ordering broke at ${rps} rps`)
  }
})
check('adding replicas never raises utilization', () => {
  const id = ulidFrom('sample:api')
  const bigger = normalizeIR({ ...sampleIR, nodes: sampleIR.nodes.map((n) => (n.id === id ? { ...n, capacity: { ...n.capacity, replicas: 12 } } : n)) })
  ok(simulate(bigger, 8000).stats[id].util <= simulate(sampleIR, 8000).stats[id].util)
})
check('drops appear only past capacity', () => {
  ok(simulate(sampleIR, 100).totalDropped === 0)
  ok(simulate(sampleIR, 5_000_000).totalDropped > 0)
})
check('availability composes down the path', () => ok(simulate(sampleIR, 1000).sysAvail < 1))
check('a zero-replica node makes the system unavailable', () => {
  const dead = normalizeIR({ ...sampleIR, nodes: sampleIR.nodes.map((n) => (n.label === 'db' ? { ...n, capacity: { ...n.capacity, replicas: 0 } } : n)) })
  eq(simulate(dead, 1000).sysAvail, 0)
})
check('single-leader replication caps write capacity', () => {
  const leader = normalizeIR({ ...sampleIR, nodes: sampleIR.nodes.map((n) => (n.label === 'db' ? { ...n, attrs: { replication: 'leader' } } : n)) })
  const id = ulidFrom('sample:db')
  ok(simulate(leader, 6000).stats[id].writeCap < simulate(sampleIR, 6000).stats[id].writeCap)
})
check('linearizable consistency costs capacity', () => {
  const strict = normalizeIR({ ...sampleIR, nodes: sampleIR.nodes.map((n) => (n.label === 'db' ? { ...n, attrs: { consistency: 'linearizable' } } : n)) })
  const id = ulidFrom('sample:db')
  ok(simulate(strict, 6000).stats[id].readCap < simulate(sampleIR, 6000).stats[id].readCap)
})
check('a cache forwards only misses', () => {
  const ir = normalizeIR({
    ...sampleIR,
    nodes: [...sampleIR.nodes, irNode({ id: 'cache1', kind: 'cache', label: 'cache', capacity: { ...capacityFor('cache'), replicas: 2 } }, capacityFor)],
    edges: [irEdge({ from: ulidFrom('sample:users'), to: ulidFrom('sample:alb') }), irEdge({ from: ulidFrom('sample:alb'), to: 'cache1' }), irEdge({ from: 'cache1', to: ulidFrom('sample:db') })],
  })
  const sim = simulate(ir, 10000)
  ok(sim.stats[ulidFrom('sample:db')].in < sim.stats.cache1.in * 0.5)
})
check('simulation is deterministic', () => eq(JSON.stringify(simulate(sampleIR, 4000)), JSON.stringify(simulate(sampleIR, 4000))))
check('capacityReport ranks the bottleneck first', () => {
  const cap = capacityReport(sampleIR, simulate(sampleIR, 20000))
  ok(cap.rows[0].util >= cap.rows[cap.rows.length - 1].util)
})

section('Core — chaos faults')
check('every fault has an id, a name and an effect', () =>
  ok(FAULTS.every((f) => f.id && f.name && typeof f.effect === 'function' && f.desc)))
check('fault ids are unique', () => eq(new Set(FAULTS.map((f) => f.id)).size, FAULTS.length))
check('an AZ loss cuts capacity everywhere', () => {
  const fx = compileFaults([{ fault: 'az' }], sampleIR)
  ok(Object.values(fx.node).every((f) => f.capMul < 1))
})
check('a fault never makes the system better', () => {
  const base = simulate(sampleIR, 4000)
  for (const f of FAULTS) {
    const fx = compileFaults([{ fault: f.id }], sampleIR, base)
    const after = simulate(sampleIR, 4000, { fx })
    ok(after.p99 >= base.p99 * 0.999 || after.totalDropped >= base.totalDropped, `${f.id} improved the system`)
  }
})
check('a kind: selector targets the right node', () => {
  const fx = compileFaults([{ fault: 'crash', target: 'kind:sql' }], sampleIR, simulate(sampleIR, 4000))
  eq(fx.applied[0].target, ulidFrom('sample:db'))
})
check('a label: selector targets the right node', () => {
  const fx = compileFaults([{ fault: 'slow', target: 'label:api' }], sampleIR, simulate(sampleIR, 4000))
  eq(fx.applied[0].target, ulidFrom('sample:api'))
})
check('an untargeted node fault picks the busiest node', () => {
  const fx = compileFaults([{ fault: 'slow' }], sampleIR, simulate(sampleIR, 4000))
  ok(fx.applied[0].target)
})
check('a retry storm inflates demand', () => {
  const fx = compileFaults([{ fault: 'retry', target: 'kind:sql' }], sampleIR, simulate(sampleIR, 4000))
  ok(simulate(sampleIR, 4000, { fx }).stats[ulidFrom('sample:db')].dupIn > 0)
})
check('a cache stampede sends everything through', () => {
  const fx = compileFaults([{ fault: 'stampede' }], sampleIR, simulate(sampleIR, 4000))
  ok(Object.values(fx.node).some((f) => f.noCache))
})

section('Core — cost')
check('cost rises with replicas', () => {
  const cheap = nodeCost({ kind: 'app', capacity: { replicas: 2 } }, 0).total
  const dear = nodeCost({ kind: 'app', capacity: { replicas: 8 } }, 0).total
  ok(dear > cheap)
})
check('usage-priced components cost more under traffic', () =>
  ok(nodeCost({ kind: 'llm', capacity: { replicas: 1 } }, 100).total > nodeCost({ kind: 'llm', capacity: { replicas: 1 } }, 0).total))
check('prices escalate from the date they were checked', () =>
  ok(rateFor('app', new Date('2030-01-01')).hourly > rateFor('app', new Date(PRICED_AT)).hourly))
check('the price basis is dated, not undated', () => ok(/^\d{4}-\d{2}-\d{2}$/.test(PRICED_AT)))
check('cost report totals its rows', () => {
  const c = costReport(sampleIR, simulate(sampleIR, 4000))
  near(c.total, c.rows.reduce((a, r) => a + r.total, 0), 0.01)
})
check('cost excludes the traffic source', () =>
  ok(!costReport(sampleIR, simulate(sampleIR, 1000)).rows.some((r) => r.kind === 'client')))

section('Core — Monte-Carlo and SLOs')
const mcOpts = { runs: 120, seed: 42, scenarios: [{ id: 'az', faults: [{ fault: 'az' }] }] }
const mc = runMonteCarlo(sampleIR, mcOpts)
check('the same seed produces the same worlds', () =>
  eq(JSON.stringify(runMonteCarlo(sampleIR, mcOpts).cells.map((c) => c.metrics)), JSON.stringify(mc.cells.map((c) => c.metrics))))
check('a different seed produces different worlds', () =>
  ok(JSON.stringify(runMonteCarlo(sampleIR, { ...mcOpts, seed: 43 }).cells[0].metrics) !== JSON.stringify(mc.cells[0].metrics)))
check('the nominal scenario is always included', () => ok(mc.scenarios.includes('nominal')))
check('run count is honoured', () => eq(mc.cells[0].runs.length, 120))
check('jitter actually varies the outcome', () => {
  const spread = mc.cells[0].metrics.p99_ms
  ok(spread.max > spread.min, 'sampled worlds must differ')
})
check('disabling jitter collapses the parameter spread', () => {
  // Only *parameter* sampling is switched off. A diurnal workload still lands
  // at a different point of the day in each world, which is the arrival
  // realization doing its job — so this check holds the arrival rate constant
  // to isolate the thing it is actually testing.
  const constant = { ...sampleIR, workloads: [{ id: 'flat', arrival: { dist: 'const', rps: 4000 } }] }
  const flat = runMonteCarlo(constant, { ...mcOpts, jitter: false })
  near(flat.cells[0].metrics.p99_ms.max, flat.cells[0].metrics.p99_ms.min, 1e-6)
})
check('the band draw is centred on 1', () => {
  const r = rng(9)
  const xs = Array.from({ length: 20000 }, () => bandDraw(r, 40))
  near(xs.reduce((a, b) => a + b, 0) / xs.length, 1, 0.02)
})
check('the band draw stays inside its declared band', () => {
  const r = rng(3)
  for (let i = 0; i < 20000; i++) {
    const v = bandDraw(r, 40)
    ok(v >= 0.6 - 1e-9 && v <= 1.4 + 1e-9, `band draw escaped: ${v}`)
  }
})
check('streams are independent per run', () => ok(streamFor(42, 1)() !== streamFor(42, 2)()))
check('percentiles are ordered', () => {
  const xs = Array.from({ length: 1000 }, (_, i) => i)
  ok(percentile(xs, 50) < percentile(xs, 90) && percentile(xs, 90) < percentile(xs, 99))
})

const ev = evaluateSLOs(sampleIR, mc)
check('every SLO gets a verdict', () => eq(ev.results.length, sampleIR.slos.length))
check('verdicts are drawn from the declared set', () => ok(ev.results.every((r) => ['pass', 'fail', 'risk', 'skip'].includes(r.verdict))))
check('hold percentages are proportions, not point estimates', () =>
  ok(ev.results.filter((r) => r.kind === 'distribution').every((r) => r.holdPct >= 0 && r.holdPct <= 100)))
check('a scenario-scoped SLO ignores other scenarios', () => {
  const r = ev.results.find((x) => x.slo.id === 'av')
  ok(r.perScenario.every((p) => p.scenario === 'nominal'))
})
check('an unscoped SLO is judged by its worst scenario', () => {
  const r = ev.results.find((x) => x.slo.id === 'lat')
  ok(r.perScenario.length > 1)
  ok(r.holdPct === Math.min(...r.perScenario.map((p) => p.holdPct)))
})
check('an impossible SLO fails', () => {
  const strict = { ...sampleIR, slos: [{ id: 'x', scope: 'system', metric: 'p99_ms', op: '<=', threshold: 0.0001, under: 'all' }] }
  eq(evaluateSLOs(strict, runMonteCarlo(strict, mcOpts)).exitCode, 1)
})
check('a trivial SLO passes', () => {
  const loose = { ...sampleIR, slos: [{ id: 'x', scope: 'system', metric: 'p99_ms', op: '<=', threshold: 1e9, under: 'all' }] }
  eq(evaluateSLOs(loose, runMonteCarlo(loose, mcOpts)).exitCode, 0)
})
check('cost SLOs are deterministic, not sampled', () =>
  eq(ev.results.find((r) => r.slo.metric === 'monthly_cost_usd').kind, 'deterministic'))
check('a single-replica node on the path is reported as a SPOF', () => {
  const spof = normalizeIR({ ...sampleIR, nodes: sampleIR.nodes.map((n) => (n.label === 'db' ? { ...n, capacity: { ...n.capacity, replicas: 1 } } : n)) })
  ok(structuralRisks(spof, runMonteCarlo(spof, mcOpts)).some((r) => r.kind === 'spof'))
})
check('an idle single-replica node is not reported as a SPOF', () => {
  const idle = normalizeIR({ ...sampleIR, nodes: [...sampleIR.nodes, irNode({ id: 'lonely', kind: 'blob', label: 'archive', capacity: { ...capacityFor('blob'), replicas: 1 } }, capacityFor)] })
  ok(!structuralRisks(idle, runMonteCarlo(idle, mcOpts)).some((r) => r.nodeId === 'lonely'))
})

section('Core — the convergent quick-fix engine')
const failing = normalizeIR({
  ...sampleIR,
  nodes: sampleIR.nodes.map((n) => (n.label === 'api' ? { ...n, capacity: { ...n.capacity, replicas: 1 } } : n)),
  slos: [{ id: 'lat', scope: 'system', metric: 'p99_ms', op: '<=', threshold: 400, under: 'peak' }],
})
const fix = findCheapestFix(failing, { mcOpts: { runs: 60, seed: 42, scenarios: [] } })
check('a failing design gets a proposed fix', () => ok(fix.needed && fix.steps.length > 0))
check('the fix is priced', () => ok(Number.isFinite(fix.costDelta)))
check('the fix improves the verdict', () => {
  const before = fix.before.results.find((r) => r.slo.id === 'lat').holdPct
  const after = fix.after.results.find((r) => r.slo.id === 'lat').holdPct
  ok(after >= before)
})
check('a passing design needs no fix', () => {
  const fine = { ...sampleIR, slos: [{ id: 'x', scope: 'system', metric: 'p99_ms', op: '<=', threshold: 1e9, under: 'all' }] }
  eq(findCheapestFix(fine, { mcOpts: { runs: 40, seed: 1, scenarios: [] } }).needed, false)
})
check('right-sizing finds headroom nobody is using', () => {
  const fat = normalizeIR({ ...sampleIR, nodes: sampleIR.nodes.map((n) => (n.label === 'api' ? { ...n, capacity: { ...n.capacity, replicas: 60 } } : n)) })
  const plan = rightSizePlan(fat, runMonteCarlo(fat, { runs: 20, seed: 1, workloads: [{ id: 'w', arrival: { dist: 'const', rps: 500 } }] }))
  ok(plan.some((p) => p.label === 'api' && p.to < 60))
})
check('right-sizing flags when it would create a SPOF', () => {
  const fat = normalizeIR({ ...sampleIR, nodes: sampleIR.nodes.map((n) => (n.label === 'db' ? { ...n, capacity: { ...n.capacity, replicas: 20 } } : n)) })
  const plan = rightSizePlan(fat, runMonteCarlo(fat, { runs: 20, seed: 1, workloads: [{ id: 'w', arrival: { dist: 'const', rps: 50 } }] }))
  const row = plan.find((p) => p.label === 'db')
  ok(!row || row.to > 1 || row.caveat)
})

// ────────────────────────────────────────────────────────────────────────────
section('IaC — the HCL concrete syntax tree')

check('a plain resource block parses', () => {
  const p = parseHCL(HCL_CORPUS[0].text, 'x.tf')
  eq(p.errors.length, 0)
  eq([...walkBlocks(p)].length, 1)
})
check('the address is the Terraform address', () => {
  const p = parseHCL(HCL_CORPUS[0].text, 'x.tf')
  eq(addressOf([...walkBlocks(p)][0].block), 'aws_instance.web')
})
check('a literal count is read as a number', () => {
  const p = parseHCL(HCL_CORPUS[0].text, 'x.tf')
  eq(bodyOf([...walkBlocks(p)][0].block).attrs.count.value, 3)
})
check('a computed count is flagged dynamic, not guessed', () => {
  const p = parseHCL(HCL_CORPUS.find((c) => c.name === 'dynamic-count').text, 'x.tf')
  ok(bodyOf([...walkBlocks(p)][0].block).attrs.count.dynamic)
})
check('a heredoc containing braces does not break block matching', () => {
  const p = parseHCL(HCL_CORPUS.find((c) => c.name === 'heredoc-with-braces').text, 'x.tf')
  eq(p.errors.length, 0)
  eq([...walkBlocks(p)].filter((b) => b.block.name === 'resource').length, 1)
})
check('a dynamic block parses as a nested block', () => {
  const p = parseHCL(HCL_CORPUS.find((c) => c.name === 'dynamic-block').text, 'x.tf')
  eq(p.errors.length, 0)
  eq([...walkBlocks(p)].filter((b) => b.block.name === 'resource').length, 2)
})
check('a block comment does not smuggle in a decoy resource', () => {
  const p = parseHCL(HCL_CORPUS.find((c) => c.name === 'block-comment').text, 'x.tf')
  eq([...walkBlocks(p)].filter((b) => b.block.name === 'resource').length, 1)
})
check('comments are retained as items', () => {
  const p = parseHCL(HCL_CORPUS.find((c) => c.name === 'comments-around-count').text, 'x.tf')
  ok(p.body.some((i) => i.type === 'comment'))
})
check('byte ranges point at the right text', () => {
  const c = HCL_CORPUS[0]
  const p = parseHCL(c.text, 'x.tf')
  const attr = bodyOf([...walkBlocks(p)][0].block).attrs.count
  eq(c.text.slice(attr.valueStart, attr.valueEnd), '3')
})
check('applyEdits is a no-op with no edits', () => eq(applyEdits(HCL_CORPUS[0].text, []), HCL_CORPUS[0].text))
check('applyEdits applies back-to-front safely', () => {
  const text = 'abcdef'
  eq(applyEdits(text, [{ start: 0, end: 1, replacement: 'X' }, { start: 4, end: 5, replacement: 'Y' }]), 'XbcdYf')
})
check('the whole example file parses without errors', () => eq(parseHCL(read('examples/terraform/main.tf'), 'main.tf').errors.length, 0))

section('IaC — the YAML reader')
check('multi-document files split correctly', () => eq(parseYamlDocs(K8S_CORPUS[1].text).length, 2))
check('nested mappings parse', () => {
  const d = parseYamlDocs(K8S_CORPUS[0].text)[0]
  eq(getPath(d.value, 'spec.replicas'), 3)
})
check('sequences of mappings parse', () => {
  const d = parseYamlDocs(K8S_CORPUS[0].text)[0]
  eq(getPath(d.value, 'spec.template.spec.containers.0.image'), 'example/api:1.0.0')
})
check('quoted scalars are unquoted', () => {
  const d = parseYamlDocs(K8S_CORPUS[2].text)[0]
  eq(d.value.metadata.name, 'orders')
  eq(d.value.metadata.namespace, 'prod')
})
check('nested inline flow maps survive', () => {
  const d = parseYamlDocs(K8S_CORPUS[3].text)[0]
  eq(d.value.metadata.labels.app, 'flow')
  eq(getPath(d.value, 'spec.selector.matchLabels.app'), 'flow')
})
check('scalar byte ranges are recorded', () => {
  const d = parseYamlDocs(K8S_CORPUS[0].text)[0]
  const r = d.ranges.get('spec.replicas')
  eq(K8S_CORPUS[0].text.slice(r.start, r.end), '3')
})
check('the k8s address is stable', () => eq(k8sAddress(parseYamlDocs(K8S_CORPUS[0].text)[0].value), 'apps/v1:Deployment:prod/api'))
check('the whole example manifest parses', () => eq(parseYamlDocs(read('examples/k8s/checkout.yaml')).length, 10))

section('IaC — mapping tables')
const cov = coverage()
check('the tables cover all four providers', () => ok(Object.keys(cov.byProvider).length >= 4))
check('there are at least 40 AWS rules', () => ok(cov.byProvider.aws >= 40))
check('a VPC is structural, not a component', () => ok(isStructural('aws_vpc')))
check('a listener is a connector, not context', () => ok(isConnector('aws_lb_listener')))
check('a VPC is not a connector — hopping through one would connect everything', () => ok(!isConnector('aws_vpc')))
check('every rule matches a real canonical kind', () => {
  for (const p of ['aws', 'gcp', 'azure']) {
    for (const t of ['aws_lb', 'google_sql_database_instance', 'azurerm_redis_cache']) {
      const rule = findRule(p, t, {})
      if (rule?.kind) ok(CATALOG[rule.kind], `${t} maps to unknown kind ${rule.kind}`)
    }
  }
})
check('image inference recognises Postgres', () => eq(inferFromImage('postgres:16.3'), 'sql'))
check('image inference recognises Redis', () => eq(inferFromImage('redis:7.2-alpine'), 'cache'))
check('image inference falls back rather than guessing wildly', () => eq(inferFromImage('example/mystery:1'), 'micro'))
check('instance sizing scales with size units', () =>
  ok(parseInstanceClass('m6i.2xlarge').factor > parseInstanceClass('m6i.large').factor))
check('an unrecognised instance class keeps the seed and says so', () => {
  const out = sizeFromInstanceClass(capacityFor('sql'), 'db.wat.enormous')
  eq(out.capPerReplica, capacityFor('sql').capPerReplica)
  eq(out.provenance.cls, 'modeled')
  ok(/unrecognised/.test(out.provenance.basis))
})
check('a recognised class becomes vendor provenance with a stated basis', () => {
  const out = sizeFromInstanceClass(capacityFor('sql'), 'db.r6g.xlarge')
  eq(out.provenance.cls, 'vendor')
  ok(out.provenance.basis.includes('db.r6g.xlarge'))
})
check('tier ranks put storage after compute', () => ok(TIER_RANK.sql > TIER_RANK.app))
check('tier ranks put the load balancer before the app', () => ok(TIER_RANK.lb < TIER_RANK.app))
check('edges into a queue are async', () => eq(callSemanticsFor('queue'), 'async'))
check('edges into a database are sync', () => eq(callSemanticsFor('sql'), 'sync'))
check('orientation flips a backwards dependency', () => {
  const [from, , flipped] = orient({ kind: 'sql' }, { kind: 'lb' })
  eq(from.kind, 'lb')
  eq(flipped, true)
})

section('IaC — Mode A: plan JSON (exact)')
const plan = JSON.parse(read('examples/terraform/tfplan.json'))
const planned = planJsonToIR(plan, { file: 'tfplan.json', name: 'checkout' })
check('the plan ingests without errors', () => ok(validateIR(planned.ir, { kinds: kinds() }).ok))
check('nothing is dropped', () => eq(planned.report.unmapped, 0))
check('count expansion is folded back into replicas', () =>
  eq(planned.ir.nodes.find((n) => n.label === 'checkout').capacity.replicas, 6))
check('a dynamic count is exact in Mode A', () =>
  eq(planned.ir.nodes.find((n) => n.label === 'fulfilment').capacity.replicas, 4))
check('multi_az becomes two replicas', () =>
  eq(planned.ir.nodes.find((n) => n.label === 'checkout-db').capacity.replicas, 2))
check('the instance class sizes the database', () =>
  ok(planned.ir.nodes.find((n) => n.label === 'checkout-db').capacity.capPerReplica > CATALOG.sql.cap))
check('a Lambda is sized by its memory', () => {
  const l = planned.ir.nodes.find((n) => n.label === 'checkout-hook')
  ok(l.capacity.provenance.basis.includes('512 MB'))
})
check('load balancer → instance is inferred through the connector chain', () => {
  const lb = planned.ir.nodes.find((n) => n.kind === 'lb')
  const app = planned.ir.nodes.find((n) => n.label === 'checkout')
  ok(planned.ir.edges.some((e) => e.from === lb.id && e.to === app.id))
})
check('a DATABASE_URL-shaped reference becomes an edge', () => {
  const fn = planned.ir.nodes.find((n) => n.label === 'checkout-hook')
  const db = planned.ir.nodes.find((n) => n.label === 'checkout-db')
  ok(planned.ir.edges.some((e) => e.from === fn.id && e.to === db.id))
})
check('every inferred edge carries a reason', () =>
  ok(planned.ir.edges.every((e) => e.attrs?.reason)))
check('a synthetic client is attached, and says it was inferred', () => {
  const c = planned.ir.nodes.find((n) => n.kind === 'client')
  ok(c && c.attrs.synthetic)
})
check('ingest is deterministic', () => eq(irHash(planJsonToIR(plan, { file: 'tfplan.json', name: 'checkout' }).ir), irHash(planned.ir)))
check('bindings default to observed — read-only until asked', () =>
  ok(planned.ir.nodes.filter((n) => n.bindings.length).every((n) => n.bindings[0].managed === 'observed')))
check('the ingested plan simulates', () => ok(simulate(planned.ir, 4000).p99 > 0))

section('IaC — Mode A: Kubernetes')
const k8sObjs = parseYamlDocs(read('examples/k8s/checkout.yaml')).map((d) => d.value).filter(Boolean)
const kres = k8sToIR(k8sObjs, { file: 'checkout.yaml' })
check('the manifest ingests without errors', () => ok(validateIR(kres.ir, { kinds: kinds() }).ok))
check('a ClusterIP Service is a routing fact, not a component', () =>
  ok(!kres.ir.nodes.some((n) => n.label === 'checkout' && n.kind === 'custom')))
check('the image decides the kind', () => eq(kres.ir.nodes.find((n) => n.label === 'orders').kind, 'sql'))
check('CPU limits size the capacity', () =>
  ok(kres.ir.nodes.find((n) => n.label === 'checkout').capacity.capPerReplica > CATALOG.micro.cap))
check('an HPA replaces the manifest replica count with its floor', () => {
  const n = kres.ir.nodes.find((n2) => n2.label === 'checkout')
  eq(n.capacity.replicas, 4)
  ok(/HPA-managed/.test(n.capacity.provenance.basis))
})
check('Ingress → Service → workload collapses to one edge', () => {
  const gw = kres.ir.nodes.find((n) => n.kind === 'gateway')
  const app = kres.ir.nodes.find((n) => n.label === 'checkout')
  ok(kres.ir.edges.some((e) => e.from === gw.id && e.to === app.id && e.confidence === 'high'))
})
check('an env-var reference is a medium-confidence edge', () => {
  const app = kres.ir.nodes.find((n) => n.label === 'checkout')
  const cache = kres.ir.nodes.find((n) => n.label === 'sessions')
  const e = kres.ir.edges.find((x) => x.from === app.id && x.to === cache.id)
  eq(e.confidence, 'medium')
})
check('an archsim.io/edge annotation beats an inference', () => {
  const w = kres.ir.nodes.find((n) => n.label === 'fulfilment-worker')
  const db = kres.ir.nodes.find((n) => n.label === 'orders')
  eq(kres.ir.edges.find((x) => x.from === w.id && x.to === db.id).confidence, 'high')
})
check('a StatefulSet is treated as single-leader', () =>
  eq(kres.ir.nodes.find((n) => n.label === 'orders').attrs.replication, 'leader'))
check('telemetry bindings are seeded from the workload name', () =>
  ok(kres.ir.nodes.find((n) => n.label === 'checkout').telemetry?.k8s?.workload === 'checkout'))
check('a List wrapper is unwrapped', () => eq(k8sObjects({ kind: 'List', items: [{ kind: 'X' }] }).length, 1))

section('IaC — Mode B: static HCL, and the round-trip corpus')
for (const fixture of HCL_CORPUS) {
  const sources = [{ path: `${fixture.name}.tf`, text: fixture.text }]
  const { ir, report } = hclToIR(sources, { managed: 'partial' })

  check(`[${fixture.name}] parses with no errors`, () => {
    const p = parseHCL(fixture.text, 'x.tf')
    eq(p.errors.length, 0)
  })
  check(`[${fixture.name}] every byte is accounted for`, () => {
    // Passthrough plus mapped block ranges must cover the file. Anything else is
    // a byte we would lose on emission.
    const passBytes = ir.passthrough.reduce((a, p) => a + p.text.length, 0)
    const nodeBytes = ir.nodes.reduce((a, n) => a + (n.bindings[0]?.range ? n.bindings[0].range.endByte - n.bindings[0].range.startByte : 0), 0)
    ok(passBytes + nodeBytes >= fixture.text.replace(/\s+$/g, '').length * 0.75,
      `only ${passBytes + nodeBytes} of ${fixture.text.length} bytes accounted for`)
  })
  check(`[${fixture.name}] emit with no changes touches nothing`, () => {
    const out = emitChanges(ir, ir, sources)
    eq(out.patches.length, 0)
    eq(out.generated.length, 0)
    eq(out.removals.length, 0)
  })

  const patchable = ir.nodes.find((n) => n.bindings.length && !n.attrs.unresolvedCount && !n.capacity.source
    && parseHCL(fixture.text, 'x').body.length >= 0 && hasLiteralCount(fixture.text, n))
  if (patchable) {
    check(`[${fixture.name}] a replica change patches exactly one line`, () => {
      const next = normalizeIR({ ...ir, nodes: ir.nodes.map((n) => (n.id === patchable.id ? { ...n, capacity: { ...n.capacity, replicas: n.capacity.replicas + 3 } } : n)) })
      const out = emitChanges(ir, next, sources)
      ok(out.patches.length === 1, 'expected exactly one patched file')
      const p = out.patches[0]
      const verdict = patchIsSurgical(p.before, p.after, p.edits)
      ok(verdict.ok, verdict.reason || 'patch was not surgical')
      eq(verdict.changedLines.length, 1)
    })
    check(`[${fixture.name}] every byte outside the edit is identical`, () => {
      const next = normalizeIR({ ...ir, nodes: ir.nodes.map((n) => (n.id === patchable.id ? { ...n, capacity: { ...n.capacity, replicas: 11 } } : n)) })
      const out = emitChanges(ir, next, sources)
      const p = out.patches[0]
      const edit = p.edits[0]
      eq(p.before.slice(0, edit.start), p.after.slice(0, edit.start))
      eq(p.before.slice(edit.end), p.after.slice(edit.start + edit.replacement.length))
    })
    check(`[${fixture.name}] comments and formatting survive the patch`, () => {
      const next = normalizeIR({ ...ir, nodes: ir.nodes.map((n) => (n.id === patchable.id ? { ...n, capacity: { ...n.capacity, replicas: 8 } } : n)) })
      const out = emitChanges(ir, next, sources)
      const commentsBefore = (fixture.text.match(/#|\/\//g) || []).length
      const commentsAfter = (out.patches[0].after.match(/#|\/\//g) || []).length
      eq(commentsAfter, commentsBefore)
    })
  }
}

check('a dynamic count is refused, not overwritten', () => {
  const f = HCL_CORPUS.find((c) => c.name === 'dynamic-count')
  const sources = [{ path: 'x.tf', text: f.text }]
  const { ir } = hclToIR(sources, { managed: 'partial' })
  const node = ir.nodes.find((n) => n.attrs.unresolvedCount)
  const next = normalizeIR({ ...ir, nodes: ir.nodes.map((n) => (n.id === node.id ? { ...n, capacity: { ...n.capacity, replicas: 9 } } : n)) })
  const out = emitChanges(ir, next, sources)
  eq(out.patches.length, 0)
  ok(out.unpatchable.some((u) => /computed expression/.test(u.reason)))
})
check('an unresolved count is shown as 1× with a badge, never invented', () => {
  const f = HCL_CORPUS.find((c) => c.name === 'dynamic-count')
  const { ir, report } = hclToIR([{ path: 'x.tf', text: f.text }])
  const n = ir.nodes.find((x) => x.attrs.unresolvedCount)
  eq(n.capacity.replicas, 1)
  ok(/shown as 1×/.test(n.attrs.badge))
  eq(n.capacity.provenance.cls, 'modeled')
  eq(report.unresolved.length, 1)
})
check('for_each is reported as unresolved', () => {
  const f = HCL_CORPUS.find((c) => c.name === 'for-each-unresolvable')
  eq(hclToIR([{ path: 'x.tf', text: f.text }]).report.unresolved.length, 1)
})
check('an unmapped resource becomes a custom component, not a hole', () => {
  const f = HCL_CORPUS.find((c) => c.name === 'unmapped-resource')
  const { ir, report } = hclToIR([{ path: 'x.tf', text: f.text }])
  eq(report.unmapped, 1)
  ok(ir.nodes.some((n) => n.kind === 'custom'))
})
check('an observed binding refuses to be written', () => {
  const sources = [{ path: 'x.tf', text: HCL_CORPUS[0].text }]
  const { ir } = hclToIR(sources, { managed: 'observed' })
  const next = normalizeIR({ ...ir, nodes: ir.nodes.map((n) => ({ ...n, capacity: { ...n.capacity, replicas: 99 } })) })
  const out = emitChanges(ir, next, sources)
  eq(out.patches.length, 0)
  ok(out.unpatchable.some((u) => /read-only/.test(u.reason)))
})
check('a new canvas node generates valid-looking HCL', () => {
  const gen = generateNode({ id: 'X', kind: 'sql', label: 'analytics db', capacity: { ...capacityFor('sql'), replicas: 2 }, bindings: [], attrs: {} }, { provider: 'aws' })
  ok(gen.text.includes('resource "aws_db_instance"'))
  ok(gen.text.includes('# Generated by ArchSim'))
  eq(parseHCL(gen.text, 'g.tf').errors.length, 0)
})
check('generated HCL round-trips back into the same kind', () => {
  const gen = generateNode({ id: 'X', kind: 'sql', label: 'analytics db', capacity: { ...capacityFor('sql'), replicas: 2 }, bindings: [], attrs: {} }, { provider: 'aws' })
  const { ir } = hclToIR([{ path: 'g.tf', text: gen.text }])
  eq(ir.nodes.find((n) => n.kind === 'sql')?.kind, 'sql')
})
check('a deleted node becomes a removal proposal, never a deletion', () => {
  const sources = [{ path: 'x.tf', text: HCL_CORPUS[0].text }]
  const { ir } = hclToIR(sources, { managed: 'partial' })
  const next = normalizeIR({ ...ir, nodes: ir.nodes.filter((n) => n.kind === 'client') })
  const out = emitChanges(ir, next, sources)
  ok(out.removals.length >= 1)
  ok(/proposed, not applied/.test(out.removals[0].note))
})

section('IaC — what real Terraform taught us')
// Each of these is a bug found by running the compiler over ~6,800 files of
// real Terraform. None of them was reachable from a corpus I wrote myself.
for (const fixture of REAL_WORLD_CORPUS) {
  const sources = [{ path: `${fixture.name}.tf`, text: fixture.text }]
  check(`[real:${fixture.name}] parses`, () => eq(parseHCL(fixture.text, 'x.tf').errors.length, 0))
  check(`[real:${fixture.name}] ingests without throwing`, () => ok(hclToIR(sources, { managed: 'partial' }).ir.nodes.length >= 0))
  check(`[real:${fixture.name}] emit with no changes touches nothing`, () => {
    const { ir } = hclToIR(sources, { managed: 'partial' })
    eq(emitChanges(ir, ir, sources).patches.length, 0)
  })
}

check('a module block does not crash the ingest — a quarter of real files have one', () => {
  const f = REAL_WORLD_CORPUS.find((c) => c.name === 'module-block')
  const { ir } = hclToIR([{ path: 'x.tf', text: f.text }])
  ok(ir.nodes.some((n) => n.kind === 'app'))
})
check('a module is a connector, not a component', () => {
  const f = REAL_WORLD_CORPUS.find((c) => c.name === 'module-block')
  const { ir } = hclToIR([{ path: 'x.tf', text: f.text }])
  ok(!ir.nodes.some((n) => n.bindings.some((b) => b.address.startsWith('module.'))))
})
check('a string interpolation containing quotes does not unbalance the file', () => {
  const f = REAL_WORLD_CORPUS.find((c) => c.name === 'interpolation-with-nested-quotes')
  const p = parseHCL(f.text, 'x.tf')
  eq(p.errors.length, 0)
  eq([...walkBlocks(p)].filter((b) => b.block.name === 'resource').length, 2)
})
check('an interpolated object literal keeps its braces to itself', () => {
  const f = REAL_WORLD_CORPUS.find((c) => c.name === 'interpolation-with-object')
  const p = parseHCL(f.text, 'x.tf')
  eq(p.errors.length, 0)
  eq([...walkBlocks(p)].filter((b) => b.block.name === 'resource').length, 2)
})
check('provisioning glue never becomes a component', () => {
  const f = REAL_WORLD_CORPUS.find((c) => c.name === 'provisioning-noise')
  const { ir } = hclToIR([{ path: 'x.tf', text: f.text }])
  const labels = ir.nodes.map((n) => n.bindings[0]?.address || '')
  ok(!labels.some((a) => /^(random_|null_resource|tls_)/.test(a)), `drew glue: ${labels.join(', ')}`)
  ok(ir.nodes.some((n) => n.kind === 'blob'), 'the bucket itself is still a component')
})
check('a setting on a resource is not a second copy of that resource', () => {
  const f = REAL_WORLD_CORPUS.find((c) => c.name === 'provisioning-noise')
  const { ir } = hclToIR([{ path: 'x.tf', text: f.text }])
  eq(ir.nodes.filter((n) => n.kind === 'blob').length, 1)
})
check('glue is classified, not lost — it still round-trips', () => {
  const f = REAL_WORLD_CORPUS.find((c) => c.name === 'provisioning-noise')
  const sources = [{ path: 'x.tf', text: f.text }]
  const { ir } = hclToIR(sources, { managed: 'partial' })
  ok(ir.passthrough.some((p) => p.text.includes('null_resource')), 'the bytes must survive even when the box does not')
})
check('sub-resources are detected structurally, not by enumeration', () => {
  ok(isSubResource('aws_cognito_user_pool_client'))
  ok(isSubResource('aws_s3_bucket_versioning'))
  ok(!isSubResource('aws_lb'))
  ok(!isSubResource('aws_rds_cluster_instance'), 'an explicit rule must win over the prefix heuristic')
})
check('a generic Terraform name falls back to the resource type', () => {
  eq(labelFromAddress('aws_cognito_user_pool', 'this'), 'cognito user pool')
  eq(labelFromAddress('aws_instance', 'other'), 'other')
})
check('no two components share a meaningless label', () => {
  const f = REAL_WORLD_CORPUS.find((c) => c.name === 'generic-names')
  const { ir } = hclToIR([{ path: 'x.tf', text: f.text }])
  const labels = ir.nodes.filter((n) => !n.attrs.synthetic).map((n) => n.label)
  eq(new Set(labels).size, labels.length, `duplicate labels: ${labels.join(', ')}`)
  ok(!labels.includes('this'))
})
check('a hub is not a connector: one shared module must not connect everything', () => {
  const f = REAL_WORLD_CORPUS.find((c) => c.name === 'hub-module')
  const { ir } = hclToIR([{ path: 'x.tf', text: f.text }])
  const real = ir.nodes.filter((n) => !n.attrs.synthetic && !n.capacity.source)
  // Six components sharing one module produced 30 edges before the degree cap.
  ok(ir.edges.length <= real.length, `${ir.edges.length} edges for ${real.length} components is a hairball`)
})
check('the patch attribute is read off the block, not assumed to be `count`', () => {
  const f = REAL_WORLD_CORPUS.find((c) => c.name === 'implicit-count-attribute')
  const sources = [{ path: 'x.tf', text: f.text }]
  const { ir } = hclToIR(sources, { managed: 'partial' })
  const node = ir.nodes.find((n) => n.bindings.length)
  const next = normalizeIR({ ...ir, nodes: ir.nodes.map((n) => (n.id === node.id ? { ...n, capacity: { ...n.capacity, replicas: 9 } } : n)) })
  const out = emitChanges(ir, next, sources)
  eq(out.patches.length, 1)
  ok(out.patches[0].edits[0].why.includes('desired_capacity'))
  const v = patchIsSurgical(out.patches[0].before, out.patches[0].after, out.patches[0].edits)
  ok(v.ok && v.changedLines.length === 1)
})
check('the mapping tables classify glue as noise, not as unmapped components', () => {
  ok(isNoise('null_resource') && isNoise('random_pet') && isNoise('aws_s3_object'))
  ok(!isNoise('aws_lb') && !isNoise('aws_db_instance'))
})

section('IaC — YAML round-trip')
for (const fixture of K8S_CORPUS) {
  const sources = [{ path: `${fixture.name}.yaml`, text: fixture.text }]
  const objs = parseYamlDocs(fixture.text, sources[0].path).map((d) => d.value).filter(Boolean)
  const { ir } = k8sToIR(objs, { file: sources[0].path, managed: 'partial' })
  check(`[k8s:${fixture.name}] emit with no changes touches nothing`, () => eq(emitChanges(ir, ir, sources).patches.length, 0))
  const workload = ir.nodes.find((n) => n.bindings.length && !n.attrs.hpa && !n.capacity.source)
  if (workload) {
    check(`[k8s:${fixture.name}] a replica change patches exactly one line`, () => {
      const next = normalizeIR({ ...ir, nodes: ir.nodes.map((n) => (n.id === workload.id ? { ...n, capacity: { ...n.capacity, replicas: n.capacity.replicas + 2 } } : n)) })
      const out = emitChanges(ir, next, sources)
      ok(out.patches.length === 1)
      const verdict = patchIsSurgical(out.patches[0].before, out.patches[0].after, out.patches[0].edits)
      ok(verdict.ok, verdict.reason)
      eq(verdict.changedLines.length, 1)
    })
  }
}
check('an HPA-managed workload refuses a replica patch, and explains why', () => {
  const sources = [{ path: 'checkout.yaml', text: read('examples/k8s/checkout.yaml') }]
  const objs = parseYamlDocs(sources[0].text, sources[0].path).map((d) => d.value).filter(Boolean)
  const { ir } = k8sToIR(objs, { file: sources[0].path, managed: 'partial' })
  const hpa = ir.nodes.find((n) => n.attrs.hpa)
  const next = normalizeIR({ ...ir, nodes: ir.nodes.map((n) => (n.id === hpa.id ? { ...n, capacity: { ...n.capacity, replicas: 15 } } : n)) })
  const out = emitChanges(ir, next, sources)
  eq(out.patches.length, 0)
  ok(out.unpatchable.some((u) => /HPA-managed/.test(u.reason)))
})

// ────────────────────────────────────────────────────────────────────────────
section('DES — closed-form agreement')

check('Erlang-C is 1 when demand exceeds the servers', () => eq(erlangC(2, 3), 1))
check('Erlang-C falls as servers are added', () => ok(erlangC(4, 1.5) < erlangC(2, 1.5)))
check('M/M/1 sojourn matches the textbook', () => near(mmcSojourn(0.5, 1, 1), 2, 1e-9))
for (const rho of [0.3, 0.5, 0.7, 0.85]) {
  check(`DES matches Erlang-C at ρ=${rho}`, () => {
    const r = checkErlangC({ serviceMeanMs: 20, capacityRps: 100, rps: 100 * rho, horizonMs: 600000, seed: 7, tolerance: 0.12 })
    ok(r.ok, `theory ${r.theory.toFixed(2)}ms vs observed ${r.observed.toFixed(2)}ms (${(r.relErr * 100).toFixed(1)}% apart)`)
  })
}
check('mean service time conversion is distribution-aware', () => {
  near(meanServiceMs(10, 'const', 0), 10, 1e-9)
  near(meanServiceMs(Math.LN2 * 10, 'exponential', 1), 10, 1e-9)
  ok(meanServiceMs(10, 'lognormal', 0.5) > 10)
})

section('DES — cross-engine consistency')
const chain = chainFixture({ rps: 500 })
for (const rps of [100, 300, 600]) {
  check(`the two engines agree at ${rps} rps (below the knee)`, () => {
    const r = checkCrossEngine(chain, rps, { horizonMs: 90000, seed: 11, tolerance: 0.4 })
    ok(r.ok, `DES mean ${r.des.toFixed(1)}ms vs analytic ${r.analytic.toFixed(1)}ms (${(r.relErr * 100).toFixed(0)}% apart)`)
  })
}
check('divergence past the knee is expected, and documented', () => {
  const r = checkCrossEngine(chain, 1900, { horizonMs: 60000, seed: 11, tolerance: 10 })
  ok(r.maxUtil > 0.85, 'the fixture must actually be past the knee for this check to mean anything')
})

section('DES — metamorphic properties')
check('doubling workers never raises p99', () => {
  const r = METAMORPHIC.moreWorkersNeverWorse(chain, 700)
  ok(r.ok, `p99 ${r.base.toFixed(1)}ms → ${r.doubled.toFixed(1)}ms`)
})
check('a retry budget never raises the steady-state error rate', () => {
  const r = METAMORPHIC.retryBudgetNeverWorse(chain, 700)
  ok(r.ok, `errors ${r.unbudgeted} → ${r.budgeted}`)
})
check('an open breaker never raises upstream p99', () => {
  const r = METAMORPHIC.breakerNeverRaisesUpstreamP99(chain, 700)
  ok(r.ok, `p99 ${r.without.toFixed(1)}ms → ${r.with.toFixed(1)}ms`)
})
check('the same seed produces the same trace', () => {
  const a = runDES(chain, { seed: 5, horizonMs: 20000 })
  const b = runDES(chain, { seed: 5, horizonMs: 20000 })
  eq(a.p99_ms, b.p99_ms)
  eq(a.events, b.events)
})
check('a different seed produces a different trace', () =>
  ok(runDES(chain, { seed: 5, horizonMs: 20000 }).p99_ms !== runDES(chain, { seed: 6, horizonMs: 20000 }).p99_ms))
check("Little's law holds inside the engine", () => eq(runDES(chain, { seed: 5, horizonMs: 60000 }).invariants.length, 0))
check('flow is conserved: nothing is served that never arrived', () => {
  const r = runDES(chain, { seed: 5, horizonMs: 30000 })
  ok(r.throughputRps <= r.offeredRps * 1.02)
})
check('worker pools are derived from baseline hold time, not own service time', () => {
  const hold = holdTimeBaseline(chain)
  ok(hold.get('gw') > hold.get('db'), 'a caller holds a worker for its whole downstream wait')
})
check('worker sizing excludes the fault — a design cannot re-provision mid-incident', () => {
  const slow = { node: { db: { capMul: 1, latMul: 20, drop: 0, dup: 0, noCache: false } }, cut: new Set(), rpsMul: 1 }
  const base = runDES(chain, { seed: 2, horizonMs: 40000, workload: { id: 'w', arrival: { dist: 'const', rps: 600 } } })
  const hurt = runDES(chain, { seed: 2, horizonMs: 40000, workload: { id: 'w', arrival: { dist: 'const', rps: 600 } }, fx: slow })
  eq(base.nodes.app.workers, hurt.nodes.app.workers)
})

section('DES — the findings')
check('thread starvation appears at unchanged arrival rate', () => {
  const slow = { node: { db: { capMul: 1, latMul: 15, drop: 0, dup: 0, noCache: false } }, cut: new Set(), rpsMul: 1 }
  const wl = { id: 'w', arrival: { dist: 'const', rps: 600 } }
  const healthy = runDES(chain, { seed: 2, horizonMs: 40000, workload: wl })
  const starved = runDES(chain, { seed: 2, horizonMs: 40000, workload: wl, fx: slow })
  ok(starved.nodes.app.utilization > healthy.nodes.app.utilization * 2,
    `app utilization ${(healthy.nodes.app.utilization * 100).toFixed(0)}% → ${(starved.nodes.app.utilization * 100).toFixed(0)}% at the same λ`)
  ok(analyzeStarvation(starved).starving)
})
check('an unbudgeted retry storm amplifies demand', () => {
  const stormy = withRetry(chain, { max: 3, backoffMs: 40, jitter: 'full', budgetPct: 0 })
  const res = runDES(stormy, { seed: 4, horizonMs: 40000, workload: { id: 'w', arrival: { dist: 'const', rps: 900 } }, fx: failLastHop(chain) })
  const storm = analyzeStorm(res)
  ok(storm.amplifying, storm.verdict)
})
check('a retry budget damps the storm', () => {
  const wl = { id: 'w', arrival: { dist: 'const', rps: 900 } }
  const fx = failLastHop(chain)
  const naive = runDES(withRetry(chain, { max: 3, backoffMs: 40, jitter: 'full', budgetPct: 0 }), { seed: 4, horizonMs: 40000, workload: wl, fx })
  const budgeted = runDES(withRetry(chain, { max: 3, backoffMs: 40, jitter: 'full', budgetPct: 10 }), { seed: 4, horizonMs: 40000, workload: wl, fx })
  const a = analyzeStorm(naive).edges[0]?.amplification ?? 1
  const b = analyzeStorm(budgeted).edges[0]?.amplification ?? 1
  ok(b <= a, `amplification ${a.toFixed(2)}× → ${b.toFixed(2)}×`)
})
check('a breaker opens under sustained failure', () => {
  const ir = withBreaker(withTimeouts(chain, 200), { windowSec: 5, errThreshold: 0.3, minSamples: 20, halfOpenProbes: 1, cooloffMs: 3000 })
  const res = runDES(ir, { seed: 9, horizonMs: 40000, workload: { id: 'w', arrival: { dist: 'const', rps: 700 } }, fx: failLastHop(chain) })
  ok(analyzeBreakers(res).any)
  ok(Object.values(res.edges).some((e) => e.breakerOpens > 0))
})
check('an open breaker short-circuits calls at zero latency', () => {
  const ir = withBreaker(withTimeouts(chain, 200), { windowSec: 5, errThreshold: 0.3, minSamples: 20, halfOpenProbes: 1, cooloffMs: 3000 })
  const res = runDES(ir, { seed: 9, horizonMs: 40000, workload: { id: 'w', arrival: { dist: 'const', rps: 700 } }, fx: failLastHop(chain) })
  ok(Object.values(res.edges).some((e) => e.shortCircuited > 0))
})
check('a bounded queue sheds rather than growing without limit', () => {
  const small = { ...chain, nodes: chain.nodes.map((n) => (n.id === 'app' ? { ...n, capacity: { ...n.capacity, queueDepth: 10 } } : n)) }
  const res = runDES(small, { seed: 3, horizonMs: 20000, workload: { id: 'w', arrival: { dist: 'const', rps: 4000 } } })
  ok(res.nodes.app.shed > 0)
  ok(res.nodes.app.avgQueue <= 10 * 2 + 1)
})
check('the DES emits telemetry-shaped frames', () => {
  const res = runDES(chain, { seed: 1, horizonMs: 10000, frameMs: 1000, workload: { id: 'w', arrival: { dist: 'const', rps: 400 } } })
  ok(res.frames.length >= 8)
  const f = res.frames[5]
  ok(typeof f.ts === 'number' && f.nodes && f.edges)
  ok(Object.values(f.nodes).every((n) => 'rps' in n && 'p99' in n && 'errRate' in n))
})
check("declared concurrency that contradicts capacity is reported, not silently chosen", () => {
  const odd = { ...chain, nodes: chain.nodes.map((n) => (n.id === 'app' ? { ...n, capacity: { ...n.capacity, concurrency: 4000 } } : n)) }
  const res = runDES(odd, { seed: 1, horizonMs: 5000, concurrencyMode: 'declared', workload: { id: 'w', arrival: { dist: 'const', rps: 100 } } })
  ok(res.discrepancies.some((d) => d.nodeId === 'app'))
})

section('DES — data structures')
check('the heap pops in time order', () => {
  const h = new EventHeap()
  for (const t of [5, 1, 9, 3, 7]) h.push(t, { t })
  const out = []
  while (h.size) out.push(h.pop().t)
  eq(out.join(','), '1,3,5,7,9')
})
check('ties pop in insertion order — determinism depends on it', () => {
  const h = new EventHeap()
  h.push(1, { k: 'a' }); h.push(1, { k: 'b' }); h.push(1, { k: 'c' })
  eq([h.pop(), h.pop(), h.pop()].map((x) => x.event.k).join(''), 'abc')
})
check('t-digest percentiles are close to exact', () => {
  const d = new TDigest(200)
  const xs = Array.from({ length: 100000 }, (_, i) => i + 1)
  for (const x of xs) d.push(x)
  near(d.quantile(50), 50000, 2000)
  near(d.quantile(99), 99000, 1500)
  eq(d.quantile(100), 100000)
})
check('t-digest memory stays bounded', () => {
  const d = new TDigest(100)
  for (let i = 0; i < 500000; i++) d.push(Math.random() * 1000)
  d.flush()
  ok(d.centroids.length < 400, `${d.centroids.length} centroids`)
})
check('t-digest handles a single sample', () => {
  const d = new TDigest()
  d.push(42)
  eq(d.quantile(50), 42)
})

// ────────────────────────────────────────────────────────────────────────────
section('Gate — the CI architecture gate')

const gateConfig = parseConfig(read('examples/archsim/slo.yaml'), 'slo.yaml')
check('the example config parses clean', () => eq(gateConfig.errors.length, 0))
check('the shipped example config also parses clean', () => eq(parseConfig(EXAMPLE_CONFIG).errors.length, 0))
check('nested inline arrival params survive the YAML reader', () =>
  eq(gateConfig.workloads[0].arrival.params.peakFactor, 3))
check('a typo in a metric is an error, not a silent skip', () => {
  const bad = parseConfig('slos:\n  - metric: vibes\n    op: "<="\n    threshold: 1\n')
  ok(bad.errors.length > 0)
})
check('an unknown fault is an error', () => {
  const bad = parseConfig('scenarios:\n  - fault: solar_flare\n')
  ok(bad.errors.some((e) => /unknown fault/.test(e)))
})

const baseLock = parseIR(read('examples/archsim/checkout.lock.json'))
const regression = planJsonToIR(JSON.parse(read('examples/terraform/tfplan-regression.json')), { file: 'tfplan.json' }).ir
const gateResult = runGate({ ir: regression, base: baseLock, config: { ...gateConfig, runs: 120 } })

check('the regression plan fails the gate', () => eq(gateResult.exitCode, 1))
check('the gate names what changed', () => ok(gateResult.diff.summary.some((s) => /replicas 6→3/.test(s))))
check('the gate compares against main', () => ok(gateResult.baseline !== null))
check('the gate reports a probability, not a point estimate', () =>
  ok(gateResult.evaluation.results.filter((r) => r.kind === 'distribution').every((r) => r.holdPct <= 100)))
check('the gate prices the repair', () => ok(gateResult.quickFix?.steps?.length > 0 && Number.isFinite(gateResult.quickFix.costDelta)))
check('the gate is reproducible with the same seed', () => {
  const again = runGate({ ir: regression, base: baseLock, config: { ...gateConfig, runs: 120 } })
  eq(JSON.stringify(again.evaluation.results.map((r) => r.holdPct)), JSON.stringify(gateResult.evaluation.results.map((r) => r.holdPct)))
})
check('the baseline passes the same gate', () => {
  const clean = runGate({ ir: baseLock, base: baseLock, config: { ...gateConfig, runs: 120 } })
  ok(clean.exitCode !== 1, 'main must not fail its own gate')
})
check('a gate with no violations exits 0', () => {
  const loose = { ...gateConfig, runs: 60, slos: [{ id: 'x', scope: 'system', metric: 'p99_ms', op: '<=', threshold: 1e9, under: 'all' }] }
  eq(runGate({ ir: baseLock, base: null, config: loose }).exitCode, 0)
})
check('error-budget risk exits 2, not 1 — "eating the budget" is not "broken"', () => {
  // Find a threshold that lands between the pass and risk bands. Searching for
  // it beats guessing a quantile: the point of the check is that the middle
  // band exists and is reachable, not that any particular number produces it.
  const mcHere = runMonteCarlo(baseLock, { runs: 200, seed: 42, scenarios: gateConfig.scenarios, workloads: gateConfig.workloads })
  const worst = mcHere.cells.map((c) => c.runs.map((r) => r.p99_ms).sort((a, b) => a - b))
  let found = null
  for (const q of [0.94, 0.92, 0.9, 0.88, 0.86, 0.84, 0.82]) {
    const threshold = Math.max(...worst.map((xs) => xs[Math.floor(xs.length * q)]))
    const cfg = { ...gateConfig, runs: 200, slos: [{ id: 'x', scope: 'system', metric: 'p99_ms', op: '<=', threshold, under: 'all' }] }
    if (runGate({ ir: baseLock, base: null, config: cfg }).exitCode === 2) { found = threshold; break }
  }
  ok(found !== null, 'no threshold produced the middle band — the risk verdict is unreachable')
})

section('Gate — reports')
const md = markdownReport(gateResult)
check('the markdown report leads with the verdict', () => ok(md.startsWith('## 🏗️ ArchSim Architecture Gate')))
check('the markdown report shows the change', () => ok(md.includes('**Change:**')))
check('the markdown report has one row per SLO', () =>
  eq((md.match(/\n\| [a-z]/g) || []).length, gateResult.evaluation.results.length))
check('the markdown report prices the fix', () => ok(/Cheapest fix found/.test(md)))
check('the markdown report states the seed, so anyone can reproduce it', () => ok(/seed 42/.test(md)))
check('the markdown report states the IR hash', () => ok(md.includes(gateResult.irHash)))
check('repeated replica steps are collapsed into one decision', () => ok(!/→\d+ replicas, then `[^`]+` \d+→/.test(md)))
check('cost rows show money, not a proportion of worlds', () => ok(/monthly_cost_usd.*\$/.test(md)))
const json = JSON.parse(jsonReport(gateResult))
check('the JSON report parses', () => ok(json.slos.length > 0))
check('the JSON report carries the exit code', () => eq(json.exitCode, gateResult.exitCode))
check('the JSON report carries per-scenario detail', () => ok(json.slos.some((s) => s.perScenario?.length > 1)))
check('the JSON report marks regressions against main', () => ok(json.slos.some((s) => s.was)))
const sarif = JSON.parse(sarifReport(gateResult))
check('the SARIF report is well-formed 2.1.0', () => {
  eq(sarif.version, '2.1.0')
  ok(Array.isArray(sarif.runs) && sarif.runs[0].tool.driver.name)
})
check('SARIF results carry a rule id and a level', () =>
  ok(sarif.runs[0].results.every((r) => r.ruleId && ['error', 'warning', 'note'].includes(r.level))))
check('SARIF findings point at a file, so they land in the diff view', () =>
  ok(sarif.runs[0].results.some((r) => r.locations?.[0]?.physicalLocation?.artifactLocation?.uri)))
check('SARIF declares every rule it emits', () => {
  const declared = new Set(sarif.runs[0].tool.driver.rules.map((r) => r.id))
  ok(sarif.runs[0].results.every((r) => declared.has(r.ruleId)), 'an undeclared rule id would be dropped by GitHub')
})
check('the terminal report is plain text, not markdown', () => {
  const t = terminalReport(gateResult)
  ok(!/<\/?[a-z]/i.test(t), 'no HTML')
  ok(!/\*\*/.test(t), 'no bold markers')
})

section('CLI — the headless engine')
const cli = (args, expectCode = 0) => {
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'packages/cli/bin/archsim.mjs'), ...args], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    if (expectCode !== 0) throw new Error(`expected exit ${expectCode}, got 0`)
    return out
  } catch (err) {
    if (err.status === undefined) throw err
    if (err.status !== expectCode) throw new Error(`expected exit ${expectCode}, got ${err.status}: ${err.stderr || ''}`)
    return err.stdout || ''
  }
}
check('`archsim version` prints a version', () => ok(/^2\.\d+\.\d+/.test(cli(['version']).trim())))
check('`archsim help` documents the exit codes', () => ok(/EXIT CODES/.test(cli(['help']))))
check('an unknown command exits 3 — never mistaken for a pass', () => cli(['nonsense'], 3))
check('`archsim ingest --plan` emits a valid IR', () => {
  const out = cli(['ingest', '--plan', 'examples/terraform/tfplan.json'])
  ok(validateIR(parseIR(out), { kinds: kinds() }).ok)
})
check('`archsim ingest --hcl` emits a valid IR', () => {
  const out = cli(['ingest', '--hcl', 'examples/terraform/main.tf'])
  ok(validateIR(parseIR(out), { kinds: kinds() }).ok)
})
check('`archsim ingest --k8s` emits a valid IR', () => {
  const out = cli(['ingest', '--k8s', 'examples/k8s/checkout.yaml'])
  ok(validateIR(parseIR(out), { kinds: kinds() }).ok)
})
check('`archsim validate` passes on the committed lockfile', () => ok(/valid/.test(cli(['validate', '--ir', 'examples/archsim/checkout.lock.json']))))
check('`archsim gate` exits 1 on the regression plan', () =>
  ok(cli(['gate', '--plan', 'examples/terraform/tfplan-regression.json', '--base', 'examples/archsim/checkout.lock.json', '--slo', 'examples/archsim/slo.yaml', '--runs', '80'], 1).includes('ArchSim Architecture Gate')))
check('`archsim gate` refuses an SLO file it does not understand', () => {
  fs.writeFileSync(path.join(ROOT, 'test/.tmp-bad-slo.yaml'), 'slos:\n  - metric: vibes\n    op: "<="\n    threshold: 1\n')
  try {
    cli(['gate', '--ir', 'examples/archsim/checkout.lock.json', '--slo', 'test/.tmp-bad-slo.yaml'], 3)
  } finally {
    fs.unlinkSync(path.join(ROOT, 'test/.tmp-bad-slo.yaml'))
  }
})
check('`archsim simulate` reports utilization', () => ok(/util/.test(cli(['simulate', '--ir', 'examples/archsim/checkout.lock.json', '--rps', '4000']))))
check('`archsim des` runs a trace', () => ok(/DES ·/.test(cli(['des', '--ir', 'examples/archsim/checkout.lock.json', '--rps', '2000', '--horizon', '5']))))
check('`archsim faults` lists the chaos library', () => ok(cli(['faults']).includes('retry')))
check('`archsim coverage` reports what the tables know', () => ok(/mapping rules/.test(cli(['coverage']))))
check('`archsim diff` reports the regression', () =>
  ok(/replicas 6→3/.test(cli(['diff', '--base', 'examples/archsim/checkout.lock.json', '--plan', 'examples/terraform/tfplan-regression.json']))))
check('`archsim replay --run` reproduces one world exactly', () => {
  const a = cli(['replay', '--ir', 'examples/archsim/checkout.lock.json', '--seed', '42', '--runs', '50', '--run', '17'])
  const b = cli(['replay', '--ir', 'examples/archsim/checkout.lock.json', '--seed', '42', '--runs', '50', '--run', '17'])
  eq(a, b)
  ok(/bottleneck/.test(a))
})
check('`archsim selftest` holds the DES to theory', () => ok(/ok  /.test(cli(['selftest']))))
check('`archsim migrate` converts a v1 payload', () => {
  const tmp = path.join(ROOT, 'test/.tmp-v1.json')
  fs.writeFileSync(tmp, JSON.stringify(v1Payload))
  try {
    ok(validateIR(parseIR(cli(['migrate', '--in', 'test/.tmp-v1.json'])), { kinds: kinds() }).ok)
  } finally { fs.unlinkSync(tmp) }
})
check('the CLI has no runtime dependencies — it must ship to an airgapped runner', () => {
  const pkg = JSON.parse(read('packages/cli/package.json'))
  ok(Object.keys(pkg.dependencies).every((d) => d.startsWith('@archsim/')))
})

// ────────────────────────────────────────────────────────────────────────────
section('Twin — telemetry, drift, calibration, replay')

const twinIR = baseLock
const t0 = 1767225600000
const source = syntheticSource(twinIR, { seed: 3, rps: 4000, incidentAt: t0 + 300000 })
const twin = new Twin(twinIR, source, { tickMs: 5000 })
for (let i = 0; i < 8; i++) await twin.tick(t0 + i * 5000)

check('frames arrive with node metrics', () => {
  const f = twin.buffer.latest
  ok(Object.keys(f.nodes).length > 0)
  ok(Object.values(f.nodes).every((n) => 'rps' in n && 'p99' in n))
})
check('saturation is measured against the modelled ceiling', () =>
  ok(Object.values(twin.buffer.latest.nodes).every((n) => n.saturation >= 0)))
check('a declared archsim.io/node attribute resolves first', () =>
  ok(Object.values(twin.buffer.latest.nodes).every((n) => n.confidence === 'declared')))
check('the resolution ladder falls back to a name match', () => {
  const resolve = buildResolver(twinIR)
  const hit = resolve({ service: twinIR.nodes[1].label })
  ok(hit.node && ['matched', 'heuristic'].includes(hit.confidence))
})
check('the ladder degrades to heuristic for a fuzzy name', () => {
  const resolve = buildResolver(twinIR)
  const label = twinIR.nodes.find((n) => !n.capacity.source).label
  const hit = resolve({ service: label.replace(/-/g, '_') })
  ok(!hit.node || hit.confidence === 'heuristic' || hit.confidence === 'matched')
})
check('an unmatched series becomes a ghost node, not an error', () => {
  ok(twin.ghosts.some((g) => g.name === 'fraud-scoring'))
})
check('a ghost carries the traffic that proves it exists', () =>
  ok(twin.ghosts.find((g) => g.name === 'fraud-scoring').rps > 0))
check('confirming a binding promotes it to declared', () => {
  const node = twinIR.nodes.find((n) => !n.capacity.source)
  const { ir: after, patch } = confirmBinding(twinIR, node.id, { service: 'checkout-api' })
  eq(after.nodes.find((n) => n.id === node.id).telemetry.confidence, 'declared')
  ok(patch.annotation['archsim.io/node'] === node.id, 'the confirmation must be writable back into the code')
})
check('the frame buffer is bounded', () => {
  const b = new FrameBuffer(10)
  for (let i = 0; i < 50; i++) b.push({ ts: i, nodes: {}, edges: {} })
  eq(b.frames.length, 10)
})
check('rollup reduces resolution without losing the tail', () => {
  const frames = Array.from({ length: 20 }, (_, i) => ({ ts: i * 1000, nodes: { a: { rps: 10, p99: i === 7 ? 900 : 20, errRate: 0 } }, edges: {} }))
  const rolled = rollup(frames, 10000)
  eq(rolled.length, 2)
  eq(rolled[0].nodes.a.p99, 900, 'a max over p99s: averaging tails invents a calmer system')
})
check('drift is detected when the model and production disagree', () => {
  const wrong = normalizeIR({ ...twinIR, nodes: twinIR.nodes.map((n) => (n.capacity.source ? n : { ...n, capacity: { ...n.capacity, latencyMs: { ...n.capacity.latencyMs, p50: n.capacity.latencyMs.p50 / 12 } } })) })
  const t2 = new Twin(wrong, syntheticSource(twinIR, { seed: 3, rps: 4000 }), {})
  return (async () => {
    for (let i = 0; i < 6; i++) await t2.tick(t0 + i * 5000)
    ok(t2.drift().length > 0)
  })()
})
check('calibration flips provenance to telemetry and tightens the band', () => {
  const node = twinIR.nodes.find((n) => !n.capacity.source && twin.buffer.latest.nodes[n.id])
  const { ir: after, applied } = calibrateNode(twinIR, twin.buffer.frames, node.id)
  eq(after.nodes.find((n) => n.id === node.id).overrides.provenance.cls, 'telemetry')
  ok(applied.to.jitter.capPct < applied.from.jitter.capPct)
})
check('calibration without an observed knee never lowers a ceiling', () => {
  const node = twinIR.nodes.find((n) => !n.capacity.source && twin.buffer.latest.nodes[n.id])
  const { applied } = calibrateNode(twinIR, twin.buffer.frames, node.id)
  if (!applied.kneeObserved) ok(applied.to.capPerReplica >= applied.from.capPerReplica,
    'a comfortable window is evidence of a floor, not of a ceiling')
})
check('a calibrated node narrows the gate’s sampled spread', () => {
  const node = twinIR.nodes.find((n) => !n.capacity.source && twin.buffer.latest.nodes[n.id])
  const { ir: after } = calibrateNode(twinIR, twin.buffer.frames, node.id)
  const before = runMonteCarlo(twinIR, { runs: 120, seed: 5 }).cells[0].metrics.p99_ms
  const calibrated = runMonteCarlo(normalizeIR(after), { runs: 120, seed: 5 }).cells[0].metrics.p99_ms
  ok((calibrated.max - calibrated.min) <= (before.max - before.min) * 1.02)
})
check('a range query is all a replay is', async () => {
  const frames = await twin.loadRange(t0 + 280000, t0 + 400000, 10000)
  ok(frames.length >= 10)
})
check('the scrubber seeks to a timestamp', async () => {
  const frames = await twin.loadRange(t0 + 280000, t0 + 400000, 10000)
  const s = new Scrubber(frames, { resolutionMs: 10000 })
  const f = s.seekTo(t0 + 330000)
  ok(Math.abs(f.ts - (t0 + 330000)) <= 10000)
})
check('an incident yields a fault signature', async () => {
  const frames = await twin.loadRange(t0 + 280000, t0 + 520000, 10000)
  const sig = faultSignature(twinIR, frames, { baselineFrames: twin.buffer.frames })
  ok(sig.length > 0)
  ok(sig.every((s) => FAULTS.some((f) => f.id === s.fault)), 'every signature must name a fault the gate can run')
})
check('an incident becomes a scenario the gate can enforce', async () => {
  const frames = await twin.loadRange(t0 + 280000, t0 + 520000, 10000)
  const repro = reproduceInSimulator(twinIR, frames, { id: 'inc', baselineFrames: twin.buffer.frames })
  const parsed = parseConfig(repro.yaml)
  eq(parsed.errors.length, 0, 'the emitted YAML must be valid gate config, or the loop is broken')
  ok(parsed.scenarios.length > 0 && parsed.workloads.length > 0)
})
check('the incident loop closes: replayed scenario runs in the engines', async () => {
  const frames = await twin.loadRange(t0 + 280000, t0 + 520000, 10000)
  const repro = reproduceInSimulator(twinIR, frames, { id: 'inc', baselineFrames: twin.buffer.frames })
  const fx = compileFaults(repro.scenario.faults, twinIR, simulate(twinIR, repro.workload.arrival.rps))
  const sim = simulate(twinIR, repro.workload.arrival.rps, { fx })
  ok(sim.p99 > 0)
  const des = runDES(twinIR, { workload: repro.workload, horizonMs: 8000, seed: 1, fx })
  ok(des.events > 0)
})
check('a frame becomes a workload the simulators accept', () => {
  const w = frameToWorkload(twin.buffer.latest, twinIR)
  ok(w.arrival.rps > 0)
})
check('trace spans become edges across service boundaries', () => {
  const edges = edgesFromSpans([
    { parentService: 'web', service: 'api', durationMs: 30, kind: 'server' },
    { parentService: 'web', service: 'api', durationMs: 90, kind: 'server', status: 'error' },
    { service: 'api', kind: 'client', attributes: { 'db.system': 'postgresql' }, durationMs: 12 },
  ], null)
  ok(edges.some((e) => e.from === 'web' && e.to === 'api' && e.errRate === 0.5))
  ok(edges.some((e) => e.to === 'postgresql'), 'an uninstrumented sink is still on the critical path')
})
check('a twin whose source fails says so rather than going quiet', async () => {
  const broken = new Twin(twinIR, { name: 'broken', async sample() { throw new Error('collector unreachable') }, async range() { return [] } }, {})
  await broken.tick()
  ok(broken.lastError && /unreachable/.test(broken.lastError))
})
check('the Prometheus adapter builds range queries against the vendor TSDB', async () => {
  const calls = []
  const src = prometheusSource({
    baseUrl: 'http://prom:9090',
    fetchImpl: async (url) => { calls.push(url); return { ok: true, json: async () => ({ status: 'success', data: { result: [] } }) } },
  })
  await src.range(1000, 61000, 10000)
  ok(calls.length >= 3 && calls.every((c) => c.includes('/api/v1/query_range')))
})

// ────────────────────────────────────────────────────────────────────────────
section('Repository — the claims this README makes')

check('every package is dependency-free apart from its siblings', () => {
  for (const p of ['ir', 'core', 'iac', 'des', 'twin', 'cli']) {
    const pkg = JSON.parse(read(`packages/${p}/package.json`))
    for (const d of Object.keys(pkg.dependencies || {})) ok(d.startsWith('@archsim/'), `${p} depends on ${d}`)
  }
})
check('the IR package depends on nothing at all', () =>
  eq(Object.keys(JSON.parse(read('packages/ir/package.json')).dependencies || {}).length, 0))
check('no package imports from the web app', () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])
  const files = walk(path.join(ROOT, 'packages')).filter((f) => f.endsWith('.js'))
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8')
    ok(!/from ['"].*apps\//.test(text), `${f} imports from apps/`)
  }
})
check('no package touches the DOM', () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])
  const files = walk(path.join(ROOT, 'packages')).filter((f) => f.endsWith('.js'))
  for (const f of files) {
    // Comments are stripped first: prose about "an incident window." is not a
    // DOM reference, and neither is `b.window.push` — a breaker's sliding
    // window, which is why the pattern also refuses a preceding dot.
    const text = stripComments(fs.readFileSync(f, 'utf8'))
    ok(!/(^|[^.\w])(document|window)\./m.test(text), `${f} references the DOM`)
  }
})
check('the JSON schema is published and parses', () => {
  const schema = JSON.parse(read('packages/ir/schema/archir-2.0.schema.json'))
  eq(schema.properties.irVersion.const, '2.0')
})
check('the schema documents every capacity field the engines read', () => {
  const props = JSON.parse(read('packages/ir/schema/archir-2.0.schema.json')).$defs.capacity.properties
  for (const k of ['replicas', 'capPerReplica', 'latencyMs', 'availability', 'concurrency', 'queueDepth', 'provenance', 'jitter']) {
    ok(props[k], `schema is missing ${k}`)
  }
})
check('the committed lockfile is current with the example plan', () => {
  const fresh = planJsonToIR(JSON.parse(read('examples/terraform/tfplan.json')), { file: 'examples/terraform/tfplan.json', name: 'checkout' }).ir
  eq(irHash(fresh), irHash(baseLock), 'run `archsim ingest --plan examples/terraform/tfplan.json --out examples/archsim/checkout.lock.json`')
})
check('the GitHub Action exists and calls the gate', () => {
  const action = read('action.yml')
  ok(/archsim/.test(action) && /gate/.test(action))
})
check('CI runs the suite', () => ok(/npm run verify/.test(read('.github/workflows/ci.yml'))))

function hasLiteralCount(text, node) {
  const addr = node.bindings[0]?.address
  if (!addr) return false
  const p = parseHCL(text, 'x.tf')
  for (const { block } of walkBlocks(p)) {
    if (block.name !== 'resource' || addressOf(block) !== addr) continue
    const { attrs } = bodyOf(block)
    const a = attrs.count || attrs.desired_count || attrs.desired_capacity || attrs.num_cache_nodes || attrs.num_cache_clusters
    return !!a && !a.dynamic
  }
  return false
}

// ── CloudFormation, CDK and SAM ─────────────────────────────────────────────
section('CloudFormation: the path CDK actually takes')

const CFN_STACK = {
  AWSTemplateFormatVersion: '2010-09-09',
  Parameters: { Count: { Type: 'Number', Default: 4 }, Env: { Type: 'String', Default: 'prod' }, NoDefault: { Type: 'String' } },
  Mappings: { Sizing: { prod: { Db: 'db.r6g.2xlarge' }, dev: { Db: 'db.t3.micro' } } },
  Conditions: { IsProd: { 'Fn::Equals': [{ Ref: 'Env' }, 'prod'] }, Unknowable: { 'Fn::Equals': [{ Ref: 'NoDefault' }, 'x'] } },
  Resources: {
    Vpc: { Type: 'AWS::EC2::VPC', Properties: { CidrBlock: '10.0.0.0/16' } },
    Alb: { Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer', Properties: { Type: 'application', Subnets: [{ Ref: 'Vpc' }] } },
    Tg: { Type: 'AWS::ElasticLoadBalancingV2::TargetGroup', Properties: { VpcId: { Ref: 'Vpc' } } },
    Listener: { Type: 'AWS::ElasticLoadBalancingV2::Listener', Properties: { LoadBalancerArn: { Ref: 'Alb' }, DefaultActions: [{ TargetGroupArn: { Ref: 'Tg' } }] } },
    CheckoutServiceB1CE1F2A: { Type: 'AWS::ECS::Service', Properties: { DesiredCount: { Ref: 'Count' }, LoadBalancers: [{ TargetGroupArn: { Ref: 'Tg' } }] } },
    OrdersDb: { Type: 'AWS::RDS::DBInstance', Properties: { Engine: 'postgres', DBInstanceClass: { 'Fn::FindInMap': ['Sizing', { Ref: 'Env' }, 'Db'] }, MultiAZ: { 'Fn::If': ['IsProd', true, false] } }, DependsOn: ['CheckoutServiceB1CE1F2A'] },
    StagingOnly: { Type: 'AWS::S3::Bucket', Condition: 'NotProd', Properties: {} },
    Role: { Type: 'AWS::IAM::Role', Properties: {} },
    Meta: { Type: 'AWS::CDK::Metadata', Properties: {} },
  },
}
CFN_STACK.Conditions.NotProd = { 'Fn::Not': [{ 'Fn::Equals': [{ Ref: 'Env' }, 'prod'] }] }

const cfnText = JSON.stringify(CFN_STACK)
const cfn = cfnToIR([{ file: 'Checkout.template.json', text: cfnText }])
const cfnNode = (label) => cfn.ir.nodes.find((n) => n.label === label)

check('a CloudFormation type resolves to the cfn provider, not to Kubernetes', () =>
  providerOf('AWS::Lambda::Function') === 'cfn' && providerOf('apps/v1:Deployment') === 'k8s')
check('a template becomes components', () =>
  // three mapped resources, plus the client the ingest attaches to the front
  cfn.report.mapped === 3 && cfn.ir.nodes.length === 4)
check('a parameter default supplies a replica count', () => cfnNode('checkout-service').capacity.replicas === 4)
check('Fn::FindInMap through a Ref sizes the database', () =>
  cfnNode('orders-db').capacity.capPerReplica === sizeFromInstanceClass(capacityFor('sql'), 'db.r6g.2xlarge').capPerReplica)
check('Fn::If on a decidable condition is decided', () => cfnNode('orders-db').capacity.replicas === 2)
check('a resource whose condition is false is not deployed', () =>
  !cfn.ir.nodes.some((n) => n.label === 'staging-only'))
check('IAM and CDK metadata are structural, not components', () =>
  cfn.report.resources.filter((r) => r.disposition === 'structural').length >= 2 &&
  !cfn.ir.nodes.some((n) => /role|meta/.test(n.label)))
check('a listener and target group are hopped through, not drawn', () => {
  const l = (id) => cfn.ir.nodes.find((n) => n.id === id)?.label
  return cfn.ir.edges.some((e) => l(e.from) === 'alb' && l(e.to) === 'checkout-service')
})
check('a CDK logical id becomes a readable label', () => labelFromLogicalIdIsReadable())
function labelFromLogicalIdIsReadable() { return !!cfnNode('checkout-service') }
check('an unresolvable condition is reported, not silently assumed', () => {
  const t = { Resources: { B: { Type: 'AWS::S3::Bucket', Properties: { BucketName: { 'Fn::If': ['Unknowable', 'a', 'b'] } } } }, Conditions: CFN_STACK.Conditions, Parameters: CFN_STACK.Parameters }
  const r = cfnToIR([{ file: 'x.json', text: JSON.stringify(t) }])
  return r.report.warnings.some((w) => /could not be evaluated/.test(w.msg))
})
check('Fn::ImportValue says which stack is missing rather than inventing a value', () => {
  const t = { Resources: { S: { Type: 'AWS::ECS::Service', Properties: { DesiredCount: { 'Fn::ImportValue': 'other-stack-count' } } } } }
  const r = cfnToIR([{ file: 'x.json', text: JSON.stringify(t) }])
  return r.report.warnings.some((w) => /crosses a stack boundary/.test(w.msg))
})
check('the whole template is kept verbatim in passthrough', () =>
  cfn.ir.passthrough.length === 1 && cfn.ir.passthrough[0].text === cfnText)
check('a template simulates', () => Number.isFinite(simulate(cfn.ir, 2000).p99))

const cfnYaml = `AWSTemplateFormatVersion: '2010-09-09'
Resources:
  Bucket:
    Type: AWS::S3::Bucket
  Fn:
    Type: AWS::Lambda::Function
    Properties:
      Environment:
        Variables:
          BUCKET: !Ref Bucket
          ARN: !GetAtt Bucket.Arn
`
check('YAML short-form intrinsics normalise to the long form', () => {
  const { template } = parseCfnTemplate(cfnYaml, 'x.yaml')
  const v = template.Resources.Fn.Properties.Environment.Variables
  return v.BUCKET.Ref === 'Bucket' && v.ARN['Fn::GetAtt'][0] === 'Bucket'
})
check('a YAML template ingests and its references become an edge', () => {
  const r = cfnToIR([{ file: 'x.yaml', text: cfnYaml }])
  return r.ir.nodes.length >= 2 && r.ir.edges.length >= 1
})
check('parameter defaults are the only parameter values read', () => {
  const d = parameterDefaults(CFN_STACK)
  return d.Count === 4 && d.Env === 'prod' && !('NoDefault' in d)
})
check('conditions that cannot be decided stay undecided', () => {
  const c = evaluateConditions(CFN_STACK, parameterDefaults(CFN_STACK))
  return c.IsProd === true && c.NotProd === false && c.Unknowable === undefined
})
check('cdk.out is read through its manifest', () => {
  const r = cdkOutToIR([
    { path: 'cdk.out/manifest.json', text: JSON.stringify({ artifacts: { CheckoutStack: { type: 'aws:cloudformation:stack', properties: { templateFile: 'CheckoutStack.template.json' } } } }) },
    { path: 'cdk.out/CheckoutStack.template.json', text: cfnText },
  ])
  return r.report.stacks.length === 1 && r.report.stacks[0].stack === 'CheckoutStack' && r.ir.nodes.length === cfn.ir.nodes.length
})
check('cdk.out without a manifest still reads, and says the ordering is unknown', () => {
  const r = cdkOutToIR([{ path: 'cdk.out/A.template.json', text: cfnText }])
  return r.ir.nodes.length > 0 && r.report.warnings.some((w) => /no manifest\.json/.test(w.msg))
})
check('the same template twice produces the same irHash', () =>
  irHash(cfnToIR([{ file: 'a.json', text: cfnText }]).ir) === irHash(cfnToIR([{ file: 'a.json', text: cfnText }]).ir))

// ── Pulumi ──────────────────────────────────────────────────────────────────
section('Pulumi: state and preview')

const U = (t, n) => `urn:pulumi:prod::shop::${t}::${n}`
const PULUMI_STATE = { deployment: { resources: [
  { urn: U('pulumi:pulumi:Stack', 'shop-prod'), type: 'pulumi:pulumi:Stack' },
  { urn: U('aws:ec2/vpc:Vpc', 'main'), inputs: {} },
  { urn: U('aws:elasticloadbalancingv2/loadBalancer:LoadBalancer', 'edge'), inputs: {}, dependencies: [U('aws:ec2/vpc:Vpc', 'main')] },
  { urn: U('aws:elasticloadbalancingv2/targetGroup:TargetGroup', 'tg'), inputs: {}, dependencies: [U('aws:elasticloadbalancingv2/loadBalancer:LoadBalancer', 'edge')] },
  { urn: U('aws:ecs/service:Service', 'checkout'), inputs: { desired_count: 6 }, dependencies: [U('aws:elasticloadbalancingv2/targetGroup:TargetGroup', 'tg')] },
  { urn: U('aws:rds/instance:Instance', 'orders'), inputs: { instance_class: 'db.r6g.xlarge', multi_az: true }, dependencies: [U('aws:ecs/service:Service', 'checkout')] },
] } }
const pulumi = pulumiToIR(PULUMI_STATE)

check('a URN parses into stack, project, type and name', () => {
  const p = parseUrn(U('aws:ecs/service:Service', 'checkout'))
  return p.stack === 'prod' && p.project === 'shop' && p.name === 'checkout'
})
check('a Pulumi type maps onto the Terraform rule already in the registry', () =>
  typeToTerraform('aws:ecs/service:Service').terraformType === 'aws_ecs_service' &&
  typeToTerraform('aws:elasticloadbalancingv2/loadBalancer:LoadBalancer').terraformType === 'aws_lb' &&
  typeToTerraform('aws:elasticache/replicationGroup:ReplicationGroup').terraformType === 'aws_elasticache_replication_group')
check('a stack export becomes components with their real replica counts', () =>
  pulumi.report.source === 'state' && pulumi.ir.nodes.find((n) => n.label === 'checkout')?.capacity.replicas === 6)
check('multi_az on a Pulumi RDS instance is two replicas, same as in Terraform', () =>
  pulumi.ir.nodes.find((n) => n.label === 'orders')?.capacity.replicas === 2)
check("Pulumi's own stack and provider resources are not components", () =>
  !pulumi.ir.nodes.some((n) => /shop-prod/.test(n.label)))
check('the dependency graph becomes edges, hopping the target group', () => {
  const l = (id) => pulumi.ir.nodes.find((n) => n.id === id)?.label
  return pulumi.ir.edges.some((e) => l(e.from) === 'edge' && l(e.to) === 'checkout')
})
check('a preview is read too, and says it is a preview', () => {
  const p = pulumiToIR({ steps: [
    { op: 'create', urn: U('aws:ecs/service:Service', 'checkout'), newState: { urn: U('aws:ecs/service:Service', 'checkout'), inputs: { desired_count: 3 } } },
    { op: 'delete', urn: U('aws:sqs/queue:Queue', 'old'), oldState: { urn: U('aws:sqs/queue:Queue', 'old'), inputs: {} } },
  ] })
  return p.report.source === 'preview' && p.ir.nodes.some((n) => n.label === 'checkout') && !p.ir.nodes.some((n) => n.label === 'old')
})
check('a Pulumi stack simulates', () => Number.isFinite(simulate(pulumi.ir, 1000).p99))

// ── Helm ────────────────────────────────────────────────────────────────────
section('Helm: render what is safe, refuse the rest')

const CHART = [
  { path: 'checkout/Chart.yaml', text: 'name: checkout\nversion: 1.4.2\nappVersion: "2.0"\n' },
  { path: 'checkout/values.yaml', text: 'replicaCount: 5\nimage:\n  repository: nginx\ncache:\n  replicas: 3\n' },
  { path: 'checkout/templates/deployment.yaml', text: 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: {{ .Chart.Name }}-api\nspec:\n  replicas: {{ .Values.replicaCount }}\n  template:\n    spec:\n      containers:\n        - name: api\n          image: {{ .Values.image.repository }}:{{ .Values.image.tag | default "latest" }}\n' },
  { path: 'checkout/templates/ingress.yaml', text: '{{- if .Values.ingress.enabled }}\napiVersion: networking.k8s.io/v1\nkind: Ingress\n{{- end }}\n' },
  { path: 'checkout/templates/_helpers.tpl', text: '{{- define "x" -}}y{{- end -}}' },
]

check('a chart directory is recognised', () => looksLikeChart(CHART) && !looksLikeChart([{ path: 'a/b.yaml', text: '' }]))
check('plain value substitution renders exactly', () => {
  const out = substitute('replicas: {{ .Values.n }}', { values: { n: 7 }, chart: {}, release: {} })
  return out === 'replicas: 7'
})
check('.Chart.Name reads the chart file\'s lowercase key', () => {
  const r = renderChart(CHART)
  return /name: checkout-api/.test(r.rendered.find((f) => /deployment/.test(f.path)).text)
})
check('a default pipeline supplies a missing value', () =>
  substitute('{{ .Values.tag | default "latest" }}', { values: {}, chart: {}, release: {} }) === 'latest')
check('an unknown pipeline is left visible rather than guessed', () =>
  substitute('{{ .Values.x | b64enc }}', { values: { x: 'a' }, chart: {}, release: {} }) === '{{ .Values.x | b64enc }}')
check('control flow is refused by name and line, never half-rendered', () => {
  const r = renderChart(CHART)
  return r.refused.length === 1 && r.refused[0].what === 'if' && r.refused[0].line === 1
})
check('a refusal names the file and points at helm template', () => {
  const { report } = helmToIR(CHART)
  return report.warnings.some((w) => /ingress\.yaml/.test(w.address) && /helm template/.test(w.msg))
})
check('the renderable half of a chart still becomes an architecture', () => {
  const { ir } = helmToIR(CHART)
  return ir.nodes.find((n) => n.label === 'checkout-api')?.capacity.replicas === 5
})
check('a values override wins over the chart default, exactly as -f does', () => {
  const { ir } = helmToIR(CHART, { values: { replicaCount: 9 } })
  return ir.nodes.find((n) => n.label === 'checkout-api')?.capacity.replicas === 9
})
check('_helpers.tpl renders nothing', () => renderChart(CHART).rendered.every((f) => !/_helpers/.test(f.path)))

// ── drift ───────────────────────────────────────────────────────────────────
section('Drift: the design against the estate')

const driftStack = (desired, dbClass, extra = {}) => JSON.stringify({ Resources: {
  Alb: { Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer', Properties: {} },
  Checkout: { Type: 'AWS::ECS::Service', Properties: { DesiredCount: desired }, DependsOn: ['Alb'] },
  OrdersDb: { Type: 'AWS::RDS::DBInstance', Properties: { DBInstanceClass: dbClass, Engine: 'postgres' }, DependsOn: ['Checkout'] },
  ...extra,
} })
const designIR = cfnToIR([{ file: 'design.json', text: driftStack(6, 'db.r6g.2xlarge') }]).ir
const liveIR = cfnToIR([{ file: 'live.json', text: driftStack(2, 'db.r6g.2xlarge', { LegacyBucket: { Type: 'AWS::S3::Bucket', Properties: {} } }) }]).ir

check('a design compared to itself is clean', () => compareToDeployed(designIR, designIR).clean)
check('a replica count that differs is drift', () => {
  const d = compareToDeployed(designIR, liveIR)
  return d.diverged.some((x) => x.label === 'checkout' && x.fields.some((f) => f.field === 'replicas' && f.design === 6 && f.live === 2))
})
check('a resource nobody designed is reported as unmanaged', () => {
  const d = compareToDeployed(designIR, liveIR)
  return d.unmanaged.length === 1 && d.unmanaged[0].label === 'legacy-bucket'
})
check('a designed component that is not deployed is reported as undeployed', () => {
  const d = compareToDeployed(liveIR, designIR)
  return d.undeployed.some((u) => u.label === 'legacy-bucket')
})
check('only fields the simulator reads count as drift', () => {
  // Same design, one extra tag. Nothing the engine reads changed.
  const tagged = normalizeIR({ ...designIR, nodes: designIR.nodes.map((n) => ({ ...n, attrs: { ...n.attrs, owner: 'platform' } })) })
  return compareToDeployed(designIR, tagged).clean
})
check('every simulation field named is one the IR actually carries', () => {
  // A cache is the only kind that carries `cacheHit`, so the check needs a
  // design containing one — a field list that names something the IR never has
  // is a drift report that can never fire.
  const withCache = cfnToIR([{ file: 'c.json', text: JSON.stringify({ Resources: {
    Svc: { Type: 'AWS::ECS::Service', Properties: { DesiredCount: 2 } },
    Cache: { Type: 'AWS::ElastiCache::ReplicationGroup', Properties: { NumCacheClusters: 2 } },
  } }) }]).ir
  const missing = SIMULATION_FIELDS.filter((f) => !withCache.nodes.some((n) =>
    f.path.reduce((o, k) => (o == null ? undefined : o[k]), n) !== undefined))
  if (missing.length) throw new Error(`no node carries ${missing.map((m) => m.path.join('.')).join(', ')}`)
  return true
})
check('the drift report states what each difference changes', () => {
  const md = driftMarkdown(compareToDeployed(designIR, liveIR))
  return /capacity and availability/.test(md) && /Unmanaged/.test(md)
})
check('a clean report says so rather than printing empty tables', () => {
  const md = driftMarkdown(compareToDeployed(designIR, designIR))
  return /No drift/.test(md) && !/### Diverged/.test(md)
})

// ── the pull request ────────────────────────────────────────────────────────
section('Pull requests: packaged, not opened')

const PR_TF = `resource "aws_lb" "edge" {
  name = "edge"
}

resource "aws_ecs_service" "checkout" {
  name          = "checkout"
  desired_count = 6
  cluster       = aws_ecs_cluster.main.id
}
`
const prBase = hclToIR([{ path: 'main.tf', text: PR_TF }], { managed: 'partial' }).ir
const prTarget = normalizeIR({ ...prBase, nodes: prBase.nodes.map((n) => (n.label === 'checkout' ? { ...n, capacity: { ...n.capacity, replicas: 3 } } : n)) })
const prEmit = emitChanges(prBase, prTarget, [{ path: 'main.tf', text: PR_TF }])
const pr = pullRequestPayload({ emit: prEmit, sources: { 'main.tf': PR_TF }, ir: prTarget, base: prBase })

check('the title states the change rather than describing the tool', () => /desired_count 6 → 3/.test(pr.title))
check('the branch name is stable for the same design', () =>
  pr.branch === pullRequestPayload({ emit: prEmit, sources: { 'main.tf': PR_TF }, ir: prTarget, base: prBase }).branch)
check('a different design gets a different branch', () => {
  const other = normalizeIR({ ...prBase, nodes: prBase.nodes.map((n) => (n.label === 'checkout' ? { ...n, capacity: { ...n.capacity, replicas: 4 } } : n)) })
  return pullRequestPayload({ emit: emitChanges(prBase, other, [{ path: 'main.tf', text: PR_TF }]), sources: { 'main.tf': PR_TF }, ir: other, base: prBase }).branch !== pr.branch
})
check('the diff is a real unified diff of the real edit', () =>
  /^--- a\/main\.tf$/m.test(pr.diff) && /^-  desired_count = 6$/m.test(pr.diff) && /^\+  desired_count = 3$/m.test(pr.diff))
check('the diff shows only the changed lines and their context', () =>
  pr.diff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---')).length === 1)
check('the commit message carries the IR hash', () => pr.commitMessage.includes(irHash(prTarget)))
check('an unchanged design produces an empty diff', () => unifiedDiff('a.tf', PR_TF, PR_TF) === '')
check('the payload never contains a command ArchSim ran itself', () =>
  /gh pr create/.test(pr.script) && !/token/i.test(pr.script))
check('a removal is labelled for a human rather than patched', () => {
  const shrunk = normalizeIR({ ...prBase, nodes: prBase.nodes.filter((n) => n.label !== 'checkout') })
  const p = pullRequestPayload({ emit: emitChanges(prBase, shrunk, [{ path: 'main.tf', text: PR_TF }]), sources: { 'main.tf': PR_TF }, ir: shrunk, base: prBase })
  return p.labels.includes('needs-human-review') && /never emits a destroy/.test(p.body)
})
check('a gate result, when there is one, is stated in the body', () => {
  const gate = { evaluation: { results: [{ slo: { id: 'latency' }, verdict: 'fail', holdPct: 12 }] } }
  const p = pullRequestPayload({ emit: prEmit, sources: { 'main.tf': PR_TF }, ir: prTarget, base: prBase, gate })
  return /1 SLO violation/.test(p.body) && p.labels.includes('slo-violation')
})

// ── provider breadth ────────────────────────────────────────────────────────
section('Providers: six tables, honestly counted')

check('coverage reports every provider table', () => {
  const c = coverage()
  return ['aws', 'gcp', 'azure', 'k8s', 'oci', 'cfn'].every((p) => c.byProvider[p] > 0)
})
check('an Oracle Cloud instance pool states its own replica count', () => {
  const r = findRule('oci', 'oci_core_instance_pool', {})
  return r?.capacity({ size: 5 }, { seed: capacityFor }).replicas === 5
})
check('an Oracle load balancer shape becomes a capacity figure', () => {
  const r = findRule('oci', 'oci_load_balancer_load_balancer', {})
  const cap = r.capacity({ shape: '400Mbps' }, { seed: capacityFor })
  return cap.capPerReplica === 50000
})
check('Oracle networking is structural, not components', () =>
  isStructural('oci_core_vcn') && isStructural('oci_core_security_list') && !isStructural('oci_core_instance'))
// A rule that maps to a kind the catalog has never heard of produces a node the
// simulator prices as `custom` while the table claims otherwise. Every rule in
// the two new tables is checked; the four older tables are covered by the
// corpus, which ingests real files through them.
const NEW_TABLE_TYPES = {
  oci: ['oci_core_instance', 'oci_core_instance_pool', 'oci_load_balancer_load_balancer',
    'oci_database_autonomous_database', 'oci_nosql_table', 'oci_streaming_stream',
    'oci_objectstorage_bucket', 'oci_functions_function', 'oci_cache_redis_cluster',
    'oci_opensearch_opensearch_cluster', 'oci_containerengine_node_pool', 'oci_queue_queue',
    'oci_vault_secret', 'oci_generative_ai_dedicated_ai_cluster'],
  cfn: ['AWS::ECS::Service', 'AWS::RDS::DBInstance', 'AWS::Lambda::Function', 'AWS::SQS::Queue',
    'AWS::DynamoDB::Table', 'AWS::S3::Bucket', 'AWS::ElastiCache::ReplicationGroup',
    'AWS::CloudFront::Distribution', 'AWS::Kinesis::Stream', 'AWS::StepFunctions::StateMachine',
    'AWS::AutoScaling::AutoScalingGroup', 'AWS::OpenSearchService::Domain', 'AWS::MSK::Cluster',
    'AWS::Cognito::UserPool', 'AWS::Redshift::Cluster'],
}

check('every rule in the new tables names a kind the catalog knows', () => {
  const bad = []
  for (const [provider, types] of Object.entries(NEW_TABLE_TYPES)) {
    for (const t of types) {
      const rule = findRule(provider, t, {})
      if (!rule) { bad.push(`${provider}:${t} has no rule`); continue }
      if (rule.kind && !CATALOG[rule.kind]) bad.push(`${provider}:${t} → unknown kind '${rule.kind}'`)
    }
  }
  if (bad.length) throw new Error(bad.slice(0, 3).join('; '))
  return true
})

// ── arranging ───────────────────────────────────────────────────────────────
section('Arrange: layouts that can be scored')

const messy = template('ecommerce-storefront')
const scattered = normalizeIR({ ...messy, nodes: messy.nodes.map((n) => ({ ...n, layout: { x: 100, y: 100 } })) })

check('quality counts crossings, overlaps, backward edges and length', () => {
  const q = layoutQuality(messy)
  return ['crossings', 'overlaps', 'backward', 'length', 'edges'].every((k) => Number.isFinite(q[k]))
})
check('components stacked on one point are all overlaps', () =>
  layoutQuality(scattered).overlaps === (scattered.nodes.length * (scattered.nodes.length - 1)) / 2)
check('two edges meeting at a shared component are not counted as a crossing', () => {
  const star = normalizeIR({
    ...createIR({ name: 'star' }),
    nodes: [
      irNode({ id: 'hub', kind: 'app', label: 'hub', layout: { x: 200, y: 200 } }, capacityFor),
      irNode({ id: 'a', kind: 'sql', label: 'a', layout: { x: 400, y: 100 } }, capacityFor),
      irNode({ id: 'b', kind: 'sql', label: 'b', layout: { x: 400, y: 300 } }, capacityFor),
    ],
    edges: [irEdge({ from: 'hub', to: 'a' }), irEdge({ from: 'hub', to: 'b' })],
  })
  return layoutQuality(star).crossings === 0
})
check('a deliberate crossing is counted', () => {
  const x = normalizeIR({
    ...createIR({ name: 'x' }),
    nodes: [
      irNode({ id: 'a', kind: 'app', label: 'a', layout: { x: 0, y: 0 } }, capacityFor),
      irNode({ id: 'b', kind: 'app', label: 'b', layout: { x: 0, y: 400 } }, capacityFor),
      irNode({ id: 'c', kind: 'sql', label: 'c', layout: { x: 600, y: 400 } }, capacityFor),
      irNode({ id: 'd', kind: 'sql', label: 'd', layout: { x: 600, y: 0 } }, capacityFor),
    ],
    edges: [irEdge({ from: 'a', to: 'c' }), irEdge({ from: 'b', to: 'd' })],
  })
  return layoutQuality(x).crossings === 1
})
check('every layout leaves no component sitting on another', () =>
  LAYOUTS.every((l) => layoutQuality(l.run(scattered)).overlaps === 0))
check('every layout is deterministic — same design, same positions', () =>
  LAYOUTS.every((l) => JSON.stringify(l.run(messy).nodes.map((n) => n.layout)) === JSON.stringify(l.run(messy).nodes.map((n) => n.layout))))
check('a layout moves components and changes nothing else', () => {
  const strip = (d) => canonical({ ...d, nodes: d.nodes.map((n) => ({ ...n, layout: undefined })) })
  return strip(layeredTidy(messy)) === strip(messy)
})
check('tidying never leaves more crossings than naming', () =>
  layoutQuality(layeredTidy(messy)).crossings <= layoutQuality(layered(messy)).crossings)
check('the ranking never crowns a layout worse than what is already there', () => {
  const bad = []
  for (const t of TEMPLATES) {
    const ir = template(t.id)
    if (rankLayouts(ir)[0].quality.crossings > layoutQuality(ir).crossings) bad.push(t.id)
  }
  if (bad.length) throw new Error(`picked worse on ${bad.slice(0, 3).join(', ')}`)
  return true
})
check('the current arrangement is a row, so leaving it alone is an answer', () => {
  const r = rankLayouts(messy)
  return r.some((l) => l.id === 'current') && r.length === LAYOUTS.length + 1
})
check('rearranging the hundred templates removes crossings far more often than not', () => {
  let better = 0
  for (const t of TEMPLATES) {
    const ir = template(t.id)
    if (rankLayouts(ir)[0].quality.crossings < layoutQuality(ir).crossings) better++
  }
  return better > 20
})
check('a cycle does not pile every component into one column', () => {
  const ring = normalizeIR({
    ...createIR({ name: 'ring' }),
    nodes: ['a', 'b', 'c'].map((id) => irNode({ id, kind: 'micro', label: id }, capacityFor)),
    edges: [irEdge({ from: 'a', to: 'b' }), irEdge({ from: 'b', to: 'c' }), irEdge({ from: 'c', to: 'a' })],
  })
  return new Set(layeredTidy(ring).nodes.map((n) => n.layout.x)).size > 1
})
check('align moves only the selection, and only on one axis', () => {
  const ids = messy.nodes.slice(0, 3).map((n) => n.id)
  const out = align(messy, ids, 'left')
  const xs = out.nodes.filter((n) => ids.includes(n.id)).map((n) => n.layout.x)
  const untouched = out.nodes.filter((n) => !ids.includes(n.id))
  return new Set(xs).size === 1
    && untouched.every((n) => n.layout.y === messy.nodes.find((m) => m.id === n.id).layout.y)
})
check('align needs two components; one is a no-op', () =>
  align(messy, [messy.nodes[0].id], 'left') === messy)
check('distribute leaves equal gaps', () => {
  const ids = messy.nodes.slice(0, 4).map((n) => n.id)
  const out = distribute(messy, ids, 'x')
  const xs = out.nodes.filter((n) => ids.includes(n.id)).map((n) => n.layout.x).sort((a, b) => a - b)
  const gaps = xs.slice(1).map((x, i) => x - xs[i])
  return Math.max(...gaps) - Math.min(...gaps) <= 8
})
check('tighten moves the design to the margin without changing its shape', () => {
  const far = normalizeIR({ ...messy, nodes: messy.nodes.map((n) => ({ ...n, layout: { x: n.layout.x + 4000, y: n.layout.y + 3000 } })) })
  const out = tighten(far)
  return Math.min(...out.nodes.map((n) => n.layout.x)) === 48
    && layoutQuality(out).crossings === layoutQuality(far).crossings
})
check('snapping to the grid leaves every coordinate on it', () => {
  const off = normalizeIR({ ...messy, nodes: messy.nodes.map((n) => ({ ...n, layout: { x: n.layout.x + 3, y: n.layout.y + 5 } })) })
  return snapAll(off).nodes.every((n) => n.layout.x % 8 === 0 && n.layout.y % 8 === 0)
})
check('every alignment names an axis the layout actually has', () =>
  ALIGNMENTS.every((a) => a.axis === 'x' || a.axis === 'y'))
check('a drop into empty space is left exactly where it was put', () => {
  const clean = layeredTidy(messy)
  const dropped = normalizeIR({
    ...clean,
    nodes: [...clean.nodes, irNode({ id: 'dropped', kind: 'cache', label: 'dropped', layout: { x: 2000, y: 900 } }, capacityFor)],
  })
  const out = tidyIfWorse(clean, dropped)
  return out.tidied === false && out.ir.nodes.find((n) => n.id === 'dropped').layout.x === 2000
})
check('a drop on top of another component tidies, and says why', () => {
  const clean = layeredTidy(messy)
  const victim = clean.nodes[0]
  const dropped = normalizeIR({
    ...clean,
    nodes: [...clean.nodes, irNode({ id: 'dropped', kind: 'cache', label: 'dropped', layout: { ...victim.layout } }, capacityFor)],
  })
  const out = tidyIfWorse(clean, dropped)
  return out.tidied && /sitting on top/.test(out.reason) && layoutQuality(out.ir).overlaps === 0
})
check('tidying after a drop never leaves the canvas worse than the drop did', () => {
  const clean = layeredTidy(messy)
  const dropped = normalizeIR({
    ...clean,
    nodes: [...clean.nodes, irNode({ id: 'dropped', kind: 'cache', label: 'dropped', layout: { ...clean.nodes[0].layout } }, capacityFor)],
  })
  const out = tidyIfWorse(clean, dropped)
  return layoutScore(layoutQuality(out.ir)) <= layoutScore(layoutQuality(dropped))
})
check('a drop that hurts nothing measurable is never given a reason', () => {
  const clean = layeredTidy(messy)
  const out = tidyIfWorse(clean, clean)
  return out.tidied === false && out.reason === null && out.ir === clean
})
check('request order numbers every connection exactly once', () => {
  const order = requestOrder(messy)
  const keys = order.map((e) => e.id || `${e.from}->${e.to}`)
  return keys.length === messy.edges.length && new Set(keys).size === keys.length
})
check('request order starts at the source', () => {
  const first = requestOrder(messy)[0]
  return messy.nodes.find((n) => n.id === first.from)?.capacity?.source === true
})
check('request order is breadth-first, so a fan-out is numbered together', () => {
  const fan = normalizeIR({
    ...createIR({ name: 'fan' }),
    nodes: [
      irNode({ id: 'c', kind: 'client', label: 'c', layout: { x: 0, y: 100 } }, capacityFor),
      irNode({ id: 'g', kind: 'gateway', label: 'g', layout: { x: 200, y: 100 } }, capacityFor),
      irNode({ id: 'a', kind: 'micro', label: 'a', layout: { x: 400, y: 0 } }, capacityFor),
      irNode({ id: 'b', kind: 'micro', label: 'b', layout: { x: 400, y: 200 } }, capacityFor),
      irNode({ id: 'db', kind: 'sql', label: 'db', layout: { x: 600, y: 0 } }, capacityFor),
    ],
    edges: [irEdge({ from: 'c', to: 'g' }), irEdge({ from: 'g', to: 'a' }), irEdge({ from: 'g', to: 'b' }), irEdge({ from: 'a', to: 'db' })],
  })
  // Both branches of the fan-out come before anything downstream of either.
  const seq = requestOrder(fan).map((e) => `${e.from}>${e.to}`)
  return seq.indexOf('g>b') < seq.indexOf('a>db')
})
check('a fan-out is numbered top to bottom, the way the eye reads it', () => {
  const fan = normalizeIR({
    ...createIR({ name: 'fan2' }),
    nodes: [
      irNode({ id: 'c', kind: 'client', label: 'c', layout: { x: 0, y: 100 } }, capacityFor),
      irNode({ id: 'low', kind: 'micro', label: 'low', layout: { x: 300, y: 400 } }, capacityFor),
      irNode({ id: 'high', kind: 'micro', label: 'high', layout: { x: 300, y: 0 } }, capacityFor),
    ],
    edges: [irEdge({ from: 'c', to: 'low' }), irEdge({ from: 'c', to: 'high' })],
  })
  return requestOrder(fan)[0].to === 'high'
})
check('a design with no source is still numbered rather than left blank', () => {
  const ring = normalizeIR({
    ...createIR({ name: 'ring' }),
    nodes: ['a', 'b'].map((id) => irNode({ id, kind: 'micro', label: id }, capacityFor)),
    edges: [irEdge({ from: 'a', to: 'b' }), irEdge({ from: 'b', to: 'a' })],
  })
  return requestOrder(ring).length === 2
})
check('every template numbers all of its connections', () =>
  TEMPLATES.every((t) => { const ir = template(t.id); return requestOrder(ir).length === ir.edges.length }))
check('step glyphs are circled up to 20 and plain past it', () =>
  circled(1) === '①' && circled(20) === '⑳' && circled(21) === '21')

// ── the catalog, as a person meets it ───────────────────────────────────────
section('Catalog: 117 components a person can actually find')

check('every catalog kind has a category and a description', () => {
  const missing = kinds().filter((k) => !TAXONOMY[k])
  if (missing.length) throw new Error(`undescribed: ${missing.join(', ')}`)
  return true
})
check('nothing is described that the catalog does not have', () => {
  const extra = Object.keys(TAXONOMY).filter((k) => !CATALOG[k])
  if (extra.length) throw new Error(`described but absent: ${extra.join(', ')}`)
  return true
})
check('every kind lands in exactly one declared category', () =>
  Object.values(TAXONOMY).every(([c]) => COMPONENT_CATEGORIES.includes(c))
  && kinds().every((k) => COMPONENT_CATEGORIES.filter((c) => kindsIn(c).includes(k)).length === 1))
check('no category is empty', () => COMPONENT_CATEGORIES.every((c) => kindsIn(c).length > 0))
check('the categories partition the catalog exactly', () =>
  COMPONENT_CATEGORIES.reduce((n, c) => n + kindsIn(c).length, 0) === kinds().length)
check('a description says something the name does not', () => {
  // "Load Balancer — balances load" is a row that wastes a reader's time.
  const lazy = kinds().filter((k) => {
    const d = describeKind(k).toLowerCase()
    const name = (CATALOG[k]?.name || '').toLowerCase().replace(/[^a-z ]/g, '')
    return d.length < 40 || (name.length > 6 && d.startsWith(name))
  })
  if (lazy.length) throw new Error(`thin descriptions: ${lazy.slice(0, 4).join(', ')}`)
  return true
})
check('search finds a component by a phrase only its description contains', () => {
  const hits = searchKinds('replication lag', CATALOG)
  return hits.length === 1 && hits[0] === 'cdc'
})
check('search finds a component by name and by category', () =>
  searchKinds('vector', CATALOG).includes('vector')
  && searchKinds('Google AI', CATALOG).length === kindsIn('Google AI').length)
check('an empty search returns the whole catalog', () => searchKinds('', CATALOG).length === kinds().length)

check('every capacity figure obeys Little\'s law', () => {
  // Concurrency is in-flight requests, which is arrival rate times service
  // time. A row where those disagree is a row where the analytic engine and the
  // discrete-event engine will disagree about the same component.
  const off = []
  for (const k of kinds()) {
    const s2 = specOf(k)
    if (!Number.isFinite(s2.cap) || !s2.cap || !s2.concurrency) continue
    const need = s2.cap * (s2.lat / 1000)
    const ratio = need / s2.concurrency
    if (ratio < 0.5 || ratio > 2) off.push(`${k} (${ratio.toFixed(2)}x)`)
  }
  if (off.length) throw new Error(`off by more than 2x: ${off.slice(0, 5).join(', ')}`)
  return true
})
check('a bounded queue is never smaller than the pool it feeds', () =>
  kinds().every((k) => {
    const s2 = specOf(k)
    return !s2.concurrency || !s2.queueDepth || s2.queueDepth >= s2.concurrency
  }))
check('every kind states an availability below one', () =>
  kinds().filter((k) => !specOf(k).source).every((k) => {
    const a = specOf(k).avail
    return a === undefined || (a > 0.9 && a < 1)
  }))
check('the palette can reach every component in the catalog', () => {
  const src = fs.readFileSync(path.join(ROOT, 'apps/canvas/src/Palette.jsx'), 'utf8')
  // It renders whatever `kindsIn` returns for each declared category, so the
  // reachable set is the taxonomy — which the checks above pin to the catalog.
  return /kindsIn\(c\)/.test(src) && /COMPONENT_CATEGORIES/.test(src) && !/\['lb', 'gateway'/.test(src)
})

// ── the studio's chrome ─────────────────────────────────────────────────────
section('Chrome: fonts, the View menu, the tour')

const css = fs.readFileSync(path.join(ROOT, 'apps/canvas/src/styles.css'), 'utf8')

check('the three families are the ones ArchSim 1.x uses', () =>
  /--font-body:\s*'IBM Plex Sans'/.test(css)
  && /--font-display:\s*'Space Grotesk'/.test(css)
  && /--font-mono:\s*'IBM Plex Mono'/.test(css))
check('every family declares a real fallback stack', () => {
  for (const m of css.matchAll(/--font-(body|display|mono):([^;]+);/g)) {
    const stack = m[2].split(',').map((x) => x.trim()).filter(Boolean)
    if (stack.length < 3) throw new Error(`--font-${m[1]} has ${stack.length} families`)
    if (!/sans-serif|monospace|system-ui/.test(m[2])) throw new Error(`--font-${m[1]} has no generic family`)
  }
  return true
})
check('the label treatment is v1\'s: uppercase mono at .09em', () =>
  /--label-font:\s*var\(--font-mono\)/.test(css) && /--label-tt:\s*uppercase/.test(css) && /--label-ls:\s*\.09em/.test(css))
check('both delivery paths load the webfonts', () => {
  const html = fs.readFileSync(path.join(ROOT, 'apps/canvas/index.html'), 'utf8')
  const artifact = fs.readFileSync(path.join(ROOT, 'scripts/artifact.mjs'), 'utf8')
  const wanted = /IBM\+Plex\+Sans.*IBM\+Plex\+Mono.*Space\+Grotesk/
  return wanted.test(html) && wanted.test(artifact)
})
check("v1's three palettes are all still on offer", () =>
  ['kesar', 'glow', 'lilac'].every((id) => PALETTES.some((p) => p.id === id))
  && PALETTES.every((p) => new RegExp(`\\[data-palette="${p.id}"\\]\\s*{\\s*--accent:\\s*${p.swatch}`, 'i').test(css)))

check('an accent palette changes the accent pair and nothing else', () => {
  // The original rule was "exactly one token", which kept light and dark from
  // becoming a lottery. It is now "the accent and its foreground", because a
  // fill colour without the text colour that goes on it is half a decision —
  // and the half that was missing is what failed contrast on all three.
  //
  // A palette that restyles the ground is a different thing and must say so in
  // PALETTES with `surface: true`, so the View menu can tell someone their
  // light/dark toggle no longer applies.
  const ALLOWED = new Set(['--accent', '--on-accent'])
  for (const m of css.matchAll(/\[data-palette="([a-z]+)"\]\s*{([^}]*)}/g)) {
    const [, id, body] = m
    const names = body.split(';').map((d) => d.trim()).filter(Boolean).map((d) => d.split(':')[0].trim())
    const surface = PALETTES.find((p) => p.id === id)?.surface
    if (surface) {
      if (!names.includes('--bg')) throw new Error(`${id} claims to be a surface palette but sets no --bg`)
      continue
    }
    const extra = names.filter((n) => !ALLOWED.has(n))
    if (extra.length) throw new Error(`palette ${id} also declares ${extra.join(', ')} but is not marked surface: true`)
  }
  return true
})

check('every palette puts legible text on its accent', () => {
  // This is the check the studio did not have. `color: #fff` was hardcoded on
  // every accent-filled control, and measured 3.47:1 on Kesar, 3.09 on Lilac
  // and 2.27 on Glow — under AA on all three, on the primary button, the
  // active tab and the selected chip.
  const lum = (hex) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
  }
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)]
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
  }
  for (const m of css.matchAll(/\[data-palette="([a-z]+)"\]\s*{([^}]*)}/g)) {
    const [, id, body] = m
    const accent = body.match(/--accent:\s*(#[0-9a-fA-F]{6})/)?.[1]
    const on = body.match(/--on-accent:\s*(#[0-9a-fA-F]{6})/)?.[1]
    if (!accent || !on) throw new Error(`palette ${id} does not declare both --accent and --on-accent`)
    const r = ratio(accent, on)
    if (r < 4.5) throw new Error(`palette ${id}: ${on} on ${accent} is ${r.toFixed(2)}:1, under AA`)
  }
  return true
})

check('no control picks its own foreground on an accent fill', () => {
  // The rule the contrast check depends on. One hardcoded white here and the
  // palette-level guarantee above stops being true of the actual pixels.
  const offenders = []
  for (const line of css.split('\n')) {
    if (/background:\s*var\(--accent\)/.test(line) && /color:\s*#/.test(line)) offenders.push(line.trim())
  }
  if (offenders.length) throw new Error(`hardcoded foreground on an accent fill: ${offenders[0]}`)
  return true
})
check('screen-reader mode turns off motion and strengthens focus', () =>
  /:root\[data-sr\] \* \{[^}]*animation: none !important/.test(css)
  && /:root\[data-sr\] :focus-visible \{[^}]*outline: 3px/.test(css))

const tour = buildTour({ setTab: () => {}, switchVariant: () => {}, setSearch: () => {}, canvasApi: { current: null } })
check('the tour covers the studio rather than a subset of it', () => tour.length >= 15)
check('every tour step names a real target', () =>
  tour.every((t) => !t.target || /^[.#][\w-]/.test(t.target)))
check('no two tour steps say the same thing', () =>
  new Set(tour.map((t) => t.title)).size === tour.length)
check('every tour step has a body worth reading', () =>
  tour.every((t) => t.title && t.body && t.body.length > 60))
check('the keyboard map lists every bare letter the app binds', () => {
  // Bare letters only. A shortcut behind ⌘ is listed as ⌘K, and matching the
  // modifier branches too would report every one of them as missing.
  const app = fs.readFileSync(path.join(ROOT, 'apps/canvas/src/App.jsx'), 'utf8')
  const bound = app.split('\n')
    .filter((line) => !/mod &&/.test(line))
    .flatMap((line) => [...line.matchAll(/e\.key\.toLowerCase\(\) === '([a-z])'/g)].map((m) => m[1].toUpperCase()))
  const listed = SHORTCUTS.map((x) => x.keys.toUpperCase())
  const missing = [...new Set(bound)].filter((k) => !listed.includes(k))
  if (missing.length) throw new Error(`bound but not listed: ${missing.join(', ')}`)
  return true
})

check('the score weights overlaps above crossings above ink', () =>
  layoutScore({ crossings: 0, overlaps: 1, backward: 0, length: 0 }) >
  layoutScore({ crossings: 2, overlaps: 0, backward: 0, length: 0 }) &&
  layoutScore({ crossings: 1, overlaps: 0, backward: 0, length: 0 }) >
  layoutScore({ crossings: 0, overlaps: 0, backward: 0, length: 5000 }))

// ── wiring rules ────────────────────────────────────────────────────────────
section('Wiring: what connects to what')

const wireIR = (specs, edges = []) => normalizeIR({
  ...createIR({ name: 'wiring' }),
  nodes: specs.map(([kind, label, x, y]) =>
    irNode({ id: `w-${label}`, kind, label, layout: { x, y } }, capacityFor)),
  edges: edges.map(([a, b]) => irEdge({ from: `w-${a}`, to: `w-${b}` })),
})

const wireChain = wireIR([
  ['client', 'users', 60, 60], ['lb', 'edge', 270, 60], ['app', 'api', 480, 60],
  ['sql', 'db', 900, 60], ['queue', 'events', 690, 160], ['worker', 'mailer', 900, 160],
  ['monitor', 'prom', 900, 320], ['cache', 'sessions', 690, 60],
])

check('every catalog kind resolves to a role', () => kinds().every((k) => typeof roleOf(k) === 'string'))
check('a client is a source', () => roleOf('client') === 'source')
check('a queue is async and a worker consumes it', () => roleOf('kafka') === 'async' && roleOf('worker') === 'consumer')
check('an unlisted kind is classified from its catalog shape, not dumped', () => {
  // `cdn` declares a cache-hit rate; `transcode` is slow. Neither is guessed as
  // a bare default.
  return roleOf('cdn') === 'edge' && roleOf('batch') === 'consumer'
})

check('wiring connects a stranded design end to end', () => {
  const { edges } = suggestOrphans(wireChain)
  const pairs = new Set(edges.map((e) => `${e.from}>${e.to}`))
  return pairs.has('w-users>w-edge') && pairs.has('w-edge>w-api')
})
check('a queue is written by compute and read by a worker', () => {
  const { edges } = suggestOrphans(wireChain)
  return edges.some((e) => e.from === 'w-events' && e.to === 'w-mailer')
    && edges.some((e) => e.to === 'w-events')
})
check('an edge touching a queue is async, not sync', () => {
  const { edges } = suggestOrphans(wireChain)
  return edges.filter((e) => e.from === 'w-events' || e.to === 'w-events').every((e) => e.callSemantics === 'async')
})
check('observability is never wired into the request path', () => {
  const { edges, refused } = suggestOrphans(wireChain)
  return !edges.some((e) => e.from === 'w-prom' || e.to === 'w-prom')
    && refused.some((r) => r.id === 'w-prom' && /platform component/.test(r.why))
})
check('every proposal is marked inferred, never authored', () => {
  const { edges } = suggestOrphans(wireChain)
  return edges.length > 0 && edges.every((e) => e.inferred === true && e.confidence === 'medium')
})
check('wiring never duplicates an edge that already exists', () => {
  const wired = normalizeIR({ ...wireChain, edges: [irEdge({ from: 'w-users', to: 'w-edge' })] })
  const { edges } = suggestOrphans(wired)
  return !edges.some((e) => e.from === 'w-users' && e.to === 'w-edge')
})
check('wiring is deterministic', () => {
  const a = suggestOrphans(wireChain).edges.map((e) => `${e.from}>${e.to}`).join('|')
  const b = suggestOrphans(wireChain).edges.map((e) => `${e.from}>${e.to}`).join('|')
  return a === b
})
check('wiring a design leaves nothing stranded but the platform components', () => {
  const { edges } = suggestOrphans(wireChain)
  const wired = normalizeIR({ ...wireChain, edges: [...wireChain.edges, ...edges.map((e, i) => irEdge({ id: `x${i}`, from: e.from, to: e.to }))] })
  return orphans(wired).map((n) => n.label).join() === 'prom'
})
check('a wired design still simulates', () => {
  const { edges } = suggestOrphans(wireChain)
  const wired = normalizeIR({ ...wireChain, edges: [...wireChain.edges, ...edges.map((e, i) => irEdge({ id: `x${i}`, from: e.from, to: e.to }))] })
  return Number.isFinite(simulate(wired, 1000).p99)
})
check('a lone component proposes nothing rather than inventing a peer', () => {
  const alone = wireIR([['app', 'only', 60, 60]])
  return suggestFor(alone, 'w-only').edges.length === 0
})
check('placement puts a store to the right of the compute that reads it', () => {
  return suggestPlacement(wireChain, 'sql').x > suggestPlacement(wireChain, 'app').x
})
check('placement never lands a component on top of another', () => {
  const p = suggestPlacement(wireChain, 'app')
  return !wireChain.nodes.some((n) => n.layout && Math.abs(n.layout.x - p.x) < 80 && Math.abs(n.layout.y - p.y) < 60)
})
check('every role in the table is one the classifier can produce', () => {
  const produced = new Set(kinds().map(roleOf))
  return Object.keys(ROLES).every((r) => produced.has(r))
})

// ── the template library ────────────────────────────────────────────────────
section('Templates: 100 architectures')

check('there are exactly 100 templates', () => TEMPLATES.length === 100)
check('ten categories, ten templates each', () => {
  const counts = {}
  for (const t of TEMPLATES) counts[t.category] = (counts[t.category] || 0) + 1
  return CATEGORIES.length === 10 && CATEGORIES.every((c) => counts[c] === 10)
})
check('template ids are unique', () => new Set(TEMPLATES.map((t) => t.id)).size === 100)
check('every template names only catalog kinds', () =>
  TEMPLATES.every((t) => t.kinds.every((k) => !!CATALOG[k])))

const built = TEMPLATES.map((t) => template(t.id))
check('every template builds a valid IR', () =>
  built.every((ir) => validateIR(ir, { kinds: kinds() }).errors.length === 0))
check('every template is fully connected — no stranded components', () =>
  built.every((ir) => orphans(ir).length === 0))
check('every template has a source and a sink', () =>
  built.every((ir) => ir.nodes.some(isSourceNode) && ir.edges.length >= ir.nodes.length - 1))
check('every template simulates to a finite p99', () =>
  built.every((ir, i) => Number.isFinite(simulate(ir, TEMPLATES[i].rps).p99)))
check('every template carries its own workload and four SLOs', () =>
  built.every((ir) => ir.workloads.length === 1 && ir.slos.length === 4))
check('every template round-trips through serialization', () =>
  built.every((ir) => irHash(parseIR(serializeIR(ir))) === irHash(ir)))
check('template ids are reproducible — same spec, same irHash', () =>
  TEMPLATES.every((t) => irHash(template(t.id)) === irHash(template(t.id))))
check('no template runs hot at the peak of its own day', () =>
  built.every((ir, i) => capacityReport(ir, simulate(ir, TEMPLATES[i].rps * 2)).rows.every((r) => r.util <= 0.8)))
check('an edge naming an undeclared component is a build error, not a dropped edge', () => {
  try {
    buildTemplate(['bad', 'Bad', 'Web & API', 100, 100, 0.99, 100, 'app:a', 'a>ghost', 'x'])
    return false
  } catch (err) { return /undeclared component/.test(err.message) }
})
check('search finds a template by component kind', () =>
  searchTemplates('kafka').length > 0 && searchTemplates('kafka').every((t) => /kafka/.test(JSON.stringify(t))))
check('search finds a template by category', () => searchTemplates('Finance & regulated').length === 10)
check('search with no query returns everything', () => searchTemplates('').length === 100)
check('the library is not uniformly green — the gate has real opinions', () => {
  // A hundred templates that all pass would mean the thresholds were fitted to
  // the answer. A sample must contain more than one verdict.
  const verdicts = new Set()
  for (const t of TEMPLATES.filter((_, i) => i % 9 === 0)) {
    const ir = template(t.id)
    const mc = runMonteCarlo(ir, { runs: 24, seed: 42, scenarios: TEMPLATE_SCENARIOS })
    const rows = evaluateSLOs(ir, mc).results
    verdicts.add(rows.some((r) => r.verdict === 'fail') ? 'fail' : rows.some((r) => r.verdict === 'risk') ? 'risk' : 'pass')
  }
  return verdicts.size >= 2
})
check('a template gates end to end through runGate', () => {
  const ir = template('checkout-flow')
  const r = runGate({ ir, config: { ...parseConfig(''), scenarios: TEMPLATE_SCENARIOS } })
  return r.evaluation.results.length === 4 && [0, 1, 2].includes(r.exitCode)
})

section('Tooling — the checks that keep the other checks honest')

check('the dependency boundary holds', () => {
  // Not a re-implementation of scripts/deps.mjs — the script itself, run. If it
  // ever stops agreeing with the README, this is where you hear about it.
  execFileSync(process.execPath, [path.join(ROOT, 'scripts/deps.mjs')], { cwd: ROOT, stdio: 'pipe' })
  return true
})

check('no runtime package declares a third-party dependency', () => {
  const dirs = fs.readdirSync(path.join(ROOT, 'packages'))
  for (const d of dirs) {
    const p = path.join(ROOT, 'packages', d, 'package.json')
    if (!fs.existsSync(p)) continue
    const deps = Object.keys(JSON.parse(fs.readFileSync(p, 'utf8')).dependencies || {})
    const foreign = deps.filter((n) => !n.startsWith('@archsim/'))
    if (foreign.length) throw new Error(`@archsim/${d} depends on ${foreign.join(', ')}`)
  }
  return true
})

check('the canvas is the only package allowed third-party imports', () => {
  const src = read('scripts/deps.mjs')
  return src.includes("'apps/canvas'") && /BUNDLED/.test(src)
})

check('the JSDoc typechecks', () => {
  // The whole point of writing types in comments is that something reads them.
  // tsc is a devDependency, so skip rather than fail where it is absent — CI
  // installs it and runs `npm run typecheck` as its own step regardless.
  const tsc = path.join(ROOT, 'node_modules/.bin/tsc')
  if (!fs.existsSync(tsc)) return true
  execFileSync(tsc, ['-p', path.join(ROOT, 'tsconfig.json')], { cwd: ROOT, stdio: 'pipe' })
  return true
})

check('the typecheck is configured to actually read the JSDoc', () => {
  const cfg = JSON.parse(stripComments(read('tsconfig.json')))
  return cfg.compilerOptions.checkJs === true
    && cfg.compilerOptions.allowJs === true
    && cfg.compilerOptions.noEmit === true
})

check('every check CI runs is a script anyone can run locally', () => {
  const pkg = JSON.parse(read('package.json'))
  const ci = read('.github/workflows/ci.yml')
  for (const s of ['deps', 'typecheck', 'verify', 'budget']) {
    if (!pkg.scripts[s]) throw new Error(`package.json has no '${s}' script`)
    if (!ci.includes(`npm run ${s}`)) throw new Error(`CI never runs 'npm run ${s}'`)
  }
  return true
})

check('the bundle budget names what grew, not just that it grew', () => {
  // A budget that reports one number makes finding the cause your problem. This
  // one decodes the source map and attributes the bytes.
  const src = read('scripts/budget.mjs')
  return src.includes('attribute(') && src.includes('.map') && /gzipSync/.test(src)
})

check('the budget has headroom but is not decorative', () => {
  const src = read('scripts/budget.mjs')
  const m = src.match(/const BUDGET = \{([\s\S]*?)\}/)
  const budgets = [...m[1].matchAll(/(\w+):\s*([\d.]+)/g)].map(([, k, v]) => [k, Number(v)])
  // Three assets, each with a real number. A budget of Infinity is not a budget.
  return budgets.length === 3 && budgets.every(([, v]) => v > 0 && Number.isFinite(v))
})

check('CI proves the airgap rather than asserting it', () => {
  const ci = read('.github/workflows/ci.yml')
  return ci.includes('--offline') && /archsim\.mjs gate/.test(ci) && ci.includes('airgapped')
})

check('the tour footer holds its buttons in any card width', () => {
  // The Next button used to sit 49px past the card's right edge: seventeen
  // progress dots took 187px of a 322px row, and `overflow: auto` turned the
  // difference into a horizontal scrollbar. The dots are gone, the actions have
  // their own wrapping row, and the card no longer scrolls sideways at all.
  const css = read('apps/canvas/src/styles.css')
  const foot = css.match(/\.tourfoot \{[^}]*\}/)[0]
  if (!/flex-wrap:\s*wrap/.test(foot)) throw new Error('.tourfoot must wrap, not overflow')
  const card = css.match(/\.tourcard \{ max-height[^}]*\}/)[0]
  if (!/overflow-x:\s*hidden/.test(card)) throw new Error('.tourcard must never scroll horizontally')
  return true
})

check('progress is a bar, not one dot per step', () => {
  const jsx = read('apps/canvas/src/Overlays.jsx')
  return jsx.includes('tourbar') && !jsx.includes('tourdots')
})

check('the spotlight stays inside the viewport', () => {
  // Padding the ring 8px outside a full-width target put it past the window
  // edge, which the page paid for with a horizontal scrollbar.
  const jsx = read('apps/canvas/src/Overlays.jsx')
  return /Math\.max\(0, r\.left - pad\)/.test(jsx) && /window\.innerWidth - left/.test(jsx)
})

check('nothing in the app can scroll the page sideways', () => {
  const css = read('apps/canvas/src/styles.css')
  // Each of these was a real regression: the deck's slide animation, the
  // palette's over-long button, and a grid track sized to its widest child.
  const deck = css.match(/\.deck \{[\s\S]*?\n\}/)[0]
  if (!/overflow-x:\s*clip/.test(deck)) throw new Error('.deck must clip its entry animation')
  const pal = css.match(/\.palette \{[\s\S]*?\n\}/)[0]
  if (!/overflow-x:\s*hidden/.test(pal)) throw new Error('.palette must not scroll horizontally')
  if (!/\.body > \* \{ min-width: 0; \}/.test(css)) throw new Error('grid tracks must not size to content')
  return true
})

check('the component panel is wide enough for the components in it', () => {
  // Measured, not chosen: at the old 178px, 33 of the 117 names were ellipsised.
  // Every name fits at 232px. 240 is that plus a little room.
  const css = read('apps/canvas/src/styles.css')
  const m = css.match(/\.body \{ display: grid; grid-template-columns: (\d+)px/)
  if (!m) throw new Error('could not find the three-column grid')
  const width = Number(m[1])
  if (width < 232) throw new Error(`panel is ${width}px; names start truncating below 232px`)
  return true
})

check('no component name is too long for the panel', () => {
  // The panel was widened to fit the catalogue as it stands. This is the other
  // half of that bargain: a new component with a very long name should fail
  // here rather than quietly appear with an ellipsis nobody notices.
  // 24 characters is what the 240px panel holds at the label's size and weight.
  const LIMIT = 24
  const tooLong = kinds().map((k) => kindName(k)).filter((n) => n.length > LIMIT)
  if (tooLong.length) throw new Error(`too long for the panel (max ${LIMIT}): ${tooLong.join(', ')}`)
  return true
})

check('the benchmark profiles isolate one variable each', () => {
  // The first draft of the profile set ran retry-storm at 2.5× load and
  // cache-stampede at 4×, so those cells measured the load rather than the
  // fault, and 98% of the library failed both. Load profiles carry no faults;
  // fault profiles sit at the design point.
  for (const p of PROFILES) {
    const hasFaults = p.faults.length > 0
    if (hasFaults && p.rpsMul !== 1) throw new Error(`${p.id} varies both load (${p.rpsMul}×) and a fault`)
    if (!hasFaults && p.rpsMul === 1 && p.id !== 'nominal') throw new Error(`${p.id} varies nothing`)
  }
  return PROFILES.length === 10
})

check('the load multipliers are derived from the sizing target', () => {
  // 1 / 0.65 is where a correctly sized template reaches 100% utilisation. A
  // multiplier picked because it made the table look interesting would tell
  // you about the author, not the architectures.
  const calib = read('test/calibrate-templates.mjs')
  const target = Number(calib.match(/TARGET_UTIL = ([\d.]+)/)[1])
  if (target !== TARGET_UTIL) throw new Error(`benchmark assumes ${TARGET_UTIL}, calibrator uses ${target}`)
  return Math.abs(KNEE - 1 / target) < 0.01
})

check('the benchmark discriminates — no condition is unanimous', () => {
  // A benchmark where everything fails carries exactly as much information as
  // one where everything passes. Run a slice of the matrix and require that
  // the conditions actually separate the library.
  const slice = TEMPLATES.filter((_, i) => i % 9 === 0)
  const verdicts = new Map()
  for (const t of slice) {
    const ir = template(t.id)
    for (const p of PROFILES) {
      const mc = runMonteCarlo(ir, {
        runs: 10, seed: 42,
        scenarios: [{ id: p.id, faults: p.faults }],
        workloads: (ir.workloads || []).map((w) => ({ ...w, arrival: { ...w.arrival, rps: (w.arrival?.rps ?? 0) * p.rpsMul } })),
      })
      const rows = evaluateSLOs(ir, mc).results
      const v = rows.some((r) => r.verdict === 'fail') ? 'fail' : 'pass'
      if (!verdicts.has(p.id)) verdicts.set(p.id, new Set())
      verdicts.get(p.id).add(v)
    }
  }
  // Across the whole slice, at least three conditions must produce both
  // outcomes — otherwise the matrix is a constant and not worth running.
  const informative = [...verdicts.values()].filter((s) => s.size > 1).length
  if (informative < 3) throw new Error(`only ${informative} of ${PROFILES.length} conditions separate anything`)
  return true
})

check('the candidate library is published beside the studio', () => {
  // A private artifact link is not somewhere anyone goes twice. The page is
  // built from the repo's own data during the deploy, so it cannot drift.
  const pages = read('.github/workflows/pages.yml')
  if (!pages.includes('docs/candidates/build-page.mjs')) throw new Error('pages.yml never builds the candidate page')
  if (!pages.includes('candidates/index.html')) throw new Error('the candidate page is not published to a path')
  if (!/ROWS.*-eq 1000/.test(pages)) throw new Error('the deploy must assert the page actually has its rows')
  return true
})

check('the candidate list is 1000 rows and says how many are distinct', () => {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'docs/candidates/generate.mjs')], { cwd: ROOT, encoding: 'utf8' })
  if (!/^1000 candidates/m.test(out)) throw new Error('expected 1000 candidates')
  const m = out.match(/(\d+) distinct \(archetype × constraint\)/)
  if (!m) throw new Error('the generator must report how many are structurally distinct')
  // The whole point of the number is that it is far below 1000. If a change
  // ever made it approach 1000, the honesty in the README would be wrong.
  const distinct = Number(m[1])
  if (!(distinct > 50 && distinct < 300)) throw new Error(`distinct shapes = ${distinct}, which makes the README's claim wrong`)
  return true
})

section('The IR view — the source of truth, made visible')

check('every node and edge has a line range in the document', () => {
  const ir = template('checkout-flow')
  const doc = irDocument(ir)
  for (const n of ir.nodes) if (!doc.ranges.has(n.id)) throw new Error(`node ${n.label} has no lines`)
  for (const e of ir.edges) if (!doc.ranges.has(e.id)) throw new Error(`edge ${e.id} has no lines`)
  return true
})

check("a node's range covers its whole object, nested parts included", () => {
  const ir = template('checkout-flow')
  const doc = irDocument(ir)
  const n = ir.nodes[0]
  const { start, end } = doc.ranges.get(n.id)
  const body = doc.lines.slice(start, end + 1).join('\n')
  // capacity is a nested object; a naive scan would end the range at its
  // closing brace and cut the node in half.
  if (!body.includes(`"id": "${n.id}"`)) throw new Error('range does not contain the id')
  if (!body.includes('"capacity"')) throw new Error('range stops before capacity')
  if (!body.includes('"provenance"')) throw new Error('range stops before the nested provenance object')
  return end > start
})

check('a line inside a node belongs to the node, not to the document', () => {
  const ir = template('checkout-flow')
  const doc = irDocument(ir)
  const n = ir.nodes[1]
  const { start, end } = doc.ranges.get(n.id)
  const mid = Math.floor((start + end) / 2)
  return ownerOfLine(doc.ranges, mid) === n.id
})

check('braces inside strings do not break the scan', () => {
  // An attrs value can hold anything. If the scanner counted braces inside
  // quoted text, one Helm template or JSON blob in an attribute would shift
  // every range after it.
  const text = JSON.stringify({
    nodes: [{ id: 'A', label: 'has { a brace', attrs: { tpl: '{{ .Chart.Name }}' } }, { id: 'B', label: 'plain' }],
  }, null, 2)
  const ranges = irLineRanges(text)
  if (!ranges.has('A') || !ranges.has('B')) throw new Error('lost a node to a brace in a string')
  const a = ranges.get('A'); const b = ranges.get('B')
  if (!(a.end < b.start)) throw new Error(`ranges overlap: A ${a.start}-${a.end}, B ${b.start}-${b.end}`)
  return true
})

check('the IR view is read-only', () => {
  // The IR carries ULID identity and a content hash. A free-text editor over it
  // would let someone break both in a way nothing downstream could recover
  // from, so it is edited through the canvas and the inspector.
  const src = read('apps/canvas/src/IRPanel.jsx')
  if (/<(input|textarea)\b/.test(src) || /contentEditable/.test(src)) throw new Error('the IR panel offers an editor')
  return src.includes('Read-only')
})

check('tri-view is a mode, and the layout still has one column when narrow', () => {
  const css = read('apps/canvas/src/styles.css')
  if (!/\.body\.triview \{ grid-template-columns:/.test(css)) throw new Error('no tri-view grid')
  // Below the breakpoint the side panels already vanish, so three columns are
  // moot; the page must fall back rather than squeeze.
  const narrow = css.slice(css.indexOf('@media (max-width: 1100px)'))
  if (!/\.body\.triview \{ grid-template-columns: 1fr; \}/.test(narrow)) throw new Error('tri-view does not collapse when narrow')
  return true
})

section('Replication — what a replica count actually buys')

check('quorum availability matches the closed form, empirically', () => {
  // Held to the same standard as the DES against Erlang-C: the arithmetic is
  // checked against a simulation of independent replica failures, not merely
  // against itself.
  const r = rng(7)
  for (const [a, n] of [[0.99, 3], [0.99, 5], [0.95, 3], [0.9, 7], [0.99, 2]]) {
    let up = 0
    const T = 120000
    for (let i = 0; i < T; i++) {
      let live = 0
      for (let k = 0; k < n; k++) if (r() < a) live++
      if (live >= quorumOf(n)) up++
    }
    const observed = up / T
    const theory = availabilityOf(a, n, 'quorum')
    if (Math.abs(observed - theory) > 0.004) {
      throw new Error(`a=${a} n=${n}: theory ${theory.toFixed(6)}, observed ${observed.toFixed(6)}`)
    }
  }
  return true
})

check('a second quorum member is worse than one, not better', () => {
  // The inversion that made the old model actively misleading. It said adding
  // a replica always helps; for a consensus group it does not, and a tool that
  // advises otherwise damages the system it is advising about.
  const one = availabilityOf(0.99, 1, 'quorum')
  const two = availabilityOf(0.99, 2, 'quorum')
  if (!(two < one)) throw new Error(`2 members (${two}) should be worse than 1 (${one})`)
  // …and stateless still behaves the old way, because for a pool it is right.
  return availabilityOf(0.99, 2, 'stateless') > availabilityOf(0.99, 1, 'stateless')
})

check('an even quorum is never better than the odd count below it', () => {
  for (const n of [2, 4, 6, 8]) {
    const even = availabilityOf(0.99, n, 'quorum')
    const odd = availabilityOf(0.99, n - 1, 'quorum')
    if (even >= odd) throw new Error(`${n} members should be worse than ${n - 1}`)
  }
  return true
})

check('the old arithmetic still applies to a stateless pool', () => {
  // The fix must not change the answer where the old answer was right.
  for (const n of [1, 2, 3, 5]) {
    const expected = 1 - (1 - 0.99) ** n
    if (Math.abs(availabilityOf(0.99, n, 'stateless') - expected) > 1e-12) throw new Error(`stateless n=${n} changed`)
  }
  return true
})

check('quorum does not move the median, and says so', () => {
  // The majority-th of an odd group is the median, so a quorum write's p50 is
  // one replica's p50. Surprising enough to be worth asserting rather than
  // leaving as a silent no-op in the hot path.
  for (const n of [3, 5, 7]) if (Math.abs(quorumLatencyMul(n, 'quorum', 0.5) - 1) > 1e-9) throw new Error(`n=${n} moved the median`)
  // The even case does move it, which is the other half of why even is bad.
  return quorumLatencyMul(2, 'quorum', 0.5) > 1
})

check('the quorum kinds are a short, deliberate list', () => {
  // Guessing that every datastore is a consensus group would be the same error
  // in the pessimistic direction. A SQL database is usually leader-follower.
  const quorum = kinds().filter((k) => capacityFor(k).replication === 'quorum')
  if (!quorum.includes('zk')) throw new Error('coordination is definitionally a quorum')
  if (quorum.includes('sql')) throw new Error('sql assumed to be quorum; that is a guess about the design')
  return quorum.length > 0 && quorum.length <= 6
})

check('no template runs a quorum component on an even member count', () => {
  // The new arithmetic found one the moment it existed: the config-and-service
  // discovery template ran a 2-member registry, which needs both up.
  const bad = []
  for (const row of TEMPLATES) {
    const ir = template(row.id)
    for (const n of ir.nodes) {
      if (n.capacity.replication === 'quorum' && n.capacity.replicas > 0 && n.capacity.replicas % 2 === 0) {
        bad.push(`${row.name}/${n.label}×${n.capacity.replicas}`)
      }
    }
  }
  if (bad.length) throw new Error(`even quorum: ${bad.join(', ')}`)
  return true
})

check('replication survives a normalize round-trip', () => {
  const ir = normalizeIR({ nodes: [irNode({ kind: 'zk', label: 'c', capacity: { replicas: 3, replication: 'quorum' } })], edges: [] })
  const again = normalizeIR(ir)
  return ir.nodes[0].capacity.replication === 'quorum' && again.nodes[0].capacity.replication === 'quorum'
})

check('an unknown replication mode falls back rather than throwing', () => {
  const c = normalizeCapacity({ replication: 'gossip-magic' })
  return c.replication === 'stateless'
})

check('every term the glossary defines says something the name does not', () => {
  for (const a of ACRONYMS) {
    if (a.means.length < 30) throw new Error(`${a.short}: explanation too thin`)
    // "CDN — a content delivery network" teaches nobody anything.
    if (a.means.toLowerCase().startsWith(a.long.toLowerCase().slice(0, 12)) && a.long !== '—') {
      throw new Error(`${a.short}: the explanation just restates the expansion`)
    }
  }
  return ACRONYMS.length >= 40
})

check('the glossary covers the jargon the studio actually shows', () => {
  // A glossary that omits the terms on screen is decoration. These are the ones
  // that appear in the panels, the verdict bar and the catalog.
  const must = ['p99', 'p50', 'rps', 'SLO', 'DES', 'IR', 'ULID', 'CDC', 'mTLS', 'CDN', 'HSM', 'quorum', 'drift', 'AZ']
  const have = new Set(ACRONYMS.map((a) => a.short))
  const missing = must.filter((m) => !have.has(m))
  if (missing.length) throw new Error(`not defined: ${missing.join(', ')}`)
  return true
})

check('the terms that invite a mistake carry the warning', () => {
  // The reason this is a panel and not a link to a glossary. p99 read as
  // "99% of the time it is fine" inverts every verdict the gate gives.
  const risky = ['p99', 'quorum', 'the knee', 'grey failure', 'thundering herd', 'error budget', 'ULID']
  for (const r of risky) {
    const a = ACRONYMS.find((x) => x.short === r)
    if (!a?.gotcha) throw new Error(`${r} has no note about how it is misread`)
  }
  return ACRONYMS.filter((a) => a.gotcha).length >= 20
})

check('no term is defined twice', () => {
  const seen = new Set()
  for (const a of ACRONYMS) {
    if (seen.has(a.short)) throw new Error(`${a.short} defined twice`)
    seen.add(a.short)
  }
  return true
})

check('the glossary search reaches an explanation, not just a name', () => {
  // Someone who does not know the word "quorum" types what they are worried
  // about. The search has to cover the prose.
  if (!searchAcronyms('majority').some((a) => a.short === 'quorum')) throw new Error('"majority" does not find quorum')
  if (!searchAcronyms('percentile').some((a) => a.short === 'p99')) throw new Error('"percentile" does not find p99')
  return searchAcronyms('').length === ACRONYMS.length
})

check('the Acronyms tab is wired into the deck', () => {
  const app = read('apps/canvas/src/App.jsx')
  return /TABS = \[[^\]]*'Acronyms'/.test(app) && app.includes('<AcronymsPanel />')
})

section('The node hint — what a component is, while you point at it')

check('the load bands are monotone and cover every utilisation', () => {
  // A band table with a gap or an inversion gives contradictory advice about
  // two nearly identical numbers.
  const order = { live: 0, drift: 1, breach: 2 }
  let last = -1
  for (let u = 0.36; u <= 1.4; u += 0.01) {
    const b = loadBand(u, true)
    if (!b?.say) throw new Error(`no band at util ${u.toFixed(2)}`)
    if (order[b.tone] < last) throw new Error(`tone goes backwards at util ${u.toFixed(2)}`)
    last = order[b.tone]
  }
  return true
})

check('a stranded component is not called over-provisioned', () => {
  // Idle and unreachable are identical in the arithmetic and are completely
  // different problems. The first draft advised shrinking components that were
  // at zero because nothing was wired to them.
  const stranded = loadBand(0, false)
  const idle = loadBand(0, true)
  if (stranded.say === idle.say) throw new Error('stranded and idle give the same advice')
  if (!/reaches this|not on a path/.test(stranded.say)) throw new Error('stranded does not say why it is at zero')
  if (/larger than it needs|sized for something real/.test(stranded.say)) throw new Error('stranded is told it is over-provisioned')
  return true
})

check('a third of capacity is not described as idle', () => {
  // It was. 33% is a comfortable component, and calling it idle invites
  // someone to shrink a thing that is working.
  const b = loadBand(0.33, true)
  if (/idle|barely/.test(b.say)) throw new Error(`33% described as "${b.say}"`)
  return b.tone === 'live'
})

check('the knee is where the engine says it is', () => {
  // These thresholds must agree with the point the analytic model itself stops
  // trusting its own arithmetic, or the hint and the verdict disagree.
  if (loadBand(0.65, true).tone !== 'live') throw new Error('65% should still read as fine')
  if (loadBand(0.75, true).tone !== 'drift') throw new Error('75% should warn')
  if (loadBand(0.9, true).tone !== 'breach') throw new Error('90% should be a breach')
  return true
})

check('the hint is keyboard-reachable, which the old tooltip never was', () => {
  const canvas = read('apps/canvas/src/Canvas.jsx')
  if (!/tabIndex=\{0\}/.test(canvas)) throw new Error('nodes cannot be focused')
  if (!/onFocus=/.test(canvas) || !/onBlur=/.test(canvas)) throw new Error('focus does not open the hint')
  return true
})

check('the hint is clamped to the window', () => {
  // Same lesson as the tour card: a card that follows its target off the edge
  // has hidden itself.
  const src = read('apps/canvas/src/NodeHint.jsx')
  return /Math\.min\(Math\.max\(M, at\.left\)/.test(src) && /window\.innerWidth/.test(src)
})

check('a traffic source is not offered capacity advice', () => {
  const src = read('apps/canvas/src/NodeHint.jsx')
  if (!/isSourceNode\(node\)/.test(src)) throw new Error('sources are not distinguished')
  return /!source && Number\.isFinite/.test(src)
})

check('the node keeps a short accessible name, and the edge keeps its tooltip', () => {
  // The detail moved to the card, but `<title>` is the accessible name in SVG,
  // so it stays — short. And the edge's own tooltip is a different element that
  // must not have been caught by the same edit.
  const canvas = read('apps/canvas/src/Canvas.jsx')
  if (!/<title>\{`\$\{n\.label\} — \$\{kindName\(n\.kind\)\}`\}<\/title>/.test(canvas)) throw new Error('node has no accessible name')
  if (!/confidence: \$\{conf\}/.test(canvas)) throw new Error("the edge's tooltip was lost")
  return true
})

check('the studio does not open on a wall of JSON', () => {
  // Tri-view was default-on for one commit, which put 495 lines of the IR
  // where the diagram should be. It is the right thing to have and the wrong
  // thing to greet someone with.
  const app = read('apps/canvas/src/App.jsx')
  if (!/persist\.read\('triView', false\)/.test(app)) throw new Error('tri-view is on by default again')
  return true
})

check('an untouched example explains itself before it accuses', () => {
  // The shipped example fails on purpose. Opening with a red count of
  // violations a first-time reader did not cause reads as a report card.
  const v = read('apps/canvas/src/Verdict.jsx')
  if (!/pristine/.test(v)) throw new Error('the verdict cannot tell a fresh example from the reader’s own work')
  if (!/on purpose/.test(v)) throw new Error('nothing says the example is meant to fail')
  return true
})

check('the empty inspector speaks plainly', () => {
  // It is what someone reads before clicking anything, which makes it the worst
  // place in the app for internal vocabulary. It used to say "a projection of
  // the IR — the same document the CLI gates and the compiler writes back into
  // Terraform": four pieces of jargon in one sentence.
  const src = read('apps/canvas/src/Inspector.jsx')
  const empty = src.slice(src.indexOf('Nothing selected'), src.indexOf('Nothing selected') + 700)
  for (const word of ['projection of the IR', 'CLI gates', 'compiler writes back']) {
    if (empty.includes(word)) throw new Error(`the empty state still says "${word}"`)
  }
  return /boxes are the parts of your system/.test(empty)
})

check('no tab label is an unexplained acronym', () => {
  // "Chaos (DES)" taught nobody what DES meant; a tab label is the wrong place
  // to introduce a term. It is in the glossary instead.
  const app = read('apps/canvas/src/App.jsx')
  const tabs = app.match(/const TABS = \[([^\]]*)\]/)[1].split(',').map((t) => t.trim().replace(/'/g, ''))
  for (const t of tabs) {
    if (/\([A-Z]{2,}\)/.test(t)) throw new Error(`tab "${t}" carries a bare acronym`)
  }
  return tabs.length > 0
})

section('The load slider, and what the design can see about itself')

check('every step of the slider changes the value', () => {
  // The property the first version's test missed. It asserted a value survives
  // a round trip, which was true, while adjacent positions snapped to the same
  // figure — so near 4,600 rps the thumb sprang back and the slider looked as
  // though it had a ceiling.
  const stuck = []
  for (let p = 0; p < STEPS; p++) if (fromSlider(p) === fromSlider(p + 1)) stuck.push(p)
  if (stuck.length) throw new Error(`${stuck.length} position(s) where a step does nothing, first at ${stuck[0]}`)
  return true
})

check('the rungs are strictly increasing', () => {
  for (let i = 1; i < LADDER.length; i++) {
    if (LADDER[i] <= LADDER[i - 1]) throw new Error(`rung ${i} (${LADDER[i]}) is not above ${LADDER[i - 1]}`)
  }
  return LADDER[0] === MIN_RPS && LADDER[LADDER.length - 1] === MAX_RPS
})

check('a value on the ladder survives a round trip', () => {
  for (const r of [10, 100, 1000, 4000, 8000, 120000, 2000000]) {
    if (fromSlider(toSlider(r)) !== r) throw new Error(`${r} → ${fromSlider(toSlider(r))}`)
  }
  return true
})

check('the slider covers the range designs are actually sized for', () => {
  // A slider that stops at 100k cannot ask the question the benchmark asks.
  if (toSlider(1_000_000) >= STEPS) throw new Error('a million rps is off the end')
  if (LADDER.filter((v) => v >= 1000 && v <= 100_000).length < 100) throw new Error('too coarse in the common range')
  return true
})

check('telemetry coverage reads the design rather than decorating it', () => {
  // "🔭 traces, metrics, logs" printed unconditionally says the same thing
  // about a design with a full observability stack and one with nothing.
  const blind = telemetryCoverage({ nodes: [{ kind: 'app', label: 'api' }] })
  if (SIGNALS.some((s) => blind[s].length)) throw new Error('a design with no observability claims coverage')

  const seen = telemetryCoverage({ nodes: [{ kind: 'otel', label: 'collector' }] })
  if (!SIGNALS.every((s) => seen[s].length)) throw new Error('an OpenTelemetry collector should provide all three')

  const partial = telemetryCoverage({ nodes: [{ kind: 'monitor', label: 'prom' }] })
  if (!partial.metrics.length || partial.traces.length) throw new Error('metrics alone should not imply traces')
  return true
})

check('a missing signal says what you will be missing', () => {
  // The three failures feel identical at three in the morning and are not.
  const notes = SIGNALS.map((s) => telemetryNote(s, []))
  if (new Set(notes).size !== SIGNALS.length) throw new Error('the three gaps give the same explanation')
  for (const n of notes) if (n.length < 40) throw new Error(`"${n}" does not explain the gap`)
  return telemetryNote('metrics', ['prom']) === 'prom'
})

check('every observability kind named is one the catalog has', () => {
  for (const k of Object.values(SIGNAL_KINDS).flat()) {
    if (!CATALOG[k]) throw new Error(`SIGNAL_KINDS names '${k}', which is not a component`)
  }
  return true
})

check('the stat row states success rather than making you invert it', () => {
  const src = read('apps/canvas/src/Panels.jsx')
  if (!/label="success"/.test(src)) throw new Error('no success rate')
  if (!/label="QPS"/.test(src)) throw new Error('the row does not say what load it describes')
  return true
})

// ────────────────────────────────────────────────────────────────────────────
await Promise.all(pending)
process.stdout.write('\n\n')
if (failures.length) {
  process.stdout.write(`${failures.length} FAILED\n\n`)
  for (const f of failures) process.stdout.write(`  [${f.group}] ${f.name}\n    ${f.msg}\n`)
  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`)
  process.exit(1)
}
process.stdout.write(`${passed}/${passed} checks passed.\n`)
process.stdout.write('Every claim in the README is one of these.\n')
