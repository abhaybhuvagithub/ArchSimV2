// Emission — patch, don't regenerate.
//
// The classic bidirectional failure is a tool that rewrites the file: comments
// gone, ordering shuffled, the `dynamic` block it did not understand quietly
// deleted. Once that has happened to a team once, the tool is uninstalled and
// the category gets a reputation. So the contract here is narrow on purpose:
//
//   1. Existing resource, mapped attribute changed  → surgical CST patch. We
//      locate the binding's byte range and rewrite only that expression.
//      Comments, ordering, whitespace: untouched, by construction rather than
//      by effort.
//   2. New node drawn on the canvas → full generation from the rule's emit
//      template, into a file the user chose, with a header comment linking back
//      to the IR node id.
//   3. Node deleted on the canvas → never silently deleted in code. It becomes
//      a removal proposal in the diff review, and a human applies it.
//   4. Passthrough blocks → re-emitted byte for byte, position-stable.

import { parseHCL, walkBlocks, addressOf, bodyOf, applyEdits } from './hcl.js'
import { parseYamlDocs, k8sAddress, yamlEdit } from './yaml.js'
import { findRule, providerOf, allRules, isNoise } from './mappings/index.js'

/**
 * Compute the edits that carry `targetIR` back into the source files.
 *
 * @param baseIR   the IR as it was ingested from these files
 * @param targetIR the IR after canvas edits
 * @param sources  Map<file, text> (or [{path, text}])
 * @returns {{patches, generated, removals, unpatchable}}
 */
export function emitChanges(baseIR, targetIR, sources, opts = {}) {
  const files = normalizeSources(sources)
  const patches = new Map()
  const generated = []
  const removals = []
  const unpatchable = []

  const baseById = new Map(baseIR.nodes.map((n) => [n.id, n]))
  const targetById = new Map(targetIR.nodes.map((n) => [n.id, n]))

  for (const node of targetIR.nodes) {
    const before = baseById.get(node.id)
    if (!before) {
      const gen = generateNode(node, opts)
      if (gen) generated.push(gen)
      else unpatchable.push({ nodeId: node.id, label: node.label, reason: `no emit template for kind '${node.kind}' — add one to the mapping table, or add the resource by hand` })
      continue
    }
    for (const binding of node.bindings || []) {
      if (binding.managed === 'observed') {
        if (changedFields(before, node).length) {
          unpatchable.push({ nodeId: node.id, label: node.label, address: binding.address,
            reason: `binding is 'observed' (read-only). ArchSim renders this resource but will not write to it — promote it to 'partial' to allow attribute patches.` })
        }
        continue
      }
      const text = files.get(binding.file)
      if (text === undefined) { unpatchable.push({ nodeId: node.id, address: binding.address, reason: `source file '${binding.file}' was not provided to the emitter` }); continue }
      const edits = binding.lang === 'k8s'
        ? yamlEdits(text, binding, before, node)
        : hclEdits(text, binding, before, node)
      if (edits.unpatchable.length) unpatchable.push(...edits.unpatchable.map((u) => ({ nodeId: node.id, address: binding.address, ...u })))
      if (edits.edits.length) {
        if (!patches.has(binding.file)) patches.set(binding.file, [])
        patches.get(binding.file).push(...edits.edits)
      }
    }
  }

  for (const node of baseIR.nodes) {
    if (targetById.has(node.id)) continue
    for (const b of node.bindings || []) {
      removals.push({
        nodeId: node.id, label: node.label, file: b.file, address: b.address,
        // Deleting infrastructure is the one operation a diagram tool must never
        // do on its own recognisance.
        proposal: `remove \`${b.address}\` from ${b.file}`,
        note: 'proposed, not applied — review and delete it in your PR',
      })
    }
  }

  const applied = []
  for (const [file, edits] of patches) {
    const before = files.get(file)
    const after = applyEdits(before, edits)
    applied.push({ file, before, after, edits, changed: before !== after })
  }

  return { patches: applied, generated, removals, unpatchable }
}

function hclEdits(text, binding, before, node) {
  const parsed = parseHCL(text, binding.file)
  const edits = []
  const unpatchable = []
  let target = null
  for (const { block } of walkBlocks(parsed)) {
    if (block.name !== 'resource') continue
    if (addressOf(block) === binding.address) { target = block; break }
  }
  if (!target) {
    // The file moved under us. Refusing beats writing to the wrong byte range.
    return { edits: [], unpatchable: [{ reason: `\`${binding.address}\` is no longer in ${binding.file} — re-ingest before emitting` }] }
  }
  const { attrs } = bodyOf(target)
  const rule = findRule(providerOf(target.labels[0]), target.labels[0], {})
  // Where no rule declares which attribute carries the replica count, read it
  // off the block instead of assuming `count`. Assuming produced a confident
  // refusal ("has no `count` attribute") about resources that plainly declared
  // `desired_capacity` two lines below — right to refuse, wrong about why.
  const patchMap = rule?.patch || { replicas: { attr: countAttrName(attrs) } }

  for (const field of changedFields(before, node)) {
    if (field !== 'replicas') continue // only replica counts are round-tripped today; everything else is a removal-safe no-op
    const spec = patchMap.replicas
    const attrName = spec?.attr
    const attrNode = attrName ? attrs[attrName] : null
    if (!attrNode) {
      unpatchable.push({ reason: `\`${binding.address}\` has no \`${attrName || 'count'}\` attribute to patch — the replica count is implicit, so this change needs a hand edit` })
      continue
    }
    if (attrNode.dynamic) {
      unpatchable.push({ reason: `\`${binding.address}.${attrName}\` is \`${attrNode.raw.trim()}\` — a computed expression. Overwriting it would silently drop the variable, so this is left for a human.` })
      continue
    }
    edits.push({ start: attrNode.valueStart, end: attrNode.valueEnd, replacement: String(node.capacity.replicas), why: `${binding.address}.${attrName}: ${attrNode.raw.trim()} → ${node.capacity.replicas}` })
  }
  return { edits, unpatchable }
}

function yamlEdits(text, binding, before, node) {
  const docs = parseYamlDocs(text, binding.file)
  const doc = docs.find((d) => d.value && k8sAddress(d.value) === binding.address)
  if (!doc) return { edits: [], unpatchable: [{ reason: `\`${binding.address}\` is no longer in ${binding.file} — re-ingest before emitting` }] }
  const edits = []
  const unpatchable = []
  for (const field of changedFields(before, node)) {
    if (field !== 'replicas') continue
    const e = yamlEdit(doc, 'spec.replicas', node.capacity.replicas)
    if (!e) { unpatchable.push({ reason: `\`${binding.address}\` declares no \`spec.replicas\` — add one, or let the HPA own the count` }); continue }
    if (node.attrs?.hpa) {
      unpatchable.push({ reason: `\`${binding.address}\` is HPA-managed (${node.attrs.hpa.min}–${node.attrs.hpa.max}). Patching spec.replicas would be overwritten by the autoscaler within a minute — change the HPA bounds instead.` })
      continue
    }
    edits.push({ ...e, why: `${binding.address}.spec.replicas → ${node.capacity.replicas}` })
  }
  return { edits, unpatchable }
}

const COUNT_ATTRS = ['count', 'desired_count', 'desired_capacity', 'num_cache_nodes',
  'num_cache_clusters', 'number_of_broker_nodes', 'instance_count', 'node_count',
  'target_size', 'instances', 'min_size', 'shard_count', 'number_of_nodes']

function countAttrName(attrs) {
  return COUNT_ATTRS.find((a) => attrs[a]) || 'count'
}

export function changedFields(before, after) {
  const out = []
  if (before.capacity.replicas !== after.capacity.replicas) out.push('replicas')
  if (before.kind !== after.kind) out.push('kind')
  if (before.label !== after.label) out.push('label')
  return out
}

/** Full generation for a node that exists on the canvas but not in code. */
export function generateNode(node, opts = {}) {
  const kindType = node.attrs?.tfType
  const rule = kindType ? findRule(providerOf(kindType), kindType, {}) : findRuleByKind(node.kind, opts.provider || 'aws')
  const emit = rule?.emit
  if (!emit) return null
  const lang = rule.match.provider === 'k8s' ? 'k8s' : 'hcl'
  const body = emit(node)
  const header = lang === 'hcl'
    ? `# Generated by ArchSim from canvas node ${node.id} (${node.label}).\n# Edit freely: ArchSim patches attributes in place and never regenerates this block.\n`
    : ''
  return {
    file: opts.file || (lang === 'hcl' ? 'archsim.generated.tf' : 'archsim.generated.yaml'),
    lang,
    nodeId: node.id,
    text: `${header}${body}\n`,
  }
}

function findRuleByKind(kind, provider) {
  // Reverse lookup: the canvas says "put a Postgres here", the table decides
  // which resource that is for this repo's provider.
  return allRules().find((r) => r.match.provider === provider && r.kind === kind && r.emit) || null
}

/** Re-emit the passthrough blocks for a file, in order, byte for byte. */
export function renderPassthrough(ir, file) {
  return ir.passthrough.filter((p) => p.file === file).map((p) => p.text).join('')
}

function normalizeSources(sources) {
  if (sources instanceof Map) return sources
  const m = new Map()
  for (const s of sources || []) m.set(s.path, s.text)
  return m
}

/**
 * `terraform fmt` idempotency check without shelling out to Terraform: a patch
 * must not change indentation, line count outside the edited line, or trailing
 * whitespace. Asserted in the suite for every golden-corpus patch.
 */
export function patchIsSurgical(before, after, edits) {
  if (before === after) return { ok: true, changedLines: [] }
  const b = before.split('\n')
  const a = after.split('\n')
  if (b.length !== a.length) return { ok: false, reason: 'line count changed — a patch must not add or remove lines', changedLines: [] }
  const changed = []
  for (let i = 0; i < b.length; i++) if (b[i] !== a[i]) changed.push(i + 1)
  if (changed.length > edits.length) return { ok: false, reason: `${changed.length} lines changed for ${edits.length} edits`, changedLines: changed }
  for (const i of changed) {
    const indentB = /^\s*/.exec(b[i - 1])[0]
    const indentA = /^\s*/.exec(a[i - 1])[0]
    if (indentB !== indentA) return { ok: false, reason: `indentation changed on line ${i}`, changedLines: changed }
  }
  return { ok: true, changedLines: changed }
}
