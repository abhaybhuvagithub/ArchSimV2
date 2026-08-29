// Fault library — the v1 chaos catalogue, now CI-addressable.
//
// In v1 these were buttons you pressed on a canvas. In v2 they are scenarios
// named in `.archsim/slo.yaml`, so "does this design survive losing an AZ" stops
// being a demo and becomes a status check on every pull request.
//
// Each fault compiles to the same `fx` shape the analytic engine has always
// taken — {node:{id:{capMul,latMul,drop,dup,noCache}}, cut:Set<edgeId>, rpsMul} —
// and the DES reads the same structure, so a scenario means one thing in both
// engines.

import { CATALOG } from './catalog.js'
import { isSourceNode } from './simulate.js'

const STORAGE = ['sql', 'nosql', 'blob', 'search', 'cache', 'lake', 'warehouse', 'ledger', 'graph']

export const FAULTS = [
  // ── Infrastructure ────────────────────────────────────────────────────────
  { id: 'az', icon: '🧱', name: 'Availability Zone loss', group: 'Infrastructure', scope: 'global',
    desc: 'One AZ goes dark. Every multi-replica tier loses roughly a third of its instances at once.',
    hint: 'Spread replicas across at least three zones so losing one costs a third, not everything.',
    effect: () => ({ all: { capMul: 0.66 } }) },
  { id: 'region', icon: '🏢', name: 'Region loss', group: 'Infrastructure', scope: 'global',
    desc: 'A whole region is lost. Half of all capacity disappears and what remains queues.',
    hint: 'Size the surviving region to carry the load, or fail traffic over to it.',
    effect: () => ({ all: { capMul: 0.5, latMul: 1.6 } }) },
  { id: 'crash', icon: '💥', name: 'Instance crash', group: 'Infrastructure', scope: 'node',
    desc: 'One replica of the target dies. Survivors absorb its share until it restarts.',
    hint: 'Run enough replicas that losing one is absorbed by the rest.',
    effect: (n) => ({ node: { capMul: Math.max(0, ((n?.capacity?.replicas || 1) - 1) / (n?.capacity?.replicas || 1)) } }) },
  { id: 'slow', icon: '🐢', name: 'Grey failure (slow instance)', group: 'Infrastructure', scope: 'node',
    desc: 'The instance still answers health checks but responds 5× slower, so it also serves far less traffic.',
    hint: 'Make the health check measure latency, so it ejects the slow instance instead of trusting it.',
    effect: () => ({ node: { latMul: 5, capMul: 0.6 } }) },
  { id: 'iops', icon: '📉', name: 'Storage IOPS throttle', group: 'Infrastructure', scope: 'node', prefer: STORAGE,
    desc: 'Burst credits exhausted — IOPS throttled to a fraction of provisioned.',
    hint: 'Move the hot reads into a cache rather than buying more disk.',
    effect: () => ({ node: { capMul: 0.3, latMul: 3 } }) },

  // ── Network ───────────────────────────────────────────────────────────────
  { id: 'partition', icon: '✂️', name: 'Network partition', group: 'Network', scope: 'node',
    desc: 'Calls to the target hang until they time out, rather than failing fast.',
    hint: 'The expensive kind of failure: a held worker costs more than a rejected request.',
    effect: () => ({ node: { latMul: 8, drop: 0.5 } }) },
  { id: 'latency', icon: '🐌', name: 'Network latency spike', group: 'Network', scope: 'global',
    desc: 'Every hop pays an extra round trip.',
    hint: 'Fan-out multiplies added latency: parallelise, or cut the number of hops.',
    effect: () => ({ all: { latMul: 2.2 } }) },
  { id: 'cutdeps', icon: '🔌', name: 'Dependency unreachable', group: 'Network', scope: 'node',
    desc: 'Everything downstream of the target is severed.',
    hint: 'What does the caller do when this never answers? That is the design question.',
    effect: () => ({ cutFrom: true, node: { drop: 1 } }) },

  // ── Distributed ───────────────────────────────────────────────────────────
  { id: 'retry', icon: '🔁', name: 'Retry storm', group: 'Distributed', scope: 'node', prefer: ['ledger', 'sql', 'queue', 'gateway', 'micro'],
    desc: 'Upstream timeouts trigger client retries: the target sees ~40% duplicate requests on top of real traffic, and every duplicate it processes flows downstream too.',
    hint: 'Retries are duplicates wearing a disguise. Budget them, or the storm is self-sustaining — run this scenario under --engine des to watch the feedback loop rather than take the multiplier on faith.',
    effect: () => ({ node: { dup: 0.4, latMul: 1.15 } }) },
  { id: 'stampede', icon: '🐘', name: 'Cache stampede', group: 'Distributed', scope: 'node', prefer: ['cache', 'cdn'],
    desc: 'The cache is cold or evicted: every request goes through to the origin.',
    hint: 'A cache is a capacity assumption. Size the tier behind it for the day the assumption fails.',
    effect: () => ({ node: { noCache: true } }) },
  { id: 'hotkey', icon: '🔥', name: 'Hot partition', group: 'Distributed', scope: 'node', prefer: STORAGE,
    desc: 'Traffic concentrates on one shard: effective capacity collapses to a fraction of nominal.',
    hint: 'Nominal capacity assumes even keys. Check the key distribution, not the cluster size.',
    effect: () => ({ node: { capMul: 0.35, latMul: 2 } }) },

  // ── Global ────────────────────────────────────────────────────────────────
  { id: 'surge', icon: '📈', name: 'Traffic surge', group: 'Global', scope: 'global',
    desc: 'Offered load triples with no warning.',
    hint: 'Autoscaling has a warm-up time; the surge does not.',
    effect: () => ({ rpsMul: 3 }) },
  { id: 'thunder', icon: '⛈️', name: 'Thundering herd', group: 'Global', scope: 'global',
    desc: 'Every client reconnects at the same instant after a blip.',
    hint: 'Jitter the reconnect. Synchronised clients are a self-inflicted DDoS.',
    effect: () => ({ rpsMul: 5, all: { latMul: 1.4 } }) },
]

export const faultById = (id) => FAULTS.find((f) => f.id === id)

/**
 * Resolve a scenario's target. Accepts an explicit node id, a `kind:sql`
 * selector, a `label:checkout` selector, or nothing — in which case we pick the
 * fault's preferred kind, falling back to the busiest node in the simulation,
 * because chaos aimed at an idle node proves nothing.
 */
export function pickTarget(fault, ir, sim) {
  const candidates = ir.nodes.filter((n) => !isSourceNode(n))
  if (!candidates.length) return null
  const preferred = fault.prefer ? candidates.filter((n) => fault.prefer.includes(n.kind)) : []
  const pool = preferred.length ? preferred : candidates
  return pool
    .slice()
    .sort((a, b) => (sim?.stats?.[b.id]?.in || 0) - (sim?.stats?.[a.id]?.in || 0))[0]
}

export function resolveTarget(selector, ir, sim, fault) {
  if (!selector) return pickTarget(fault, ir, sim)
  if (selector.startsWith('kind:')) {
    const kind = selector.slice(5)
    const hits = ir.nodes.filter((n) => n.kind === kind)
    if (!hits.length) return null
    return hits.sort((a, b) => (sim?.stats?.[b.id]?.in || 0) - (sim?.stats?.[a.id]?.in || 0))[0]
  }
  if (selector.startsWith('label:')) {
    const l = selector.slice(6).toLowerCase()
    return ir.nodes.find((n) => n.label.toLowerCase() === l) || null
  }
  if (selector.startsWith('address:')) {
    const a = selector.slice(8)
    return ir.nodes.find((n) => (n.bindings || []).some((b) => b.address === a)) || null
  }
  return ir.nodes.find((n) => n.id === selector) || null
}

/** Compile a list of {fault, target?} into the fx structure both engines read. */
export function compileFaults(active, ir, sim = null) {
  const node = {}
  const cut = new Set()
  let rpsMul = 1
  const byId = new Map(ir.nodes.map((n) => [n.id, n]))
  const applied = []

  const merge = (id, e) => {
    const cur = node[id] || { capMul: 1, latMul: 1, drop: 0, dup: 0, noCache: false }
    node[id] = {
      capMul: cur.capMul * (e.capMul ?? 1),
      latMul: cur.latMul * (e.latMul ?? 1),
      drop: 1 - (1 - cur.drop) * (1 - (e.drop ?? 0)),
      dup: cur.dup + (e.dup ?? 0),
      noCache: cur.noCache || !!e.noCache,
    }
  }

  for (const a of active) {
    const f = typeof a === 'string' ? faultById(a) : faultById(a.fault ?? a.faultId)
    if (!f) continue
    const target = f.scope === 'node' ? resolveTarget(typeof a === 'string' ? null : a.target, ir, sim, f) : null
    const eff = f.effect(target || {})
    applied.push({ fault: f.id, name: f.name, target: target?.id || null, targetLabel: target?.label || null })

    if (eff.rpsMul) rpsMul *= eff.rpsMul
    if (eff.all) for (const n of ir.nodes) if (!isSourceNode(n)) merge(n.id, eff.all)
    if (target) {
      if (eff.node) merge(target.id, eff.node)
      if (eff.cutFrom) for (const e of ir.edges) if (e.from === target.id) cut.add(e.id)
    }
  }
  return { node, cut, rpsMul, applied }
}

export const faultSummary = (applied) =>
  applied.map((a) => (a.targetLabel ? `${a.name} on ${a.targetLabel}` : a.name)).join(', ')

export const KINDS_WITH_FAULTS = Object.keys(CATALOG)
