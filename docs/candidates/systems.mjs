// The candidate template library, generated from two axes that both matter.
//
// A template earns its place only if it poses a *different* simulation problem.
// "Uber for dogs" and "Uber for cats" are one template. So the list is built as
// 250 real systems × 4 constraints each, where every constraint changes the
// shape of the queueing problem — where the work queues, what cannot be cached,
// what has to be synchronous, what the failure mode is.
//
// Format per system: [slug, Name, archetype, what makes it its own problem]

export const ARCHETYPES = {
  readheavy: {
    nodes: 'client:Client,cdn:CDN,lb:Load balancer,app:App,cache:Cache,sql:Primary DB,search:Search',
    edges: 'client>cdn>lb>app,app>cache,app>sql,app>search',
    about: 'Cache hit rate is the whole design; the origin only sees the misses.',
  },
  writeheavy: {
    nodes: 'client:Client,lb:Load balancer,gateway:API gateway,app:Write API,queue:Ingest queue,worker:Writer,sql:Primary DB,cache:Read cache',
    edges: 'client>lb>gateway>app,app>queue>worker>sql,app>cache',
    about: 'The queue absorbs the burst; the writer is the ceiling and the lag is the symptom.',
  },
  fanout: {
    nodes: 'client:Client,cdn:CDN,gateway:API gateway,bff:BFF,micro:Service A,micro:Service B,micro:Service C,cache:Cache,sql:DB',
    edges: 'client>cdn>gateway>bff,bff>micro,bff>micro,bff>micro,micro>cache,micro>sql',
    about: 'One request becomes many; the slowest branch sets the p99 and retries multiply.',
  },
  pipeline: {
    nodes: 'client:Producer,kafka:Event log,stream:Stream processor,lake:Lake,etl:Transform,warehouse:Warehouse,bi:BI',
    edges: 'client>kafka>stream>lake>etl>warehouse>bi',
    about: 'Throughput and lag, not latency. Backpressure is the failure mode.',
  },
  inference: {
    nodes: 'client:Client,gateway:API gateway,ratelimiter:Rate limiter,guard:Safety filter,llm:Model,vector:Vector store,cache:Response cache',
    edges: 'client>gateway>ratelimiter>guard>llm,llm>vector,gateway>cache',
    about: 'Concurrency, not rps: a slow token stream holds a worker for seconds.',
  },
  txn: {
    nodes: 'client:Client,waf:WAF,gateway:API gateway,app:Transaction API,ledger:Ledger,sql:Records DB,queue:Settlement queue,worker:Settler',
    edges: 'client>waf>gateway>app,app>ledger,app>sql,app>queue>worker',
    about: 'Correctness before latency: the ledger write cannot be made eventual.',
  },
  realtime: {
    nodes: 'client:Client,gslb:Global LB,ws:Realtime gateway,stream:Processor,tsdb:Time series,cache:State cache',
    edges: 'client>gslb>ws>stream>tsdb,ws>cache',
    about: 'Connections, not requests. Fan-out on every update is the cost.',
  },
  integration: {
    nodes: 'partner:Partner,mft:File transfer,esb:Integration bus,app:Adapter,erp:ERP,sql:Staging DB,queue:Retry queue',
    edges: 'partner>mft>esb>app>erp,app>sql,app>queue',
    about: 'The slow system on the far end sets the pace and cannot be scaled.',
  },
  batch: {
    nodes: 'scheduler:Scheduler,batch:Batch job,lake:Lake,etl:Transform,warehouse:Warehouse,blob:Object store',
    edges: 'scheduler>batch>lake>etl>warehouse,batch>blob',
    about: 'A window, not a latency budget: it either finishes by morning or it does not.',
  },
  search: {
    nodes: 'client:Client,cdn:CDN,gateway:API gateway,app:Query API,search:Index,cache:Cache,cdc:Indexer,sql:Source DB',
    edges: 'client>cdn>gateway>app,app>search,app>cache,sql>cdc>search',
    about: 'Two paths with different SLOs: query latency and index freshness.',
  },
  media: {
    nodes: 'client:Client,cdn:CDN,gateway:API gateway,app:Catalog API,blob:Object store,transcode:Transcoder,queue:Job queue,sql:Metadata DB',
    edges: 'client>cdn>gateway>app,app>sql,app>blob,app>queue>transcode>blob',
    about: 'Bytes are the CDN’s problem; the control plane is small and must never be.',
  },
  edgeiot: {
    nodes: 'client:Device,edge:Edge collector,mq:Broker,stream:Processor,tsdb:Time series,alert:Alerting,blob:Cold store',
    edges: 'client>edge>mq>stream>tsdb,stream>alert,stream>blob',
    about: 'Many small writers, intermittent links, and a store that only ever grows.',
  },
}

/** Constraints that change the simulation, not the branding. */
export const VARIANTS = {
  base: ['', '', 'The straightforward shape, sized for steady load.'],
  readheavy: ['read-heavy', 'cache:Edge cache', 'Reads dominate 50:1; the design lives or dies on hit rate.'],
  writeheavy: ['write-heavy', 'queue:Write buffer,worker:Writer', 'Writes dominate; the buffer decides whether a burst is absorbed or dropped.'],
  strict: ['strictly consistent', 'zk:Coordinator', 'No stale reads allowed, so the cache stops being a shock absorber.'],
  multiregion: ['multi-region active-active', 'gslb:Global LB,cdc:Replicator', 'Two live regions; replication lag becomes a correctness question.'],
  regulated: ['audited', 'audit:Audit log,pii:PII vault,sign:Signer', 'Every mutation is evidence, and the audit path cannot be sampled.'],
  bursty: ['burst-tolerant', 'queue:Surge queue,ratelimiter:Rate limiter', 'Load arrives in spikes 20× the mean; steady-state sizing is a trap.'],
  offline: ['offline-first', 'queue:Sync queue,worker:Reconciler', 'Clients go dark for hours and reconcile on return.'],
  fanout: ['high fan-out', 'micro:Aggregator', 'One call becomes twenty; tail latency is the only latency that matters.'],
  costcapped: ['cost-capped', '', 'Sized to a budget rather than to a latency target, which changes every answer.'],
  lowlatency: ['sub-100ms', 'edge:Edge compute', 'The budget is small enough that a single extra hop breaks it.'],
  hascale: ['highly available', 'lb:Standby LB,sql:Replica', 'Designed to survive a zone loss without a verdict change.'],
}
