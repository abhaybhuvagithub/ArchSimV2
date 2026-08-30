// Kubernetes mapping table.
//
// Two things make K8s a better citizen here than raw cloud IaC: the workload
// object already declares its replica count and resource requests, and the
// Service→Deployment selector relationship is a real, checkable edge rather
// than an inference. What it takes away is the type: a Deployment is not a
// component kind, it is a container image, so the kind has to be inferred from
// what is actually running.

import { sizeFromK8sResources } from '../sizing.js'

/**
 * image → canonical kind. Ordered: first match wins, so be specific first.
 * @type {[re: RegExp, kind: string][]}
 */
export const IMAGE_HINTS = [
  [/(^|\/)(postgres|postgresql|mysql|mariadb|cockroach)/i, 'sql'],
  [/(^|\/)(redis|valkey|memcached)/i, 'cache'],
  [/(^|\/)(mongo|cassandra|scylla|dynamodb-local)/i, 'nosql'],
  [/(^|\/)(elasticsearch|opensearch|solr)/i, 'search'],
  [/(^|\/)(kafka|redpanda|pulsar)/i, 'kafka'],
  [/(^|\/)(rabbitmq|activemq|nats)/i, 'queue'],
  [/(^|\/)(nginx|httpd|apache|caddy|traefik)/i, 'web'],
  [/(^|\/)(envoy|istio|linkerd)/i, 'mesh'],
  [/(^|\/)(prometheus|grafana|victoria)/i, 'monitor'],
  [/(^|\/)(jaeger|tempo|zipkin)/i, 'tracing'],
  [/(^|\/)(otel|opentelemetry)/i, 'otel'],
  [/(^|\/)(clickhouse|druid|pinot)/i, 'analytics'],
  [/(^|\/)(minio|ceph)/i, 'blob'],
  [/(^|\/)(etcd|zookeeper|consul)/i, 'zk'],
  [/(^|\/)(vault)/i, 'secrets'],
  [/(^|\/)(qdrant|weaviate|milvus|pgvector)/i, 'vector'],
  [/(^|\/)(vllm|tgi|ollama|triton)/i, 'llm'],
  [/(worker|consumer|job)/i, 'worker'],
  [/(gateway|kong|apisix)/i, 'gateway'],
]

export function inferFromImage(image, fallback = 'micro') {
  if (!image) return fallback
  for (const [re, kind] of IMAGE_HINTS) if (re.test(image)) return kind
  return fallback
}

const WORKLOAD_KINDS = ['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job', 'CronJob']

export const K8S_RULES = [
  {
    match: { provider: 'k8s', type: 'apps/v1:Deployment' },
    kindOf: (obj) => inferFromImage(firstImage(obj), 'micro'),
    capacity: (obj, ctx) => ({
      ...sizeFromK8sResources(ctx.seed(inferFromImage(firstImage(obj), 'micro')), firstContainer(obj)?.resources),
      replicas: numOr(obj?.spec?.replicas, 1),
    }),
    patch: { replicas: { path: 'spec.replicas' } },
    telemetry: (obj) => ({ k8s: { namespace: ns(obj), workload: obj?.metadata?.name }, service: obj?.metadata?.labels?.['app.kubernetes.io/name'] || obj?.metadata?.name, confidence: 'matched' }),
    emit: emitDeployment,
  },
  {
    match: { provider: 'k8s', type: 'apps/v1:StatefulSet' },
    kindOf: (obj) => inferFromImage(firstImage(obj), 'sql'),
    capacity: (obj, ctx) => ({
      ...sizeFromK8sResources(ctx.seed(inferFromImage(firstImage(obj), 'sql')), firstContainer(obj)?.resources),
      replicas: numOr(obj?.spec?.replicas, 1),
    }),
    attrs: () => ({ replication: 'leader' }), // a StatefulSet with one writer is single-leader whether or not anyone drew it that way
    patch: { replicas: { path: 'spec.replicas' } },
    emit: emitDeployment,
  },
  {
    match: { provider: 'k8s', type: 'apps/v1:DaemonSet' },
    kindOf: (obj) => inferFromImage(firstImage(obj), 'otel'),
    capacity: (obj, ctx) => ({ ...sizeFromK8sResources(ctx.seed('otel'), firstContainer(obj)?.resources), replicas: numOr(obj?.status?.desiredNumberScheduled, 3) }),
  },
  {
    match: { provider: 'k8s', type: 'batch/v1:CronJob' },
    kindOf: () => 'scheduler',
    capacity: (obj, ctx) => ({ ...ctx.seed('scheduler'), replicas: 1 }),
  },
  {
    match: { provider: 'k8s', type: 'v1:Service' },
    // A Service is not a queueing station; it is a routing fact. It becomes a
    // node only when it is the ingress point (LoadBalancer type), and an edge
    // source in every case.
    kindOf: (obj) => (obj?.spec?.type === 'LoadBalancer' ? 'lb' : null),
    serviceEdges: true,
  },
  {
    match: { provider: 'k8s', type: 'networking.k8s.io/v1:Ingress' },
    kindOf: () => 'gateway',
    edges: (obj) => ingressEdges(obj),
  },
  {
    match: { provider: 'k8s', type: 'gateway.networking.k8s.io/v1:Gateway' },
    kindOf: () => 'k8sgw',
  },
  {
    match: { provider: 'k8s', type: 'autoscaling/v2:HorizontalPodAutoscaler' },
    // An HPA is not a node either — it is a statement about a node's replica
    // range, which is exactly what the gate needs to know before it believes a
    // fixed replica count.
    hpa: true,
  },
]

export const K8S_CONNECTORS = ['v1:Endpoints', 'discovery.k8s.io/v1:EndpointSlice']

export const K8S_STRUCTURAL = [
  'v1:ConfigMap', 'v1:Secret', 'v1:ServiceAccount', 'v1:Namespace', 'v1:PersistentVolumeClaim',
  'rbac.authorization.k8s.io/v1:Role', 'rbac.authorization.k8s.io/v1:RoleBinding',
  'rbac.authorization.k8s.io/v1:ClusterRole', 'rbac.authorization.k8s.io/v1:ClusterRoleBinding',
  'policy/v1:PodDisruptionBudget', 'v1:LimitRange', 'v1:ResourceQuota',
]

export const isWorkload = (kind) => WORKLOAD_KINDS.includes(kind)

export function firstContainer(obj) {
  return obj?.spec?.template?.spec?.containers?.[0]
    || obj?.spec?.jobTemplate?.spec?.template?.spec?.containers?.[0]
    || null
}
export const firstImage = (obj) => firstContainer(obj)?.image || null
export const ns = (obj) => obj?.metadata?.namespace || 'default'

/**
 * Service selector → workload match. This is the highest-confidence edge in the
 * whole compiler: it is not a guess about intent, it is the same label match
 * kube-proxy itself performs.
 */
export function selectorMatches(selector, workload) {
  if (!selector || !Object.keys(selector).length) return false
  const labels = workload?.spec?.template?.metadata?.labels || workload?.metadata?.labels || {}
  return Object.entries(selector).every(([k, v]) => labels[k] === v)
}

function ingressEdges(obj) {
  const out = []
  for (const rule of obj?.spec?.rules || []) {
    for (const p of rule?.http?.paths || []) {
      const svc = p?.backend?.service?.name
      if (svc) out.push({ toServiceName: svc, confidence: 'high', reason: `Ingress rule ${rule.host || ''}${p.path || ''}`, protocol: 'http' })
    }
  }
  return out
}

/** Environment variables that name another service are medium-confidence edges. */
export function envServiceEdges(obj) {
  const c = firstContainer(obj)
  const out = []
  for (const e of c?.env || []) {
    const v = e?.value
    if (typeof v !== 'string') continue
    if (!/(_URL|_HOST|_ENDPOINT|_ADDR|_URI|_DSN)$/i.test(e.name || '')) continue
    // http://checkout.prod.svc.cluster.local:8080 → checkout
    const m = /(?:\/\/)?([a-z0-9-]+)(?:\.([a-z0-9-]+))?(?:\.svc[^\s:/]*)?(?::\d+)?/i.exec(v.replace(/^[a-z+]+:\/\//i, ''))
    if (m) out.push({ toServiceName: m[1], namespace: m[2], confidence: 'medium', reason: `env ${e.name}` })
  }
  return out
}

function emitDeployment(node) {
  const name = String(node.label).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'archsim-node'
  return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
  labels:
    app: ${name}
    archsim.io/node: "${node.id}"
spec:
  replicas: ${node.capacity.replicas}
  selector:
    matchLabels:
      app: ${name}
  template:
    metadata:
      labels:
        app: ${name}
      annotations:
        archsim.io/node: "${node.id}"
    spec:
      containers:
        - name: ${name}
          image: CHANGEME
          resources:
            requests:
              cpu: "2"
              memory: 2Gi`
}

const numOr = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)
