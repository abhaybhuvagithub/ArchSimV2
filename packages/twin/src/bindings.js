// Mapping telemetry back onto the IR — the resolution ladder.
//
//   1. Declared  — an `archsim.io/node=<ulid>` resource attribute or label. The
//      IaC compiler *emits* these, so the two halves close the loop: what we
//      generated is what we can identify.
//   2. Matched   — `service.name` or `k8s.deployment.name` equals an IaC binding
//      address or a workload name. Not a guess; the same string on both sides.
//   3. Heuristic — fuzzy name match. Rendered dashed until a human confirms, and
//      confirming persists it as a declared binding, so the guess is made once
//      and never again.
//
// And the part that earns the money: series that match *nothing* become ghost
// nodes. The twin discovers what the diagram forgot, which is how a first
// session ends with "your architecture review is missing four services that
// production knows about".

export const CONFIDENCE_ORDER = { declared: 3, matched: 2, heuristic: 1 }

export function buildResolver(ir) {
  const byUlid = new Map(ir.nodes.map((n) => [n.id, n]))
  const byService = new Map()
  const byWorkload = new Map()
  const byLabel = new Map()

  for (const n of ir.nodes) {
    const t = n.telemetry
    if (t?.service) byService.set(t.service.toLowerCase(), n)
    if (t?.k8s?.workload) byWorkload.set(`${t.k8s.namespace}/${t.k8s.workload}`.toLowerCase(), n)
    byLabel.set(String(n.label).toLowerCase(), n)
    for (const b of n.bindings || []) {
      const tail = String(b.address).split(/[.:/]/).pop()
      if (tail) byLabel.set(tail.toLowerCase(), n)
    }
  }

  /**
   * @param series {{ attributes?: object, service?: string, namespace?: string,
   *                  workload?: string, name?: string }}
   */
  return function resolve(series) {
    const declared = series.attributes?.['archsim.io/node'] || series.attributes?.['archsim_io_node']
    if (declared && byUlid.has(declared)) return { node: byUlid.get(declared), confidence: 'declared' }

    const svc = (series.service || series.attributes?.['service.name'] || '').toLowerCase()
    if (svc && byService.has(svc)) return { node: byService.get(svc), confidence: 'matched' }

    const ns = (series.namespace || series.attributes?.['k8s.namespace.name'] || 'default').toLowerCase()
    const wl = (series.workload || series.attributes?.['k8s.deployment.name'] || '').toLowerCase()
    if (wl && byWorkload.has(`${ns}/${wl}`)) return { node: byWorkload.get(`${ns}/${wl}`), confidence: 'matched' }

    const name = (series.name || svc || wl || '').toLowerCase()
    if (name && byLabel.has(name)) return { node: byLabel.get(name), confidence: 'matched' }

    // Fuzzy: normalise separators and try again, then substring containment.
    const norm = name.replace(/[-_.]/g, '')
    for (const [k, node] of byLabel) {
      if (!k) continue
      if (k.replace(/[-_.]/g, '') === norm) return { node, confidence: 'heuristic', why: `name '${name}' matches '${k}' once separators are ignored` }
    }
    for (const [k, node] of byLabel) {
      if (k.length > 3 && norm.includes(k.replace(/[-_.]/g, ''))) return { node, confidence: 'heuristic', why: `'${name}' contains '${k}'` }
    }
    return { node: null, confidence: null, name: series.service || series.name || wl || 'unknown' }
  }
}

/**
 * Services production knows about and the diagram does not.
 *
 * A ghost node is not an error state — it is the finding. It renders on the
 * canvas in a distinct style with its observed traffic, and adopting it writes a
 * real node with `provenance: 'telemetry'`, which is the only provenance class
 * that is a measurement rather than a prior.
 */
export function discoverGhosts(unresolved, edgesSeen = []) {
  const ghosts = new Map()
  for (const s of unresolved) {
    const key = s.name || 'unknown'
    if (!ghosts.has(key)) ghosts.set(key, { name: key, rps: 0, p99: 0, errRate: 0, samples: 0, peers: new Set() })
    const g = ghosts.get(key)
    g.rps += s.rps || 0
    g.p99 = Math.max(g.p99, s.p99 || 0)
    g.errRate = Math.max(g.errRate, s.errRate || 0)
    g.samples++
  }
  for (const e of edgesSeen) {
    if (ghosts.has(e.from)) ghosts.get(e.from).peers.add(e.to)
    if (ghosts.has(e.to)) ghosts.get(e.to).peers.add(e.from)
  }
  return [...ghosts.values()]
    .map((g) => ({ ...g, peers: [...g.peers] }))
    .sort((a, b) => b.rps - a.rps)
}

/**
 * Confirming a heuristic binding. The confirmation is written back as a declared
 * binding *and* returned as an annotation patch, so the next ingest of the code
 * carries the answer with it rather than re-deriving it.
 */
export function confirmBinding(ir, nodeId, series) {
  const node = ir.nodes.find((n) => n.id === nodeId)
  if (!node) return { ir, patch: null }
  const telemetry = {
    ...(node.telemetry || {}),
    ...(series.service ? { service: series.service } : {}),
    ...(series.workload ? { k8s: { namespace: series.namespace || 'default', workload: series.workload } } : {}),
    ...(series.promSelector ? { promSelector: series.promSelector } : {}),
    confidence: 'declared',
  }
  return {
    ir: { ...ir, nodes: ir.nodes.map((n) => (n.id === nodeId ? { ...n, telemetry } : n)) },
    patch: {
      kind: 'annotation',
      target: node.bindings?.[0]?.address || node.label,
      annotation: { 'archsim.io/node': node.id },
      note: 'Add this annotation to the workload so the binding survives without ArchSim having to guess again.',
    },
  }
}

/** Edges from traces: span pairs that cross a service boundary. */
export function edgesFromSpans(spans, resolve) {
  const agg = new Map()
  for (const s of spans) {
    const parentSvc = s.parentService || s.attributes?.['parent.service.name']
    const childSvc = s.service || s.attributes?.['service.name']
    // `span.kind=client` plus `peer.service`/`db.system` catches the sinks that
    // were never instrumented — the database that has no agent but is very
    // definitely on the critical path.
    const peer = s.attributes?.['peer.service'] || s.attributes?.['db.system'] || s.attributes?.['messaging.system']
    const from = parentSvc || childSvc
    const to = s.kind === 'client' && peer ? peer : childSvc
    if (!from || !to || from === to) continue
    const key = `${from}->${to}`
    if (!agg.has(key)) agg.set(key, { from, to, calls: 0, errors: 0, durations: [] })
    const a = agg.get(key)
    a.calls++
    if (s.status === 'error' || s.error) a.errors++
    if (Number.isFinite(s.durationMs)) a.durations.push(s.durationMs)
  }
  return [...agg.values()].map((a) => {
    const sorted = a.durations.sort((x, y) => x - y)
    return {
      from: a.from, to: a.to,
      fromNode: resolve ? resolve({ service: a.from }).node : null,
      toNode: resolve ? resolve({ service: a.to }).node : null,
      rps: a.calls,
      errRate: a.calls ? a.errors / a.calls : 0,
      p99: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] : 0,
    }
  })
}
