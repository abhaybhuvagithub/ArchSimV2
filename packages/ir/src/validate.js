// IR validation. No dependencies — the gate ships as a single binary onto
// airgapped runners, so a schema library we cannot vendor is a library we
// cannot use.
//
// Errors are things that make the IR unusable. Warnings are things that make
// the *answers* less trustworthy, and the gate prints them next to the verdict
// rather than swallowing them: a p99 computed from four 'modeled' nodes and a
// guessed edge deserves a louder caveat than one computed from telemetry.

import {
  IR_VERSION, CALL_SEMANTICS, PROTOCOLS, MANAGED, IAC_LANGS,
  PROVENANCE_CLASSES, SLO_METRICS, ARRIVAL_DISTS, LATENCY_DISTS,
} from './schema.js'

export function validateIR(ir, { kinds = null } = {}) {
  const errors = []
  const warnings = []
  const err = (path, msg) => errors.push({ path, msg })
  const warn = (path, msg) => warnings.push({ path, msg })

  if (!ir || typeof ir !== 'object') return { ok: false, errors: [{ path: '/', msg: 'IR is not an object' }], warnings }
  if (ir.irVersion !== IR_VERSION) err('/irVersion', `expected '${IR_VERSION}', got ${JSON.stringify(ir.irVersion)}`)
  if (!Array.isArray(ir.nodes)) err('/nodes', 'must be an array')
  if (!Array.isArray(ir.edges)) err('/edges', 'must be an array')
  if (errors.length) return { ok: false, errors, warnings }

  const ids = new Set()
  ir.nodes.forEach((n, i) => {
    const p = `/nodes/${i}`
    if (!n.id) err(p, 'node has no id')
    else if (ids.has(n.id)) err(p, `duplicate node id ${n.id}`)
    ids.add(n.id)
    if (kinds && !kinds.includes(n.kind)) warn(`${p}/kind`, `unknown kind '${n.kind}' — will simulate as 'custom'`)
    const c = n.capacity
    if (!c) { err(`${p}/capacity`, 'missing capacity model'); return }
    if (!(c.replicas >= 0)) err(`${p}/capacity/replicas`, 'must be >= 0')
    if (!(c.capPerReplica >= 0)) err(`${p}/capacity/capPerReplica`, 'must be >= 0')
    if (!(c.availability >= 0 && c.availability <= 1)) err(`${p}/capacity/availability`, 'must be in [0,1]')
    if (c.latencyMs && !LATENCY_DISTS.includes(c.latencyMs.dist)) err(`${p}/capacity/latencyMs/dist`, `unknown dist '${c.latencyMs.dist}'`)
    if (c.provenance && !PROVENANCE_CLASSES[c.provenance.cls]) err(`${p}/capacity/provenance/cls`, `unknown class '${c.provenance.cls}'`)
    if (c.provenance?.cls === 'modeled' && !c.source) warn(`${p}/capacity/provenance`, `'${n.label}' runs on a modelled prior (±${c.jitter?.capPct ?? 40}%), not a measurement`)
    for (const [j, b] of (n.bindings || []).entries()) {
      const bp = `${p}/bindings/${j}`
      if (!IAC_LANGS.includes(b.lang)) err(`${bp}/lang`, `unknown lang '${b.lang}'`)
      if (!b.address) err(`${bp}/address`, 'binding has no address')
      if (!MANAGED.includes(b.managed)) err(`${bp}/managed`, `must be one of ${MANAGED.join('|')}`)
      if (b.managed !== 'observed' && !b.range && b.lang !== 'plan-json') {
        warn(`${bp}/range`, `'${b.address}' is ${b.managed} but has no CST anchor — edits will regenerate, not patch`)
      }
    }
    if (!(n.bindings || []).length && !c.source) warn(`${p}/bindings`, `'${n.label}' has no IaC binding — it exists on the canvas but not in code`)
  })

  ir.edges.forEach((e, i) => {
    const p = `/edges/${i}`
    if (!ids.has(e.from)) err(`${p}/from`, `dangling edge source ${e.from}`)
    if (!ids.has(e.to)) err(`${p}/to`, `dangling edge target ${e.to}`)
    if (!CALL_SEMANTICS.includes(e.callSemantics)) err(`${p}/callSemantics`, `unknown '${e.callSemantics}'`)
    if (e.protocol && !PROTOCOLS.includes(e.protocol)) err(`${p}/protocol`, `unknown '${e.protocol}'`)
    if (e.retry?.max > 0 && !e.timeoutMs) warn(`${p}/timeoutMs`, 'retries without a timeout: the retry can only fire after the call gives up on its own')
    if (e.retry?.max > 0 && !(e.retry.budgetPct > 0)) warn(`${p}/retry/budgetPct`, 'unbudgeted retries — the DES will show this amplify under load (§5.4)')
    if (e.confidence === 'low') warn(`${p}/confidence`, `inferred edge ${e.from}→${e.to} is low confidence — confirm it before trusting the verdict`)
  })

  for (const [i, w] of (ir.workloads || []).entries()) {
    if (!w.id) err(`/workloads/${i}/id`, 'workload has no id')
    if (!ARRIVAL_DISTS.includes(w.arrival?.dist)) err(`/workloads/${i}/arrival/dist`, `unknown '${w.arrival?.dist}'`)
    if (!(w.arrival?.rps > 0)) err(`/workloads/${i}/arrival/rps`, 'must be > 0')
  }

  const wIds = new Set((ir.workloads || []).map((w) => w.id))
  for (const [i, s] of (ir.slos || []).entries()) {
    const p = `/slos/${i}`
    if (!SLO_METRICS.includes(s.metric)) err(`${p}/metric`, `unknown metric '${s.metric}'`)
    if (!['<=', '>='].includes(s.op)) err(`${p}/op`, `must be <= or >=`)
    if (typeof s.threshold !== 'number') err(`${p}/threshold`, 'must be a number')
    if (s.under && s.under !== 'all' && !wIds.has(s.under)) err(`${p}/under`, `references unknown workload '${s.under}'`)
    if (typeof s.scope === 'object' && s.scope.node && !ids.has(s.scope.node)) err(`${p}/scope/node`, `references unknown node '${s.scope.node}'`)
    if (s.scenarios !== undefined && !Array.isArray(s.scenarios)) err(`${p}/scenarios`, 'must be an array of scenario ids')
  }

  const sources = ir.nodes.filter((n) => n.capacity?.source)
  if (ir.nodes.length && !sources.length) warn('/nodes', 'no traffic source — nothing will be simulated. Mark a client/ingress node with capacity.source')

  return { ok: errors.length === 0, errors, warnings }
}

export function assertValid(ir, opts) {
  const r = validateIR(ir, opts)
  if (!r.ok) {
    const e = new Error(`invalid ArchIR:\n${r.errors.map((x) => `  ${x.path}: ${x.msg}`).join('\n')}`)
    e.errors = r.errors
    throw e
  }
  return r
}
