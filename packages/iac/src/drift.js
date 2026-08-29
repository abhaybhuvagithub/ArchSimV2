// Drift: what is deployed versus what the design says.
//
// Three things can differ, and conflating them is the mistake that makes drift
// reports unreadable:
//
//   · **Undeployed** — the design has a component the live estate does not. A
//     pull request that has not merged looks exactly like this, so it is a
//     finding, not an error.
//   · **Unmanaged** — the estate has a resource the design does not. Someone
//     clicked something in a console, or an older stack still owns it. This is
//     the finding that costs money nobody has attributed.
//   · **Diverged** — both have it, and a field that changes the *simulation*
//     differs. A tag differing is not drift worth a report; a replica count
//     differing is a different system.
//
// The last distinction is the whole design of this module. Comparing every
// attribute produces a report where the real finding is on page four. Only
// fields the engine actually reads can change a verdict, so only those are
// compared, and each difference is reported with what it does to the model.

/**
 * Fields whose value changes what the simulator computes. Anything not here is
 * real, round-tripped, and irrelevant to whether the design holds.
 */
export const SIMULATION_FIELDS = [
  { path: ['capacity', 'replicas'], label: 'replicas', effect: 'capacity and availability' },
  { path: ['capacity', 'capPerReplica'], label: 'capacity per replica', effect: 'the saturation point' },
  { path: ['capacity', 'latencyMs', 'p50'], label: 'median latency', effect: 'every percentile downstream' },
  { path: ['capacity', 'availability'], label: 'availability', effect: 'composed system availability' },
  { path: ['capacity', 'concurrency'], label: 'concurrency', effect: 'queueing and thread starvation' },
  { path: ['capacity', 'queueDepth'], label: 'queue depth', effect: 'where shedding begins' },
  { path: ['capacity', 'cacheHit'], label: 'cache hit rate', effect: 'load reaching everything behind it' },
  { path: ['kind'], label: 'component kind', effect: 'the whole capacity model for this node' },
]

const at = (obj, path) => path.reduce((o, k) => (o == null ? undefined : o[k]), obj)

/** Address is the join key: it is what both sides agree on about identity. */
const addressesOf = (node) => (node.bindings || []).map((b) => b.address).filter(Boolean)

function indexByAddress(ir) {
  const map = new Map()
  for (const node of ir.nodes || []) {
    for (const addr of addressesOf(node)) map.set(addr, node)
    // A node with no binding — drawn on the canvas, never emitted — can only be
    // matched by label, and the report says the match was weaker.
    if (!addressesOf(node).length) map.set(`label:${node.label}`, node)
  }
  return map
}

/**
 * Compare a committed IR against one ingested from live state.
 *
 * Named for what it does rather than for the word 'drift', because the twin
 * exports a `detectDrift` of its own about a different thing entirely: that one
 * compares the model to telemetry, this one compares the design to the estate.
 *
 * Both sides are IR, which is the point: `terraform show -json`, `kubectl get -o
 * json`, a Pulumi stack export and a CloudFormation template all become IR
 * first, so drift is one comparison rather than one per provider.
 *
 * @param design  the IR under review (a lockfile, or the canvas)
 * @param live    the IR ingested from deployed state
 */
export function compareToDeployed(design, live, opts = {}) {
  const byDesign = indexByAddress(design)
  const byLive = indexByAddress(live)
  const ignore = new Set(opts.ignore || [])

  const undeployed = []
  const unmanaged = []
  const diverged = []

  const seenLive = new Set()

  for (const [addr, node] of byDesign) {
    if (ignore.has(addr)) continue
    const match = byLive.get(addr) || (addr.startsWith('label:') ? null : byLive.get(`label:${node.label}`))
    if (!match) {
      if (!undeployed.some((u) => u.node.id === node.id)) {
        undeployed.push({ address: addr, node, label: node.label, kind: node.kind })
      }
      continue
    }
    seenLive.add(match.id)

    const fields = []
    for (const f of SIMULATION_FIELDS) {
      const a = at(node, f.path)
      const b = at(match, f.path)
      if (a === undefined && b === undefined) continue
      if (numericallySame(a, b)) continue
      fields.push({ field: f.label, effect: f.effect, design: a, live: b })
    }
    if (fields.length) {
      diverged.push({ address: addr, label: node.label, kind: node.kind, fields, weakMatch: !byLive.has(addr) })
    }
  }

  for (const [addr, node] of byLive) {
    if (ignore.has(addr) || seenLive.has(node.id)) continue
    if (byDesign.has(addr)) continue
    if (!unmanaged.some((u) => u.node.id === node.id)) {
      unmanaged.push({ address: addr, node, label: node.label, kind: node.kind })
    }
  }

  // Edges drift too, and a missing edge is a missing dependency — which is a
  // capacity path the design believes exists and production does not.
  const designEdges = edgeKeys(design)
  const liveEdges = edgeKeys(live)
  const edges = {
    missing: [...designEdges].filter((k) => !liveEdges.has(k)),
    extra: [...liveEdges].filter((k) => !designEdges.has(k)),
  }

  return {
    undeployed,
    unmanaged,
    diverged,
    edges,
    clean: !undeployed.length && !unmanaged.length && !diverged.length,
    counts: {
      undeployed: undeployed.length,
      unmanaged: unmanaged.length,
      diverged: diverged.length,
      edgesMissing: edges.missing.length,
      edgesExtra: edges.extra.length,
    },
  }
}

/**
 * A replica count of `3` and `"3"` are the same system. Floating-point capacity
 * figures that differ in the twelfth decimal are the same system too — the
 * comparison is between two models, and a model does not have twelve
 * significant figures.
 */
function numericallySame(a, b) {
  if (a === b) return true
  const na = Number(a)
  const nb = Number(b)
  if (Number.isFinite(na) && Number.isFinite(nb)) {
    const scale = Math.max(Math.abs(na), Math.abs(nb), 1)
    return Math.abs(na - nb) / scale < 1e-6
  }
  return false
}

function edgeKeys(ir) {
  const label = new Map((ir.nodes || []).map((n) => [n.id, n.label]))
  return new Set((ir.edges || []).map((e) => `${label.get(e.from) || e.from} → ${label.get(e.to) || e.to}`))
}

/** The report a person reads, or a pull request comment. */
export function driftMarkdown(drift, opts = {}) {
  const title = drift.clean
    ? '✅ No drift — the deployed estate matches the design'
    : `⚠️ ${drift.counts.diverged} diverged · ${drift.counts.unmanaged} unmanaged · ${drift.counts.undeployed} undeployed`
  const out = [`## 🏗️ ArchSim drift — ${title}`, '']

  if (drift.diverged.length) {
    out.push('### Diverged', '', 'Both sides have these, and a field the simulator reads differs.', '')
    out.push('| Component | Field | Design | Deployed | What it changes |', '|---|---|---:|---:|---|')
    for (const d of drift.diverged) {
      for (const f of d.fields) {
        out.push(`| \`${d.label}\`${d.weakMatch ? ' *(matched by name)*' : ''} | ${f.field} | ${fmt(f.design)} | ${fmt(f.live)} | ${f.effect} |`)
      }
    }
    out.push('')
  }

  if (drift.unmanaged.length) {
    out.push('### Unmanaged', '', 'Deployed, and in nobody\'s design. Someone made these by hand, or an older stack still owns them.', '')
    for (const u of drift.unmanaged) out.push(`- \`${u.label}\` (${u.kind}) — \`${u.address}\``)
    out.push('')
  }

  if (drift.undeployed.length) {
    out.push('### Undeployed', '', 'In the design, not in the estate. An unmerged pull request looks exactly like this.', '')
    for (const u of drift.undeployed) out.push(`- \`${u.label}\` (${u.kind}) — \`${u.address}\``)
    out.push('')
  }

  if (drift.edges.missing.length || drift.edges.extra.length) {
    out.push('### Connections', '')
    for (const e of drift.edges.missing) out.push(`- missing in the estate: ${e}`)
    for (const e of drift.edges.extra) out.push(`- present in the estate only: ${e}`)
    out.push('')
  }

  if (opts.note) out.push('', `<sub>${opts.note}</sub>`)
  return out.join('\n') + '\n'
}

const fmt = (v) => (v === undefined ? '—' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(4)) : `\`${v}\``)
