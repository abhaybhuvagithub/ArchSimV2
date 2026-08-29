// Azure mapping table.

import { sizeFromInstanceClass } from '../sizing.js'

const r = (type, kind, extra = {}) => ({ match: { provider: 'azure', type }, kind, ...extra })

export const AZURE_RULES = [
  r('azurerm_lb', 'lb'),
  r('azurerm_application_gateway', 'gateway'),
  r('azurerm_api_management', 'gateway'),
  r('azurerm_front_door', 'cdn'),
  r('azurerm_cdn_endpoint', 'cdn'),
  r('azurerm_dns_zone', 'dns'),
  r('azurerm_linux_virtual_machine', 'app', {
    capacity: (a, ctx) => sizeFromInstanceClass(ctx.seed('app'), sizeName(a.size || a.vm_size)),
    patch: { replicas: { attr: 'count' } },
  }),
  r('azurerm_virtual_machine_scale_set', 'app', {
    capacity: (a) => ({ replicas: num(a.sku?.capacity ?? a.instances, 1) }),
    patch: { replicas: { attr: 'instances' } },
  }),
  r('azurerm_linux_web_app', 'web'),
  r('azurerm_function_app', 'worker'),
  r('azurerm_linux_function_app', 'worker'),
  r('azurerm_container_group', 'micro'),
  r('azurerm_kubernetes_cluster', 'k8s'),
  r('azurerm_mssql_database', 'sql'),
  r('azurerm_postgresql_flexible_server', 'sql', {
    capacity: (a, ctx) => sizeFromInstanceClass(ctx.seed('sql'), sizeName(a.sku_name)),
    attrs: (a) => ({ replication: a.high_availability ? 'leader' : undefined }),
  }),
  r('azurerm_mysql_flexible_server', 'sql'),
  r('azurerm_cosmosdb_account', 'nosql', {
    attrs: (a) => ({ consistency: cosmosConsistency(a.consistency_policy?.consistency_level) }),
  }),
  r('azurerm_redis_cache', 'cache', { capacity: (a) => ({ replicas: num(a.replicas_per_master, 0) + 1 }) }),
  r('azurerm_storage_account', 'blob'),
  r('azurerm_servicebus_queue', 'queue'),
  r('azurerm_servicebus_topic', 'queue'),
  r('azurerm_eventhub', 'kafka', { capacity: (a) => ({ replicas: num(a.partition_count, 2) }) }),
  r('azurerm_search_service', 'search'),
  r('azurerm_synapse_workspace', 'warehouse'),
  r('azurerm_key_vault', 'secrets'),
  r('azurerm_machine_learning_workspace', 'ml'),
  r('azurerm_container_registry', 'containerreg'),
  r('azurerm_private_dns_zone', 'dns'),
  r('azurerm_log_analytics_workspace', 'logs'),
  r('azurerm_monitor_action_group', 'alert'),
  r('azurerm_application_insights', 'apm'),
  r('azurerm_data_factory', 'etl'),
  r('azurerm_databricks_workspace', 'analytics'),
]

export const AZURE_NOISE = ['azurerm_key_vault_secret', 'azurerm_storage_blob', 'azurerm_role_definition']

export const AZURE_CONNECTORS = [
  'azurerm_lb_backend_address_pool', 'azurerm_lb_rule', 'azurerm_lb_probe',
  'azurerm_network_interface_backend_address_pool_association', 'azurerm_private_dns_a_record',
]

export const AZURE_STRUCTURAL = [
  'azurerm_resource_group', 'azurerm_virtual_network', 'azurerm_subnet',
  'azurerm_network_security_group', 'azurerm_network_interface', 'azurerm_public_ip',
  'azurerm_role_assignment', 'azurerm_user_assigned_identity', 'azurerm_private_endpoint',
]

// Azure consistency levels map onto the same three the simulator prices.
function cosmosConsistency(level) {
  switch (String(level || '').toLowerCase()) {
    case 'strong': return 'linearizable'
    case 'boundedstaleness':
    case 'session': return 'causal'
    default: return 'eventual'
  }
}

/** 'Standard_D4s_v3' / 'GP_Standard_D4s_v3' → a size token the sizing table reads. */
function sizeName(sku) {
  if (!sku) return null
  const m = /_?([A-Z])(\d+)/.exec(String(sku))
  if (!m) return null
  const cores = Number(m[2])
  const size = cores >= 32 ? '8xlarge' : cores >= 16 ? '4xlarge' : cores >= 8 ? '2xlarge' : cores >= 4 ? 'xlarge' : cores >= 2 ? 'large' : 'medium'
  return `${m[1].toLowerCase()}5.${size}`
}

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)
