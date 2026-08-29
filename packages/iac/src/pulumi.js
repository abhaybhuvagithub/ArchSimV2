// Pulumi — stack state and preview JSON.
//
// Pulumi programs are TypeScript, Python, Go or C#, and the same argument
// applies as for CDK: the language is not the artefact. `pulumi stack export`
// emits the deployed state and `pulumi preview --json` emits what a change will
// do, both with resolved property values and an explicit dependency graph. Both
// are Mode A inputs. A TypeScript AST walk over the program would re-derive
// worse versions of facts these files already state exactly.
//
// The other reason this is short: Pulumi's AWS, GCP and Azure providers are
// generated from the same schemas as Terraform's, so a URN's type maps onto the
// Terraform rules already in the registry. `aws:ec2/instance:Instance` is
// `aws_instance`. That correspondence is mechanical, and doing it here means
// every rule contributed for Terraform also serves Pulumi.

import { createIR, irNode, irEdge, normalizeIR, ulidFrom } from '@archsim/ir'
import { capacityFor } from '@archsim/core'
import { findRule, isStructural, isConnector, isNoise, providerOf } from './mappings/index.js'
import { inferEdges } from './edges.js'
import { attachClient, edgeCtx } from './ingest.js'

const ctxBase = { seed: (kind) => capacityFor(kind) }

/**
 * A Pulumi URN is `urn:pulumi:<stack>::<project>::<type>::<name>`, and the type
 * is `<provider>:<module>/<member>:<Class>`.
 *
 * @returns `{ stack, project, type, name, provider, terraformType }`
 */
export function parseUrn(urn) {
  const parts = String(urn).split('::')
  if (parts.length < 4 || !parts[0].startsWith('urn:pulumi:')) return null
  const stack = parts[0].slice('urn:pulumi:'.length)
  const project = parts[1]
  const type = parts[parts.length - 2]
  const name = parts[parts.length - 1]
  return { stack, project, type, name, ...typeToTerraform(type) }
}

/**
 * `aws:ec2/instance:Instance` → `aws_instance`.
 * `aws:elasticloadbalancingv2/loadBalancer:LoadBalancer` → `aws_lb`.
 *
 * The rule is: take the class name, split its camel case, lowercase it, and
 * prefix the provider. That is exactly how the Pulumi bridge derives a class
 * name from a Terraform type, run backwards. A handful of resources renamed on
 * the way across, and those are listed rather than guessed.
 */
const RENAMES = {
  'aws:elasticloadbalancingv2/loadBalancer:LoadBalancer': 'aws_lb',
  'aws:elasticloadbalancingv2/targetGroup:TargetGroup': 'aws_lb_target_group',
  'aws:elasticloadbalancingv2/listener:Listener': 'aws_lb_listener',
  'aws:rds/cluster:Cluster': 'aws_rds_cluster',
  'aws:rds/instance:Instance': 'aws_db_instance',
  'aws:ecs/service:Service': 'aws_ecs_service',
  'aws:lambda/function:Function': 'aws_lambda_function',
  'aws:s3/bucket:Bucket': 'aws_s3_bucket',
  'aws:s3/bucketV2:BucketV2': 'aws_s3_bucket',
  'aws:elasticache/cluster:Cluster': 'aws_elasticache_cluster',
  'aws:elasticache/replicationGroup:ReplicationGroup': 'aws_elasticache_replication_group',
  'aws:cloudfront/distribution:Distribution': 'aws_cloudfront_distribution',
  'aws:sqs/queue:Queue': 'aws_sqs_queue',
  'aws:dynamodb/table:Table': 'aws_dynamodb_table',
  'kubernetes:apps/v1:Deployment': 'apps/v1:Deployment',
  'kubernetes:apps/v1:StatefulSet': 'apps/v1:StatefulSet',
  'kubernetes:core/v1:Service': 'v1:Service',
}

export function typeToTerraform(type) {
  const t = String(type)
  if (RENAMES[t]) {
    const tf = RENAMES[t]
    return { provider: providerOf(tf), terraformType: tf }
  }
  const m = /^([a-z0-9-]+):([^:]+):([A-Za-z0-9]+)$/.exec(t)
  if (!m) return { provider: 'unknown', terraformType: t }
  const [, ns, , cls] = m
  const provider = ns === 'kubernetes' ? 'k8s' : ns === 'google-native' ? 'gcp' : ns === 'azure-native' ? 'azure' : ns
  if (provider === 'k8s') return { provider, terraformType: t }
  const snake = cls.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
  const prefix = provider === 'gcp' ? 'google' : provider === 'azure' ? 'azurerm' : provider
  return { provider, terraformType: `${prefix}_${snake}` }
}

/** Pulumi's own bookkeeping: a stack, a provider instance, a component wrapper. */
const INTERNAL = /^pulumi:(pulumi|providers):/

/**
 * Stack state (`pulumi stack export`) or preview (`pulumi preview --json`) → IR.
 *
 * A preview names resources that do not exist yet; a state names resources that
 * do. Both are read the same way, and the report says which it was, because
 * "this is what is deployed" and "this is what will be deployed" are different
 * claims and the gate should not confuse them.
 */
export function pulumiToIR(doc, opts = {}) {
  const file = opts.file || 'pulumi.json'
  const managed = opts.managed || 'observed'
  const ir = createIR({ name: opts.name || 'pulumi', createdBy: 'archsim-iac' })
  const report = { mapped: 0, structural: 0, unmapped: 0, resources: [], warnings: [], source: null }

  const { resources, source } = collectPulumiResources(doc)
  report.source = source
  if (!resources.length) {
    report.warnings.push({ address: file, msg: 'no resources found — expected `pulumi stack export` or `pulumi preview --json` output' })
    return { ir: normalizeIR(ir), report }
  }

  const nodesByAddress = new Map()
  const connectors = new Set()
  const hints = []
  const deps = new Map()
  const byUrn = new Map(resources.map((r) => [r.urn, r]))

  for (const res of resources) {
    const parsed = parseUrn(res.urn)
    if (!parsed || INTERNAL.test(parsed.type)) continue
    const address = pulumiAddress(parsed)

    if (res.dependencies?.length || res.propertyDependencies) {
      const set = new Set([
        ...(res.dependencies || []),
        ...Object.values(res.propertyDependencies || {}).flat(),
        ...(res.parent && byUrn.has(res.parent) ? [res.parent] : []),
      ])
      for (const d of set) {
        const p = parseUrn(d)
        if (!p || INTERNAL.test(p.type)) continue
        if (!deps.has(address)) deps.set(address, new Set())
        deps.get(address).add(pulumiAddress(p))
      }
    }

    const type = parsed.terraformType
    const attrs = res.inputs || res.outputs || res.newState?.inputs || {}
    const rule = findRule(parsed.provider, type, attrs)

    if (!rule && (isStructural(type) || isNoise(type))) {
      if (isConnector(type)) connectors.add(address)
      report.structural++
      report.resources.push({ address, type, disposition: isConnector(type) ? 'connector' : isNoise(type) ? 'noise' : 'structural' })
      continue
    }

    const kind = rule ? (rule.kindOf?.(attrs) || rule.kind || 'custom') : 'custom'
    if (kind === null) continue
    if (!rule) {
      report.unmapped++
      report.warnings.push({ address, msg: `no mapping rule for '${type}' (Pulumi type '${parsed.type}') — rendered as a custom component, not dropped` })
    } else {
      report.mapped++
    }

    const seeded = capacityFor(kind, rule ? {} : { provenanceCls: 'modeled', basis: `no mapping rule for '${type}'; simulated as a generic component` })
    const node = irNode({
      id: ulidFrom(`pulumi:${address}`),
      kind,
      label: parsed.name,
      capacity: { ...seeded, ...(rule?.capacity?.(attrs, { ...ctxBase, ...edgeCtx(), address }) || {}) },
      bindings: [{ lang: 'pulumi', file, address, managed }],
      attrs: { pulumiType: parsed.type, tfType: type, stack: parsed.stack },
    })
    ir.nodes.push(node)
    nodesByAddress.set(address, node)
    report.resources.push({ address, type, disposition: rule ? 'mapped' : 'unmapped', kind })

    for (const h of rule?.edges?.(attrs, { ...ctxBase, ...edgeCtx(), address }) || []) {
      hints.push({ from: h.from || address, to: h.to, confidence: h.confidence, reason: h.reason, protocol: h.protocol })
    }
  }

  ir.edges.push(...inferEdges(hints, nodesByAddress, connectors, deps, (spec) => irEdge(spec)))
  attachClient(ir)
  return { ir: normalizeIR(ir), report }
}

const pulumiAddress = (parsed) => `${parsed.type}::${parsed.name}`

/**
 * The two shapes, told apart by what they contain rather than by a flag the
 * caller passes — a caller who has to know which file they have is a caller who
 * will get it wrong.
 */
function collectPulumiResources(doc) {
  if (Array.isArray(doc?.steps)) {
    // preview: each step carries the resource it would create or change
    return {
      source: 'preview',
      resources: doc.steps
        .filter((s) => s.op !== 'delete' && (s.newState || s.oldState))
        .map((s) => ({ ...(s.newState || s.oldState), urn: s.urn || (s.newState || s.oldState)?.urn })),
    }
  }
  const state = doc?.deployment?.resources || doc?.checkpoint?.latest?.resources || doc?.resources
  if (Array.isArray(state)) return { source: 'state', resources: state }
  return { source: null, resources: [] }
}
