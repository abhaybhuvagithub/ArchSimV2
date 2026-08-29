// Google Cloud mapping table.
//
// Smaller than the AWS table, and honest about it: coverage is reported by
// `coverage()` and unmapped resources render as `custom` with passthrough,
// so a GCP repo is never silently half-modelled.

import { sizeFromInstanceClass } from '../sizing.js'

const r = (type, kind, extra = {}) => ({ match: { provider: 'gcp', type }, kind, ...extra })

export const GCP_RULES = [
  r('google_compute_global_forwarding_rule', 'lb'),
  r('google_compute_forwarding_rule', 'lb'),
  r('google_compute_backend_service', 'lb'),
  r('google_compute_url_map', 'gateway'),
  r('google_api_gateway_gateway', 'gateway'),
  r('google_dns_managed_zone', 'dns'),
  r('google_compute_instance', 'app', {
    capacity: (a, ctx) => sizeFromInstanceClass(ctx.seed('app'), (a.machine_type || '').replace(/^.*\//, '')),
    patch: { replicas: { attr: 'count' } },
  }),
  r('google_compute_instance_group_manager', 'app', {
    capacity: (a) => ({ replicas: num(a.target_size, 1) }),
    patch: { replicas: { attr: 'target_size' } },
  }),
  r('google_cloud_run_service', 'micro', { capacity: () => ({ replicas: 2 }) }),
  r('google_cloud_run_v2_service', 'micro', {
    capacity: (a) => ({ replicas: num(a.template?.scaling?.min_instance_count, 1) }),
    patch: { replicas: { attr: 'min_instance_count' } },
  }),
  r('google_cloudfunctions_function', 'worker'),
  r('google_cloudfunctions2_function', 'worker'),
  r('google_container_cluster', 'k8s'),
  r('google_sql_database_instance', 'sql', {
    capacity: (a, ctx) => ({
      ...sizeFromInstanceClass(ctx.seed('sql'), (a.settings?.tier || '').replace('db-custom-', 'db.custom.')),
      replicas: a.settings?.availability_type === 'REGIONAL' ? 2 : 1,
    }),
    attrs: () => ({ replication: 'leader' }),
  }),
  r('google_spanner_instance', 'sql', {
    capacity: (a) => ({ replicas: Math.max(1, num(a.num_nodes, 1)) }),
    attrs: () => ({ consistency: 'linearizable' }), // Spanner's whole proposition, and it is not free
  }),
  r('google_bigtable_instance', 'nosql'),
  r('google_firestore_database', 'nosql'),
  r('google_redis_instance', 'cache'),
  r('google_storage_bucket', 'blob'),
  r('google_pubsub_topic', 'queue'),
  r('google_pubsub_subscription', 'queue'),
  r('google_bigquery_dataset', 'warehouse'),
  r('google_dataflow_job', 'stream'),
  r('google_dataproc_cluster', 'analytics'),
  r('google_vertex_ai_endpoint', 'ml'),
  r('google_secret_manager_secret', 'secrets'),
  r('google_kms_crypto_key', 'crypto'),
  r('google_artifact_registry_repository', 'containerreg'),
  r('google_compute_backend_bucket', 'cdn'),
]

export const GCP_NOISE = ['google_project_service', 'google_storage_bucket_object', 'google_secret_manager_secret_version']

export const GCP_CONNECTORS = [
  'google_compute_backend_service', 'google_compute_url_map', 'google_compute_target_https_proxy',
  'google_compute_health_check', 'google_compute_instance_group', 'google_cloud_run_service_iam_member',
]

export const GCP_STRUCTURAL = [
  'google_compute_network', 'google_compute_subnetwork', 'google_compute_firewall',
  'google_compute_router', 'google_compute_address', 'google_compute_global_address',
  'google_service_account', 'google_project_iam_member', 'google_project_iam_binding',
  'google_compute_health_check', 'google_compute_ssl_certificate', 'google_compute_target_https_proxy',
]

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)
