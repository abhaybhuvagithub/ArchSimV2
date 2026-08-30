// What each component is, and when to reach for it.
//
// The catalog carries the numbers a component simulates with. This carries the
// two things a *person* needs before they can use it: which group it belongs to,
// and one sentence saying when it is the right answer.
//
// It lives here rather than in the studio because it is a property of the
// catalog, not of one interface — the CLI's `coverage` and the palette read the
// same table, and a kind added to the catalog without an entry here is a
// failing check rather than a silent gap.
//
// The descriptions have a rule: say something the name does not. "Load Balancer
// — balances load" is a row that wastes a reader's time. What they need is the
// capacity fact or the trade-off that decides whether this is the component
// they want.

/**
 * Groups, in the order traffic tends to move through them.
 *
 * Named `COMPONENT_CATEGORIES` rather than `CATEGORIES` because the template
 * library already owns that word for a different taxonomy, and two things
 * called the same thing in one namespace is a bug waiting for a `export *`.
 */
export const COMPONENT_CATEGORIES = [
  'Traffic',
  'Compute',
  'Data',
  'Messaging',
  'AI & ML',
  'Google AI',
  'Observability',
  'Security',
  'Platform',
  'Enterprise',
  'Testing',
  'Utility',
]

/**
 * kind → [category, description]
 *
 * Kept as a flat table rather than nested under categories: a kind belongs to
 * exactly one group, and a flat map makes that structurally true instead of a
 * convention that decays the first time someone pastes a line into the wrong
 * block.
 */
export const TAXONOMY = {
  /* ── Traffic ────────────────────────────────────────────────────────────── */
  client: ['Traffic', 'Where requests come from. Unlimited capacity by definition — it is the load, not a thing that serves load.'],
  dns: ['Traffic', 'Resolution, and a single point of failure most diagrams omit. Cheap, fast, and catastrophic when it is wrong.'],
  cdn: ['Traffic', 'Absorbs cacheable traffic before it reaches you. The hit rate is the whole design: at 90% your origin sees a tenth of the load.'],
  gslb: ['Traffic', 'Steers users to a region. The component that decides whether losing a region costs latency or costs availability.'],
  lb: ['Traffic', 'Spreads requests across replicas. Very high capacity, very low latency — rarely the bottleneck, frequently the SPOF.'],
  gateway: ['Traffic', 'One front door: auth, rate limits, routing. Everything behind it inherits its availability.'],
  k8sgw: ['Traffic', 'Gateway API ingress for a cluster. The Kubernetes-native answer to the same job an API gateway does.'],
  grpcgw: ['Traffic', 'Translates JSON to gRPC at the edge, so browsers can call services that only speak protobuf.'],
  graphql: ['Traffic', 'One query fans out to several services, so tail latency is the max of several tails rather than the mean.'],
  ratelimiter: ['Traffic', 'Sheds load before it reaches anything expensive. On the request path, so it is also a dependency.'],
  edge: ['Traffic', 'Code that runs at the CDN. Milliseconds from the user and a long way from your data.'],
  waf: ['Traffic', 'Inspects requests for attacks. Adds latency to every request, including the legitimate ones.'],
  tenant: ['Traffic', 'Routes each tenant to its own data. Where multi-tenant isolation is either enforced or quietly not.'],
  mesh: ['Traffic', 'A sidecar on every call. Buys uniform retries and mTLS; charges a hop of latency to every request in the estate.'],
  bff: ['Traffic', 'A façade shaped for one client. Exists because a chatty mobile app and a web page want different responses.'],

  /* ── Compute ────────────────────────────────────────────────────────────── */
  web: ['Compute', 'Serves pages and static responses. Cheap per request and the easiest tier to scale horizontally.'],
  app: ['Compute', 'The general-purpose service tier: business logic, moderate throughput, the thing most designs are mostly made of.'],
  micro: ['Compute', 'A service that owns one capability. Higher throughput than an app server, and one more network hop to reach.'],
  grpc: ['Compute', 'Binary protocol, persistent connections, roughly twice the throughput of a JSON service at half the latency.'],
  fastapi: ['Compute', 'An async Python service. Handles concurrency well for the language; still Python on the arithmetic.'],
  ws: ['Compute', 'Holds connections open. Capacity is measured in connections held, not requests served, which changes how you size it.'],
  worker: ['Compute', 'Processes a queue. Sized by Little\'s law — throughput is pool width over hold time, not a request rate.'],
  scheduler: ['Compute', 'Fires jobs on a clock. Needs leader election, or the job runs twice and nobody notices until it matters.'],
  saga: ['Compute', 'A distributed transaction that admits it is not one. The compensation path exists because a step will fail.'],
  batch: ['Compute', 'Long-running bulk work. Latency measured in minutes; the SLO is a deadline, not a percentile.'],
  stream: ['Compute', 'Stateful processing over a stream. A restart is not free, which is what makes this hard to operate.'],
  sandbox: ['Compute', 'Runs untrusted code. Slow and wide by design — isolation costs startup time on every call.'],
  transcode: ['Compute', 'Media encoding. Seconds per job, enormous pools, and entirely off the request path if you let it be.'],
  k8s: ['Compute', 'The cluster the containers run on. Not on the request path itself, and the thing that decides where everything else is.'],
  llmworker: ['Compute', 'Consumes a queue of model calls. Around a second per item, so the queue is the product, not a detail.'],

  /* ── Data ───────────────────────────────────────────────────────────────── */
  cache: ['Data', 'The cheapest capacity in any design. The hit rate decides how much load reaches everything behind it.'],
  sql: ['Data', 'Transactions and joins. Usually the hardest tier to scale, and the one a cache is protecting.'],
  nosql: ['Data', 'Horizontal by design, four times the throughput of SQL, and no joins to lean on.'],
  graph: ['Data', 'Traversals that would be a self-join in SQL. Worth it when relationships are the query, not the schema.'],
  tsdb: ['Data', 'Metrics and readings. Cardinality is the capacity unit the request rate hides.'],
  search: ['Data', 'Inverted index over documents. Query path and index path share a cluster and compete for it.'],
  vector: ['Data', 'Nearest-neighbour over embeddings. The retrieval half of a RAG system, and the fast half.'],
  blob: ['Data', 'Objects, priced per request and per byte. Effectively unlimited capacity, meaningful egress cost.'],
  lake: ['Data', 'Raw data at rest, cheap and slow. Storage and compute are separate, so an expensive month is a storage question.'],
  warehouse: ['Data', 'Analytical queries over structured data. Seconds per query is normal and fine.'],
  geoidx: ['Data', 'Spatial queries. Every position update is a query, which makes the index the ceiling.'],
  featurestore: ['Data', 'The features a model reads at serving time. Where training and serving usually disagree about what a feature means.'],
  ledger: ['Data', 'Double-entry, append-only. Low throughput, extreme consequence, and the reason a cache in front of balances is dangerous.'],
  analytics: ['Data', 'OLAP over events. Slow queries by design; the SLO belongs to the dashboard, not the request.'],
  bi: ['Data', 'Dashboards people open. Query latency is measured against attention span, not a percentile.'],
  etl: ['Data', 'Moves and reshapes data on a schedule. A batch window is a latency SLO with a deadline attached.'],
  cdc: ['Data', 'Streams changes out of a database. Replication lag is the only metric that matters and it is invisible until it is a crisis.'],

  /* ── Messaging ──────────────────────────────────────────────────────────── */
  queue: ['Messaging', 'Work handed off asynchronously. Turns a slow request into a job someone can walk away from.'],
  kafka: ['Messaging', 'A log many consumers read at their own pace. The slowest consumer sets the retention you need.'],
  mq: ['Messaging', 'Enterprise messaging with transactional semantics. Slower than Kafka, and it can be part of a transaction.'],
  push: ['Messaging', 'Notifications out to people. Every send depends on someone else\'s uptime.'],

  /* ── AI & ML ────────────────────────────────────────────────────────────── */
  llm: ['AI & ML', 'Text generation. Hundreds of milliseconds to seconds, priced per call — usually the entire latency and cost budget.'],
  embed: ['AI & ML', 'Text to vectors. Cheap next to generation, and on the request path for every retrieval.'],
  ml: ['AI & ML', 'A trained model behind an endpoint. Fast enough to sit inline if you keep it small.'],
  guard: ['AI & ML', 'Safety and policy checks around a model. Another call in series inside the same budget.'],
  finetune: ['AI & ML', 'Training runs. Hours per job, nobody waiting, and judged on cost rather than latency.'],
  aiagent: ['AI & ML', 'A managed agent runtime. Multi-step, so latency compounds and any step failing fails the run.'],
  agentgraph: ['AI & ML', 'Plans and orders the steps an agent takes. The component that turns one request into twenty.'],
  llmobs: ['AI & ML', 'Traces and evaluates model calls. Off the request path, and the only way to know why a bill tripled.'],

  /* ── Google AI ──────────────────────────────────────────────────────────── */
  gemini3: ['Google AI', 'Frontier reasoning. The slowest and most capable option — reach for it when the task actually needs it.'],
  gemini2: ['Google AI', 'The workhorse model. Faster and cheaper than frontier, and enough for most of what people call AI features.'],
  vertexai: ['Google AI', 'Managed model serving. Removes the GPU fleet from your architecture and adds a vendor to your critical path.'],
  imagen: ['Google AI', 'Image generation. Seconds per image, so it belongs behind a queue, not on a request.'],
  veo: ['Google AI', 'Video generation. The slowest thing in the catalog and the one most obviously a job rather than a call.'],
  gemmaos: ['Google AI', 'Open weights you run yourself. Trades a vendor dependency for a GPU fleet you now operate.'],
  notebooklm: ['Google AI', 'Grounded question answering over a document set. Retrieval and generation, packaged.'],
  astra: ['Google AI', 'Multimodal, low-latency interaction. Sized for a conversation rather than a request.'],
  mariner: ['Google AI', 'An agent that drives a browser. Slow, stateful, and doing real actions — which is what makes it risky.'],
  antigravity: ['Google AI', 'Agentic development environment. Modelled here because it appears in architectures, not because it serves traffic.'],
  duetai: ['Google AI', 'Assistance embedded in cloud tooling. A developer-facing dependency rather than a user-facing one.'],
  beam: ['Google AI', 'Real-time 3D presence. Bandwidth and latency bound in a way most of this catalog is not.'],

  /* ── Observability ──────────────────────────────────────────────────────── */
  monitor: ['Observability', 'Metrics and alerting. Never on the request path — wire it there and the simulator will price traffic that does not exist.'],
  otel: ['Observability', 'Collects telemetry from everything. High volume, low value per record, and the first thing to shed under load.'],
  logs: ['Observability', 'The highest-volume, lowest-value-per-record system most companies run. Its whole design is a tiering argument.'],
  tracing: ['Observability', 'Follows one request across services. The only tool that answers "which hop was slow".'],
  apm: ['Observability', 'What the browser or app actually experienced, which is usually worse than what your server measured.'],
  synthetic: ['Observability', 'Probes that behave like users on a schedule. Catches what nobody is currently hitting.'],
  slo: ['Observability', 'Error budgets and burn rate. Turns "is it healthy" into a number with a deadline.'],
  alert: ['Observability', 'Paging and escalation. Off the request path, and the thing that decides how long an outage lasts.'],

  /* ── Security ───────────────────────────────────────────────────────────── */
  iam: ['Security', 'Identity and SSO. Everything depends on it, so its availability target is a tier above what it serves.'],
  secrets: ['Security', 'Secret storage and key management. A dependency at startup, and often at every request too.'],
  hsm: ['Security', 'Keys in hardware. Slow, expensive, and non-negotiable where regulation says so.'],
  crypto: ['Security', 'Encryption as a service. Adds latency in exchange for keys your services never hold.'],
  e2ee: ['Security', 'End-to-end encryption. Moves the trust boundary to the client and takes your servers out of it.'],
  tls: ['Security', 'Terminates TLS. A handshake cost people forget when they count hops.'],
  hash: ['Security', 'Deliberately slow, because that is the whole point — and a real capacity cost on every sign-in.'],
  digest: ['Security', 'Checksums and content hashes. Fast enough to ignore, and the basis of every integrity guarantee above it.'],
  sign: ['Security', 'Issues and verifies tokens. On the path for every authenticated request.'],
  pii: ['Security', 'Swaps sensitive values for tokens. The difference between a breach and an incident.'],
  audit: ['Security', 'Append-only record of what happened. A legal requirement rather than a nice-to-have, and it cannot be re-created.'],
  siem: ['Security', 'Correlates security events. Consumes everything the observability stack produces and asks different questions of it.'],
  bastion: ['Security', 'The controlled way in to a private network. Low throughput; high consequence.'],

  /* ── Platform ───────────────────────────────────────────────────────────── */
  registry: ['Platform', 'Service discovery. Part of the control plane everything assumes is up.'],
  config: ['Platform', 'Configuration at runtime. Changes behaviour without a deploy, which is both the point and the risk.'],
  zk: ['Platform', 'Consensus and coordination. What stops a scheduled job from running twice.'],
  featureflag: ['Platform', 'Evaluated on every request in every service, so it needs an availability figure most teams have never had to hit.'],
  cicd: ['Platform', 'The system that ships every other system. Its SLO is measured in minutes and it is still the loudest complaint.'],
  containerreg: ['Platform', 'Stores images. Off the request path and squarely on the deploy path.'],
  backup: ['Platform', 'Copies you hope never to read. Judged on restore time, which is the number nobody measures.'],
  billing: ['Platform', 'Metering and invoicing. Almost all the work happens on one day of the month.'],

  /* ── Enterprise ─────────────────────────────────────────────────────────── */
  esb: ['Enterprise', 'The integration bus a strangler-fig migration is trying to retire. Two architectures behind one gateway.'],
  erp: ['Enterprise', 'Slow, licensed per call, and impossible to scale. Everything in front of it exists to protect it.'],
  crm: ['Enterprise', 'Customer records, usually someone else\'s SaaS, usually with a rate limit you do not control.'],
  mainframe: ['Enterprise', 'The system you cannot change. Reads move off it; writes stay on it.'],
  mft: ['Enterprise', 'Files on a schedule you do not set. A great deal of real integration still looks exactly like this.'],
  partner: ['Enterprise', 'Someone else\'s API on your critical path. Their availability is now yours.'],

  /* ── Testing ────────────────────────────────────────────────────────────── */
  e2e: ['Testing', 'Drives the real UI. The slowest and most honest test you have.'],
  apitest: ['Testing', 'Exercises the API directly. Fast enough to run on every change.'],
  contract: ['Testing', 'Checks two services still agree. Catches the break before deployment rather than after.'],
  load: ['Testing', 'Generates the traffic this simulator models. The way to find out whether the model was right.'],
  mock: ['Testing', 'Stands in for a dependency you cannot call. Makes tests deterministic and makes them lie a little.'],
  testdata: ['Testing', 'Realistic data without real people in it. Usually the reason a test environment is unusable.'],
  qgate: ['Testing', 'Static analysis that blocks a merge. Cheap, early, and easy to route around if the gate is not enforced.'],
  dast: ['Testing', 'Attacks the running application. Finds what static analysis cannot see.'],
  devicefarm: ['Testing', 'Real browsers and phones. The only place client behaviour is real.'],
  testops: ['Testing', 'Aggregates test results. Turns a wall of red into a trend.'],

  /* ── Utility ────────────────────────────────────────────────────────────── */
  custom: ['Utility', 'Anything the mapping tables did not recognise. Simulated conservatively, round-tripped byte for byte, never dropped.'],
}

/** The kinds in one category, in catalog order. */
export const kindsIn = (category) =>
  Object.entries(TAXONOMY).filter(([, [c]]) => c === category).map(([k]) => k)

export const categoryOf = (kind) => TAXONOMY[kind]?.[0] || 'Utility'
export const describeKind = (kind) => TAXONOMY[kind]?.[1] || ''

/**
 * Substring search over kind, display name, category and description.
 *
 * The description is searchable deliberately: someone who does not know the word
 * "CDC" may well type "replication lag", and the sentence that explains the
 * component is the only place that phrase appears.
 */
export function searchKinds(query, catalog) {
  const q = String(query || '').trim().toLowerCase()
  const all = Object.keys(TAXONOMY)
  if (!q) return all
  return all.filter((k) => {
    const [cat, desc] = TAXONOMY[k]
    const name = catalog?.[k]?.name || ''
    return k.includes(q) || name.toLowerCase().includes(q)
      || cat.toLowerCase().includes(q) || desc.toLowerCase().includes(q)
  })
}
