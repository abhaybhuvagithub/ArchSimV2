// Structural diff between two IRs — what the gate turns into the "Change:"
// line of the PR comment.
//
// Matching is by id first (ingest derives ids deterministically from the IaC
// address, so a re-plan of the same repo produces the same ids) and by binding
// address second, which is what survives a node being rebuilt from scratch.

/**
 * The fields a diff compares, each paired with the accessor that reads it. The
 * pair is a tuple, not a list of two loosely-related things — saying so keeps
 * `get` callable instead of `string | function`.
 *
 * @typedef {[path: string, get: (x: any) => any]} FieldProbe
 * @type {FieldProbe[]}
 */
const CAP_FIELDS = [
  ['capacity.replicas', (n) => n.capacity.replicas],
  ['capacity.capPerReplica', (n) => n.capacity.capPerReplica],
  ['capacity.latencyMs.p50', (n) => n.capacity.latencyMs?.p50],
  ['capacity.availability', (n) => n.capacity.availability],
  ['capacity.concurrency', (n) => n.capacity.concurrency],
  ['capacity.queueDepth', (n) => n.capacity.queueDepth],
  ['kind', (n) => n.kind],
  ['label', (n) => n.label],
]

/** @type {FieldProbe[]} */
const EDGE_FIELDS = [
  ['callSemantics', (e) => e.callSemantics],
  ['protocol', (e) => e.protocol],
  ['timeoutMs', (e) => e.timeoutMs],
  ['retry.max', (e) => e.retry?.max],
  ['retry.budgetPct', (e) => e.retry?.budgetPct],
  ['breaker.errThreshold', (e) => e.breaker?.errThreshold],
  ['weight', (e) => e.weight],
]

export function diffIR(before, after) {
  const bIndex = indexNodes(before)
  const aIndex = indexNodes(after)
  const matched = new Map() // beforeId -> afterId

  for (const n of after.nodes) {
    if (bIndex.byId.has(n.id)) { matched.set(n.id, n.id); continue }
    for (const b of n.bindings || []) {
      const hit = bIndex.byAddress.get(addrKey(b))
      if (hit) { matched.set(hit.id, n.id); break }
    }
  }

  const addedNodes = after.nodes.filter((n) => ![...matched.values()].includes(n.id))
  const removedNodes = before.nodes.filter((n) => !matched.has(n.id))
  const changedNodes = []
  for (const [bId, aId] of matched) {
    const b = bIndex.byId.get(bId)
    const a = aIndex.byId.get(aId)
    const fields = []
    for (const [path, get] of CAP_FIELDS) {
      const x = get(b), y = get(a)
      if (!same(x, y)) fields.push({ path, from: x, to: y })
    }
    if (fields.length) changedNodes.push({ id: aId, label: a.label, address: primaryAddress(a) || primaryAddress(b), fields })
  }

  const bEdges = new Map(before.edges.map((e) => [edgeKey(e, matched), e]))
  const aEdges = new Map(after.edges.map((e) => [`${e.from}->${e.to}`, e]))
  const addedEdges = [...aEdges].filter(([k]) => !bEdges.has(k)).map(([, e]) => e)
  const removedEdges = [...bEdges].filter(([k]) => !aEdges.has(k)).map(([, e]) => e)
  const changedEdges = []
  for (const [k, be] of bEdges) {
    const ae = aEdges.get(k)
    if (!ae) continue
    const fields = []
    for (const [path, get] of EDGE_FIELDS) {
      const x = get(be), y = get(ae)
      if (!same(x, y)) fields.push({ path, from: x, to: y })
    }
    if (fields.length) changedEdges.push({ id: ae.id, from: ae.from, to: ae.to, fields })
  }

  const empty = !addedNodes.length && !removedNodes.length && !changedNodes.length
    && !addedEdges.length && !removedEdges.length && !changedEdges.length

  return {
    empty,
    nodes: { added: addedNodes, removed: removedNodes, changed: changedNodes },
    edges: { added: addedEdges, removed: removedEdges, changed: changedEdges },
    summary: summarize({ addedNodes, removedNodes, changedNodes, addedEdges, removedEdges, changedEdges }),
  }
}

// Fields a human edited, versus fields that moved because of one. Nobody
// changed `queueDepth`; they changed an instance class and six numbers followed.
// A change list that reports all six buries the one that matters.
const AUTHORED = new Set(['capacity.replicas', 'kind', 'label'])
const DERIVED_LABEL = {
  'capacity.capPerReplica': 'capacity',
  'capacity.latencyMs.p50': 'service time',
  'capacity.availability': 'availability',
  'capacity.concurrency': 'worker pool',
  'capacity.queueDepth': 'queue depth',
}

function summarize({ addedNodes, removedNodes, changedNodes, addedEdges, removedEdges, changedEdges }) {
  const parts = []
  for (const n of addedNodes) parts.push(`+ ${primaryAddress(n) || n.label}`)
  for (const n of removedNodes) parts.push(`− ${primaryAddress(n) || n.label}`)
  for (const c of changedNodes) {
    const name = c.address || c.label
    for (const f of c.fields.filter((x) => AUTHORED.has(x.path))) {
      parts.push(`${name} ${f.path.replace('capacity.', '')} ${fmt(f.from)}→${fmt(f.to)}`)
    }
    const derived = c.fields.filter((x) => !AUTHORED.has(x.path))
    const cap = derived.find((x) => x.path === 'capacity.capPerReplica')
    if (cap) parts.push(`${name} resized (${fmt(cap.from)}→${fmt(cap.to)} rps/replica)`)
    else if (derived.length) parts.push(`${name} ${DERIVED_LABEL[derived[0].path] || derived[0].path} ${fmt(derived[0].from)}→${fmt(derived[0].to)}`)
  }
  for (const e of addedEdges) parts.push(`+ edge ${e.from}→${e.to}`)
  for (const e of removedEdges) parts.push(`− edge ${e.from}→${e.to}`)
  for (const c of changedEdges) for (const f of c.fields) parts.push(`edge ${c.from}→${c.to} ${f.path} ${fmt(f.from)}→${fmt(f.to)}`)
  return parts
}

function indexNodes(ir) {
  const byId = new Map(ir.nodes.map((n) => [n.id, n]))
  const byAddress = new Map()
  for (const n of ir.nodes) for (const b of n.bindings || []) byAddress.set(addrKey(b), n)
  return { byId, byAddress }
}

const addrKey = (b) => `${b.lang}:${b.address}`
const primaryAddress = (n) => n?.bindings?.[0]?.address || null
const edgeKey = (e, matched) => `${matched.get(e.from) || e.from}->${matched.get(e.to) || e.to}`
const same = (a, b) => (a === b) || (a == null && b == null)
const fmt = (v) => (v === undefined || v === null ? '—' : String(v))
