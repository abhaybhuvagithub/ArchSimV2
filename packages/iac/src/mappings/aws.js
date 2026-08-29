// AWS mapping table.
//
// Normalization is data, not code. That is the whole design: a versioned,
// community-extensible table of rules, so adding a provider resource is a pull
// request against a list rather than a change to the compiler. Everything the
// table does not match becomes `kind: 'custom'` plus full passthrough — never
// dropped, never guessed.
//
// Each rule may supply:
//   kind      the canonical component this resource simulates as
//   capacity  (attrs, ctx) => Partial<CapacityModel>
//   edges     (attrs, ctx) => EdgeHint[]  — inferred connections, with confidence
//   patch     which IR fields map to which HCL attribute (surgical edits)
//   emit      how to generate this resource from scratch (canvas → code)

import { sizeFromInstanceClass, sizeFromLambdaMemory } from '../sizing.js'

const r = (type, kind, extra = {}) => ({ match: { provider: 'aws', type }, kind, ...extra })

export const AWS_RULES = [
  // ── edge / traffic ────────────────────────────────────────────────────────
  r('aws_lb', 'lb', {
    label: (a, addr) => a.name || tail(addr),
    capacity: (a) => (a.load_balancer_type === 'network' ? { capPerReplica: 300000, latencyMs: { dist: 'lognormal', p50: 0.5, cv: 0.4 } } : {}),
    edges: (a, ctx) => ctx.targetGroupsFor(ctx.address).map((tg) => ({ to: tg, confidence: 'high', reason: 'listener → target group attachment', protocol: 'http' })),
    emit: emitLB,
  }),
  r('aws_alb', 'lb', { emit: emitLB }),
  r('aws_elb', 'lb'),
  r('aws_lb_listener', null, { // not a node: a listener is an edge fact
    edgeOnly: true,
    edges: (a, ctx) => {
      const lb = ref(a.load_balancer_arn)
      const tg = ref(a.default_action?.target_group_arn) || ctx.firstTargetGroupRef(a)
      return lb && tg ? [{ from: lb, to: tg, confidence: 'high', reason: 'aws_lb_listener default action', protocol: 'http' }] : []
    },
  }),
  r('aws_lb_target_group_attachment', null, {
    edgeOnly: true,
    edges: (a) => {
      const tg = ref(a.target_group_arn), t = ref(a.target_id)
      return tg && t ? [{ from: tg, to: t, confidence: 'high', reason: 'target group attachment' }] : []
    },
  }),
  r('aws_api_gateway_rest_api', 'gateway', { emit: emitSimple('aws_api_gateway_rest_api', { name: (n) => n.label }) }),
  r('aws_apigatewayv2_api', 'gateway', {
    capacity: (a) => (a.protocol_type === 'WEBSOCKET' ? { capPerReplica: 50000, latencyMs: { dist: 'lognormal', p50: 5, cv: 0.5 } } : {}),
  }),
  r('aws_cloudfront_distribution', 'cdn'),
  r('aws_route53_zone', 'dns'),
  r('aws_route53_record', null, { edgeOnly: true }),
  r('aws_wafv2_web_acl', 'waf'),
  r('aws_globalaccelerator_accelerator', 'gslb'),

  // ── compute ───────────────────────────────────────────────────────────────
  r('aws_instance', 'app', {
    capacity: (a, ctx) => sizeFromInstanceClass(ctx.seed('app'), a.instance_type, ['https://aws.amazon.com/ec2/pricing/on-demand/']),
    patch: { replicas: { attr: 'count' } },
    emit: emitInstance,
  }),
  r('aws_autoscaling_group', 'app', {
    capacity: (a, ctx) => ({ ...sizeFromInstanceClass(ctx.seed('app'), a.instance_type), replicas: num(a.desired_capacity, num(a.min_size, 1)) }),
    patch: { replicas: { attr: 'desired_capacity' } },
  }),
  r('aws_ecs_service', 'micro', {
    capacity: (a) => ({ replicas: num(a.desired_count, 1) }),
    patch: { replicas: { attr: 'desired_count' } },
    edges: (a, ctx) => ctx.taskDefEdges(a.task_definition),
    emit: emitEcsService,
  }),
  r('aws_eks_cluster', 'k8s'),
  r('aws_lambda_function', 'worker', {
    capacity: (a, ctx) => sizeFromLambdaMemory(ctx.seed('worker'), num(a.memory_size, 128)),
    patch: { 'capacity.memory': { attr: 'memory_size' } },
    edges: (a) => envEdges(a.environment?.variables || a.environment?.[0]?.variables),
    emit: emitLambda,
  }),
  r('aws_apprunner_service', 'app'),
  r('aws_batch_job_definition', 'batch'),
  r('aws_sfn_state_machine', 'saga'),
  r('aws_elastic_beanstalk_environment', 'app'),

  // ── data stores ───────────────────────────────────────────────────────────
  r('aws_db_instance', 'sql', {
    capacity: (a, ctx) => ({
      ...sizeFromInstanceClass(ctx.seed('sql'), a.instance_class, ['https://aws.amazon.com/rds/pricing/']),
      replicas: a.multi_az ? 2 : 1,
      availability: a.multi_az ? 0.9995 : 0.999,
    }),
    attrs: (a) => ({ engine: a.engine === 'postgres' || a.engine === 'mysql' ? 'btree' : undefined, replication: a.multi_az ? 'leader' : undefined }),
    patch: { replicas: { attr: 'count' } },
    emit: emitDb,
  }),
  r('aws_rds_cluster', 'sql', {
    capacity: (a, ctx) => ({ ...sizeFromInstanceClass(ctx.seed('sql'), a.instance_class || 'db.r5.large'), replicas: 2 }),
    attrs: () => ({ replication: 'leader' }),
  }),
  r('aws_rds_cluster_instance', 'sql', {
    capacity: (a, ctx) => sizeFromInstanceClass(ctx.seed('sql'), a.instance_class),
  }),
  r('aws_dynamodb_table', 'nosql', {
    capacity: (a, ctx) => {
      const onDemand = (a.billing_mode || 'PROVISIONED') === 'PAY_PER_REQUEST'
      const rcu = num(a.read_capacity, 0), wcu = num(a.write_capacity, 0)
      if (onDemand) return { ...ctx.seed('nosql'), provenance: { cls: 'vendor', basis: 'on-demand DynamoDB: capacity adapts, so the ceiling modelled here is the per-partition limit, not an account limit', refs: ['https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ServiceQuotas.html'] } }
      return {
        ...ctx.seed('nosql'),
        capPerReplica: Math.max(1, rcu + wcu),
        provenance: { cls: 'vendor', basis: `provisioned throughput: ${rcu} RCU + ${wcu} WCU`, refs: [] },
        jitter: { capPct: 15, latPct: 25 },
      }
    },
    attrs: () => ({ engine: 'lsm', consistency: 'eventual' }),
    patch: { 'capacity.readUnits': { attr: 'read_capacity' } },
    emit: emitDynamo,
  }),
  r('aws_elasticache_cluster', 'cache', {
    capacity: (a, ctx) => ({ ...sizeFromInstanceClass(ctx.seed('cache'), a.node_type), replicas: num(a.num_cache_nodes, 1) }),
    patch: { replicas: { attr: 'num_cache_nodes' } },
  }),
  r('aws_elasticache_replication_group', 'cache', {
    capacity: (a, ctx) => ({ ...sizeFromInstanceClass(ctx.seed('cache'), a.node_type), replicas: num(a.num_cache_clusters, num(a.replicas_per_node_group, 1) + 1) }),
    patch: { replicas: { attr: 'num_cache_clusters' } },
  }),
  r('aws_memorydb_cluster', 'cache'),
  r('aws_s3_bucket', 'blob', { emit: emitSimple('aws_s3_bucket', { bucket: (n) => slug(n.label) }) }),
  r('aws_efs_file_system', 'blob'),
  r('aws_opensearch_domain', 'search', {
    capacity: (a, ctx) => ({ ...sizeFromInstanceClass(ctx.seed('search'), a.cluster_config?.instance_type), replicas: num(a.cluster_config?.instance_count, 1) }),
  }),
  r('aws_elasticsearch_domain', 'search'),
  r('aws_redshift_cluster', 'warehouse', { capacity: (a) => ({ replicas: num(a.number_of_nodes, 1) }) }),
  r('aws_neptune_cluster', 'graph'),
  r('aws_docdb_cluster', 'nosql'),
  r('aws_qldb_ledger', 'ledger'),
  r('aws_timestreamwrite_table', 'tsdb'),

  // ── async ─────────────────────────────────────────────────────────────────
  r('aws_sqs_queue', 'queue', {
    attrs: (a) => ({ delivery: a.fifo_queue ? 'effectivelyOnce' : 'atLeastOnce' }),
    capacity: (a) => (a.fifo_queue ? { capPerReplica: 3000, provenance: { cls: 'vendor', basis: 'SQS FIFO: 3,000 msg/s with batching, versus effectively unlimited for standard queues', refs: ['https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-messages.html'] } } : {}),
    emit: emitSimple('aws_sqs_queue', { name: (n) => slug(n.label) }),
  }),
  r('aws_sns_topic', 'queue'),
  r('aws_msk_cluster', 'kafka', { capacity: (a) => ({ replicas: num(a.number_of_broker_nodes, 3) }) }),
  r('aws_kinesis_stream', 'kafka', { capacity: (a) => ({ replicas: num(a.shard_count, 1), capPerReplica: 1000, provenance: { cls: 'vendor', basis: '1,000 records/s per shard write limit', refs: ['https://docs.aws.amazon.com/streams/latest/dev/service-sizes-and-limits.html'] } }) }),
  r('aws_mq_broker', 'mq'),

  // ── data / ML ─────────────────────────────────────────────────────────────
  r('aws_glue_job', 'etl'),
  r('aws_emr_cluster', 'analytics'),
  r('aws_athena_workgroup', 'analytics'),
  r('aws_sagemaker_endpoint', 'ml'),
  r('aws_bedrock_provisioned_model_throughput', 'llm'),

  // ── platform / security ───────────────────────────────────────────────────
  r('aws_cognito_user_pool', 'iam'),
  r('aws_secretsmanager_secret', 'secrets'),
  r('aws_kms_key', 'crypto'),
  r('aws_cloudwatch_log_group', 'logs'),
  r('aws_cloudwatch_metric_alarm', 'alert'),
  r('aws_service_discovery_service', 'registry'),
  r('aws_ecr_repository', 'containerreg'),
  r('aws_transfer_server', 'mft'),
  r('aws_cloudhsm_v2_cluster', 'hsm'),

  // ── found by running the compiler over 14,000 real resources ───────────────
  // Every rule below exists because a real repository had one and the canvas
  // rendered it as an anonymous grey box.
  r('aws_appmesh_mesh', 'mesh'),
  r('aws_appmesh_virtual_node', 'mesh'),
  r('aws_appmesh_virtual_service', 'mesh'),
  r('aws_prometheus_workspace', 'monitor'),
  r('aws_grafana_workspace', 'bi'),
  r('aws_backup_vault', 'backup'),
  r('aws_backup_plan', 'backup'),
  r('aws_dms_endpoint', 'cdc'),
  r('aws_dms_replication_instance', 'cdc'),
  r('aws_datasync_agent', 'mft'),
  r('aws_datazone_domain', 'analytics'),
  r('aws_quicksight_data_source', 'bi'),
  r('aws_quicksight_data_set', 'bi'),
  r('aws_guardduty_detector', 'siem'),
  r('aws_securityhub_account', 'siem'),
  r('aws_config_configuration_recorder', 'audit'),
  r('aws_cloudtrail', 'audit'),
  r('aws_appconfig_application', 'config'),
  r('aws_acmpca_certificate_authority', 'tls'),
  r('aws_medialive_channel', 'transcode'),
  r('aws_mediaconvert_queue', 'transcode'),
  r('aws_elastictranscoder_pipeline', 'transcode'),
  r('aws_kinesisanalyticsv2_application', 'stream'),
  r('aws_kinesis_firehose_delivery_stream', 'stream'),
  r('aws_glue_catalog_database', 'lake'),
  r('aws_lakeformation_resource', 'lake'),
  r('aws_pinpoint_app', 'push'),
  r('aws_sesv2_email_identity', 'push'),
  r('aws_amplify_app', 'edge'),
  r('aws_appsync_graphql_api', 'graphql'),
  r('aws_verifiedaccess_instance', 'iam'),
  r('aws_networkmanager_global_network', 'gslb'),
]

/**
 * Resources that are real infrastructure but not simulable components. They are
 * neither nodes nor lost: recorded as context, re-emitted verbatim. Modelling a
 * VPC as a queueing station would be a lie with a diagram attached.
 */
export const AWS_STRUCTURAL = [
  'aws_vpc', 'aws_subnet', 'aws_internet_gateway', 'aws_nat_gateway', 'aws_route_table',
  'aws_route', 'aws_route_table_association', 'aws_security_group', 'aws_security_group_rule',
  'aws_iam_role', 'aws_iam_policy', 'aws_iam_role_policy', 'aws_iam_role_policy_attachment',
  'aws_iam_instance_profile', 'aws_acm_certificate', 'aws_key_pair',
  'aws_availability_zones', 'aws_caller_identity', 'aws_region', 'aws_ecs_cluster',
  'aws_db_subnet_group', 'aws_elasticache_subnet_group', 'aws_cloudwatch_event_rule',
  // Cloud WAN / Network Manager is network topology, in the same category as a
  // VPC: real, and not a queueing station.
  'aws_networkmanager_core_network', 'aws_networkmanager_core_network_policy_attachment',
  'aws_networkmanager_site', 'aws_networkmanager_device', 'aws_networkmanager_link',
  'aws_networkmanager_connection', 'aws_networkmanager_attachment_accepter',
  'aws_networkmanager_transit_gateway_route_table_attachment',
  'aws_networkmanager_vpc_attachment', 'aws_networkmanager_site_to_site_vpn_attachment',
  'aws_ec2_transit_gateway', 'aws_ec2_transit_gateway_vpc_attachment', 'aws_vpc_peering_connection',
  'aws_dx_gateway', 'aws_dx_connection', 'aws_vpn_gateway', 'aws_customer_gateway',
]

/**
 * Connectors are structural resources that *carry traffic*: a listener, a target
 * group, an attachment, an integration. Edge inference is allowed to hop through
 * these and only these.
 *
 * The distinction matters more than it looks. Every resource in a repo references
 * the VPC, so a compiler that hops through context resources connects everything
 * to everything and produces a diagram shaped like a hairball — technically
 * derived from the code, and useless. Hopping only through connectors is what
 * makes `aws_lb → aws_lb_listener → aws_lb_target_group → attachment →
 * aws_instance` collapse into the one architectural edge a human would draw.
 */
/**
 * Noise: real resources that are not architecture.
 *
 * A `null_resource` is a provisioner hook. `random_pet` names things.
 * `aws_s3_object` uploads a file. `aws_s3_bucket_versioning` is a setting on a
 * bucket that is already a node. None of them queue, serve or fail in a way the
 * simulator can model, and drawing them is worse than useless — a real repo
 * contributes hundreds, and a canvas showing 555 `null_resource` boxes is a
 * canvas nobody looks at twice.
 *
 * They are classified, not dropped: they still round-trip through passthrough
 * byte for byte. The distinction is between "we do not model this" and "we lost
 * this", and only the second one is a bug.
 */
export const AWS_NOISE = [
  // provisioning glue (provider-agnostic — see NOISE_PREFIXES too)
  'null_resource', 'terraform_data', 'aws_ssm_parameter', 'aws_ssm_document',
  'aws_s3_object', 'aws_s3_bucket_object',
  // settings on a resource that is already a node
  'aws_s3_bucket_versioning', 'aws_s3_bucket_acl', 'aws_s3_bucket_policy',
  'aws_s3_bucket_ownership_controls', 'aws_s3_bucket_public_access_block',
  'aws_s3_bucket_server_side_encryption_configuration', 'aws_s3_bucket_lifecycle_configuration',
  'aws_s3_bucket_cors_configuration', 'aws_s3_bucket_logging', 'aws_s3_bucket_notification',
  'aws_s3_bucket_replication_configuration', 'aws_s3_bucket_website_configuration',
  'aws_db_parameter_group', 'aws_db_option_group', 'aws_rds_cluster_parameter_group',
  'aws_elasticache_parameter_group', 'aws_dynamodb_table_item',
  'aws_lambda_permission', 'aws_lambda_alias', 'aws_lambda_layer_version',
  'aws_cloudwatch_log_stream', 'aws_cloudwatch_log_resource_policy',
  'aws_sqs_queue_policy', 'aws_sns_topic_policy', 'aws_sns_topic_subscription',
  'aws_iam_user', 'aws_iam_user_policy_attachment', 'aws_iam_group', 'aws_iam_openid_connect_provider',
]

/** Provider prefixes that never contribute a component, whatever the type. */
export const NOISE_PREFIXES = ['random_', 'tls_', 'local_', 'time_', 'external_', 'archive_', 'template_', 'http_']

export const AWS_CONNECTORS = [
  'aws_lb_listener', 'aws_lb_listener_rule', 'aws_lb_target_group', 'aws_lb_target_group_attachment',
  'aws_autoscaling_attachment', 'aws_ecs_task_definition', 'aws_launch_template',
  'aws_launch_configuration', 'aws_lambda_event_source_mapping', 'aws_lambda_permission',
  'aws_api_gateway_integration', 'aws_api_gateway_resource', 'aws_api_gateway_method',
  'aws_apigatewayv2_integration', 'aws_apigatewayv2_route', 'aws_cloudfront_origin_access_identity',
  'aws_route53_record', 'aws_service_discovery_instance', 'aws_sns_topic_subscription',
  'aws_elasticache_cluster_attachment', 'aws_vpc_endpoint',
]

// ── emit templates ──────────────────────────────────────────────────────────
// Generation is the *rarer* path: most changes are patches to existing blocks.
// These templates exist so a node drawn on the canvas becomes real code, in a
// file the user chose, with a header comment linking back to the IR node id.

function emitLB(node) {
  return `resource "aws_lb" "${slug(node.label)}" {
  name               = "${slug(node.label)}"
  internal           = false
  load_balancer_type = "application"
  subnets            = var.public_subnet_ids
  tags               = var.tags
}`
}

function emitInstance(node) {
  return `resource "aws_instance" "${slug(node.label)}" {
  count         = ${node.capacity.replicas}
  ami           = var.ami_id
  instance_type = "${instanceForCapacity(node.capacity.capPerReplica)}"
  subnet_id     = var.private_subnet_ids[count.index % length(var.private_subnet_ids)]
  tags          = merge(var.tags, { Name = "${node.label}" })
}`
}

function emitEcsService(node) {
  return `resource "aws_ecs_service" "${slug(node.label)}" {
  name            = "${slug(node.label)}"
  cluster         = var.ecs_cluster_id
  task_definition = aws_ecs_task_definition.${slug(node.label)}.arn
  desired_count   = ${node.capacity.replicas}
  launch_type     = "FARGATE"

  network_configuration {
    subnets         = var.private_subnet_ids
    security_groups = [var.app_security_group_id]
  }
}`
}

function emitLambda(node) {
  return `resource "aws_lambda_function" "${slug(node.label)}" {
  function_name = "${slug(node.label)}"
  role          = var.lambda_role_arn
  handler       = "index.handler"
  runtime       = "nodejs20.x"
  memory_size   = 1024
  timeout       = 30
  tags          = var.tags
}`
}

function emitDb(node) {
  return `resource "aws_db_instance" "${slug(node.label)}" {
  identifier           = "${slug(node.label)}"
  engine               = "postgres"
  instance_class       = "${dbInstanceForCapacity(node.capacity.capPerReplica)}"
  allocated_storage    = 100
  multi_az             = ${node.capacity.replicas > 1}
  db_subnet_group_name = var.db_subnet_group_name
  skip_final_snapshot  = false
  tags                 = var.tags
}`
}

function emitDynamo(node) {
  return `resource "aws_dynamodb_table" "${slug(node.label)}" {
  name         = "${slug(node.label)}"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"

  attribute {
    name = "pk"
    type = "S"
  }

  tags = var.tags
}`
}

function emitSimple(type, fields) {
  return (node) => {
    const lines = Object.entries(fields).map(([k, f]) => `  ${k} = "${f(node)}"`)
    return `resource "${type}" "${slug(node.label)}" {\n${lines.join('\n')}\n  tags = var.tags\n}`
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)
const tail = (addr) => String(addr).split('.').pop()
export const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'archsim_node'

/** `aws_lb.main.arn` / `${aws_lb.main.arn}` → `aws_lb.main` */
export function ref(v) {
  if (typeof v !== 'string') return null
  const m = /(?:\$\{)?((?:module\.[A-Za-z0-9_-]+\.)?(?:data\.)?[a-z][a-z0-9_]*\.[A-Za-z0-9_-]+)/.exec(v)
  return m ? m[1] : null
}

/** DATABASE_URL-shaped environment variables are edges hiding in plain sight. */
export function envEdges(vars) {
  if (!vars || typeof vars !== 'object') return []
  const out = []
  for (const [k, v] of Object.entries(vars)) {
    if (typeof v !== 'string') continue
    const target = ref(v)
    if (!target) continue
    const looksLikeDep = /(_URL|_ENDPOINT|_HOST|_ARN|_URI|_ADDRESS)$/i.test(k)
    if (looksLikeDep) out.push({ to: target, confidence: 'medium', reason: `environment variable ${k}` })
  }
  return out
}

function instanceForCapacity(cap) {
  if (cap >= 16000) return 'c6i.4xlarge'
  if (cap >= 8000) return 'c6i.2xlarge'
  if (cap >= 4000) return 'm6i.xlarge'
  return 'm6i.large'
}
function dbInstanceForCapacity(cap) {
  if (cap >= 40000) return 'db.r6g.4xlarge'
  if (cap >= 20000) return 'db.r6g.2xlarge'
  if (cap >= 10000) return 'db.r6g.xlarge'
  return 'db.r6g.large'
}
