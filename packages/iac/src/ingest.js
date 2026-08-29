// Ingestion — two modes, deliberately.
//
// Mode A (plan JSON / live cluster JSON): exact. `terraform show -json tfplan`
// hands us the fully evaluated resource graph — every count expanded, every
// variable resolved — as JSON Terraform itself guarantees. Same move for
// Kubernetes: `kubectl get -A -o json` or rendered Helm output beats parsing
// templated YAML. The cost is that a plan must exist; for the CI gate that
// dependency is free, because a plan already exists in every PR pipeline.
//
// Mode B (static HCL/YAML): best-effort, and honest about it. We parse the CST,
// evaluate literals and simple references, and degrade gracefully: a resource
// with an unresolvable `count` renders as one replica with the badge "count
// unresolved: shown as 1×" and a `modeled` provenance class that widens its
// Monte-Carlo band. Honesty over hallucination.
//
// Both modes agree on the two rules that matter: nothing is ever dropped, and
// every byte we did not model comes back out unchanged.

import { createIR, irNode, irEdge, normalizeIR, ulidFrom } from '@archsim/ir'
import { capacityFor } from '@archsim/core'
import { findRule, isStructural, isConnector, isNoise, providerOf } from './mappings/index.js'
import { inferEdges, annotationEdges, protocolFor, callSemanticsFor } from './edges.js'
import { parseHCL, walkBlocks, addressOf, bodyOf, attrValue } from './hcl.js'
import { parseYamlDocs, k8sAddress } from './yaml.js'
import { selectorMatches, isWorkload, envServiceEdges, firstContainer, ns } from './mappings/k8s.js'

const ctxBase = { seed: (kind) => capacityFor(kind) }

// ── Mode A: Terraform plan / state JSON ─────────────────────────────────────

/**
 * @param plan   parsed `terraform show -json` output (plan or state)
 * @param opts.file  the file it came from, for bindings
 * @param opts.managed default 'observed' — read-only until the user opts in.
 *   This is the adoption unlock: a brownfield estate renders without ArchSim
 *   asking permission to own anyone's Terraform.
 */
export function planJsonToIR(plan, opts = {}) {
  const file = opts.file || 'tfplan.json'
  const managed = opts.managed || 'observed'
  const ir = createIR({ name: opts.name || 'terraform', createdBy: 'archsim-iac' })
  const report = { mapped: 0, structural: 0, unmapped: 0, dropped: 0, resources: [], warnings: [] }

  const resources = collectResources(plan)
  const nodesByAddress = new Map()
  const connectors = new Set()
  const hints = []
  const annotated = []

  for (const res of resources) {
    const type = res.type
    const provider = providerOf(type)
    const attrs = res.values || {}
    const rule = findRule(provider, type, attrs)

    if (!rule && (isStructural(type) || isNoise(type))) {
      if (isConnector(type)) connectors.add(res.address)
      report.structural++
      report.resources.push({ address: res.address, type, disposition: isConnector(type) ? 'connector' : isNoise(type) ? 'noise' : 'structural' })
      continue
    }
    if (rule?.edgeOnly) {
      connectors.add(res.address)
      for (const h of rule.edges?.(attrs, edgeCtx(res, resources)) || []) hints.push({ from: h.from || res.address, to: h.to, confidence: h.confidence, reason: h.reason, protocol: h.protocol })
      report.resources.push({ address: res.address, type, disposition: 'edge-only' })
      continue
    }

    const kind = rule ? (rule.kind || rule.kindOf?.(attrs) || 'custom') : 'custom'
    if (!rule) {
      report.unmapped++
      report.warnings.push({ address: res.address, msg: `no mapping rule for '${type}' — rendered as a custom component and simulated conservatively, not dropped` })
    } else {
      report.mapped++
    }

    const seeded = capacityFor(kind, rule ? {} : { provenanceCls: 'modeled', basis: `no mapping rule for '${type}'; simulated as a generic component` })
    const ruleCap = rule?.capacity?.(attrs, { ...ctxBase, address: res.address, ...edgeCtx(res, resources) }) || {}
    const cap = { ...seeded, ...ruleCap }
    // A count-expanded resource states its own replica count; a single resource
    // that models an HA pair (multi_az, a replication group) lets the rule say so.
    cap.replicas = res.expandedCount > 1 ? res.expandedCount : (ruleCap.replicas ?? 1)

    const node = irNode({
      id: ulidFrom(`tf:${res.address}`),
      kind,
      label: rule?.label?.(attrs, res.address) || labelFor(res),
      capacity: cap,
      bindings: [{ lang: 'plan-json', file, address: res.address, managed }],
      attrs: { ...(rule?.attrs?.(attrs) || {}), tfType: type, ...(res.expandedCount > 1 ? { expandedFrom: res.expandedCount } : {}) },
    })
    // strip undefined attrs so the IR hash stays stable
    node.attrs = Object.fromEntries(Object.entries(node.attrs).filter(([, v]) => v !== undefined))
    ir.nodes.push(node)
    nodesByAddress.set(res.address, node)
    report.resources.push({ address: res.address, type, disposition: rule ? 'mapped' : 'unmapped', kind })

    for (const h of rule?.edges?.(attrs, { ...ctxBase, address: res.address, ...edgeCtx(res, resources) }) || []) {
      hints.push({ from: h.from || res.address, to: h.to, confidence: h.confidence, reason: h.reason, protocol: h.protocol })
    }
    if (attrs.tags?.['archsim.io/edge']) annotated.push({ address: res.address, annotations: attrs.tags })
  }

  const deps = dependencyGraph(plan, resources)
  const mkEdge = (spec) => irEdge(spec)
  ir.edges.push(...inferEdges(hints, nodesByAddress, connectors, deps, mkEdge))
  ir.edges.push(...annotationEdges(annotated, nodesByAddress, mkEdge))

  attachClient(ir)
  report.passthrough = 0
  return { ir: normalizeIR(ir), report }
}

function collectResources(plan) {
  const root = plan?.planned_values?.root_module || plan?.values?.root_module || plan?.root_module
  const flat = []
  const walk = (mod, prefix) => {
    if (!mod) return
    for (const r of mod.resources || []) {
      if (r.mode === 'data') continue
      flat.push({ ...r, address: prefix ? `${prefix}.${r.address}` : r.address })
    }
    for (const child of mod.child_modules || []) walk(child, child.address ? '' : prefix)
  }
  walk(root, '')

  // Terraform expands `count` and `for_each` into one instance per index —
  // `aws_instance.checkout[0]` through `[5]`. That expansion is exactly what
  // makes Mode A exact, and exactly what we have to fold back up: six identical
  // instances behind one target group are one component with six replicas, not
  // six components. The instance count becomes `replicas`, which is the number
  // the simulator, the cost model and the gate all actually need.
  const groups = new Map()
  for (const r of flat) {
    const base = String(r.address).replace(/\[[^\]]+\]$/, '')
    if (!groups.has(base)) groups.set(base, { ...r, address: base, instances: [] })
    groups.get(base).instances.push(r)
  }
  return [...groups.values()].map((g) => ({
    ...g,
    expandedCount: g.instances.length,
    values: g.instances[0]?.values || g.values,
  }))
}

/**
 * Terraform's own reference graph, from the `configuration` section. Plan values
 * are evaluated — references have already collapsed into literals — so this is
 * the only place the wiring survives, and it is why Mode A can draw arrows at
 * all rather than just listing boxes.
 */
function dependencyGraph(plan, resources) {
  const deps = new Map()
  const addDep = (from, to) => {
    if (!deps.has(from)) deps.set(from, new Set())
    deps.get(from).add(to)
  }
  const conf = plan?.configuration?.root_module
  const walkConf = (mod, prefix = '') => {
    if (!mod) return
    for (const r of mod.resources || []) {
      const addr = `${prefix}${r.address || `${r.type}.${r.name}`}`
      for (const expr of Object.values(r.expressions || {})) collectRefs(expr, (ref) => addDep(addr, normalizeRef(ref, prefix)))
      for (const d of r.depends_on || []) addDep(addr, normalizeRef(d, prefix))
    }
    for (const [name, call] of Object.entries(mod.module_calls || {})) walkConf(call.module, `${prefix}module.${name}.`)
  }
  walkConf(conf)

  // `depends_on` also shows up on planned resources in some Terraform versions
  for (const r of resources) for (const d of r.depends_on || []) addDep(r.address, d)
  return deps
}

function collectRefs(expr, cb) {
  if (!expr || typeof expr !== 'object') return
  if (Array.isArray(expr)) { for (const e of expr) collectRefs(e, cb); return }
  if (Array.isArray(expr.references)) for (const ref of expr.references) cb(ref)
  for (const [k, v] of Object.entries(expr)) if (k !== 'references') collectRefs(v, cb)
}

/** `aws_lb.main.arn` → `aws_lb.main`; drop `var.`/`local.`/`each.` references. */
function normalizeRef(ref, prefix = '') {
  const s = String(ref)
  if (/^(var|local|each|count|path|terraform)\./.test(s)) return `__ignored.${s}`
  const parts = s.split('.')
  const head = parts[0] === 'data' ? parts.slice(0, 3) : parts.slice(0, 2)
  return `${prefix}${head.join('.')}`
}

/**
 * The helpers a mapping rule's `edges()` may call. They return nothing here
 * because on the plan-JSON path the dependency graph already carries these
 * relationships — but a rule is entitled to call them, so every ingest path has
 * to supply them or the first listener rule it meets throws.
 */
export function edgeCtx() {
  return {
    targetGroupsFor: () => [],
    firstTargetGroupRef: () => null,
    taskDefEdges: () => [],
  }
}

function labelFor(res) {
  const v = res.values || {}
  return v.name || v.identifier || v.bucket || v.function_name || v.cluster_identifier
    || v.domain_name || labelFromAddress(res.type, res.name)
}

// ── Mode A: Kubernetes live/rendered JSON ───────────────────────────────────

/**
 * @param objects  array of K8s objects (from `kubectl get -A -o json` items, or
 *                 rendered Helm output parsed to JSON)
 */
export function k8sToIR(objects, opts = {}) {
  const file = opts.file || 'cluster.json'
  const managed = opts.managed || 'observed'
  const ir = createIR({ name: opts.name || 'kubernetes', createdBy: 'archsim-iac' })
  const report = { mapped: 0, structural: 0, unmapped: 0, resources: [], warnings: [] }

  const workloads = []
  const services = []
  const hpas = []
  const nodesByKey = new Map()

  for (const obj of objects) {
    const type = `${obj.apiVersion}:${obj.kind}`
    const address = k8sAddress(obj)
    const rule = findRule('k8s', type, obj)

    if (obj.kind === 'HorizontalPodAutoscaler') { hpas.push(obj); report.resources.push({ address, type, disposition: 'hpa' }); continue }
    if (obj.kind === 'Service') { services.push(obj); report.resources.push({ address, type, disposition: 'service' }) }
    if (!rule) {
      if (isStructural(type)) { report.structural++; report.resources.push({ address, type, disposition: 'structural' }); continue }
      report.unmapped++
      report.warnings.push({ address, msg: `no mapping rule for '${type}' — rendered as a custom component, not dropped` })
    }

    // A rule whose `kindOf` returns null is saying "this object is real, but it
    // is not a component" — a ClusterIP Service is a routing fact, not a
    // queueing station. It still contributes edges, just not a box.
    const kind = rule?.kindOf ? rule.kindOf(obj) : (rule?.kind ?? 'custom')
    if (kind === null || kind === undefined) continue
    if (rule) report.mapped++

    const seeded = capacityFor(kind)
    const node = irNode({
      id: ulidFrom(`k8s:${address}`),
      kind,
      label: obj.metadata?.name || address,
      capacity: { ...seeded, ...(rule?.capacity?.(obj, ctxBase) || {}) },
      bindings: [{ lang: 'k8s', file, address, managed }],
      telemetry: rule?.telemetry?.(obj),
      attrs: {
        ...(rule?.attrs?.(obj) || {}),
        namespace: ns(obj),
        ...(firstContainer(obj)?.image ? { image: firstContainer(obj).image } : {}),
      },
    })
    ir.nodes.push(node)
    nodesByKey.set(address, node)
    if (isWorkload(obj.kind)) workloads.push({ obj, node })
    report.resources.push({ address, type, disposition: rule ? 'mapped' : 'unmapped', kind })
  }

  // Honest replica counts: an HPA means the fixed number in the manifest is a
  // floor, not a fact. The gate needs to know which, because "it fits at 3
  // replicas" and "it will have 3 replicas" are different claims.
  for (const h of hpas) {
    const targetName = h.spec?.scaleTargetRef?.name
    const hit = workloads.find((w) => w.obj.metadata?.name === targetName && ns(w.obj) === ns(h))
    if (!hit) continue
    hit.node.attrs.hpa = { min: h.spec?.minReplicas ?? 1, max: h.spec?.maxReplicas ?? null, target: h.spec?.metrics?.[0]?.resource?.target?.averageUtilization ?? null }
    hit.node.capacity.provenance = {
      cls: hit.node.capacity.provenance.cls,
      basis: `${hit.node.capacity.provenance.basis}; replica count is HPA-managed (${h.spec?.minReplicas ?? 1}–${h.spec?.maxReplicas ?? '∞'}) — modelled at the declared minimum, which is the worst case a burst arrives into`,
      refs: hit.node.capacity.provenance.refs,
    }
    hit.node.capacity.replicas = h.spec?.minReplicas ?? hit.node.capacity.replicas
  }

  // Service selector → workload. Not a guess about intent: the same label match
  // kube-proxy performs.
  const serviceTargets = new Map()
  for (const svc of services) {
    const matched = workloads.filter((w) => ns(w.obj) === ns(svc) && selectorMatches(svc.spec?.selector, w.obj))
    serviceTargets.set(`${ns(svc)}/${svc.metadata?.name}`, matched.map((m) => m.node))
    const svcNode = nodesByKey.get(k8sAddress(svc))
    if (svcNode) {
      for (const m of matched) ir.edges.push(irEdge({ from: svcNode.id, to: m.node.id, confidence: 'high', protocol: 'http', callSemantics: 'sync', attrs: { reason: `Service selector ${JSON.stringify(svc.spec?.selector)}` } }))
    }
  }

  // Ingress → Service → workload, collapsed to one architectural edge.
  for (const obj of objects) {
    if (obj.kind !== 'Ingress') continue
    const from = nodesByKey.get(k8sAddress(obj))
    if (!from) continue
    for (const rule of obj.spec?.rules || []) {
      for (const p of rule?.http?.paths || []) {
        const svcName = p?.backend?.service?.name
        for (const target of serviceTargets.get(`${ns(obj)}/${svcName}`) || []) {
          ir.edges.push(irEdge({ from: from.id, to: target.id, confidence: 'high', protocol: 'http', attrs: { reason: `Ingress ${rule.host || ''}${p.path || ''} → Service ${svcName}` } }))
        }
      }
    }
  }

  // Declared bindings beat everything: an annotation is a human's answer.
  for (const { obj, node } of workloads) {
    const decl = obj.metadata?.annotations?.['archsim.io/edge']
    if (!decl) continue
    for (const target of String(decl).split(',').map((s) => s.trim())) {
      const hit = [...nodesByKey.values()].find((n) => n.label === target)
      if (hit) ir.edges.push(irEdge({ from: node.id, to: hit.id, confidence: 'high', attrs: { reason: 'archsim.io/edge annotation (confirmed by a human)' } }))
    }
  }

  // Environment variables naming another service: medium confidence, dashed.
  for (const { obj, node } of workloads) {
    for (const hint of envServiceEdges(obj)) {
      const targets = serviceTargets.get(`${hint.namespace || ns(obj)}/${hint.toServiceName}`)
        || serviceTargets.get(`${ns(obj)}/${hint.toServiceName}`)
      for (const t of targets || []) {
        if (t.id === node.id) continue
        ir.edges.push(irEdge({ from: node.id, to: t.id, confidence: hint.confidence, protocol: protocolFor(t.kind), callSemantics: callSemanticsFor(t.kind), attrs: { reason: hint.reason } }))
      }
    }
  }

  attachClient(ir)
  return { ir: normalizeIR(ir), report }
}

/** Accepts a `kubectl get -o json` List, a single object, or an array. */
export function k8sObjects(json) {
  if (Array.isArray(json)) return json.flatMap(k8sObjects)
  if (json?.kind === 'List' && Array.isArray(json.items)) return json.items
  if (json?.items && !json.kind) return json.items
  return json ? [json] : []
}

// ── Mode B: static HCL ──────────────────────────────────────────────────────

/**
 * Best-effort ingest straight from `.tf` files, with CST byte ranges so the
 * emitter can patch in place afterwards. Anything dynamic degrades loudly
 * rather than quietly: `count = var.replicas` becomes one replica with a badge
 * and a widened band, never an invented number.
 */
export function hclToIR(files, opts = {}) {
  const managed = opts.managed || 'partial'
  const ir = createIR({ name: opts.name || 'terraform-hcl', createdBy: 'archsim-iac' })
  const report = { mapped: 0, structural: 0, unmapped: 0, unresolved: [], resources: [], warnings: [] }
  const nodesByAddress = new Map()
  const connectors = new Set()
  const deps = new Map()
  const parsedFiles = []

  for (const { path, text } of files) {
    const parsed = parseHCL(text, path)
    parsedFiles.push(parsed)
    // Passthrough first: every top-level item we do not turn into a node is
    // stored verbatim, in order, with the address it followed. This is the
    // anti-tarpit rule made concrete — bidirectional IaC dies when the tool
    // destroys code it did not model, and we refuse that failure class
    // structurally rather than promising to be careful.
    capturePassthrough(ir, parsed, path)
    for (const { block } of walkBlocks(parsed)) {
      if (block.name !== 'resource' && block.name !== 'module') continue
      // A module call is not a component, but it *is* traffic-carrying: real
      // Terraform wires services together by passing one module's output into
      // another's input, so edge inference has to be able to hop through it.
      // What is *inside* the module is a separate ingest — and in Mode A the
      // plan has already flattened it, which is the better answer.
      if (block.name === 'module') {
        const addr = addressOf(block)
        connectors.add(addr)
        const modRefs = new Set()
        collectHclRefs(block, modRefs)
        deps.set(addr, modRefs)
        report.structural++
        report.resources.push({ address: addr, type: 'module', disposition: 'connector' })
        continue
      }
      const type = block.labels[0]
      const address = addressOf(block)
      const { attrs } = bodyOf(block)
      const values = literalValues(block)
      const provider = providerOf(type)
      const rule = findRule(provider, type, values)

      // references, for the dependency graph
      const refs = new Set()
      collectHclRefs(block, refs)
      deps.set(address, refs)

      if (!rule && (isStructural(type) || isNoise(type))) {
        if (isConnector(type)) connectors.add(address)
        report.structural++
        report.resources.push({ address, type, disposition: isConnector(type) ? 'connector' : isNoise(type) ? 'noise' : 'structural' })
        continue
      }
      if (rule?.edgeOnly) { connectors.add(address); continue }

      const kind = rule?.kind || 'custom'
      const countAttr = attrs.count || attrs.desired_count || attrs.desired_capacity
        || attrs.num_cache_nodes || attrs.num_cache_clusters || attrs.number_of_broker_nodes
      let declaredReplicas = null
      let unresolved = false
      if (countAttr) {
        const v = attrValue(countAttr)
        if (typeof v === 'number') declaredReplicas = v
        else { unresolved = true; report.unresolved.push({ address, attr: countAttr.name, raw: countAttr.raw }) }
      }
      if (attrs.for_each) { unresolved = true; report.unresolved.push({ address, attr: 'for_each', raw: attrs.for_each.raw }) }

      const seeded = capacityFor(kind, unresolved
        ? { provenanceCls: 'modeled', basis: `${countAttr?.name || 'for_each'} is dynamic in static HCL — shown as 1×. Run \`archsim ingest --plan\` for the evaluated count.` }
        : {})
      const ruleCap = rule?.capacity?.(values, { ...ctxBase, address }) || {}
      // A literal `count` wins; otherwise the mapping rule may know better than
      // the default (multi_az means two, num_cache_clusters means what it says).
      const replicas = declaredReplicas ?? ruleCap.replicas ?? 1
      const cap = { ...seeded, ...ruleCap, replicas }
      if (unresolved) {
        // The mapping rule may have derived a confident figure from an instance
        // class — but we do not know how many of them there are, so the whole
        // node is an estimate and has to be labelled as one. A 'vendor' class on
        // a node whose replica count we invented would be false precision.
        cap.provenance = seeded.provenance
        cap.jitter = { capPct: 40, latPct: 40 }
      }

      const node = irNode({
        id: ulidFrom(`tf:${address}`),
        kind,
        label: values.name || labelFromAddress(type, block.labels[1]),
        capacity: cap,
        bindings: [{
          lang: 'hcl', file: path, address, managed,
          range: { startByte: block.start, endByte: block.end },
        }],
        attrs: {
          ...(rule?.attrs?.(values) || {}),
          tfType: type,
          ...(unresolved ? { unresolvedCount: true, badge: `count unresolved: shown as ${replicas}×` } : {}),
        },
      })
      node.attrs = Object.fromEntries(Object.entries(node.attrs).filter(([, v]) => v !== undefined))
      ir.nodes.push(node)
      nodesByAddress.set(address, node)
      if (rule) report.mapped++; else report.unmapped++
      report.resources.push({ address, type, disposition: rule ? 'mapped' : 'unmapped', kind, unresolved })
    }
  }

  ir.edges.push(...inferEdges([], nodesByAddress, connectors, deps, (spec) => irEdge(spec)))
  attachClient(ir)
  return { ir: normalizeIR(ir), report, parsedFiles }
}

/**
 * Store every top-level item that will not become a node — providers, variables,
 * outputs, locals, structural resources, comments between them — as verbatim
 * text, anchored after the previous item so ordering survives emission.
 */
function capturePassthrough(ir, parsed, file) {
  let anchor = null
  for (const item of parsed.body) {
    if (item.type === 'block' && item.name === 'resource') {
      const type = item.labels[0]
      const rule = findRule(providerOf(type), type, {})
      if (rule && !rule.edgeOnly && !isStructural(type)) { anchor = addressOf(item); continue }
    }
    ir.passthrough.push({
      lang: 'hcl', file,
      text: parsed.text.slice(item.start, item.end),
      ...(anchor ? { anchorAfter: anchor } : {}),
    })
  }
}

/**
 * Terraform convention names the primary resource in a module `this`, so a
 * faithful label puts six boxes called "this" on the canvas. When the name
 * carries no information, the type does: `aws_cognito_user_pool.this` reads
 * better as "cognito user pool".
 */
const GENERIC_NAMES = new Set(['this', 'main', 'default', 'primary', 'that', 'example', 'test'])
export function labelFromAddress(type, name) {
  if (name && !GENERIC_NAMES.has(name)) return name
  const pretty = String(type)
    .replace(/^(aws|google|azurerm|azapi)_/, '')
    .replace(/_/g, ' ')
  return pretty || name || type
}

function literalValues(block) {
  const out = {}
  for (const item of block.items || []) {
    if (item.type === 'attribute') { const v = attrValue(item); if (v !== undefined) out[item.name] = v }
    else if (item.type === 'block') out[item.name] = literalValues(item)
  }
  return out
}

function collectHclRefs(block, into) {
  for (const item of block.items || []) {
    if (item.type === 'attribute') {
      for (const m of item.raw.matchAll(/\b((?:module\.[A-Za-z0-9_-]+\.)?(?:data\.)?[a-z][a-z0-9_]*\.[A-Za-z0-9_-]+)/g)) {
        if (!/^(var|local|each|count|path|terraform)\./.test(m[1])) into.add(m[1])
      }
    } else if (item.type === 'block') collectHclRefs(item, into)
  }
}

// ── shared ──────────────────────────────────────────────────────────────────

/**
 * Infrastructure never contains the users. Every ingested design gets a synthetic
 * client attached to its entry points, because a graph with no source simulates
 * nothing — and the entry point is a claim worth showing on the canvas so
 * somebody can correct it.
 */
export function attachClient(ir) {
  if (ir.nodes.some((n) => n.capacity?.source)) return ir
  const hasIncoming = new Set(ir.edges.map((e) => e.to))
  const FRONT = ['dns', 'cdn', 'lb', 'gateway', 'k8sgw', 'waf', 'gslb', 'web', 'graphql']
  let entries = ir.nodes.filter((n) => FRONT.includes(n.kind) && !hasIncoming.has(n.id))
  if (!entries.length) entries = ir.nodes.filter((n) => !hasIncoming.has(n.id) && !['monitor', 'logs', 'tracing', 'otel'].includes(n.kind))
  if (!entries.length) return ir
  const client = irNode({
    id: ulidFrom('synthetic:client'),
    kind: 'client',
    label: 'users',
    capacity: capacityFor('client'),
    attrs: { synthetic: true, note: 'Added by ingest: infrastructure code does not contain its users. Entry points were inferred — correct them on the canvas if wrong.' },
  })
  ir.nodes.push(client)
  for (const e of entries) ir.edges.push(irEdge({ from: client.id, to: e.id, confidence: 'medium', attrs: { reason: 'inferred entry point (no inbound dependency in the plan)' } }))
  return ir
}
