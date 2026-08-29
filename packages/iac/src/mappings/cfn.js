// CloudFormation mapping table.
//
// This table is also how AWS CDK is read. CDK is TypeScript, and the obvious
// move is a TypeScript AST extractor — but CDK's whole job is to turn that
// TypeScript into CloudFormation, and it does that correctly, resolving
// constructs, escape hatches, aspects and generated logical ids that no
// third-party AST walk can reproduce. Reading `cdk.out/*.template.json` is not
// a compromise for reading the source: it is reading the answer instead of
// re-deriving it and getting a worse one.
//
// The same argument applies to SAM (`sam build` emits a template) and to any
// other transpiler that targets CloudFormation.

import { sizeFromInstanceClass } from '../sizing.js'

const num = (v, d = 0) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

const r = (type, kind, extra = {}) => ({ match: { provider: 'cfn', type }, kind, ...extra })

export const CFN_RULES = [
  /* edge and routing */
  r('AWS::CloudFront::Distribution', 'cdn'),
  r('AWS::Route53::HostedZone', 'dns'),
  r('AWS::ElasticLoadBalancingV2::LoadBalancer', 'lb', {
    attrs: (a) => ({ lbType: a.Type || 'application' }),
  }),
  r('AWS::ElasticLoadBalancing::LoadBalancer', 'lb'),
  r('AWS::ApiGateway::RestApi', 'gateway'),
  // A WebSocket API holds connections; an HTTP one does not. Different
  // queueing problem, so the ordering matters — the narrower rule goes first.
  { match: { provider: 'cfn', type: 'AWS::ApiGatewayV2::Api', when: (a) => a.ProtocolType === 'WEBSOCKET' }, kind: 'ws' },
  r('AWS::ApiGatewayV2::Api', 'gateway'),
  r('AWS::AppSync::GraphQLApi', 'graphql'),
  r('AWS::WAFv2::WebACL', 'waf'),
  r('AWS::GlobalAccelerator::Accelerator', 'gslb'),

  /* compute */
  r('AWS::EC2::Instance', 'app', {
    capacity: (a, ctx) => sizeFromInstanceClass(ctx.seed('app'), a.InstanceType),
  }),
  r('AWS::AutoScaling::AutoScalingGroup', 'app', {
    capacity: (a, ctx) => ({
      ...sizeFromInstanceClass(ctx.seed('app'), a.InstanceType),
      replicas: Math.max(1, num(a.DesiredCapacity, num(a.MinSize, 1))),
    }),
    patch: { replicas: { attr: 'DesiredCapacity' } },
  }),
  r('AWS::ECS::Service', 'micro', {
    capacity: (a) => ({ replicas: Math.max(1, num(a.DesiredCount, 1)) }),
    patch: { replicas: { attr: 'DesiredCount' } },
  }),
  r('AWS::Lambda::Function', 'worker', {
    // Reserved concurrency is the only capacity figure a template states about
    // a Lambda. Without it the ceiling is the account's, which is not a
    // property of this architecture.
    capacity: (a, ctx) => (a.ReservedConcurrentExecutions
      ? { ...ctx.seed('worker'), concurrency: num(a.ReservedConcurrentExecutions, 64) }
      : {}),
  }),
  r('AWS::AppRunner::Service', 'micro'),
  r('AWS::Batch::JobQueue', 'batch'),
  r('AWS::EKS::Cluster', 'k8s'),
  r('AWS::ECS::Cluster', 'k8s'),

  /* data */
  r('AWS::RDS::DBInstance', 'sql', {
    capacity: (a, ctx) => ({
      ...sizeFromInstanceClass(ctx.seed('sql'), a.DBInstanceClass),
      replicas: a.MultiAZ === true || a.MultiAZ === 'true' ? 2 : 1,
    }),
    attrs: (a) => ({ engine: a.Engine, replication: a.MultiAZ ? 'sync' : undefined }),
  }),
  r('AWS::RDS::DBCluster', 'sql', {
    capacity: () => ({ replicas: 2 }),
    attrs: (a) => ({ engine: a.Engine, replication: 'leader' }),
  }),
  r('AWS::DynamoDB::Table', 'nosql', {
    capacity: (a, ctx) => (a.ProvisionedThroughput
      ? { ...ctx.seed('nosql'), capPerReplica: Math.max(1, num(a.ProvisionedThroughput.ReadCapacityUnits, 0) + num(a.ProvisionedThroughput.WriteCapacityUnits, 0)) }
      : {}),
    attrs: (a) => ({ billing: a.BillingMode || 'PROVISIONED' }),
  }),
  r('AWS::DynamoDB::GlobalTable', 'nosql', { attrs: () => ({ replication: 'multi-region' }) }),
  r('AWS::ElastiCache::CacheCluster', 'cache', {
    capacity: (a) => ({ replicas: Math.max(1, num(a.NumCacheNodes, 1)) }),
    patch: { replicas: { attr: 'NumCacheNodes' } },
  }),
  r('AWS::ElastiCache::ReplicationGroup', 'cache', {
    capacity: (a) => ({ replicas: Math.max(1, num(a.NumCacheClusters, num(a.ReplicasPerNodeGroup, 0) + 1)) }),
    patch: { replicas: { attr: 'NumCacheClusters' } },
  }),
  r('AWS::S3::Bucket', 'blob'),
  r('AWS::OpenSearchService::Domain', 'search', {
    capacity: (a) => ({ replicas: Math.max(1, num(a.ClusterConfig?.InstanceCount, 1)) }),
  }),
  r('AWS::Elasticsearch::Domain', 'search'),
  r('AWS::Neptune::DBCluster', 'graph'),
  r('AWS::Timestream::Table', 'tsdb'),
  r('AWS::Redshift::Cluster', 'warehouse', {
    capacity: (a) => ({ replicas: Math.max(1, num(a.NumberOfNodes, 1)) }),
  }),

  /* messaging */
  r('AWS::SQS::Queue', 'queue'),
  r('AWS::SNS::Topic', 'queue', { attrs: () => ({ fanout: 'true' }) }),
  r('AWS::MSK::Cluster', 'kafka', {
    capacity: (a) => ({ replicas: Math.max(1, num(a.NumberOfBrokerNodes, 1)) }),
  }),
  r('AWS::Kinesis::Stream', 'kafka', {
    capacity: (a) => ({ replicas: Math.max(1, num(a.ShardCount, 1)) }),
    patch: { replicas: { attr: 'ShardCount' } },
  }),
  r('AWS::Events::EventBus', 'queue'),
  r('AWS::StepFunctions::StateMachine', 'saga'),
  r('AWS::AmazonMQ::Broker', 'mq'),

  /* platform — real, and never on the request path */
  r('AWS::Cognito::UserPool', 'iam'),
  r('AWS::SecretsManager::Secret', 'secrets'),
  r('AWS::KMS::Key', 'crypto'),
  r('AWS::CloudTrail::Trail', 'audit'),
  r('AWS::Logs::LogGroup', 'logs'),
  r('AWS::CloudWatch::Alarm', 'alert'),
  r('AWS::ECR::Repository', 'containerreg'),
  r('AWS::SageMaker::Endpoint', 'ml'),
  r('AWS::Bedrock::Agent', 'aiagent'),
]

/**
 * Real infrastructure, never a component. Networking, permissions and the
 * plumbing that attaches one resource to another — each one round-trips through
 * passthrough, and none of them belongs on a diagram of where requests go.
 */
export const CFN_STRUCTURAL = new Set([
  'AWS::EC2::VPC', 'AWS::EC2::Subnet', 'AWS::EC2::RouteTable', 'AWS::EC2::Route',
  'AWS::EC2::SubnetRouteTableAssociation', 'AWS::EC2::InternetGateway', 'AWS::EC2::NatGateway',
  'AWS::EC2::VPCGatewayAttachment', 'AWS::EC2::EIP', 'AWS::EC2::SecurityGroup',
  'AWS::EC2::SecurityGroupIngress', 'AWS::EC2::SecurityGroupEgress', 'AWS::EC2::VPCEndpoint',
  'AWS::IAM::Role', 'AWS::IAM::Policy', 'AWS::IAM::ManagedPolicy', 'AWS::IAM::InstanceProfile',
  'AWS::IAM::User', 'AWS::IAM::Group', 'AWS::IAM::ServiceLinkedRole',
  'AWS::RDS::DBSubnetGroup', 'AWS::ElastiCache::SubnetGroup', 'AWS::Redshift::ClusterSubnetGroup',
  'AWS::CertificateManager::Certificate', 'AWS::Route53::RecordSet', 'AWS::Route53::RecordSetGroup',
  'AWS::Lambda::Permission', 'AWS::Lambda::EventInvokeConfig', 'AWS::Lambda::LayerVersion',
  'AWS::SNS::Subscription', 'AWS::SNS::TopicPolicy', 'AWS::SQS::QueuePolicy',
  'AWS::S3::BucketPolicy', 'AWS::KMS::Alias', 'AWS::SSM::Parameter',
  'AWS::CDK::Metadata', 'AWS::CloudFormation::WaitCondition', 'AWS::CloudFormation::WaitConditionHandle',
])

/** Structural, but traffic passes through: edge inference may hop these. */
export const CFN_CONNECTORS = new Set([
  'AWS::ElasticLoadBalancingV2::TargetGroup',
  'AWS::ElasticLoadBalancingV2::Listener',
  'AWS::ElasticLoadBalancingV2::ListenerRule',
  'AWS::ApiGateway::Deployment', 'AWS::ApiGateway::Stage', 'AWS::ApiGateway::Method',
  'AWS::ApiGateway::Resource', 'AWS::ApiGateway::Integration',
  'AWS::ApiGatewayV2::Route', 'AWS::ApiGatewayV2::Integration', 'AWS::ApiGatewayV2::Stage',
  'AWS::Lambda::EventSourceMapping',
  'AWS::Events::Rule',
  'AWS::AppSync::Resolver', 'AWS::AppSync::DataSource',
  'AWS::ECS::TaskDefinition',
  'AWS::AutoScaling::LaunchConfiguration', 'AWS::EC2::LaunchTemplate',
  'AWS::CloudFront::OriginAccessControl', 'AWS::CloudFront::CachePolicy',
])

/** Provisioning glue and settings-on-a-resource. */
export const CFN_NOISE = new Set([
  'AWS::CloudFormation::CustomResource', 'Custom::LogRetention', 'Custom::S3AutoDeleteObjects',
  'AWS::AutoScaling::ScalingPolicy', 'AWS::ApplicationAutoScaling::ScalableTarget',
  'AWS::ApplicationAutoScaling::ScalingPolicy',
  'AWS::Logs::SubscriptionFilter', 'AWS::Logs::MetricFilter',
])

export const CFN_NOISE_PREFIXES = ['Custom::']
