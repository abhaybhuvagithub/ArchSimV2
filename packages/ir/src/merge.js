// Three-way reconciliation.
//
// Both projections can move between syncs: you drag a node and set replicas to
// 7 on the canvas while a teammate pushes `count = 5` in HCL. We keep `baseIR`
// (the last sync point) and merge like git:
//
//   canvas changed, code didn't  → take canvas → emit patch
//   code changed, canvas didn't  → take code   → update canvas
//   both changed, same value     → converge silently
//   both changed, different      → CONFLICT — surfaced, never auto-resolved
//                                  for anything that costs money
//

/**
 * A conflict the merge refused to resolve. `costly` is the field that matters:
 * where the two sides differ in money or capacity, no winner is picked
 * automatically, however obvious the winner looks.
 *
 * @typedef {object} Conflict
 * @property {'node'|'edge'} kind
 * @property {string} id
 * @property {string} [label]
 * @property {string} field
 * @property {any} base
 * @property {any} canvas
 * @property {any} code
 * @property {boolean} [costly]
 * @property {string} [why]
 */

/**
 * A decision it did resolve — either about a whole node, which explains itself
 * in `what`, or a single field moving one way, which names the field and both
 * values.
 *
 * @typedef {object} Decision
 * @property {string} id
 * @property {string} action
 * @property {'canvas'|'code'|'both'} [side]
 * @property {string} [what]
 * @property {string} [field]
 * @property {any} [from]
 * @property {any} [to]
 */

// The last line is the rule that matters. A tool that silently picks a winner
// on `replicas` is a tool that will one day halve someone's database fleet and
// be technically correct about it.

import { normalizeIR } from './build.js'

const MERGE_FIELDS = [
  { path: ['kind'], costly: false },
  { path: ['label'], costly: false },
  { path: ['capacity', 'replicas'], costly: true },
  { path: ['capacity', 'capPerReplica'], costly: true },
  { path: ['capacity', 'availability'], costly: false },
  { path: ['capacity', 'concurrency'], costly: false },
  { path: ['capacity', 'queueDepth'], costly: false },
  { path: ['capacity', 'latencyMs', 'p50'], costly: false },
]

const EDGE_MERGE_FIELDS = [
  { path: ['callSemantics'], costly: false },
  { path: ['protocol'], costly: false },
  { path: ['timeoutMs'], costly: true },
  { path: ['weight'], costly: true },
  { path: ['retry', 'max'], costly: true },
]

export function threeWayMerge(baseIR, canvasIR, codeIR) {
  const base = normalizeIR(baseIR)
  const canvas = normalizeIR(canvasIR)
  const code = normalizeIR(codeIR)

  /** @type {Conflict[]} */
  const conflicts = []
  /** @type {Decision[]} */
  const decisions = []
  const merged = normalizeIR({ ...base, nodes: [], edges: [] })
  merged.meta = { ...base.meta, ...canvas.meta, updatedAt: canvas.meta.updatedAt }

  const bN = byId(base.nodes), cN = byId(canvas.nodes), kN = byId(code.nodes)
  const allNodeIds = new Set([...bN.keys(), ...cN.keys(), ...kN.keys()])

  for (const id of [...allNodeIds].sort()) {
    const b = bN.get(id), c = cN.get(id), k = kN.get(id)

    // existence
    if (!b && c && !k) { merged.nodes.push(c); decisions.push({ id, action: 'emit-new', side: 'canvas', what: `new node '${c.label}' → generate IaC` }); continue }
    if (!b && !c && k) { merged.nodes.push(k); decisions.push({ id, action: 'adopt', side: 'code', what: `new resource '${addr(k)}' → add to canvas` }); continue }
    if (!b && c && k) { merged.nodes.push(mergeNode(c, c, k, id, conflicts, decisions)); continue }
    if (b && !c && k) {
      // deleted on canvas — never silently deleted in code
      merged.nodes.push(k)
      decisions.push({ id, action: 'removal-proposal', side: 'canvas', what: `'${b.label}' deleted on canvas → proposed for removal in review, not deleted` })
      continue
    }
    if (b && c && !k) {
      conflicts.push({ kind: 'node', id, field: 'existence', base: 'present', canvas: 'present', code: 'absent',
        why: `'${b.label}' vanished from code. Adopting that deletion would remove it from the canvas too; refusing to guess.` })
      merged.nodes.push(c)
      continue
    }
    if (b && !c && !k) { decisions.push({ id, action: 'drop', side: 'both', what: `'${b.label}' gone from both sides` }); continue }
    merged.nodes.push(mergeNode(b, c, k, id, conflicts, decisions))
  }

  const bE = byId(base.edges), cE = byId(canvas.edges), kE = byId(code.edges)
  for (const id of [...new Set([...bE.keys(), ...cE.keys(), ...kE.keys()])].sort()) {
    const b = bE.get(id), c = cE.get(id), k = kE.get(id)
    if (!b && c && !k) { merged.edges.push(c); continue }
    if (!b && !c && k) { merged.edges.push(k); continue }
    if (b && !c && !k) continue
    if (b && c && !k) { merged.edges.push(c); continue }
    if (b && !c && k) { merged.edges.push(k); continue }
    merged.edges.push(mergeEdge(b || c, c, k, id, conflicts))
  }

  // Passthrough always comes from code: it is text we chose not to model, and
  // the canvas has no opinion about it that could be worth losing bytes over.
  merged.passthrough = code.passthrough
  merged.slos = canvas.slos.length ? canvas.slos : base.slos
  merged.workloads = canvas.workloads.length ? canvas.workloads : base.workloads

  return { merged: normalizeIR(merged), conflicts, decisions }
}

function mergeNode(b, c, k, id, conflicts, decisions) {
  const out = structuredClone(c || k)
  for (const { path, costly } of MERGE_FIELDS) {
    const bv = get(b, path), cv = get(c, path), kv = get(k, path)
    const canvasMoved = !eq(bv, cv)
    const codeMoved = !eq(bv, kv)
    if (canvasMoved && !codeMoved) { set(out, path, cv); decisions.push({ id, action: 'patch-code', field: path.join('.'), from: bv, to: cv }) }
    else if (!canvasMoved && codeMoved) { set(out, path, kv); decisions.push({ id, action: 'update-canvas', field: path.join('.'), from: bv, to: kv }) }
    else if (canvasMoved && codeMoved && eq(cv, kv)) set(out, path, cv)
    else if (canvasMoved && codeMoved) {
      conflicts.push({ kind: 'node', id, label: out.label, field: path.join('.'), base: bv, canvas: cv, code: kv, costly })
      set(out, path, kv) // hold the code value until a human decides; code is what is deployed
    }
  }
  // bindings and layout are side-owned by construction
  out.bindings = (k || c).bindings
  if (c?.layout) out.layout = c.layout
  if (k?.telemetry) out.telemetry = k.telemetry
  return out
}

function mergeEdge(b, c, k, id, conflicts) {
  const out = structuredClone(c || k)
  for (const { path, costly } of EDGE_MERGE_FIELDS) {
    const bv = get(b, path), cv = get(c, path), kv = get(k, path)
    const canvasMoved = !eq(bv, cv), codeMoved = !eq(bv, kv)
    if (canvasMoved && !codeMoved) set(out, path, cv)
    else if (!canvasMoved && codeMoved) set(out, path, kv)
    else if (canvasMoved && codeMoved && !eq(cv, kv)) {
      conflicts.push({ kind: 'edge', id, field: path.join('.'), base: bv, canvas: cv, code: kv, costly })
      set(out, path, kv)
    }
  }
  return out
}

const byId = (arr) => new Map(arr.map((x) => [x.id, x]))
const addr = (n) => n?.bindings?.[0]?.address || n?.label
const eq = (a, b) => a === b || (a == null && b == null)
function get(o, path) { let v = o; for (const p of path) { if (v == null) return undefined; v = v[p] } return v }
function set(o, path, v) {
  let t = o
  for (const p of path.slice(0, -1)) { if (t[p] == null) t[p] = {}; t = t[p] }
  t[path[path.length - 1]] = v
}
