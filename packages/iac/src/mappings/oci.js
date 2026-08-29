// Oracle Cloud mapping table.
//
// The smallest of the four provider tables, and it says so: `coverage()`
// reports it, and an unmapped OCI resource renders as `custom` with passthrough
// rather than disappearing. A short honest table beats a long speculative one —
// every rule here corresponds to a resource whose capacity or replica count is
// actually stated in the Terraform, which is the only reason a rule earns its
// place.

import { sizeFromInstanceClass } from '../sizing.js'

const num = (v, d = 0) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

const r = (type, kind, extra = {}) => ({ match: { provider: 'oci', type }, kind, ...extra })

export const OCI_RULES = [
  /* edge and routing */
  r('oci_load_balancer_load_balancer', 'lb', {
    // OCI sizes a load balancer by bandwidth shape rather than by instance
    // class: 10Mbps through flexible. The shape is the capacity statement.
    capacity: (a, ctx) => {
      const shape = String(a.shape || '')
      const mbps = /^(\d+)Mbps$/.exec(shape)
      const seed = ctx.seed('lb')
      if (!mbps) return seed
      // ~1 KB responses: bandwidth in Mbps is roughly requests/sec × 8/1000.
      return { ...seed, capPerReplica: Math.max(100, Math.round((Number(mbps[1]) * 1000) / 8)) }
    },
    attrs: (a) => ({ shape: a.shape }),
  }),
  r('oci_load_balancer', 'lb'),
  r('oci_network_load_balancer_network_load_balancer', 'lb'),
  r('oci_apigateway_gateway', 'gateway'),
  r('oci_waas_waas_policy', 'waf'),
  r('oci_dns_zone', 'dns'),

  /* compute */
  r('oci_core_instance', 'app', {
    capacity: (a, ctx) => sizeFromInstanceClass(ctx.seed('app'), a.shape),
  }),
  r('oci_core_instance_pool', 'app', {
    capacity: (a) => ({ replicas: Math.max(1, num(a.size, 1)) }),
    patch: { replicas: { attr: 'size' } },
  }),
  r('oci_containerengine_cluster', 'k8s'),
  r('oci_containerengine_node_pool', 'app', {
    capacity: (a) => ({ replicas: Math.max(1, num(a.node_config_details?.size, num(a.quantity_per_subnet, 1))) }),
    patch: { replicas: { attr: 'size' } },
  }),
  r('oci_functions_function', 'worker'),
  r('oci_functions_application', 'worker'),

  /* data */
  r('oci_database_autonomous_database', 'sql', {
    capacity: (a, ctx) => ({
      ...ctx.seed('sql'),
      // OCPUs are the only capacity dial an Autonomous Database exposes, and it
      // scales close to linearly in them.
      capPerReplica: Math.max(1, ctx.seed('sql').capPerReplica * Math.max(1, num(a.cpu_core_count, num(a.compute_count, 1)))),
    }),
    attrs: (a) => ({ engine: a.db_workload || 'OLTP' }),
  }),
  r('oci_database_db_system', 'sql', {
    capacity: (a) => ({ replicas: Math.max(1, num(a.node_count, 1)) }),
    patch: { replicas: { attr: 'node_count' } },
    attrs: () => ({ replication: 'leader' }),
  }),
  r('oci_mysql_mysql_db_system', 'sql'),
  r('oci_nosql_table', 'nosql', {
    capacity: (a, ctx) => {
      const read = num(a.table_limits?.max_read_units, 0)
      const write = num(a.table_limits?.max_write_units, 0)
      return read + write ? { ...ctx.seed('nosql'), capPerReplica: Math.max(1, read + write) } : {}
    },
  }),
  r('oci_cache_redis_cluster', 'cache', {
    capacity: (a) => ({ replicas: Math.max(1, num(a.node_count, 1)) }),
    patch: { replicas: { attr: 'node_count' } },
  }),
  r('oci_objectstorage_bucket', 'blob'),
  r('oci_opensearch_opensearch_cluster', 'search', {
    capacity: (a) => ({ replicas: Math.max(1, num(a.data_node_count, 1)) }),
  }),
  r('oci_bds_bds_instance', 'lake'),
  r('oci_analytics_analytics_instance', 'bi'),

  /* messaging */
  r('oci_queue_queue', 'queue'),
  r('oci_streaming_stream', 'kafka', {
    capacity: (a) => ({ replicas: Math.max(1, num(a.partitions, 1)) }),
    patch: { replicas: { attr: 'partitions' } },
  }),
  r('oci_streaming_stream_pool', 'kafka'),
  r('oci_ons_notification_topic', 'push'),

  /* platform — real, and never on the request path */
  r('oci_vault_secret', 'secrets'),
  r('oci_kms_key', 'crypto'),
  r('oci_logging_log', 'logs'),
  r('oci_monitoring_alarm', 'alert'),
  r('oci_artifacts_container_repository', 'containerreg'),
  r('oci_ai_language_model', 'ml'),
  r('oci_generative_ai_dedicated_ai_cluster', 'llm'),
]

export const OCI_STRUCTURAL = new Set([
  'oci_core_vcn', 'oci_core_subnet', 'oci_core_route_table', 'oci_core_route_table_attachment',
  'oci_core_internet_gateway', 'oci_core_nat_gateway', 'oci_core_service_gateway',
  'oci_core_local_peering_gateway', 'oci_core_drg', 'oci_core_drg_attachment',
  'oci_core_security_list', 'oci_core_network_security_group',
  'oci_core_network_security_group_security_rule', 'oci_core_default_security_list',
  'oci_core_default_route_table', 'oci_core_default_dhcp_options', 'oci_core_dhcp_options',
  'oci_core_public_ip', 'oci_core_private_ip', 'oci_core_vnic_attachment',
  'oci_identity_compartment', 'oci_identity_policy', 'oci_identity_group',
  'oci_identity_dynamic_group', 'oci_identity_user', 'oci_identity_user_group_membership',
  'oci_identity_tag', 'oci_identity_tag_namespace', 'oci_identity_availability_domain',
  'oci_core_volume', 'oci_core_volume_attachment', 'oci_file_storage_file_system',
  'oci_file_storage_mount_target', 'oci_file_storage_export',
])

/** Structural, but traffic passes through. */
export const OCI_CONNECTORS = new Set([
  'oci_load_balancer_backend_set', 'oci_load_balancer_backend', 'oci_load_balancer_listener',
  'oci_load_balancer_hostname', 'oci_load_balancer_path_route_set',
  'oci_network_load_balancer_backend_set', 'oci_network_load_balancer_backend',
  'oci_network_load_balancer_listener',
  'oci_apigateway_deployment',
  'oci_core_instance_configuration', 'oci_core_instance_pool_instance',
  'oci_dns_rrset', 'oci_dns_record',
])

export const OCI_NOISE = new Set([
  'oci_autoscaling_auto_scaling_configuration',
  'oci_objectstorage_object_lifecycle_policy',
  'oci_logging_log_group',
  'oci_bastion_bastion', 'oci_bastion_session',
])
