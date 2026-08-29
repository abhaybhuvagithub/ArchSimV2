// Arranging a diagram, and knowing whether the arrangement got better.
//
// Layout is where architecture tools quietly become taste. Four algorithms, an
// argument about which one is prettier, no way to settle it. So every layout
// here reports the same four numbers — edge crossings, overlapping components,
// total edge length, and edges that run backwards against the traffic — and the
// Arrange tab shows them changing. "Better" stops being a matter of opinion.
//
// The numbers are not equally important, and the order they are listed in is
// the order they matter. A crossing is a reader stopping to trace a line. An
// overlap is a component you cannot read at all. Length is aesthetic. A
// backward edge is the diagram contradicting the thing it is drawing: on a
// canvas where left-to-right means traffic direction, an arrow pointing left is
// a lie unless the traffic really does go back.

import { TIER_RANK } from '@archsim/iac'

const W = 150
const H = 44
const COL_W = 210
const ROW_H = 96
const MARGIN = 48

/* ── measuring ────────────────────────────────────────────────────────────── */

const at = (n) => n.layout || { x: 0, y: 0 }
const centre = (n) => ({ x: at(n).x + W / 2, y: at(n).y + H / 2 })

/** Do segments AB and CD cross? Standard orientation test, no edge cases fudged. */
function segmentsCross(a, b, c, d) {
  const o = (p, q, r) => Math.sign((q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y))
  const o1 = o(a, b, c)
  const o2 = o(a, b, d)
  const o3 = o(c, d, a)
  const o4 = o(c, d, b)
  return o1 !== o2 && o3 !== o4 && o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0
}

/**
 * The four numbers, in the order they matter.
 *
 * Edges are measured centre to centre rather than along the curve the canvas
 * actually draws. A curve and its chord cross the same other edges in all but
 * pathological cases, and measuring the chord means the score does not change
 * when the drawing style does.
 */
export function layoutQuality(ir) {
  const byId = new Map(ir.nodes.map((n) => [n.id, n]))
  const segs = []
  for (const e of ir.edges) {
    const a = byId.get(e.from)
    const b = byId.get(e.to)
    if (a && b) segs.push({ a: centre(a), b: centre(b), from: a, to: b })
  }

  let crossings = 0
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      // Two edges sharing an endpoint meet there by definition; that is not a
      // crossing, and counting it would penalise every hub.
      if (segs[i].from === segs[j].from || segs[i].from === segs[j].to
        || segs[i].to === segs[j].from || segs[i].to === segs[j].to) continue
      if (segmentsCross(segs[i].a, segs[i].b, segs[j].a, segs[j].b)) crossings++
    }
  }

  let overlaps = 0
  const ns = ir.nodes
  for (let i = 0; i < ns.length; i++) {
    for (let j = i + 1; j < ns.length; j++) {
      const p = at(ns[i])
      const q = at(ns[j])
      if (Math.abs(p.x - q.x) < W && Math.abs(p.y - q.y) < H) overlaps++
    }
  }

  const length = segs.reduce((s, e) => s + Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y), 0)
  const backward = segs.filter((e) => e.b.x < e.a.x - W / 2).length

  return { crossings, overlaps, length: Math.round(length), backward, edges: segs.length }
}

/** Lower is better. Weighted the way the numbers actually matter to a reader. */
export const layoutScore = (q) => q.crossings * 10 + q.overlaps * 25 + q.backward * 4 + q.length / 1000

/* ── shared graph helpers ─────────────────────────────────────────────────── */

function adjacency(ir) {
  const out = new Map(ir.nodes.map((n) => [n.id, []]))
  const inc = new Map(ir.nodes.map((n) => [n.id, []]))
  for (const e of ir.edges) {
    if (out.has(e.from)) out.get(e.from).push(e.to)
    if (inc.has(e.to)) inc.get(e.to).push(e.from)
  }
  return { out, inc }
}

/**
 * Longest path from any source, which is the column a component belongs in when
 * the graph and the catalog's tier ranks disagree — a cache called by a worker
 * belongs after the worker, whatever the taxonomy says.
 */
function depths(ir) {
  const { out, inc } = adjacency(ir)
  const depth = new Map(ir.nodes.map((n) => [n.id, 0]))
  const indeg = new Map(ir.nodes.map((n) => [n.id, inc.get(n.id).length]))
  const queue = ir.nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id)
  const seen = new Set(queue)
  while (queue.length) {
    const id = queue.shift()
    for (const next of out.get(id) || []) {
      depth.set(next, Math.max(depth.get(next) ?? 0, (depth.get(id) ?? 0) + 1))
      indeg.set(next, indeg.get(next) - 1)
      if (indeg.get(next) === 0 && !seen.has(next)) { seen.add(next); queue.push(next) }
    }
  }
  // A cycle leaves nodes unvisited with a depth of zero, which would pile them
  // all in column one. Push them one past their deepest predecessor instead.
  for (const n of ir.nodes) {
    if (seen.has(n.id) || !inc.get(n.id).length) continue
    depth.set(n.id, Math.max(...inc.get(n.id).map((p) => depth.get(p) ?? 0)) + 1)
  }
  return depth
}

const withPositions = (ir, positions) => ({
  ...ir,
  nodes: ir.nodes.map((n) => ({ ...n, layout: positions.get(n.id) || at(n) })),
})

const snap = (v, grid = 8) => Math.round(v / grid) * grid

/* ── the layouts ──────────────────────────────────────────────────────────── */

/**
 * Layered, ordered by traffic. The default, and the one that means something:
 * left to right is the direction requests travel.
 */
export function layered(ir) {
  const depth = depths(ir)
  const rankOf = (n) => TIER_RANK[n.kind] ?? 7
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
    group.forEach((n, i) => positions.set(n.id, {
      x: snap(MARGIN + col * COL_W),
      y: snap(MARGIN + 260 - height / 2 + i * ROW_H),
    }))
  }
  return withPositions(ir, positions)
}

/**
 * Layered, then ordered within each column to reduce crossings.
 *
 * This is the barycentre heuristic — put each node at the average height of its
 * neighbours, sweep forwards and backwards until it settles. It is what Dagre
 * does, in thirty lines rather than a dependency, and on the graphs this tool
 * draws (tens of nodes, not thousands) it converges in four passes.
 */
export function layeredTidy(ir, passes = 6) {
  const depth = depths(ir)
  const rankOf = (n) => TIER_RANK[n.kind] ?? 7
  const cols = new Map()
  for (const n of ir.nodes) {
    const col = Math.max(depth.get(n.id) ?? 0, Math.round(rankOf(n) / 3))
    if (!cols.has(col)) cols.set(col, [])
    cols.get(col).push(n)
  }
  const order = [...cols.entries()].sort((a, b) => a[0] - b[0]).map(([, g]) => g.slice().sort((a, b) => a.label.localeCompare(b.label)))

  const { out, inc } = adjacency(ir)
  const rowOf = new Map()
  const reindex = () => order.forEach((g) => g.forEach((n, i) => rowOf.set(n.id, i)))
  reindex()

  for (let pass = 0; pass < passes; pass++) {
    const forward = pass % 2 === 0
    const seq = forward ? order.map((_, i) => i) : order.map((_, i) => order.length - 1 - i)
    for (const ci of seq) {
      const neighbours = (n) => (forward ? inc.get(n.id) : out.get(n.id)) || []
      order[ci] = order[ci]
        .map((n) => {
          const ns = neighbours(n).map((id) => rowOf.get(id)).filter((r) => r !== undefined)
          // A node with no neighbour on the side being swept keeps its place;
          // giving it a barycentre of zero would drag it to the top every pass.
          return { n, key: ns.length ? ns.reduce((s, r) => s + r, 0) / ns.length : rowOf.get(n.id) }
        })
        .sort((a, b) => a.key - b.key || a.n.label.localeCompare(b.n.label))
        .map((x) => x.n)
      reindex()
    }
  }

  const positions = new Map()
  order.forEach((group, col) => {
    const height = (group.length - 1) * ROW_H
    group.forEach((n, i) => positions.set(n.id, {
      x: snap(MARGIN + col * COL_W),
      y: snap(MARGIN + 260 - height / 2 + i * ROW_H),
    }))
  })
  return withPositions(ir, positions)
}

/**
 * A force-directed layout, seeded so it is reproducible.
 *
 * Springs along edges, repulsion between every pair, cooling over 300 steps.
 * It is included because it is genuinely better for a mesh — a service graph
 * with no clear direction — and genuinely worse for a pipeline, which the
 * quality numbers will tell you rather than leaving you to squint.
 */
export function force(ir, opts = {}) {
  const nodes = ir.nodes.map((n, i) => ({
    id: n.id,
    // A deterministic ring start: same design, same layout, every time.
    x: 500 + 240 * Math.cos((2 * Math.PI * i) / ir.nodes.length),
    y: 300 + 240 * Math.sin((2 * Math.PI * i) / ir.nodes.length),
    vx: 0,
    vy: 0,
  }))
  const index = new Map(nodes.map((n, i) => [n.id, i]))
  const links = ir.edges
    .map((e) => ({ a: index.get(e.from), b: index.get(e.to) }))
    .filter((l) => l.a !== undefined && l.b !== undefined)

  const steps = opts.steps ?? 300
  const ideal = opts.linkDistance ?? 190
  const repel = opts.repulsion ?? 24000

  for (let step = 0; step < steps; step++) {
    const cool = 1 - step / steps
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i]
        const b = nodes[j]
        let dx = b.x - a.x
        let dy = b.y - a.y
        let d2 = dx * dx + dy * dy
        if (d2 < 1) { dx = (i - j) || 1; dy = 1; d2 = 2 }
        const f = repel / d2
        const d = Math.sqrt(d2)
        a.vx -= (dx / d) * f
        a.vy -= (dy / d) * f
        b.vx += (dx / d) * f
        b.vy += (dy / d) * f
      }
    }
    for (const l of links) {
      const a = nodes[l.a]
      const b = nodes[l.b]
      const dx = b.x - a.x
      const dy = b.y - a.y
      const d = Math.hypot(dx, dy) || 1
      const f = (d - ideal) * 0.06
      a.vx += (dx / d) * f
      a.vy += (dy / d) * f
      b.vx -= (dx / d) * f
      b.vy -= (dy / d) * f
      // A gentle rightward bias along every edge, so a force layout of a
      // pipeline still reads left to right instead of coiling.
      a.vx -= 1.2
      b.vx += 1.2
    }
    for (const n of nodes) {
      n.x += Math.max(-30, Math.min(30, n.vx)) * cool * 0.5
      n.y += Math.max(-30, Math.min(30, n.vy)) * cool * 0.5
      n.vx *= 0.82
      n.vy *= 0.82
    }
  }

  const minX = Math.min(...nodes.map((n) => n.x))
  const minY = Math.min(...nodes.map((n) => n.y))
  const positions = new Map(nodes.map((n) => [n.id, {
    x: snap(n.x - minX + MARGIN),
    y: snap(n.y - minY + MARGIN),
  }]))
  return withPositions(ir, positions)
}

/**
 * A plain grid, sorted by traffic depth then name.
 *
 * The least clever layout here and occasionally the right one: when a design
 * has barely any edges, a layered graph is a single sparse column and a grid is
 * simply a readable list of what exists.
 */
export function grid(ir, opts = {}) {
  const depth = depths(ir)
  const perRow = opts.perRow || Math.max(2, Math.ceil(Math.sqrt(ir.nodes.length)))
  const sorted = ir.nodes.slice().sort((a, b) =>
    (depth.get(a.id) ?? 0) - (depth.get(b.id) ?? 0) || a.label.localeCompare(b.label))
  const positions = new Map(sorted.map((n, i) => [n.id, {
    x: snap(MARGIN + (i % perRow) * COL_W),
    y: snap(MARGIN + Math.floor(i / perRow) * ROW_H),
  }]))
  return withPositions(ir, positions)
}

/**
 * Vertical: the same layered arrangement rotated, for a deep pipeline that runs
 * off the right edge of a laptop screen.
 */
export function vertical(ir) {
  const laid = layeredTidy(ir)
  const positions = new Map(laid.nodes.map((n) => {
    const p = at(n)
    return [n.id, { x: snap((p.y - MARGIN) * 1.6 + MARGIN), y: snap((p.x - MARGIN) * 0.62 + MARGIN) }]
  }))
  return withPositions(ir, positions)
}

export const LAYOUTS = [
  { id: 'tidy', name: 'Layered, tidied', run: layeredTidy, about: 'Traffic left to right, then components reordered within each column to cut edge crossings. The default, and usually the answer.' },
  { id: 'layered', name: 'Layered, by name', run: layered, about: 'The same columns, ordered alphabetically instead. Easier to find a specific component; more crossings.' },
  { id: 'force', name: 'Force-directed', run: force, about: 'Springs along edges, repulsion between everything. Better for a mesh, worse for a pipeline — the numbers below will say which you have.' },
  { id: 'vertical', name: 'Vertical', run: vertical, about: 'Layered, rotated. For a pipeline deep enough to run off the side of a laptop.' },
  { id: 'grid', name: 'Grid', run: grid, about: 'No graph reasoning at all. When a design has few edges, this is a readable list rather than a sparse column.' },
]

/**
 * Every layout, scored, best first — including the arrangement already on the
 * canvas.
 *
 * Including the current one matters. Without it the table always crowns a
 * winner, and on a design somebody has already arranged by hand the winner can
 * be worse than what they have: across the hundred templates, the best
 * algorithm beat the shipped arrangement 45 times and lost to it 4 times.
 * Ranking the status quo alongside the alternatives means the honest answer —
 * "leave it alone" — is one the table can give.
 */
export function rankLayouts(ir) {
  const current = { id: 'current', name: 'As it is now', run: (x) => x, about: 'The arrangement on the canvas, ranked alongside the alternatives so that leaving it alone is an answer the table can give.', current: true }
  return [current, ...LAYOUTS]
    .map((l) => {
      const result = l.run(ir)
      const quality = layoutQuality(result)
      return { ...l, result, quality, score: layoutScore(quality) }
    })
    // A tie goes to the arrangement that already exists: moving a diagram for no
    // measurable gain is the tool being busy at the reader's expense.
    .sort((a, b) => a.score - b.score || (a.current ? -1 : b.current ? 1 : 0))
}

/* ── alignment, for a selection ───────────────────────────────────────────── */

/**
 * The operations that are about tidiness rather than about the graph. They act
 * on a selection, never on the whole design, because "align everything left" is
 * not a thing anyone means.
 */
export const ALIGNMENTS = [
  { id: 'left', name: 'Align left', axis: 'x', pick: (vs) => Math.min(...vs) },
  { id: 'centre-x', name: 'Align centres', axis: 'x', pick: (vs) => Math.round(vs.reduce((s, v) => s + v, 0) / vs.length) },
  { id: 'right', name: 'Align right', axis: 'x', pick: (vs) => Math.max(...vs) },
  { id: 'top', name: 'Align top', axis: 'y', pick: (vs) => Math.min(...vs) },
  { id: 'middle', name: 'Align middles', axis: 'y', pick: (vs) => Math.round(vs.reduce((s, v) => s + v, 0) / vs.length) },
  { id: 'bottom', name: 'Align bottom', axis: 'y', pick: (vs) => Math.max(...vs) },
]

export function align(ir, ids, alignmentId) {
  const spec = ALIGNMENTS.find((a) => a.id === alignmentId)
  if (!spec || ids.length < 2) return ir
  const chosen = ir.nodes.filter((n) => ids.includes(n.id))
  const value = spec.pick(chosen.map((n) => at(n)[spec.axis]))
  return {
    ...ir,
    nodes: ir.nodes.map((n) => (ids.includes(n.id) ? { ...n, layout: { ...at(n), [spec.axis]: snap(value) } } : n)),
  }
}

/** Equal gaps along whichever axis the selection is more spread out on. */
export function distribute(ir, ids, axis = null) {
  if (ids.length < 3) return ir
  const chosen = ir.nodes.filter((n) => ids.includes(n.id))
  const spread = (k) => Math.max(...chosen.map((n) => at(n)[k])) - Math.min(...chosen.map((n) => at(n)[k]))
  const k = axis || (spread('x') >= spread('y') ? 'x' : 'y')
  const sorted = chosen.slice().sort((a, b) => at(a)[k] - at(b)[k])
  const first = at(sorted[0])[k]
  const last = at(sorted[sorted.length - 1])[k]
  const step = (last - first) / (sorted.length - 1)
  const moved = new Map(sorted.map((n, i) => [n.id, snap(first + i * step)]))
  return {
    ...ir,
    nodes: ir.nodes.map((n) => (moved.has(n.id) ? { ...n, layout: { ...at(n), [k]: moved.get(n.id) } } : n)),
  }
}

/** Everything to the 8px grid the drag handler already snaps to. */
export function snapAll(ir, gridSize = 8) {
  return {
    ...ir,
    nodes: ir.nodes.map((n) => ({ ...n, layout: { x: snap(at(n).x, gridSize), y: snap(at(n).y, gridSize) } })),
  }
}

/**
 * Pull a scattered design back to the origin without changing its shape.
 *
 * Dragging components around leaves the drawing wherever it ended up, which is
 * fine on screen and wrong in an export, where the empty space above and left of
 * the diagram is exported too.
 */
export function tighten(ir) {
  if (!ir.nodes.length) return ir
  const minX = Math.min(...ir.nodes.map((n) => at(n).x))
  const minY = Math.min(...ir.nodes.map((n) => at(n).y))
  return {
    ...ir,
    nodes: ir.nodes.map((n) => ({ ...n, layout: { x: snap(at(n).x - minX + MARGIN), y: snap(at(n).y - minY + MARGIN) } })),
  }
}
