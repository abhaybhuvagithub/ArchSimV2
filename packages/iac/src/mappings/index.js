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

import { AWS_RULES, AWS_STRUCTURAL, AWS_CONNECTORS } from './aws.js'
import { GCP_RULES, GCP_STRUCTURAL, GCP_CONNECTORS } from './gcp.js'
import { AZURE_RULES, AZURE_STRUCTURAL, AZURE_CONNECTORS } from './azure.js'
import { K8S_RULES, K8S_STRUCTURAL, K8S_CONNECTORS } from './k8s.js'

const RULES = [...AWS_RULES, ...GCP_RULES, ...AZURE_RULES, ...K8S_RULES]
const CONNECTORS = new Set([...AWS_CONNECTORS, ...GCP_CONNECTORS, ...AZURE_CONNECTORS, ...K8S_CONNECTORS])
const STRUCTURAL = new Set([...AWS_STRUCTURAL, ...GCP_STRUCTURAL, ...AZURE_STRUCTURAL, ...K8S_STRUCTURAL, ...CONNECTORS])

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
  return { rules: allRules().length, byProvider, structural: STRUCTURAL.size, connectors: CONNECTORS.size }
}

export { AWS_RULES, GCP_RULES, AZURE_RULES, K8S_RULES }
