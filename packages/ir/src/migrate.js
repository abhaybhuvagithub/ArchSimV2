// Migration from ArchSim 1.x.
//
// v1's share payload `{v, r, n[], e[]}` is the embryonic IR: it already carries
// nodes as plain data, edges as pairs, and traffic as a scalar. Growing it up
// means adding versioning, IaC bindings, SLOs and provenance — a lift, not a
// rewrite. Every v1 share link and template must survive this function, which
// is why the suite round-trips a corpus of them.

import { createIR, irNode, irEdge, normalizeIR } from './build.js'
import { ulidFrom } from './ulid.js'

/**
 * @param payload v1 share payload (already base64-decoded) or {nodes, edges, rps}
 * @param capacityFor (kind) => Partial<CapacityModel>, usually from @archsim/core
 */
export function fromV1(payload, capacityFor, meta = {}) {
  const rps = Number(payload.r ?? payload.rps ?? 100) || 100
  const v1Nodes = payload.n ?? payload.nodes ?? []
  const v1Edges = payload.e ?? payload.edges ?? []

  const ir = createIR({ name: meta.name || payload.name || 'migrated-from-v1', createdBy: meta.createdBy || 'archsim-migrate', ...meta })
  const idMap = new Map()

  for (const n of v1Nodes) {
    const newId = ulidFrom(`v1:${n.id}`)
    idMap.set(n.id, newId)
    const seeded = capacityFor ? capacityFor(n.type) : null
    ir.nodes.push(irNode({
      id: newId,
      kind: n.type || 'custom',
      label: n.label || n.type || n.id,
      capacity: {
        ...(seeded || {}),
        replicas: n.replicas ?? 1,
        // v1 carried the inspector state on the node; it changes the numbers
        // (ddia2.physicalEffects), so it travels into attrs where the analytic
        // adapter still reads it.
        provenance: seeded?.provenance || { cls: 'modeled', basis: 'v1 catalog seed', refs: [] },
      },
      layout: n.x !== undefined ? { x: n.x, y: n.y } : undefined,
      attrs: pickAttrs(n),
    }, capacityFor))
  }

  for (const e of v1Edges) {
    const from = Array.isArray(e) ? e[0] : (e.from ?? e[0])
    const to = Array.isArray(e) ? e[1] : (e.to ?? e[1])
    if (!idMap.has(from) || !idMap.has(to)) continue
    ir.edges.push(irEdge({
      from: idMap.get(from),
      to: idMap.get(to),
      callSemantics: e.async ? 'async' : 'sync',
      ...(e.readFrac !== undefined ? { readFrac: e.readFrac } : {}),
      ...(e.encoding ? { attrs: { encoding: e.encoding, rollingUpgrade: e.rollingUpgrade !== false } } : {}),
      confidence: 'high',
    }))
  }

  ir.workloads.push({ id: 'baseline', arrival: { dist: 'const', rps }, mix: { readPct: 50 } })
  return normalizeIR(ir)
}

const ATTR_KEYS = [
  'engine', 'consistency', 'replication', 'writePolicy', 'balancing', 'partitioning',
  'quorum', 'delivery', 'streamRole', 'multiWrite', 'weight', 'notes', 'region', 'az',
]
function pickAttrs(n) {
  const a = {}
  for (const k of ATTR_KEYS) if (n[k] !== undefined) a[k] = n[k]
  return a
}

/** Round-trip helper: IR back down to a v1-shaped payload for old share links. */
export function toV1(ir, rps) {
  const short = new Map(ir.nodes.map((n, i) => [n.id, `n${i}`]))
  return {
    v: 1,
    r: rps ?? ir.workloads?.[0]?.arrival?.rps ?? 100,
    n: ir.nodes.map((n) => ({
      id: short.get(n.id), type: n.kind, label: n.label,
      replicas: n.capacity.replicas,
      ...(n.layout ? { x: n.layout.x, y: n.layout.y } : {}),
      ...n.attrs,
    })),
    e: ir.edges.map((e) => [short.get(e.from), short.get(e.to)]),
  }
}
