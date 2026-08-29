// Component catalog — capacity seeds for the IR.
//
// Carried over verbatim from ArchSim 1.8 (`src/catalog.js`), because these are
// the numbers the 998-check suite has been holding honest for a year. What v2
// adds is the DES contract: `concurrency` (worker/thread pool width) and
// `queueDepth` (bounded queue K), so the same component can be run through the
// analytic engine and the discrete-event engine without a second catalog to
// keep in step.
//
//   cap   — requests/sec one replica handles
//   lat   — base service latency, ms (median; the DES fits a lognormal to it)
//   avail — single-replica availability
//   cv    — coefficient of variation of service time (DES only)
//
// Every figure here is a *prior*, not a measurement of the user's system. The
// IR carries a provenance class and a jitter band per node (default ±40%) and
// the twin (§4) overwrites both with telemetry the moment production disagrees.

export const CATALOG_AT = '2026-08-08'

export const CATALOG = {
  client: { name: 'Client', glyph: '👤', cap: Infinity, lat: 0, avail: 1, source: true, concurrency: 0, queueDepth: 0, cv: 0.5 },
  dns: { name: 'DNS', glyph: '🌐', cap: 500000, lat: 1, avail: 0.9999, concurrency: 800, queueDepth: 3200, cv: 0.5 },
  cdn: { name: 'CDN', glyph: '⚡', cap: 200000, lat: 5, avail: 0.999, cacheHit: 0.9, concurrency: 1600, queueDepth: 4096, cv: 0.5 },
  lb: { name: 'Load Balancer', glyph: '⚖️', cap: 100000, lat: 1, avail: 0.9999, concurrency: 160, queueDepth: 640, cv: 0.5 },
  gateway: { name: 'API Gateway', glyph: '🚪', cap: 50000, lat: 3, avail: 0.9995, concurrency: 240, queueDepth: 960, cv: 0.5 },
  k8sgw: { name: 'Kubernetes Gateway API', glyph: '🛣️', cap: 55000, lat: 3, avail: 0.9995, concurrency: 264, queueDepth: 1056, cv: 0.5 },
  grpcgw: { name: 'gRPC-JSON Transcoder', glyph: '🔁', cap: 40000, lat: 5, avail: 0.9995, concurrency: 320, queueDepth: 1280, cv: 0.5 },
  ratelimiter: { name: 'Rate Limiter', glyph: '🚦', cap: 80000, lat: 1, avail: 0.999, concurrency: 128, queueDepth: 512, cv: 0.5 },
  web: { name: 'Web Server', glyph: '🖥️', cap: 5000, lat: 10, avail: 0.9999, concurrency: 80, queueDepth: 320, cv: 0.5 },
  app: { name: 'App Server', glyph: '⚙️', cap: 2000, lat: 25, avail: 0.9999, concurrency: 80, queueDepth: 320, cv: 0.5 },
  micro: { name: 'Microservice', glyph: '🧩', cap: 3000, lat: 15, avail: 0.9995, concurrency: 72, queueDepth: 288, cv: 0.5 },
  grpc: { name: 'gRPC Service', glyph: '📶', cap: 6000, lat: 8, avail: 0.9995, concurrency: 77, queueDepth: 308, cv: 0.5 },
  ws: { name: 'WebSocket Srv', glyph: '🔌', cap: 50000, lat: 5, avail: 0.999, concurrency: 400, queueDepth: 1600, cv: 0.5 },
  cache: { name: 'Cache (Redis)', glyph: '🧠', cap: 100000, lat: 1, avail: 0.999, cacheHit: 0.8, concurrency: 160, queueDepth: 640, cv: 0.5 },
  sql: { name: 'SQL Database', glyph: '🗄️', cap: 5000, lat: 10, avail: 0.9995, concurrency: 80, queueDepth: 320, cv: 0.5 },
  nosql: { name: 'NoSQL DB', glyph: '📦', cap: 20000, lat: 5, avail: 0.9999, concurrency: 160, queueDepth: 640, cv: 0.5 },
  search: { name: 'Search Index', glyph: '🔍', cap: 8000, lat: 20, avail: 0.999, concurrency: 256, queueDepth: 1024, cv: 0.5 },
  queue: { name: 'Message Queue', glyph: '📨', cap: 50000, lat: 3, avail: 0.999, concurrency: 240, queueDepth: 960, cv: 0.5 },
  kafka: { name: 'Event Stream', glyph: '🌊', cap: 200000, lat: 3, avail: 0.999, concurrency: 960, queueDepth: 3840, cv: 0.5 },
  worker: { name: 'Worker Pool', glyph: '🛠️', cap: 1000, lat: 50, avail: 0.9995, concurrency: 80, queueDepth: 320, cv: 0.7 },
  scheduler: { name: 'Scheduler', glyph: '⏰', cap: 1000, lat: 5, avail: 0.999, concurrency: 8, queueDepth: 32, cv: 0.5 },
  blob: { name: 'Object Storage', glyph: '🪣', cap: 30000, lat: 30, avail: 0.999, concurrency: 1440, queueDepth: 4096, cv: 0.5 },
  zk: { name: 'Coordination', glyph: '🐘', cap: 10000, lat: 2, avail: 0.9999, concurrency: 32, queueDepth: 128, cv: 0.5 },
  analytics: { name: 'Analytics/OLAP', glyph: '📊', cap: 2000, lat: 100, avail: 0.999, concurrency: 320, queueDepth: 1280, cv: 0.7 },
  ml: { name: 'ML Service', glyph: '🤖', cap: 500, lat: 80, avail: 0.999, concurrency: 64, queueDepth: 256, cv: 0.7 },
  monitor: { name: 'Metrics & Alerts', glyph: '🩺', cap: 100000, lat: 1, avail: 0.999, concurrency: 160, queueDepth: 640, cv: 0.5 },
  bff: { name: 'BFF', glyph: '🎭', cap: 8000, lat: 8, avail: 0.999, concurrency: 102, queueDepth: 408, cv: 0.5 },
  registry: { name: 'Service Registry', glyph: '📖', cap: 40000, lat: 2, avail: 0.9999, concurrency: 128, queueDepth: 512, cv: 0.5 },
  mesh: { name: 'Service Mesh', glyph: '🕸️', cap: 40000, lat: 2, avail: 0.9995, concurrency: 128, queueDepth: 512, cv: 0.5 },
  saga: { name: 'Saga Orchestrator', glyph: '🎬', cap: 4000, lat: 20, avail: 0.999, concurrency: 128, queueDepth: 512, cv: 0.5 },
  config: { name: 'Config Server', glyph: '🎛️', cap: 20000, lat: 2, avail: 0.9995, concurrency: 64, queueDepth: 256, cv: 0.5 },
  tracing: { name: 'Tracing', glyph: '🧵', cap: 100000, lat: 1, avail: 0.999, concurrency: 160, queueDepth: 640, cv: 0.5 },
  cdc: { name: 'CDC Connector', glyph: '🔗', cap: 20000, lat: 5, avail: 0.9995, concurrency: 160, queueDepth: 640, cv: 0.5 },
  etl: { name: 'ETL / ELT Job', glyph: '🧪', cap: 2000, lat: 60, avail: 0.999, concurrency: 192, queueDepth: 768, cv: 0.7 },
  lake: { name: 'Data Lake', glyph: '🏞️', cap: 50000, lat: 40, avail: 0.9999, concurrency: 3200, queueDepth: 4096, cv: 0.5 },
  warehouse: { name: 'Data Warehouse', glyph: '🏛️', cap: 3000, lat: 120, avail: 0.999, concurrency: 576, queueDepth: 2304, cv: 0.7 },
  bi: { name: 'BI / Dashboards', glyph: '📈', cap: 1000, lat: 150, avail: 0.999, concurrency: 240, queueDepth: 960, cv: 0.7 },
  vector: { name: 'Vector DB', glyph: '🧭', cap: 4000, lat: 25, avail: 0.999, concurrency: 160, queueDepth: 640, cv: 0.5 },
  embed: { name: 'Embedding Svc', glyph: '🔢', cap: 800, lat: 40, avail: 0.999, concurrency: 51, queueDepth: 204, cv: 0.5 },
  llm: { name: 'LLM Inference', glyph: '🧠', cap: 60, lat: 900, avail: 0.999, concurrency: 86, queueDepth: 344, cv: 0.9 },
  guard: { name: 'Guardrails', glyph: '🛟', cap: 5000, lat: 20, avail: 0.999, concurrency: 160, queueDepth: 640, cv: 0.5 },
  gemini3: { name: 'Gemini 3 Pro', glyph: '✨', cap: 500, lat: 800, avail: 0.999, concurrency: 640, queueDepth: 2560, cv: 0.9 },
  gemini2: { name: 'Gemini 2.5', glyph: '💫', cap: 600, lat: 750, avail: 0.999, concurrency: 720, queueDepth: 2880, cv: 0.9 },
  notebooklm: { name: 'NotebookLM', glyph: '📖', cap: 1000, lat: 500, avail: 0.999, concurrency: 800, queueDepth: 3200, cv: 0.9 },
  antigravity: { name: 'Antigravity IDE', glyph: '🚀', cap: 200, lat: 1200, avail: 0.995, concurrency: 384, queueDepth: 1536, cv: 0.9 },
  vertexai: { name: 'Vertex AI', glyph: '🧠', cap: 800, lat: 600, avail: 0.9995, concurrency: 768, queueDepth: 3072, cv: 0.9 },
  imagen: { name: 'Imagen 4', glyph: '🎨', cap: 200, lat: 2000, avail: 0.999, concurrency: 640, queueDepth: 2560, cv: 0.9 },
  veo: { name: 'Veo 3', glyph: '🎬', cap: 50, lat: 10000, avail: 0.998, concurrency: 800, queueDepth: 3200, cv: 0.9 },
  astra: { name: 'Project Astra', glyph: '👁️', cap: 1000, lat: 100, avail: 0.998, concurrency: 160, queueDepth: 640, cv: 0.7 },
  mariner: { name: 'Project Mariner', glyph: '🌐', cap: 500, lat: 1500, avail: 0.996, concurrency: 1200, queueDepth: 4096, cv: 0.9 },
  beam: { name: 'Google Beam', glyph: '📹', cap: 5000, lat: 50, avail: 0.998, concurrency: 400, queueDepth: 1600, cv: 0.7 },
  gemmaos: { name: 'Gemma (Open)', glyph: '🌱', cap: 2000, lat: 400, avail: 0.9995, concurrency: 1280, queueDepth: 4096, cv: 0.9 },
  duetai: { name: 'Duet AI (Cloud)', glyph: '⚙️', cap: 4000, lat: 200, avail: 0.9995, concurrency: 1280, queueDepth: 4096, cv: 0.9 },
  aiagent: { name: 'Vertex AI Agents', glyph: '🤖', cap: 1000, lat: 800, avail: 0.995, concurrency: 1280, queueDepth: 4096, cv: 0.9 },
  agentgraph: { name: 'Agent Orchestrator', glyph: '🕸️', cap: 800, lat: 900, avail: 0.995, concurrency: 1152, queueDepth: 4096, cv: 0.9 },
  finetune: { name: 'Fine-tuning (LoRA)', glyph: '🎛️', cap: 20, lat: 60000, avail: 0.99, concurrency: 1920, queueDepth: 4096, cv: 0.9 },
  llmobs: { name: 'LLM Observability', glyph: '🔬', cap: 30000, lat: 3, avail: 0.999, concurrency: 144, queueDepth: 576, cv: 0.5 },
  otel: { name: 'OTel Collector', glyph: '📥', cap: 120000, lat: 1, avail: 0.9995, concurrency: 192, queueDepth: 768, cv: 0.5 },
  logs: { name: 'Log Pipeline', glyph: '🧾', cap: 60000, lat: 2, avail: 0.999, concurrency: 192, queueDepth: 768, cv: 0.5 },
  slo: { name: 'SLO / Error Budget', glyph: '🎯', cap: 20000, lat: 5, avail: 0.999, concurrency: 160, queueDepth: 640, cv: 0.5 },
  alert: { name: 'On-call / Paging', glyph: '📟', cap: 5000, lat: 2, avail: 0.9999, concurrency: 16, queueDepth: 64, cv: 0.5 },
  synthetic: { name: 'Synthetic Probes', glyph: '📡', cap: 20000, lat: 5, avail: 0.9999, concurrency: 160, queueDepth: 640, cv: 0.5 },
  apm: { name: 'RUM / Client APM', glyph: '🖱️', cap: 80000, lat: 2, avail: 0.999, concurrency: 256, queueDepth: 1024, cv: 0.5 },
  waf: { name: 'WAF / DDoS', glyph: '🛡️', cap: 200000, lat: 3, avail: 0.9999, concurrency: 960, queueDepth: 3840, cv: 0.5 },
  iam: { name: 'Identity (SSO)', glyph: '🔑', cap: 25000, lat: 15, avail: 0.9999, concurrency: 600, queueDepth: 2400, cv: 0.5 },
  secrets: { name: 'Secrets / KMS', glyph: '🔐', cap: 30000, lat: 5, avail: 0.9999, concurrency: 240, queueDepth: 960, cv: 0.5 },
  pii: { name: 'Tokenization Vault', glyph: '🎫', cap: 15000, lat: 12, avail: 0.9995, concurrency: 288, queueDepth: 1152, cv: 0.5 },
  audit: { name: 'Audit Log', glyph: '📜', cap: 40000, lat: 5, avail: 0.9999, concurrency: 320, queueDepth: 1280, cv: 0.5 },
  siem: { name: 'SIEM', glyph: '🕵️', cap: 60000, lat: 10, avail: 0.999, concurrency: 960, queueDepth: 3840, cv: 0.5 },
  gslb: { name: 'Global Traffic Mgr', glyph: '🌍', cap: 500000, lat: 2, avail: 0.99999, concurrency: 1600, queueDepth: 4096, cv: 0.5 },
  edge: { name: 'Edge Functions', glyph: '🛰️', cap: 50000, lat: 4, avail: 0.9999, concurrency: 320, queueDepth: 1280, cv: 0.5 },
  graphql: { name: 'GraphQL Federation', glyph: '🔷', cap: 6000, lat: 12, avail: 0.999, concurrency: 115, queueDepth: 460, cv: 0.5 },
  tenant: { name: 'Tenant Router', glyph: '🏷️', cap: 60000, lat: 2, avail: 0.9995, concurrency: 192, queueDepth: 768, cv: 0.5 },
  k8s: { name: 'Container Platform', glyph: '☸️', cap: 90000, lat: 2, avail: 0.9995, concurrency: 288, queueDepth: 1152, cv: 0.5 },
  cicd: { name: 'CI/CD Pipeline', glyph: '🚀', cap: 500, lat: 30, avail: 0.999, concurrency: 24, queueDepth: 96, cv: 0.5 },
  esb: { name: 'Integration Bus', glyph: '🔀', cap: 9000, lat: 25, avail: 0.999, concurrency: 360, queueDepth: 1440, cv: 0.5 },
  mq: { name: 'Enterprise MQ', glyph: '📬', cap: 30000, lat: 5, avail: 0.9995, concurrency: 240, queueDepth: 960, cv: 0.5 },
  erp: { name: 'ERP (SAP)', glyph: '🏢', cap: 900, lat: 120, avail: 0.999, concurrency: 173, queueDepth: 692, cv: 0.7 },
  crm: { name: 'CRM (Salesforce)', glyph: '🤝', cap: 1200, lat: 100, avail: 0.999, concurrency: 192, queueDepth: 768, cv: 0.7 },
  mainframe: { name: 'Mainframe Core', glyph: '🖲️', cap: 1500, lat: 60, avail: 0.99999, concurrency: 144, queueDepth: 576, cv: 0.7 },
  mft: { name: 'File Transfer / EDI', glyph: '📤', cap: 2000, lat: 40, avail: 0.999, concurrency: 128, queueDepth: 512, cv: 0.5 },
  partner: { name: 'Partner / Bank API', glyph: '⛓️', cap: 2000, lat: 250, avail: 0.995, concurrency: 800, queueDepth: 3200, cv: 0.9 },
  hsm: { name: 'HSM (PIN / Keys)', glyph: '🔏', cap: 8000, lat: 15, avail: 0.9999, concurrency: 192, queueDepth: 768, cv: 0.5 },
  e2e: { name: 'UI Test Automation', glyph: '🕹️', cap: 200, lat: 400, avail: 0.99, concurrency: 128, queueDepth: 512, cv: 0.9 },
  apitest: { name: 'API Test Suite', glyph: '🔬', cap: 2000, lat: 50, avail: 0.999, concurrency: 160, queueDepth: 640, cv: 0.7 },
  load: { name: 'Load & Perf Test', glyph: '🏋️', cap: 50000, lat: 10, avail: 0.999, concurrency: 800, queueDepth: 3200, cv: 0.5 },
  contract: { name: 'Contract Testing', glyph: '📋', cap: 3000, lat: 20, avail: 0.999, concurrency: 96, queueDepth: 384, cv: 0.5 },
  mock: { name: 'Service Virtualization', glyph: '🪞', cap: 20000, lat: 5, avail: 0.999, concurrency: 160, queueDepth: 640, cv: 0.5 },
  testdata: { name: 'Test Data Mgmt', glyph: '🗃️', cap: 5000, lat: 30, avail: 0.999, concurrency: 240, queueDepth: 960, cv: 0.5 },
  qgate: { name: 'Quality Gate (SAST)', glyph: '✅', cap: 500, lat: 120, avail: 0.999, concurrency: 96, queueDepth: 384, cv: 0.7 },
  dast: { name: 'Security Testing (DAST)', glyph: '🔎', cap: 200, lat: 300, avail: 0.999, concurrency: 96, queueDepth: 384, cv: 0.9 },
  devicefarm: { name: 'Device / Browser Grid', glyph: '📱', cap: 300, lat: 800, avail: 0.99, concurrency: 384, queueDepth: 1536, cv: 0.9 },
  testops: { name: 'Test Reporting', glyph: '🧰', cap: 10000, lat: 20, avail: 0.999, concurrency: 320, queueDepth: 1280, cv: 0.5 },
  billing: { name: 'Metering & Billing', glyph: '🧮', cap: 4000, lat: 30, avail: 0.999, concurrency: 192, queueDepth: 768, cv: 0.5 },
  backup: { name: 'Backup & Archive', glyph: '💾', cap: 6000, lat: 200, avail: 0.99999, concurrency: 1920, queueDepth: 4096, cv: 0.9 },
  tls: { name: 'TLS Termination', glyph: '🔒', cap: 180000, lat: 2, avail: 0.99995, concurrency: 576, queueDepth: 2304, cv: 0.5 },
  crypto: { name: 'Encryption Service', glyph: '🔐', cap: 45000, lat: 4, avail: 0.9999, concurrency: 288, queueDepth: 1152, cv: 0.5 },
  hash: { name: 'Password Hashing', glyph: '🧂', cap: 900, lat: 120, avail: 0.9999, concurrency: 173, queueDepth: 692, cv: 0.7 },
  digest: { name: 'Hashing / Checksum', glyph: '#️⃣', cap: 250000, lat: 1, avail: 0.99995, concurrency: 400, queueDepth: 1600, cv: 0.5 },
  sign: { name: 'Signing / JWT', glyph: '✍️', cap: 60000, lat: 3, avail: 0.9999, concurrency: 288, queueDepth: 1152, cv: 0.5 },
  e2ee: { name: 'End-to-End Crypto', glyph: '🕵️‍♀️', cap: 35000, lat: 6, avail: 0.9995, concurrency: 336, queueDepth: 1344, cv: 0.5 },
  graph: { name: 'Graph Database', glyph: '🕸️', cap: 6000, lat: 12, avail: 0.9995, concurrency: 115, queueDepth: 460, cv: 0.5 },
  tsdb: { name: 'Time-Series DB', glyph: '📈', cap: 60000, lat: 4, avail: 0.999, concurrency: 384, queueDepth: 1536, cv: 0.5 },
  featureflag: { name: 'Feature Flags', glyph: '🚩', cap: 80000, lat: 1, avail: 0.9999, concurrency: 128, queueDepth: 512, cv: 0.5 },
  featurestore: { name: 'Feature Store', glyph: '🗂️', cap: 20000, lat: 8, avail: 0.999, concurrency: 256, queueDepth: 1024, cv: 0.5 },
  stream: { name: 'Stream Processor', glyph: '🌀', cap: 40000, lat: 15, avail: 0.999, concurrency: 960, queueDepth: 3840, cv: 0.5 },
  batch: { name: 'Batch Processor', glyph: '🧮', cap: 3000, lat: 300, avail: 0.999, concurrency: 1440, queueDepth: 4096, cv: 0.9 },
  transcode: { name: 'Media Transcoder', glyph: '🎬', cap: 400, lat: 900, avail: 0.999, concurrency: 576, queueDepth: 2304, cv: 0.9 },
  sandbox: { name: 'Code Sandbox', glyph: '📦', cap: 300, lat: 400, avail: 0.999, concurrency: 192, queueDepth: 768, cv: 0.9 },
  geoidx: { name: 'Geospatial Index', glyph: '🧭', cap: 30000, lat: 6, avail: 0.9995, concurrency: 288, queueDepth: 1152, cv: 0.5 },
  push: { name: 'Push / SMS / Email', glyph: '📮', cap: 20000, lat: 120, avail: 0.999, concurrency: 3840, queueDepth: 4096, cv: 0.7 },
  containerreg: { name: 'Container Registry', glyph: '🐳', cap: 5000, lat: 20, avail: 0.9999, concurrency: 160, queueDepth: 640, cv: 0.5 },
  bastion: { name: 'Bastion / Jump Host', glyph: '🚪', cap: 500, lat: 10, avail: 0.999, concurrency: 8, queueDepth: 32, cv: 0.5 },
  ledger: { name: 'Ledger (Double-Entry)', glyph: '📒', cap: 1500, lat: 8, avail: 0.9999, concurrency: 19, queueDepth: 76, cv: 0.5 },
  fastapi: { name: 'FastAPI (Async Python)', glyph: '⚡', cap: 2200, lat: 22, avail: 0.9995, concurrency: 77, queueDepth: 308, cv: 0.5 },
  llmworker: { name: 'LLM Worker', glyph: '🦾', cap: 55, lat: 950, avail: 0.999, concurrency: 84, queueDepth: 336, cv: 0.9 },}

export const KINDS = Object.keys(CATALOG)
export const isSource = (kind) => !!CATALOG[kind]?.source
export const specOf = (kind) => CATALOG[kind] || CATALOG.custom

// Anything the mapping tables could not classify lands here rather than being
// dropped. A 'custom' node still simulates — conservatively — and still round
// trips through the IaC compiler byte for byte.
CATALOG.custom = CATALOG.custom || {
  name: 'Custom / unmapped', glyph: '🧱', cap: 5000, lat: 10, avail: 0.999,
  concurrency: 64, queueDepth: 256, cv: 0.5,
}
