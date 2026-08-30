// Construction, normalization and canonical serialization of the IR.
//
// Two properties everything downstream depends on:
//   1. `normalizeIR` is idempotent — normalize(normalize(x)) deep-equals normalize(x).
//   2. `canonical` is stable under key order and array order, so `irHash` is a
//      content address. The gate prints that hash; two runs that print the same
//      hash were the same architecture, whatever the file diff looked like.

import { IR_VERSION, FALLBACK_CAPACITY, DEFAULT_JITTER, PROVENANCE_CLASSES } from './schema.js'
import { ulid, ulidFrom } from './ulid.js'

export function createIR(meta = {}) {
  return {
    irVersion: IR_VERSION,
    meta: {
      name: meta.name || 'untitled',
      createdBy: meta.createdBy || 'archsim',
      updatedAt: meta.updatedAt || '1970-01-01T00:00:00.000Z',
      ...meta,
    },
    nodes: [],
    edges: [],
    workloads: [],
    slos: [],
    deployments: [],
    passthrough: [],
  }
}

/**
 * Build an IR node. `capacityFor(kind)` lets the caller seed from the catalog
 * without the IR package depending on the catalog.
 *
 * Every field is optional and the body says what each one falls back to. That
 * is worth stating in a type rather than only in the code, because the six
 * ingest paths each supply a different subset and the compiler is the only
 * thing that reads all six.
 *
 * @typedef {object} NodeSpec
 * @property {string} [id]        ULID; minted when absent, never derived from the label
 * @property {string} [kind]      catalog kind (default 'custom')
 * @property {string} [label]     human name (defaults to the kind)
 * @property {any}    [capacity]  overrides merged over the catalog seed
 * @property {any[]}  [bindings]  where in the source this node came from
 * @property {any}    [telemetry]
 * @property {any}    [layout]
 * @property {any}    [attrs]
 * @property {any}    [overrides]
 *
 * @param {NodeSpec} spec
 * @param {(kind: string) => any} [capacityFor] catalog lookup, injected so this package stays dependency-free
 */
export function irNode({ id, kind, label, capacity, bindings, telemetry, layout, attrs, overrides }, capacityFor) {
  const seeded = capacityFor ? capacityFor(kind) : null
  return {
    id: id || ulid(),
    kind: kind || 'custom',
    label: label || kind || 'node',
    capacity: normalizeCapacity({ ...(seeded || FALLBACK_CAPACITY), ...(capacity || {}) }),
    bindings: bindings || [],
    ...(telemetry ? { telemetry } : {}),
    ...(layout ? { layout } : {}),
    ...(overrides ? { overrides } : {}),
    attrs: attrs || {},
  }
}

/**
 * Build an IR edge. Only `from` and `to` are meaningful without a default —
 * an edge that does not say what it connects is not an edge.
 *
 * @typedef {object} EdgeSpec
 * @property {string} [id]   defaults to a ULID derived from `from->to`
 * @property {string} from
 * @property {string} to
 * @property {string} [callSemantics] 'sync' (default) or 'async'
 * @property {string} [protocol]
 * @property {number} [weight]
 * @property {number} [timeoutMs]
 * @property {any}    [retry]
 * @property {any}    [breaker]
 * @property {string} [confidence]  'high' when read from source, lower when inferred
 * @property {number} [readFrac]
 * @property {any}    [attrs]
 *
 * @param {EdgeSpec} spec
 */
export function irEdge({ id, from, to, callSemantics, protocol, weight, timeoutMs, retry, breaker, confidence, readFrac, attrs }) {
  return {
    id: id || ulidFrom(`${from}->${to}`),
    from,
    to,
    callSemantics: callSemantics || 'sync',
    ...(protocol ? { protocol } : {}),
    ...(weight !== undefined ? { weight } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(retry ? { retry } : {}),
    ...(breaker ? { breaker } : {}),
    ...(confidence ? { confidence } : {}),
    ...(readFrac !== undefined ? { readFrac } : {}),
    ...(attrs ? { attrs } : {}),
  }
}

export function normalizeCapacity(c = {}) {
  const lat = c.latencyMs == null
    ? { ...FALLBACK_CAPACITY.latencyMs }
    : typeof c.latencyMs === 'number'
      ? { dist: 'lognormal', p50: c.latencyMs, cv: 0.5 }
      : { dist: c.latencyMs.dist || 'lognormal', p50: num(c.latencyMs.p50 ?? c.latencyMs.base, 10), cv: num(c.latencyMs.cv, 0.5) }
  const prov = c.provenance || FALLBACK_CAPACITY.provenance
  const cls = PROVENANCE_CLASSES[prov.cls] ? prov.cls : 'modeled'
  const jitter = c.jitter || PROVENANCE_CLASSES[cls].jitter || DEFAULT_JITTER
  const capRaw = c.capPerReplica
  return {
    replicas: Math.max(0, Math.round(num(c.replicas, 1))),
    capPerReplica: capRaw === Infinity || capRaw === 'Infinity' ? Infinity : Math.max(0, num(capRaw, FALLBACK_CAPACITY.capPerReplica)),
    latencyMs: lat,
    availability: clamp(num(c.availability, 0.999), 0, 1),
    concurrency: Math.max(0, Math.round(num(c.concurrency, FALLBACK_CAPACITY.concurrency))),
    queueDepth: Math.max(0, Math.round(num(c.queueDepth, FALLBACK_CAPACITY.queueDepth))),
    ...(c.cacheHit !== undefined ? { cacheHit: clamp(num(c.cacheHit, 0), 0, 1) } : {}),
    ...(c.source ? { source: true } : {}),
    provenance: { cls, basis: prov.basis || '', refs: prov.refs || [] },
    jitter: { capPct: num(jitter.capPct, 40), latPct: num(jitter.latPct, 40) },
  }
}

/**
 * Fill defaults, drop dangling edges, sort deterministically. Idempotent —
 * asserted in the suite, because the gate diffs normalized IRs and a
 * normalization that wandered would manufacture phantom changes in PRs.
 */
export function normalizeIR(ir) {
  const out = {
    irVersion: IR_VERSION,
    meta: { name: 'untitled', createdBy: 'archsim', updatedAt: '1970-01-01T00:00:00.000Z', ...(ir.meta || {}) },
    nodes: [],
    edges: [],
    workloads: [],
    slos: [],
    deployments: [],
    passthrough: [],
  }
  const seen = new Set()
  for (const n of ir.nodes || []) {
    if (!n || !n.id || seen.has(n.id)) continue
    seen.add(n.id)
    out.nodes.push({
      id: n.id,
      kind: n.kind || 'custom',
      label: n.label || n.kind || n.id,
      capacity: normalizeCapacity(n.capacity),
      bindings: (n.bindings || []).map(normalizeBinding).sort(byKey((b) => `${b.file}#${b.address}`)),
      ...(n.telemetry ? { telemetry: n.telemetry } : {}),
      ...(n.layout ? { layout: { x: Math.round(num(n.layout.x, 0)), y: Math.round(num(n.layout.y, 0)) } } : {}),
      ...(n.overrides && Object.keys(n.overrides).length ? { overrides: n.overrides } : {}),
      attrs: n.attrs || {},
    })
  }
  const ids = new Set(out.nodes.map((n) => n.id))
  const edgeSeen = new Set()
  for (const e of ir.edges || []) {
    if (!e || !ids.has(e.from) || !ids.has(e.to)) continue
    const id = e.id || ulidFrom(`${e.from}->${e.to}`)
    if (edgeSeen.has(id)) continue
    edgeSeen.add(id)
    out.edges.push({ ...irEdge({ ...e, id }) })
  }
  out.workloads = (ir.workloads || []).map((w) => ({
    id: w.id,
    arrival: { dist: w.arrival?.dist || 'const', rps: num(w.arrival?.rps, 100), params: w.arrival?.params || {} },
    ...(w.mix ? { mix: { readPct: clamp(num(w.mix.readPct, 50), 0, 100) } } : {}),
  }))
  out.slos = (ir.slos || []).map((s) => ({
    id: s.id,
    scope: s.scope || 'system',
    metric: s.metric,
    op: s.op || '<=',
    threshold: num(s.threshold, 0),
    under: s.under || 'all',
    // Which chaos scenarios this SLO must survive. Omitted means all declared
    // scenarios, which is the strict reading of "will this hold up". Scope it
    // to ['nominal'] for a target that is only meaningful in steady state.
    ...(s.scenarios ? { scenarios: [...s.scenarios].sort() } : {}),
  }))
  out.deployments = ir.deployments || []
  out.passthrough = (ir.passthrough || []).map((p) => ({
    lang: p.lang, file: p.file, text: p.text, ...(p.anchorAfter ? { anchorAfter: p.anchorAfter } : {}),
  }))

  out.nodes.sort(byKey((n) => n.id))
  out.edges.sort(byKey((e) => `${e.from}|${e.to}|${e.id}`))
  out.workloads.sort(byKey((w) => w.id))
  out.slos.sort(byKey((s) => s.id))
  out.passthrough.sort(byKey((p) => `${p.file}|${p.anchorAfter || ''}`))
  return out
}

function normalizeBinding(b) {
  return {
    lang: b.lang,
    file: b.file,
    address: b.address,
    ...(b.range ? { range: { startByte: b.range.startByte, endByte: b.range.endByte } } : {}),
    managed: b.managed || 'observed',
  }
}

/** Stable JSON: object keys sorted, arrays already ordered by normalizeIR. */
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === Infinity ? 'Infinity' : value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
}

/** FNV-1a over the canonical form. Short, stable, printed in every report. */
export function irHash(ir) {
  const s = canonical(normalizeIR(ir))
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  let h2 = 0x9dc5811c
  for (let i = s.length - 1; i >= 0; i--) {
    h2 ^= s.charCodeAt(i)
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0
  }
  return (h.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0'))
}

/** Serialize for `archsim.lock.json` — the twin lockfile that lives in git. */
export function serializeIR(ir) {
  return JSON.stringify(replaceInfinity(normalizeIR(ir)), null, 2) + '\n'
}

export function parseIR(text) {
  return normalizeIR(reviveInfinity(JSON.parse(text)))
}

function replaceInfinity(v) {
  if (v === Infinity) return 'Infinity'
  if (Array.isArray(v)) return v.map(replaceInfinity)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, replaceInfinity(x)]))
  return v
}
function reviveInfinity(v) {
  if (v === 'Infinity') return Infinity
  if (Array.isArray(v)) return v.map(reviveInfinity)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, reviveInfinity(x)]))
  return v
}

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const byKey = (f) => (a, b) => (f(a) < f(b) ? -1 : f(a) > f(b) ? 1 : 0)
