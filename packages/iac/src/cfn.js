// CloudFormation — and therefore AWS CDK and SAM.
//
// The obvious way to read CDK is a TypeScript AST extractor. It is the wrong
// way. CDK's entire job is to turn TypeScript into CloudFormation, and it does
// that correctly: constructs expand, escape hatches apply, aspects run, logical
// ids are generated deterministically, and cross-stack references resolve. An
// AST walk over the source re-derives all of that badly and disagrees with what
// actually deploys. `cdk synth` has already computed the answer; this module
// reads the answer.
//
// So this is a Mode A path, in the same sense as Terraform plan JSON: exact,
// because someone else's compiler did the resolving. The Mode B concession is
// narrower and stated where it happens — a template's *unresolved* references
// (`Ref` to a parameter with no default, `Fn::ImportValue`, a condition that
// depends on a pseudo-parameter) are recorded as unresolved rather than guessed.

import { createIR, irNode, irEdge, normalizeIR, ulidFrom } from '@archsim/ir'
import { capacityFor } from '@archsim/core'
import { findRule, isStructural, isConnector, isNoise } from './mappings/index.js'
import { inferEdges } from './edges.js'
import { parseYamlDocs } from './yaml.js'
import { attachClient, edgeCtx } from './ingest.js'

const ctxBase = { seed: (kind) => capacityFor(kind) }

/** Pseudo-parameters that have a defensible value without an account. */
const PSEUDO = {
  'AWS::Region': 'us-east-1',
  'AWS::Partition': 'aws',
  'AWS::URLSuffix': 'amazonaws.com',
  'AWS::NoValue': undefined,
}

/* ── parsing ──────────────────────────────────────────────────────────────── */

/**
 * A CloudFormation template, from JSON or YAML.
 *
 * YAML templates use short-form intrinsics — `!Ref Foo`, `!GetAtt A.Arn`,
 * `!Sub "${X}/y"`. The YAML reader deliberately treats tags as opaque text, so
 * they arrive as strings and are normalised here into the long form the rest of
 * the module works in. That keeps tag handling in the one module that knows
 * what the tags mean.
 */
export function parseCfnTemplate(text, file = 'template.json') {
  const trimmed = String(text).trim()
  if (trimmed.startsWith('{')) {
    return { template: JSON.parse(trimmed), file, format: 'json' }
  }
  const docs = parseYamlDocs(text, file)
  const raw = docs.find((d) => d.value && typeof d.value === 'object')?.value || {}
  return { template: normalizeShortTags(raw), file, format: 'yaml' }
}

const SHORT_TAGS = [
  'Ref', 'GetAtt', 'Sub', 'Join', 'Select', 'Split', 'FindInMap', 'If', 'Equals',
  'And', 'Or', 'Not', 'ImportValue', 'Base64', 'Cidr', 'GetAZs', 'Transform',
]

function normalizeShortTags(node) {
  if (Array.isArray(node)) return node.map(normalizeShortTags)
  if (node && typeof node === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(node)) out[k] = normalizeShortTags(v)
    return out
  }
  if (typeof node !== 'string') return node
  const m = /^!([A-Za-z:]+)\s+([\s\S]+)$/.exec(node.trim())
  if (!m || !SHORT_TAGS.includes(m[1])) return node
  const [, tag, rest] = m
  const body = rest.trim()
  // `!Ref Foo` is `{Ref: "Foo"}`; every other tag is `Fn::`-prefixed. `!GetAtt
  // A.Arn` takes the dotted form, which CloudFormation also accepts as a list.
  if (tag === 'Ref') return { Ref: body }
  if (tag === 'GetAtt') return { 'Fn::GetAtt': body.includes('.') ? body.split('.') : [body] }
  return { [`Fn::${tag}`]: body }
}

/* ── intrinsic resolution ─────────────────────────────────────────────────── */

/**
 * Resolve what can be resolved, record what cannot.
 *
 * `refs` collects every logical id this value depends on, which is the
 * dependency graph edge inference needs. `unresolved` collects the intrinsics
 * that could not be evaluated without an AWS account — those become warnings
 * rather than invented values, because a capacity figure derived from a guessed
 * parameter is worse than no capacity figure.
 */
export function resolveValue(value, ctx) {
  if (Array.isArray(value)) return value.map((v) => resolveValue(v, ctx))
  if (!value || typeof value !== 'object') return value

  const keys = Object.keys(value)
  if (keys.length === 1) {
    const [k] = keys
    const arg = value[k]

    if (k === 'Ref') {
      if (Object.prototype.hasOwnProperty.call(PSEUDO, arg)) return PSEUDO[arg]
      if (Object.prototype.hasOwnProperty.call(ctx.parameters, arg)) return ctx.parameters[arg]
      if (ctx.resources[arg]) { ctx.refs.add(arg); return `\${${arg}}` }
      ctx.unresolved.push(`Ref to '${arg}', which is neither a resource nor a parameter with a default`)
      return undefined
    }

    if (k === 'Fn::GetAtt') {
      const [logicalId, ...attr] = Array.isArray(arg) ? arg : String(arg).split('.')
      if (ctx.resources[logicalId]) ctx.refs.add(logicalId)
      return `\${${logicalId}.${attr.join('.')}}`
    }

    if (k === 'Fn::Sub') {
      const [tpl, vars] = Array.isArray(arg) ? arg : [arg, {}]
      const local = { ...ctx, parameters: { ...ctx.parameters, ...mapValues(vars || {}, (v) => resolveValue(v, ctx)) } }
      return String(tpl).replace(/\$\{([^}]+)\}/g, (_, name) => {
        const bare = name.split('.')[0]
        if (ctx.resources[bare]) { ctx.refs.add(bare); return `\${${name}}` }
        const r = resolveValue({ Ref: name }, local)
        return r === undefined ? `\${${name}}` : String(r)
      })
    }

    if (k === 'Fn::Join') {
      const [sep, parts] = arg
      const list = resolveValue(parts, ctx)
      return Array.isArray(list) ? list.filter((p) => p !== undefined).join(sep) : undefined
    }

    if (k === 'Fn::Select') {
      const [i, list] = arg
      const resolved = resolveValue(list, ctx)
      return Array.isArray(resolved) ? resolved[Number(resolveValue(i, ctx))] : undefined
    }

    if (k === 'Fn::Split') {
      const [sep, str] = arg
      const s = resolveValue(str, ctx)
      return typeof s === 'string' ? s.split(sep) : undefined
    }

    if (k === 'Fn::FindInMap') {
      const [map, top, second] = arg.map((a) => resolveValue(a, ctx))
      const found = ctx.mappings?.[map]?.[top]?.[second]
      if (found === undefined) ctx.unresolved.push(`Fn::FindInMap ${map}.${top}.${second} has no entry`)
      return found
    }

    if (k === 'Fn::If') {
      const [condName, whenTrue, whenFalse] = arg
      const cond = ctx.conditions?.[condName]
      // An unevaluable condition takes the true branch and says so, because a
      // template's conditions overwhelmingly guard *optional extras* — taking
      // the true branch over-counts, which is the safe direction for a capacity
      // model, and the warning says the choice was made.
      if (cond === undefined) ctx.unresolved.push(`condition '${condName}' could not be evaluated; assumed true`)
      return resolveValue(cond === false ? whenFalse : whenTrue, ctx)
    }

    if (k === 'Fn::ImportValue') {
      ctx.unresolved.push(`Fn::ImportValue crosses a stack boundary; ingest the exporting stack too`)
      return undefined
    }

    if (k === 'Fn::Base64' || k === 'Fn::Transform' || k === 'Fn::Cidr' || k === 'Fn::GetAZs') {
      return undefined
    }
  }

  return mapValues(value, (v) => resolveValue(v, ctx))
}

const mapValues = (o, f) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, f(v)]))

/** Parameter defaults are the only parameter values a template states itself. */
export function parameterDefaults(template) {
  const out = {}
  for (const [name, spec] of Object.entries(template.Parameters || {})) {
    if (spec && Object.prototype.hasOwnProperty.call(spec, 'Default')) out[name] = spec.Default
  }
  return out
}

/**
 * Conditions that can be decided from parameter defaults alone. Anything
 * touching a pseudo-parameter or an unresolved reference stays `undefined`, and
 * `Fn::If` then says so rather than pretending.
 */
export function evaluateConditions(template, parameters) {
  const conditions = {}
  const evalCond = (expr) => {
    if (!expr || typeof expr !== 'object') return undefined
    const [k] = Object.keys(expr)
    const arg = expr[k]
    if (k === 'Fn::Equals') {
      const [a, b] = arg.map((x) => (x && typeof x === 'object' && x.Ref
        ? (Object.prototype.hasOwnProperty.call(parameters, x.Ref) ? parameters[x.Ref] : Symbol('unknown'))
        : x))
      if (typeof a === 'symbol' || typeof b === 'symbol') return undefined
      return String(a) === String(b)
    }
    if (k === 'Fn::Not') { const v = evalCond(arg[0]); return v === undefined ? undefined : !v }
    if (k === 'Fn::And') {
      const vs = arg.map(evalCond)
      return vs.some((v) => v === false) ? false : vs.some((v) => v === undefined) ? undefined : true
    }
    if (k === 'Fn::Or') {
      const vs = arg.map(evalCond)
      return vs.some((v) => v === true) ? true : vs.some((v) => v === undefined) ? undefined : false
    }
    if (k === 'Condition') return conditions[arg]
    return undefined
  }
  for (const [name, expr] of Object.entries(template.Conditions || {})) conditions[name] = evalCond(expr)
  return conditions
}

/* ── ingest ───────────────────────────────────────────────────────────────── */

/**
 * One or more CloudFormation templates → IR.
 *
 * @param inputs  `[{ file, text }]`, or a single already-parsed template object
 * @param opts.managed  'observed' (default) | 'partial' | 'full'
 */
export function cfnToIR(inputs, opts = {}) {
  const managed = opts.managed || 'observed'
  const files = Array.isArray(inputs) ? inputs : [{ file: opts.file || 'template.json', text: JSON.stringify(inputs) }]
  const ir = createIR({ name: opts.name || 'cloudformation', createdBy: 'archsim-iac' })
  const report = { mapped: 0, structural: 0, unmapped: 0, resources: [], warnings: [], stacks: [] }

  const nodesByAddress = new Map()
  const connectors = new Set()
  const hints = []
  const deps = new Map()
  const addDep = (from, to) => {
    if (!deps.has(from)) deps.set(from, new Set())
    deps.get(from).add(to)
  }

  for (const input of files) {
    let parsed
    try {
      parsed = parseCfnTemplate(input.text, input.file)
    } catch (err) {
      report.warnings.push({ address: input.file, msg: `could not read as CloudFormation: ${err.message}` })
      continue
    }
    const { template } = parsed
    const stack = opts.stackName || input.stack || bareName(input.file)
    const resources = template.Resources || {}
    if (!Object.keys(resources).length) {
      report.warnings.push({ address: input.file, msg: 'no Resources section — not a CloudFormation template' })
      continue
    }
    report.stacks.push({ stack, file: input.file, format: parsed.format, resources: Object.keys(resources).length })

    const parameters = parameterDefaults(template)
    const conditions = evaluateConditions(template, parameters)

    // The whole template's raw text, kept verbatim. Nothing this module does
    // not model is lost, which is the same contract the Terraform path has.
    ir.passthrough.push({ file: input.file, lang: 'cloudformation', text: input.text })

    for (const [logicalId, res] of Object.entries(resources)) {
      const type = res.Type
      const address = files.length > 1 ? `${stack}.${logicalId}` : logicalId

      // A resource guarded by a condition that evaluated false is not deployed.
      if (res.Condition && conditions[res.Condition] === false) {
        report.resources.push({ address, type, disposition: 'condition-false' })
        continue
      }

      const ctx = { parameters, mappings: template.Mappings || {}, conditions, resources, refs: new Set(), unresolved: [] }
      const attrs = resolveValue(res.Properties || {}, ctx)
      for (const d of [].concat(res.DependsOn || [])) ctx.refs.add(d)
      for (const ref of ctx.refs) addDep(address, files.length > 1 ? `${stack}.${ref}` : ref)
      for (const u of ctx.unresolved) report.warnings.push({ address, msg: u })

      const rule = findRule('cfn', type, attrs)

      if (!rule && (isStructural(type) || isNoise(type))) {
        if (isConnector(type)) connectors.add(address)
        report.structural++
        report.resources.push({ address, type, disposition: isConnector(type) ? 'connector' : isNoise(type) ? 'noise' : 'structural' })
        continue
      }

      const kind = rule ? (rule.kindOf?.(attrs) || rule.kind || 'custom') : 'custom'
      if (!rule) {
        report.unmapped++
        report.warnings.push({ address, msg: `no mapping rule for '${type}' — rendered as a custom component and simulated conservatively, not dropped` })
      } else {
        report.mapped++
      }

      const seeded = capacityFor(kind, rule ? {} : { provenanceCls: 'modeled', basis: `no mapping rule for '${type}'; simulated as a generic component` })
      const node = irNode({
        id: ulidFrom(`cfn:${address}`),
        kind,
        label: labelFromLogicalId(logicalId, type),
        capacity: { ...seeded, ...(rule?.capacity?.(attrs, { ...ctxBase, ...edgeCtx(), address }) || {}) },
        bindings: [{ lang: 'cloudformation', file: input.file, address, managed }],
        attrs: strip({ ...(rule?.attrs?.(attrs) || {}), cfnType: type, stack: files.length > 1 ? stack : undefined }),
      })
      ir.nodes.push(node)
      nodesByAddress.set(address, node)
      report.resources.push({ address, type, disposition: rule ? 'mapped' : 'unmapped', kind })

      for (const h of rule?.edges?.(attrs, { ...ctxBase, ...edgeCtx(), address }) || []) {
        hints.push({ from: h.from || address, to: h.to, confidence: h.confidence, reason: h.reason, protocol: h.protocol })
      }
    }
  }

  ir.edges.push(...inferEdges(hints, nodesByAddress, connectors, deps, (spec) => irEdge(spec)))
  attachClient(ir)
  report.passthrough = ir.passthrough.length
  return { ir: normalizeIR(ir), report }
}

/**
 * A CDK app's synthesized output.
 *
 * `cdk.out/manifest.json` names every stack and its template file, so this
 * takes the directory listing a caller already has and returns the templates in
 * the order CDK deployed them — which is also the order that makes cross-stack
 * `Fn::ImportValue` resolvable when both stacks are ingested together.
 *
 * @param files  `[{ path, text }]` — everything under `cdk.out`
 */
export function cdkOutToIR(files, opts = {}) {
  const manifestFile = files.find((f) => /(^|\/)manifest\.json$/.test(f.path))
  const templates = []

  if (manifestFile) {
    let manifest
    try { manifest = JSON.parse(manifestFile.text) } catch { manifest = null }
    for (const [id, artifact] of Object.entries(manifest?.artifacts || {})) {
      if (artifact.type !== 'aws:cloudformation:stack') continue
      const rel = artifact.properties?.templateFile
      const found = rel && files.find((f) => f.path.endsWith(rel))
      if (found) templates.push({ file: found.path, text: found.text, stack: id })
    }
  }

  // No manifest, or a manifest that named nothing we were given: fall back to
  // every file that looks like a template. Saying so matters — the fallback
  // cannot order stacks, so cross-stack references stay unresolved.
  if (!templates.length) {
    for (const f of files) {
      if (!/\.template\.json$/.test(f.path)) continue
      templates.push({ file: f.path, text: f.text, stack: bareName(f.path).replace(/\.template$/, '') })
    }
  }

  const result = cfnToIR(templates, { ...opts, name: opts.name || 'cdk' })
  if (!manifestFile) {
    result.report.warnings.push({ address: 'cdk.out', msg: 'no manifest.json — stacks were read in file order, so cross-stack references may not resolve' })
  }
  return result
}

/* ── helpers ──────────────────────────────────────────────────────────────── */

const bareName = (p) => String(p).split('/').pop().replace(/\.(json|yaml|yml|template)$/i, '')

const strip = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))

/**
 * CDK generates logical ids like `CheckoutServiceTaskDefB1CE1F2A` — a readable
 * name with an eight-hex-digit uniqueness suffix. Stripping the suffix and
 * splitting the camel case turns machine output back into something a person
 * recognises on a canvas; the logical id itself stays in the binding.
 */
export function labelFromLogicalId(logicalId, type = '') {
  let name = String(logicalId).replace(/[0-9A-F]{8}$/, '')
  if (!name) name = String(logicalId)
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
  // A logical id that is just the service name repeated in the type tells the
  // reader nothing the type does not.
  return words || String(type).split('::').pop().toLowerCase()
}
