// Cloud cost model — carried over from ArchSim 1.8 (`src/pricing.js`).
//
// Three levers per component:
//   hourly — $ per instance-hour   → scales with replicas
//   base   — $ per instance-month  (licence, managed fee, baseline storage)
//   perM   — $ per million requests that actually flow through the node
//
// So cost reacts to both the replica count and the *simulated* traffic, which
// is what makes `monthly_cost_usd` a legitimate SLO in the gate: halving a
// database and calling it a saving is only true if the latency SLO survives it.
//
// Order-of-magnitude on-demand US list prices. No reservations, savings plans,
// committed-use discounts or egress. For comparing designs, not for a quote.

export const PRICED_AT = '2026-08-08'
export const PRICE_BASIS = 'On-demand US East list prices. No reservations, savings plans, committed-use discounts or egress. Escalated 3%/yr from PRICED_AT so the figure ages honestly rather than silently.'

export const HOURS = 730                          // hours in an average month
export const SEC_PER_MONTH = HOURS * 3600
export const REQ_M_PER_RPS = SEC_PER_MONTH / 1e6  // millions of req/month per 1 rps

export const RATES = {
  client:      { hourly: 0,     base: 0,    perM: 0,    note: 'traffic source — no infrastructure cost' },
  // edge / traffic
  dns:         { hourly: 0,     base: 0.5,  perM: 0.40, note: 'hosted zone + $0.40 per million queries' },
  gslb:        { hourly: 0,     base: 18,   perM: 0.60, note: 'traffic policies + health checks' },
  waf:         { hourly: 0,     base: 8,    perM: 0.60, note: 'web ACL + rules + per-request inspection' },
  cdn:         { hourly: 0,     base: 0,    perM: 5.00, note: 'requests + ~50 KB egress per request at $0.085/GB' },
  edge:        { hourly: 0,     base: 0,    perM: 0.50, note: 'edge function invocations' },
  lb:          { hourly: 0.03,  base: 0,    perM: 0.01, note: 'ALB hours + capacity units' },
  gateway:     { hourly: 0,     base: 0,    perM: 1.00, note: 'managed HTTP API at $1.00 per million calls' },
  k8sgw:       { hourly: 0.09,  base: 0,    perM: 0,    note: 'Envoy-based gateway controller pods, self-hosted on the cluster' },
  grpcgw:      { hourly: 0.07,  base: 0,    perM: 0,    note: 'transcoding proxy instances' },
  graphql:     { hourly: 0.09,  base: 0,    perM: 0.10, note: 'self-hosted router instances' },
  ratelimiter: { hourly: 0.05,  base: 0,    perM: 0,    note: 'small always-on instances' },
  bff:         { hourly: 0.09,  base: 0,    perM: 0,    note: 'application instances' },
  tenant:      { hourly: 0.05,  base: 0,    perM: 0,    note: 'lightweight routing instances' },
  // compute
  web:         { hourly: 0.085, base: 0,    perM: 0,    note: 'general-purpose instance per replica' },
  app:         { hourly: 0.096, base: 0,    perM: 0,    note: 'general-purpose instance per replica' },
  ledger:      { hourly: 0.29,  base: 0,    perM: 0,    note: 'db-class instance per replica; io2-grade storage is where the money goes' },
    fastapi:     { hourly: 0.096, base: 0,    perM: 0,    note: 'async Python pod per replica (general-purpose instance)' },
  llmworker:   { hourly: 0.048, base: 0,    perM: 0,    note: 'small consumer pod per worker - the provider bill is the real cost, priced on the llm node' },
  micro:       { hourly: 0.08,  base: 0,    perM: 0,    note: 'container task per replica' },
  grpc:        { hourly: 0.08,  base: 0,    perM: 0,    note: 'container task per replica, same footprint as a microservice' },
  ws:          { hourly: 0.10,  base: 0,    perM: 0,    note: 'connection-heavy instance per replica' },
  worker:      { hourly: 0.10,  base: 0,    perM: 0,    note: 'batch/async compute per replica' },
  scheduler:   { hourly: 0.02,  base: 0,    perM: 0,    note: 'orchestrator instance' },
  k8s:         { hourly: 0.10,  base: 0,    perM: 0,    note: 'cluster control plane (nodes billed per service)' },
  saga:        { hourly: 0.09,  base: 0,    perM: 10.0, note: 'instances + managed state transitions' },
  // storage
  cache:       { hourly: 0.14,  base: 0,    perM: 0,    note: 'in-memory node per replica' },
  sql:         { hourly: 0.29,  base: 0,    perM: 0,    note: 'managed relational instance, HA pair' },
  nosql:       { hourly: 0,     base: 0,    perM: 1.25, note: 'on-demand read/write units' },
  search:      { hourly: 0.19,  base: 0,    perM: 0,    note: 'search cluster node per replica' },
  blob:        { hourly: 0,     base: 24,   perM: 0.40, note: '~1 TB stored at $0.023/GB + request cost' },
  backup:      { hourly: 0,     base: 12,   perM: 0,    note: 'snapshot + archive storage' },
  // async
  queue:       { hourly: 0,     base: 0,    perM: 0.40, note: '$0.40 per million messages' },
  kafka:       { hourly: 0.25,  base: 0,    perM: 0,    note: 'broker + attached storage per replica' },
  mq:          { hourly: 0.30,  base: 0,    perM: 0,    note: 'transactional broker instance' },
  esb:         { hourly: 0.40,  base: 250,  perM: 0,    note: 'iPaaS/ESB runtime plus licence' },
  // data
  cdc:         { hourly: 0.15,  base: 0,    perM: 0,    note: 'connector task per replica' },
  etl:         { hourly: 0.30,  base: 0,    perM: 0,    note: 'Spark/Glue worker per replica' },
  lake:        { hourly: 0,     base: 24,   perM: 0,    note: '~1 TB object storage per zone' },
  warehouse:   { hourly: 0.75,  base: 0,    perM: 0,    note: 'assumes the warehouse runs ~8h/day' },
  bi:          { hourly: 0,     base: 45,   perM: 0,    note: 'BI seats/licences per replica' },
  analytics:   { hourly: 0.30,  base: 0,    perM: 0,    note: 'stream/batch analytics compute' },
  billing:     { hourly: 0.15,  base: 0,    perM: 0,    note: 'metering service instances' },
  // AI / ML
  ml:          { hourly: 0.60,  base: 0,    perM: 0,    note: 'inference instance per replica' },
  embed:       { hourly: 0,     base: 0,    perM: 20,   note: '≈ $0.02 per 1k embedding calls' },
  vector:      { hourly: 0.30,  base: 0,    perM: 0,    note: 'vector index node per replica' },
  llm:         { hourly: 0,     base: 0,    perM: 1500, note: '≈ $0.0015 per generation — usually the whole bill' },
  guard:       { hourly: 0,     base: 0,    perM: 5.00, note: 'moderation/classifier calls' },
  // observability
  otel:        { hourly: 0.10,  base: 0,    perM: 0,    note: 'collector instances' },
  monitor:     { hourly: 0,     base: 45,   perM: 0.05, note: 'metrics platform per host + ingestion' },
  logs:        { hourly: 0,     base: 10,   perM: 2.00, note: '~4 KB of logs per request at $0.50/GB' },
  tracing:     { hourly: 0,     base: 10,   perM: 1.50, note: 'span ingestion (sample to cut this)' },
  slo:         { hourly: 0,     base: 20,   perM: 0,    note: 'SLO tooling' },
  alert:       { hourly: 0,     base: 21,   perM: 0,    note: 'on-call seats per responder' },
  synthetic:   { hourly: 0,     base: 15,   perM: 0,    note: 'probe checks per location' },
  apm:         { hourly: 0,     base: 15,   perM: 0.60, note: 'RUM sessions' },
  // security
  iam:         { hourly: 0,     base: 25,   perM: 0.05, note: 'identity platform tier' },
  secrets:     { hourly: 0,     base: 8,    perM: 0,    note: '~20 secrets at $0.40 each' },
  pii:         { hourly: 0,     base: 60,   perM: 5.00, note: 'tokenization vendor + per-call fee' },
  audit:       { hourly: 0,     base: 12,   perM: 0.50, note: 'immutable store + write cost' },
  siem:        { hourly: 0,     base: 150,  perM: 3.00, note: 'ingest-priced — the classic budget surprise' },
  // platform
  registry:    { hourly: 0.06,  base: 0,    perM: 0,    note: 'discovery cluster node' },
  mesh:        { hourly: 0.06,  base: 0,    perM: 0,    note: 'sidecar + control plane overhead' },
  config:      { hourly: 0.04,  base: 0,    perM: 0,    note: 'config service node' },
  zk:          { hourly: 0.10,  base: 0,    perM: 0,    note: 'coordination ensemble node' },
  cicd:        { hourly: 0.05,  base: 40,   perM: 0,    note: 'runners plus platform seats' },
  // enterprise systems of record
  erp:         { hourly: 0,     base: 4000, perM: 0,    note: 'ERP licence + hosting, per environment' },
  crm:         { hourly: 0,     base: 1500, perM: 0,    note: 'CRM seats' },
  mainframe:   { hourly: 0,     base: 12000,perM: 0,    note: 'MIPS capacity + software licences' },
  mft:         { hourly: 0,     base: 400,  perM: 0,    note: 'MFT/EDI platform licence' },
  partner:     { hourly: 0,     base: 0,    perM: 50,   note: 'per-transaction fee charged by the partner (bank, switch, GDS)' },
  hsm:         { hourly: 1.20,  base: 0,    perM: 0,    note: 'dedicated HSM instance — expensive and usually needs a pair' },
  // cryptography
  tls:         { hourly: 0.03,  base: 0,    perM: 0.008, note: 'certificate management is free; you pay for the handshake CPU' },
  crypto:      { hourly: 0,     base: 1,    perM: 0.03,  note: 'KMS: $1/key-month plus $0.03 per 10k requests — envelope encryption keeps this tiny' },
  hash:        { hourly: 0.10,  base: 0,    perM: 0,     note: 'CPU-bound by design — Argon2 memory-hardness is what you are paying for' },
  digest:      { hourly: 0.02,  base: 0,    perM: 0,     note: 'pure CPU, effectively free next to everything around it' },
  sign:        { hourly: 0,     base: 1,    perM: 0.03,  note: 'KMS asymmetric sign; verification is usually done locally for free' },
  e2ee:        { hourly: 0.06,  base: 0,    perM: 0.02,  note: 'key-distribution service plus ciphertext relay' },
  graph:        { hourly: 0.35, base: 0, perM: 0, note: 'graph instance per replica' },
  tsdb:         { hourly: 0, base: 0, perM: 0.5, note: 'per million metric writes' },
  featureflag:  { hourly: 0, base: 30, perM: 0.05, note: 'managed flag service' },
  featurestore: { hourly: 0.24, base: 0, perM: 0, note: 'online store node per replica' },
  stream:       { hourly: 0.3, base: 0, perM: 0, note: 'stream task manager per replica' },
  batch:        { hourly: 0.27, base: 0, perM: 0, note: 'executor node per replica' },
  transcode:    { hourly: 0.42, base: 0, perM: 0, note: 'transcode worker per replica' },
  sandbox:      { hourly: 0.2, base: 0, perM: 0, note: 'isolated runner per replica' },
  geoidx:       { hourly: 0.18, base: 0, perM: 0, note: 'geo index node per replica' },
  push:         { hourly: 0, base: 0, perM: 2.0, note: 'per million notifications' },
  containerreg: { hourly: 0, base: 12, perM: 0, note: 'image storage per month' },
  bastion:      { hourly: 0.02, base: 0, perM: 0, note: 'small always-on instance' },
  // quality & testing
  e2e:         { hourly: 0.08,  base: 0,    perM: 0,    note: 'CI runners executing the UI suite' },
  apitest:     { hourly: 0.02,  base: 0,    perM: 0,    note: 'cheap, fast runners — the layer to invest in' },
  load:        { hourly: 0.20,  base: 0,    perM: 0,    note: 'load generators, billed only while a test runs' },
  contract:    { hourly: 0,     base: 30,   perM: 0,    note: 'contract broker hosting' },
  mock:        { hourly: 0.05,  base: 0,    perM: 0,    note: 'mock/virtualization instances' },
  testdata:    { hourly: 0.10,  base: 0,    perM: 0,    note: 'snapshot, clone and masking jobs' },
  qgate:       { hourly: 0,     base: 120,  perM: 0,    note: 'static-analysis platform licence' },
  dast:        { hourly: 0,     base: 250,  perM: 0,    note: 'dynamic scanning platform licence' },
  devicefarm:  { hourly: 0,     base: 200,  perM: 0,    note: 'real-device / browser grid seats' },
  testops:     { hourly: 0,     base: 90,   perM: 0,    note: 'test management seats' },
  // Google AI & LLMs
  gemini3:     { hourly: 0,     base: 0,    perM: 2000, note: '≈ $2.00 per generation (input + output tokens)' },
  gemini2:     { hourly: 0,     base: 0,    perM: 800,  note: '≈ $0.80 per generation (cheaper than Gemini 3)' },
  notebooklm:  { hourly: 0,     base: 0,    perM: 100,  note: 'per-chat query + generation cost' },
  antigravity: { hourly: 0,     base: 0,    perM: 0,    note: 'free preview (agent IDE runs on Gemini 3 compute)' },
  vertexai:    { hourly: 0.15,  base: 0,    perM: 0.05, note: 'managed ML platform overhead + inference' },
  imagen:      { hourly: 0,     base: 0,    perM: 500,  note: '≈ $0.50 per image generation' },
  veo:         { hourly: 0,     base: 0,    perM: 5000, note: '≈ $5.00 per video generation (expensive!)' },
  astra:       { hourly: 0,     base: 0,    perM: 100,  note: 'Gemini Live streaming + vision processing' },
  mariner:     { hourly: 0,     base: 0,    perM: 50,   note: 'web automation agent per browser session' },
  beam:        { hourly: 0.08,  base: 0,    perM: 0,    note: 'video calling infrastructure per participant' },
  gemmaos:     { hourly: 0,     base: 0,    perM: 0,    note: 'on-device (free), no cloud cost' },
  duetai:      { hourly: 0,     base: 0,    perM: 0.50, note: 'suggestions in GCP console (part of Cloud bill)' },
  aiagent:     { hourly: 0.10,  base: 0,    perM: 50,   note: 'Vertex agent orchestration + tool calls' },
  agentgraph:  { hourly: 0.12,  base: 0,    perM: 100,  note: 'orchestrator compute + checkpoint storage; the LLM calls it makes bill separately' },
  finetune:    { hourly: 3.50,  base: 0,    perM: 0,    note: 'GPU training instance (A100-class), billed only while a job runs' },
  llmobs:      { hourly: 0,     base: 100,  perM: 2.00, note: 'tracing platform tier + per-trace ingestion' },
}

const FALLBACK = { hourly: 0.08, base: 0, perM: 0, note: 'generic compute estimate' }

export const yearsSincePriced = (now = new Date()) =>
  (now.getTime() - new Date(PRICED_AT + 'T00:00:00Z').getTime()) / (365.25 * 86400000)

/** ~3%/yr, the historical cloud list-price trend. A static table that never
 *  ages is a table that is quietly wrong; this one is loudly approximate. */
export const priceEscalationMultiplier = (now = new Date()) => Math.pow(1.03, Math.max(0, yearsSincePriced(now)))

export const rateFor = (kind, now = new Date()) => {
  const m = priceEscalationMultiplier(now)
  const r = RATES[kind] || FALLBACK
  return { ...r, hourly: r.hourly * m, base: r.base * m, perM: r.perM * m }
}

/** Monthly cost of one IR node at a given served rps. */
export function nodeCost(node, inRps = 0, now = new Date()) {
  const r = rateFor(node.kind, now)
  const replicas = Math.max(1, node.capacity?.replicas || 1)
  const fixed = replicas * (r.hourly * HOURS + r.base)
  const usage = Math.max(0, inRps) * REQ_M_PER_RPS * r.perM
  return { fixed, usage, total: fixed + usage, rate: r }
}

/** Whole-system monthly cost, driven by a simulation result. */
export function costReport(ir, sim, now = new Date()) {
  const rows = ir.nodes
    .filter((n) => !n.capacity?.source)
    .map((n) => {
      const inRps = sim?.stats?.[n.id]?.in || 0
      const c = nodeCost(n, inRps, now)
      return { id: n.id, label: n.label, kind: n.kind, replicas: Math.max(1, n.capacity.replicas), inRps, ...c }
    })
    .sort((a, b) => b.total - a.total)
  const total = rows.reduce((s, r) => s + r.total, 0)
  return {
    rows,
    total,
    fixed: rows.reduce((s, r) => s + r.fixed, 0),
    usage: rows.reduce((s, r) => s + r.usage, 0),
    hourly: total / HOURS,
    pricedAt: PRICED_AT,
  }
}
