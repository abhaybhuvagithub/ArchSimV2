// The mapping registry.
//
// Rules are looked up by (provider, type) with an optional `when` predicate, so
// one resource type can map to different components depending on how it is
// configured — an `aws_apigatewayv2_api` with `protocol_type = "WEBSOCKET"` is a
// different queueing problem from an HTTP one.
//
// The registry is open: `registerRules` lets a repo drop in its own table for
// internal modules and custom resources without forking the compiler. That is
// the answer to the mapping-table maintenance risk — the table is data, and
// data can be contributed.

import { AWS_RULES, AWS_STRUCTURAL, AWS_CONNECTORS, AWS_NOISE, NOISE_PREFIXES } from './aws.js'
import { GCP_RULES, GCP_STRUCTURAL, GCP_CONNECTORS, GCP_NOISE } from './gcp.js'
import { AZURE_RULES, AZURE_STRUCTURAL, AZURE_CONNECTORS, AZURE_NOISE } from './azure.js'
import { K8S_RULES, K8S_STRUCTURAL, K8S_CONNECTORS } from './k8s.js'

const RULES = [...AWS_RULES, ...GCP_RULES, ...AZURE_RULES, ...K8S_RULES]
const CONNECTORS = new Set([...AWS_CONNECTORS, ...GCP_CONNECTORS, ...AZURE_CONNECTORS, ...K8S_CONNECTORS])
const NOISE = new Set([...AWS_NOISE, ...GCP_NOISE, ...AZURE_NOISE])
const STRUCTURAL = new Set([...AWS_STRUCTURAL, ...GCP_STRUCTURAL, ...AZURE_STRUCTURAL, ...K8S_STRUCTURAL, ...CONNECTORS, ...NOISE])

const extra = []

export function registerRules(rules) { extra.push(...rules) }
export function allRules() { return [...extra, ...RULES] }

export function findRule(provider, type, attrs = {}) {
  for (const rule of allRules()) {
    if (rule.match.provider !== provider) continue
    if (rule.match.type !== type) continue
    if (rule.match.when && !rule.match.when(attrs)) continue
    return rule
  }
  return null
}

export const isStructural = (type) => STRUCTURAL.has(type)

/** Structural *and* traffic-carrying: edge inference may hop through these. */
export const isConnector = (type) => CONNECTORS.has(type)

/**
 * Provisioning glue and settings-on-a-resource: real, round-tripped, and never
 * a component. Without this, one real repository puts 555 `null_resource` boxes
 * on the canvas and the diagram stops being worth opening.
 */
export const isNoise = (type) =>
  NOISE.has(type) || NOISE_PREFIXES.some((p) => String(type).startsWith(p)) || isSubResource(type)

/**
 * `aws_cognito_user_pool_client` is a setting on `aws_cognito_user_pool`, which
 * is already a node. Rather than enumerate every sub-resource a provider will
 * ever add, notice that its type name extends a type we already map — and check
 * it only after the explicit rules, so `aws_rds_cluster_instance` (a real
 * component that happens to extend `aws_rds_cluster`) keeps its own mapping.
 */
export function isSubResource(type) {
  const t = String(type)
  // A type with a rule of its own is a component, whatever its name extends.
  // `aws_rds_cluster_instance` extends `aws_rds_cluster` and is not a setting on
  // it; the explicit rule has to win here too, not only at the call site.
  for (const rule of allRules()) if (rule.match.type === t) return false
  for (const rule of allRules()) {
    const parent = rule.match.type
    if (!rule.kind && !rule.kindOf) continue
    if (t.length > parent.length + 1 && t.startsWith(`${parent}_`)) return true
  }
  return false
}

export function providerOf(type) {
  if (type.startsWith('aws_')) return 'aws'
  if (type.startsWith('google_')) return 'gcp'
  if (type.startsWith('azurerm_')) return 'azure'
  if (type.includes(':')) return 'k8s'
  return 'unknown'
}

/** Coverage report — honest about what the tables do and do not know. */
export function coverage() {
  const byProvider = {}
  for (const r of allRules()) {
    const p = r.match.provider
    byProvider[p] = (byProvider[p] || 0) + 1
  }
  return { rules: allRules().length, byProvider, structural: STRUCTURAL.size, connectors: CONNECTORS.size, noise: NOISE.size + NOISE_PREFIXES.length }
}

export { AWS_RULES, GCP_RULES, AZURE_RULES, K8S_RULES }
