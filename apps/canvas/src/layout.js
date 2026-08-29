// Layered layout.
//
// Ingested infrastructure has no coordinates — nobody writes `x = 240` in
// Terraform — so the canvas has to derive a readable arrangement or the first
// impression of an imported estate is a pile. Layers come from the same tier
// ranks the edge inference uses, so what you see left-to-right is traffic
// direction, and positions are written back into `layout` where they become the
// user's to move.

import { TIER_RANK } from '@archsim/iac'

const COL_W = 210
const ROW_H = 96
const MARGIN = 48

export function autoLayout(ir) {
  const rankOf = (n) => TIER_RANK[n.kind] ?? 7
  // Longest-path depth beats a raw tier rank when the graph disagrees with the
  // taxonomy — a cache called by a worker belongs after the worker.
  const depth = longestPaths(ir)
  const columns = new Map()
  for (const n of ir.nodes) {
    const col = Math.max(depth.get(n.id) ?? 0, Math.round(rankOf(n) / 3))
    if (!columns.has(col)) columns.set(col, [])
    columns.get(col).push(n)
  }
  const positions = new Map()
  for (const [col, group] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
    group.sort((a, b) => a.label.localeCompare(b.label))
    const height = (group.length - 1) * ROW_H
    group.forEach((n, i) => {
      positions.set(n.id, { x: MARGIN + col * COL_W, y: MARGIN + 260 - height / 2 + i * ROW_H })
    })
  }
  return {
    ...ir,
    nodes: ir.nodes.map((n) => ({ ...n, layout: n.layout || positions.get(n.id) || { x: MARGIN, y: MARGIN } })),
  }
}

function longestPaths(ir) {
  const out = new Map()
  const adj = new Map()
  for (const e of ir.edges) {
    if (!adj.has(e.from)) adj.set(e.from, [])
    adj.get(e.from).push(e.to)
  }
  const depth = new Map(ir.nodes.map((n) => [n.id, 0]))
  const visit = (id, seen, d) => {
    if (seen.has(id)) return
    seen.add(id)
    depth.set(id, Math.max(depth.get(id) || 0, d))
    for (const t of adj.get(id) || []) visit(t, seen, d + 1)
    seen.delete(id)
  }
  const hasIn = new Set(ir.edges.map((e) => e.to))
  for (const n of ir.nodes) if (!hasIn.has(n.id)) visit(n.id, new Set(), 0)
  for (const n of ir.nodes) out.set(n.id, depth.get(n.id) || 0)
  return out
}

/** Orthogonal-ish path between two boxes, with a gentle curve. */
export function edgePath(a, b, w = 150, h = 44) {
  const x1 = a.x + w, y1 = a.y + h / 2
  const x2 = b.x, y2 = b.y + h / 2
  if (x2 >= x1) {
    const mid = (x1 + x2) / 2
    return `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`
  }
  // Backwards edge (a cycle, or a hand-drawn arrow): route under the boxes so it
  // is legible as a return path rather than crossing through everything.
  const dip = Math.max(y1, y2) + 70
  return `M ${a.x} ${y1} C ${a.x - 60} ${y1}, ${b.x + w + 60} ${dip}, ${b.x + w} ${y2}`
}
