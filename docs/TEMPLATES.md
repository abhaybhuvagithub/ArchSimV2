# Wiring rules, and 100 architectures

Two features that answer the same complaint: a blank canvas, or a canvas full of
components that are not joined up, is not a starting point. It is a chore.

---

## Auto-wiring

A component with no edges is dead weight. It costs money, adds no latency, and
cannot fail anything — so a design containing one is being simulated as
something other than what the person drew. The studio now wires components in
instead of leaving that to be noticed later.

**When you add one.** Click a component in the palette, or drag it onto the
canvas, and it arrives connected: a database lands downstream of the service
that will read it, a worker lands downstream of a queue, a load balancer lands
between the client and the tier it fronts. The proposal is applied immediately
and the toast that announces it carries an Undo, because a wiring guess you
have to accept before seeing it is a modal dialog with extra steps.

**When they are already stranded.** Press `C`, use the command palette, or click
the amber button that appears in the palette whenever something is unconnected.
Every stranded component is wired in one undoable step, and each proposal is
resolved against the canvas *as it grows* — so two components dropped side by
side can connect to each other rather than both reaching past one another for
the same third node.

Every automatic edge is marked `inferred` with medium confidence and a sentence
saying why, exactly like an edge the IaC compiler infers from Terraform. It
draws dashed. Nothing the tool guessed is ever presented as something you
authored.

### The rules

117 catalog kinds collapse into twelve roles, and the roles have an adjacency
table. A kind not named in the table is classified from its catalog shape — a
source is a source, something with a cache-hit rate is a cache, something slow
and wide is a consumer — so a component added to the catalog later still wires
sensibly without being listed twice.

| Role | Connects from | Connects to |
|---|---|---|
| `source` | — | edge, balancer, gateway, compute |
| `edge` | source | balancer, gateway, compute |
| `balancer` | edge, source | gateway, compute |
| `gateway` | balancer, edge, source | compute, ai |
| `compute` | gateway, balancer, edge, source | cache, store, search, async, ai |
| `cache` | compute, gateway | store |
| `store` | compute, consumer, cache, gateway | — |
| `search` | compute, gateway | — |
| `ai` | compute, gateway | store, search |
| `async` | compute, gateway | consumer |
| `consumer` | async, compute | store, external, ai |
| `external` | consumer, compute | — |
| `support` | — | — |

Among candidates of one role, the nearest wins — on a canvas, proximity is how
people express intent. Out-degree breaks ties, so a second worker attaches to
the queue with fewer consumers rather than piling onto the first. The id breaks
the rest, so the same canvas always produces the same wiring.

### The two refusals

The rules are only as good as what they decline to do.

**Observability and platform components get no automatic edge.** A metrics sink,
a log pipeline, a secrets manager, an audit trail: all real dependencies of a
real system, none of them on the request path. Wire a monitor downstream of an
app server and the simulator will faithfully route every request through it,
invent queueing delay that does not exist, and price a component the traffic
never touches. An edge the engine treats as traffic has to correspond to
traffic. So `support` appears in nobody's adjacency lists, and the studio says
so in words rather than silently doing nothing.

**Nothing is proposed between roles with no relationship.** Two databases do not
talk to each other because they happened to be the only two things on the
canvas.

---

## The template library

A hundred architectures across ten categories, each a real ArchIR 2.0 document
with capacity seeds, a workload, four SLOs and a scenario set. Press `L` in the
studio, or:

```bash
node packages/cli/bin/archsim.mjs templates
node packages/cli/bin/archsim.mjs templates --id checkout-flow --out checkout.lock.json
node packages/cli/bin/archsim.mjs gate --ir checkout.lock.json
```

### How they are built

Each template is nine fields of data: an id, a name, a category, a load, three
SLO thresholds, a component list and an edge list. The two structural fields use
a deliberately small notation — `kind:label*replicas`, and `a>b>c` chains —
because a hundred architectures written as object literals is a file nobody
proofreads, and an unproofread template is worse than no template: it teaches
the wrong shape. An edge naming a component the spec never declared is a build
error, not a silently dropped edge, and the check suite proves it.

**Replica counts are derived, not authored.** A hand-written count is a guess
about capacity, and a template that saturates the moment it opens teaches the
reader that the tool is wrong rather than that the design is. A calibration pass
raises each component's count until nothing sits above 65% utilisation at the
peak of the declared day, which makes every template a *sized* design and makes
the sizes reproducible from the catalog rather than from memory.

**Thresholds are set the way a team sets them:** measure what the sized design
does at nominal, promise a round number slightly worse than that, and let the
failure scenarios decide whether the promise survives contact. Latency and
availability are promises about normal operation. The error budget is not — it
is evaluated under every scenario, including the loss of an availability zone,
and that is where several of these stop passing.

### The distribution is the point

Run all hundred through the gate under their own SLOs and the default scenarios
and the answer is **69 pass, 18 at risk, 13 fail**. That spread is deliberate. A
library where everything passes would mean the thresholds had been fitted to the
answer, and a template that always passes teaches nothing — the check suite
asserts that a sample contains more than one verdict, so the library cannot
quietly drift green.

The failures are not mistakes. A design that holds at nominal and loses its error
budget when an availability zone goes away is the most common real architecture
there is, and seeing that stated on open is the reason to open one.


### Web & API

| Template | Components | Load | p99 | Availability | Budget | Gate |
|---|---:|---:|---:|---:|---:|:--:|
| **URL shortener** — Reads outnumber writes about a hundred to one, so the whole design is a cache-hit-rate argument. Take the cache out and watch the key-value store become the system. | 6 | 12,000 rps | 400ms | 99.5% | $200k/mo | ⚠️ |
| **Content site with a CMS** — A render tier behind a CDN. The interesting failure is a cold CDN after a purge, when every request reaches the renderer at once. | 7 | 3,000 rps | 200ms | 99.5% | $50k/mo | ✅ |
| **Multi-tenant SaaS** — One noisy tenant is the whole risk model. The router is where isolation is either enforced or quietly not. | 8 | 6,000 rps | 500ms | 99.5% | $40k/mo | ✅ |
| **Plain REST API** — The smallest thing worth gating. Useful as a control: change one number and see exactly which SLO moves. | 4 | 4,000 rps | 400ms | 99.95% | $2k/mo | ✅ |
| **Federated GraphQL** — One query fans out to three subgraphs, so tail latency is the max of three tails, not the mean. This is the template that makes that visible. | 10 | 5,000 rps | 400ms | 99.5% | $5k/mo | ✅ |
| **Static site on a CDN** — Almost nothing to break, which is the point — it sets the floor other web templates are measured against. | 4 | 8,000 rps | 150ms | 99.5% | $150k/mo | ✅ |
| **Site search** — Query path and index path share one cluster. The failure everyone hits is a reindex storm making queries slow at exactly the wrong moment. | 8 | 4,000 rps | 1000ms | 99.5% | $5k/mo | ✅ |
| **Authentication service** — Everything else depends on it, so its availability target is a tier above the systems it serves. Model an outage here and the blast radius is the whole estate. | 7 | 9,000 rps | 500ms | 99.5% | $30k/mo | ✅ |
| **Rate-limited public API** — The limiter is on the request path, so it is also a dependency. Kill it and decide whether the API fails open or closed — the model prices both. | 7 | 15,000 rps | 500ms | 99.5% | $60k/mo | ✅ |
| **BFF for mobile and web** — Two façades over one set of services. Duplicated per-client logic is the cost; a chatty mobile client is the reason. | 9 | 7,000 rps | 400ms | 99.5% | $2k/mo | ✅ |

### Commerce & payments

| Template | Components | Load | p99 | Availability | Budget | Gate |
|---|---:|---:|---:|---:|---:|:--:|
| **E-commerce storefront** — The full front of a shop. Black Friday is a scenario, not a hypothetical — run it at four times the load and see what gives first. | 12 | 9,000 rps | 400ms | 99.0% | $150k/mo | ❌ |
| **Checkout** — Low traffic, extreme consequence. Every component here is on the path between a customer intending to pay and money moving. | 10 | 2,000 rps | 800ms | 99.5% | $10k/mo | ✅ |
| **Inventory and stock** — Overselling is a consistency bug with a refund attached. The cache in front of stock is exactly where that bug lives. | 7 | 5,000 rps | 1500ms | 99.5% | $3k/mo | ⚠️ |
| **Shopping cart** — A cart is a session with money attached. Losing one is not an outage but it is a lost order, which is why the store behind the cache matters. | 5 | 8,000 rps | 400ms | 99.5% | $8k/mo | ⚠️ |
| **Payment gateway** — The acquirer is someone else's system and it is on your critical path. That dependency is the whole availability story. | 10 | 1,500 rps | 2000ms | 99.0% | $80k/mo | ✅ |
| **Subscription billing** — Almost all the work happens on the first of the month. Size it for the average and the monthly run never finishes. | 10 | 800 rps | 250ms | 99.90% | $1k/mo | ✅ |
| **Order fulfilment** — A pipeline where every stage can fail independently and nothing may be lost. The dead-letter path is not optional here. | 8 | 1,200 rps | 4000ms | 99.0% | $50k/mo | ✅ |
| **Two-sided marketplace** — Two user populations with different load shapes on one core. Sellers are few and write-heavy; buyers are many and read-heavy. | 13 | 6,000 rps | 800ms | 99.5% | $25k/mo | ⚠️ |
| **Dynamic pricing** — A model call on the hot path with a 120ms budget. Either the cache carries it or the model has to be smaller. | 8 | 10,000 rps | 1500ms | 99.5% | $20k/mo | ✅ |
| **Refunds and disputes** — Low volume, long deadlines, and an audit trail that is a legal requirement rather than a nice-to-have. | 9 | 300 rps | 1500ms | 99.0% | $10k/mo | ❌ |

### Social & media

| Template | Components | Load | p99 | Availability | Budget | Gate |
|---|---:|---:|---:|---:|---:|:--:|
| **Social feed** — Fan-out on write against fan-out on read, which is the oldest argument in social infrastructure. This models the write side. | 12 | 12,000 rps | 500ms | 99.0% | $200k/mo | ✅ |
| **Chat and messaging** — Long-lived connections change the capacity question from requests per second to connections held, which the DES models and the analytic engine approximates. | 9 | 15,000 rps | 1000ms | 99.5% | $50k/mo | ✅ |
| **Video streaming** — The CDN carries the bytes and the origin carries the metadata. Transcoding is the expensive, bursty, entirely off-path half. | 10 | 12,000 rps | 5000ms | 99.5% | $150k/mo | ✅ |
| **Photo sharing** — One upload becomes six derivatives. The write path is cheap and the processing path is not. | 10 | 12,000 rps | 1000ms | 99.0% | $150k/mo | ✅ |
| **Live comments** — Traffic follows an event, not a clock. The diurnal workload is wrong here; a spike scenario is the honest one. | 8 | 35,000 rps | 1500ms | 99.5% | $100k/mo | ✅ |
| **Notification fan-out** — One event becomes a million sends. Deduplication is the difference between a notification and a complaint. | 9 | 5,000 rps | 2500ms | 99.5% | $20k/mo | ⚠️ |
| **Content moderation** — A model triages and people decide the hard cases. The queue between them is where a backlog becomes a safety problem. | 10 | 400 rps | 4000ms | 99.5% | $250k/mo | ✅ |
| **Podcast platform** — Streaming without the bandwidth of video, which makes the metadata tier — not the CDN — the thing that falls over. | 10 | 6,000 rps | 15000ms | 99.5% | $60k/mo | ✅ |
| **News aggregator** — A read-heavy front and a continuous crawl behind it. The two share a datastore and compete for it. | 11 | 9,000 rps | 300ms | 99.5% | $150k/mo | ✅ |
| **Community forum** — Modest traffic with a very long tail of old threads, which is a cache-eviction problem disguised as a database problem. | 9 | 4,000 rps | 400ms | 99.0% | $80k/mo | ✅ |

### Data & analytics

| Template | Components | Load | p99 | Availability | Budget | Gate |
|---|---:|---:|---:|---:|---:|:--:|
| **Clickstream pipeline** — The collector must never drop and never block. Everything downstream is allowed to be late; the collector is not allowed to be down. | 9 | 20,000 rps | 2000ms | 99.5% | $40k/mo | ✅ |
| **Nightly ETL to a warehouse** — A batch window is a latency SLO with a deadline attached. Model it at the volume of the worst night, not the average one. | 9 | 400 rps | 150ms | 99.99% | $2k/mo | ✅ |
| **Change data capture** — Replication lag is the only metric that matters and it is invisible until it is a crisis. This template puts it on the canvas. | 8 | 20,000 rps | 2000ms | 99.5% | $30k/mo | ⚠️ |
| **Real-time dashboards** — Two stores with different freshness guarantees behind one query API. Which one answers is a product decision, not an infrastructure one. | 8 | 3,000 rps | 2000ms | 99.5% | $3k/mo | ✅ |
| **Lakehouse** — Storage and compute are separate, so a slow query is a compute problem and an expensive month is a storage one. The cost model separates them. | 9 | 1,500 rps | 4000ms | 99.5% | $2k/mo | ✅ |
| **Session analytics** — Sessionisation is stateful streaming, which means a restart is not free. The DES is where that shows up. | 8 | 30,000 rps | 4000ms | 99.5% | $80k/mo | ✅ |
| **Experimentation platform** — Assignment is on every request, so it has an availability target higher than the product it experiments on. | 9 | 20,000 rps | 4000ms | 99.5% | $25k/mo | ✅ |
| **Metrics platform** — Cardinality is the capacity unit that the request rate hides. Worth opening next to the observability template. | 8 | 60,000 rps | 150ms | 100.00% | $100k/mo | ✅ |
| **Log pipeline** — The highest-volume, lowest-value-per-record system most companies run. Its whole design is a tiering argument. | 8 | 30,000 rps | 500ms | 99.5% | $30k/mo | ✅ |
| **Reverse ETL** — Pushing warehouse data back into operational tools, where rate limits on someone else's API set the pace. | 8 | 600 rps | 3000ms | 99.0% | $30k/mo | ✅ |

### AI & ML

| Template | Components | Load | p99 | Availability | Budget | Gate |
|---|---:|---:|---:|---:|---:|:--:|
| **RAG chatbot** — Retrieval is fast and generation is not, so almost the entire latency budget is one component. The quick-fix engine has very little to work with, which is itself the lesson. | 10 | 60 rps | 4000ms | 99.5% | $100k/mo | ❌ |
| **LLM gateway** — A router in front of expensive, slow, rate-limited capacity. The fallback path is the availability story and the cache is the cost story. | 9 | 120 rps | 4000ms | 99.5% | $200k/mo | ✅ |
| **Embedding indexer** — An entirely asynchronous pipeline whose only user-visible property is how stale the index is. | 8 | 120 rps | 400ms | 99.5% | $4k/mo | ✅ |
| **Recommendations** — Serving and training share a feature store, which is where the two halves of an ML system usually disagree about what a feature means. | 10 | 4,000 rps | 2000ms | 99.5% | $25k/mo | ✅ |
| **Fraud scoring** — Inline on a payment with a 150ms budget: too slow and the transaction is declined by timeout, which costs more than the fraud did. | 9 | 1,200 rps | 500ms | 99.5% | $5k/mo | ✅ |
| **Image generation** — Seconds per request, not milliseconds. The queue is the product: it is what turns a 12-second wait into a job someone can walk away from. | 9 | 15 rps | 8000ms | 99.5% | $8k/mo | ❌ |
| **Speech to text** — Long jobs with a wide worker pool. Little's law does more work here than any queueing formula. | 9 | 20 rps | 4000ms | 99.5% | $25k/mo | ❌ |
| **Agent workflow** — Multi-step, so latency compounds and any single step failing fails the run. The retry-storm scenario is unusually instructive here. | 10 | 10 rps | 8000ms | 99.0% | $15k/mo | ❌ |
| **Fine-tuning pipeline** — Hours per job and no user waiting. Included because the cost model, not the latency model, is what this design is judged on. | 8 | 5 rps | 200000ms | 99.5% | $25k/mo | ✅ |
| **Semantic search** — Hybrid retrieval: keyword and vector in parallel, then a reranker. Three components in series inside a 400ms budget. | 8 | 600 rps | 400ms | 99.5% | $20k/mo | ✅ |

### Streaming & events

| Template | Components | Load | p99 | Availability | Budget | Gate |
|---|---:|---:|---:|---:|---:|:--:|
| **Event-sourced orders** — Writes and reads are separate systems that happen to share a name. Projection lag is the property to gate on. | 8 | 4,000 rps | 400ms | 99.5% | $15k/mo | ✅ |
| **Saga orchestration** — A distributed transaction that admits it is not one. The compensation path exists precisely because a step will fail. | 9 | 1,500 rps | 250ms | 99.5% | $50k/mo | ✅ |
| **Transactional outbox** — The smallest correct answer to "write to the database and publish an event". Worth having as a reference next to the wrong ones. | 8 | 6,000 rps | 1500ms | 99.5% | $30k/mo | ✅ |
| **Event fan-out** — One topic, three consumer groups with different speeds. The slowest sets the retention you need. | 10 | 40,000 rps | 3000ms | 99.5% | $80k/mo | ⚠️ |
| **Stream enrichment and join** — A stateful join with a lookup on the side. State size, not throughput, is what makes this one fall over. | 8 | 25,000 rps | 2000ms | 99.5% | $20k/mo | ✅ |
| **Dead-letter handling** — The path a message takes when it cannot be processed. Most designs draw the happy path only, which is why this is its own template. | 8 | 8,000 rps | 1000ms | 99.5% | $6k/mo | ✅ |
| **Webhook delivery** — Every delivery depends on someone else's uptime. Retry budgets are the difference between resilience and a self-inflicted denial of service. | 9 | 1,500 rps | 1500ms | 99.5% | $100k/mo | ✅ |
| **Scheduled jobs** — The leader election is what stops a job from running twice. Take it out and the failure is silent and expensive. | 8 | 200 rps | 400ms | 99.5% | $800/mo | ✅ |
| **Priority queues** — Three classes of work sharing worker pools. Starvation of the bulk queue is a design choice; starvation of the priority queue is a bug. | 9 | 12,000 rps | 1500ms | 99.5% | $25k/mo | ⚠️ |
| **Backpressure and shedding** — A bounded queue that sheds rather than a growing one that lies. Best read in the DES tab, where the bound actually binds. | 9 | 30,000 rps | 1500ms | 99.5% | $60k/mo | ⚠️ |

### Platform & infrastructure

| Template | Components | Load | p99 | Availability | Budget | Gate |
|---|---:|---:|---:|---:|---:|:--:|
| **Kubernetes microservices** — The default shape of a mid-size estate. The mesh sidecar adds a hop to every call, which is a latency line item people forget to count. | 12 | 10,000 rps | 300ms | 99.5% | $4k/mo | ✅ |
| **Service mesh** — Every hop goes through the mesh, so the mesh's own availability multiplies into every service behind it. | 10 | 15,000 rps | 800ms | 99.5% | $80k/mo | ✅ |
| **Multi-region active-active** — Two of everything and a replication link between them. Losing a region should cost latency, not availability — this is where you check that. | 11 | 20,000 rps | 600ms | 99.5% | $50k/mo | ⚠️ |
| **Blue-green deployment** — Two full stacks and one database, which is where blue-green quietly becomes a schema-compatibility problem. | 8 | 8,000 rps | 500ms | 99.5% | $3k/mo | ✅ |
| **Canary rollout** — One replica takes a slice of traffic. The question the model answers is how big a slice you need before a regression is detectable. | 9 | 12,000 rps | 500ms | 99.5% | $40k/mo | ✅ |
| **API gateway platform** — Five components before a request reaches anything that does work. Each is small; the sum is a third of the latency budget. | 11 | 25,000 rps | 300ms | 99.5% | $200k/mo | ⚠️ |
| **CI/CD pipeline** — The system that ships every other system. Its latency SLO is measured in minutes and it is still the one developers complain about most. | 9 | 100 rps | 4000ms | 99.0% | $1k/mo | ✅ |
| **Feature flag platform** — Evaluated on every request in every service, so it needs an availability figure most teams have never had to hit. | 8 | 20,000 rps | 50ms | 99.5% | $200k/mo | ✅ |
| **Config and service discovery** — The control plane everything else assumes is up. Model it down and half the estate becomes unreachable in a way no dashboard predicts. | 7 | 30,000 rps | 100ms | 99.5% | $50k/mo | ✅ |
| **Observability stack** — The system you rely on to tell you the other systems are broken, and the one most likely to be broken at the same time. | 10 | 30,000 rps | 800ms | 99.5% | $100k/mo | ✅ |

### Finance & regulated

| Template | Components | Load | p99 | Availability | Budget | Gate |
|---|---:|---:|---:|---:|---:|:--:|
| **Core banking ledger** — Five nines and double-entry. The cache in front of balances is the single most dangerous component on the canvas. | 10 | 3,000 rps | 2000ms | 99.5% | $15k/mo | ✅ |
| **Card authorisation** — A hundred milliseconds end to end, including a fraud model and a hardware security module. Every hop is measured in single-digit milliseconds. | 9 | 3,000 rps | 1500ms | 99.5% | $100k/mo | ✅ |
| **KYC onboarding** — Slow by design and legally obliged to keep records. The redaction service is on the path because the alternative is a breach. | 11 | 200 rps | 1500ms | 99.0% | $5k/mo | ❌ |
| **Trading order book** — Twenty milliseconds is the whole budget. Almost nothing in the catalog is fast enough to be added to this design casually. | 9 | 20,000 rps | 200ms | 99.5% | $100k/mo | ✅ |
| **Clearing and settlement** — Batch windows with hard external deadlines. Missing one is a regulatory event, not a latency regression. | 9 | 500 rps | 4000ms | 99.0% | $30k/mo | ✅ |
| **Insurance claims** — A long-running human workflow with a model in the middle of it. The queue depth is measured in days. | 10 | 400 rps | 2000ms | 99.0% | $15k/mo | ❌ |
| **Loan origination** — An external bureau on the critical path with a latency you do not control and a contract that says you must retry politely. | 10 | 300 rps | 1500ms | 99.0% | $15k/mo | ❌ |
| **Immutable audit trail** — Append-only with a hash chain, so a gap is detectable. Availability matters more than latency: a lost audit record cannot be re-created. | 9 | 20,000 rps | 4000ms | 99.5% | $25k/mo | ⚠️ |
| **Regulatory reporting** — Deadlines set by law rather than by product. The batch window is the SLO and there is no negotiating it. | 9 | 100 rps | 3000ms | 99.0% | $6k/mo | ❌ |
| **Treasury reconciliation** — Files arrive from banks on their schedule, not yours. Everything downstream is a batch process with a queue in front of it. | 9 | 200 rps | 2000ms | 99.5% | $2k/mo | ✅ |

### IoT, mobility & realtime

| Template | Components | Load | p99 | Availability | Budget | Gate |
|---|---:|---:|---:|---:|---:|:--:|
| **IoT telemetry ingest** — A hundred thousand small messages per second from devices that will not retry politely. The broker is the entire capacity question. | 9 | 40,000 rps | 150ms | 99.5% | $200k/mo | ✅ |
| **Fleet tracking** — Write-heavy with a small hot read set — the current position of everything, which almost fits in memory and therefore should. | 9 | 30,000 rps | 600ms | 99.5% | $20k/mo | ⚠️ |
| **Ride-hailing dispatch** — Matching supply and demand in real time, where a slow match is a lost ride and a wrong match is two of them. | 11 | 20,000 rps | 1500ms | 99.5% | $150k/mo | ⚠️ |
| **Delivery ETA** — A model call on the read path with a cache in front of it. How stale an ETA may be is the product decision the architecture encodes. | 9 | 12,000 rps | 2000ms | 99.5% | $30k/mo | ⚠️ |
| **Smart metering** — Readings arrive continuously and are billed monthly, so the same data is streamed and batched. Both paths must agree. | 9 | 40,000 rps | 5000ms | 99.5% | $60k/mo | ⚠️ |
| **Connected vehicle platform** — Two-way: telemetry up and firmware down. The over-the-air path is the one with real consequences for getting it wrong. | 10 | 25,000 rps | 600ms | 99.5% | $60k/mo | ✅ |
| **Geofencing** — Every position update is a spatial query. The index is the capacity ceiling and the cache is the only thing keeping it reachable. | 9 | 15,000 rps | 1000ms | 99.5% | $60k/mo | ✅ |
| **Real-time multiplayer** — Sixty-millisecond budget with state held in memory per session. Nothing about this design survives a stateless-service assumption. | 8 | 60,000 rps | 500ms | 99.5% | $80k/mo | ✅ |
| **Collaborative editing** — Operations must be ordered and never lost, which makes the op log the source of truth and the document store a projection of it. | 9 | 20,000 rps | 800ms | 99.5% | $50k/mo | ✅ |
| **Presence** — Enormous rate, tiny payload, no durability requirement. The one system where losing data is genuinely fine. | 7 | 30,000 rps | 500ms | 99.5% | $80k/mo | ✅ |

### Enterprise & integration

| Template | Components | Load | p99 | Availability | Budget | Gate |
|---|---:|---:|---:|---:|---:|:--:|
| **ERP integration** — The ERP is slow, licensed per call, and cannot be scaled. Everything in front of it exists to protect it. | 9 | 800 rps | 2500ms | 99.5% | $15k/mo | ✅ |
| **CRM synchronisation** — Bidirectional sync, which means conflicts. The mapping store is the only thing that makes them resolvable rather than merely detectable. | 9 | 600 rps | 2000ms | 99.5% | $4k/mo | ❌ |
| **Mainframe offload** — Reads move off the mainframe and writes stay on it. The cache and the read model are how a system you cannot change gets modernised anyway. | 9 | 2,000 rps | 800ms | 99.5% | $60k/mo | ✅ |
| **B2B file exchange** — Files, not APIs, on a schedule you do not set. Included because a great deal of real integration still looks exactly like this. | 9 | 100 rps | 600ms | 99.0% | $2k/mo | ✅ |
| **ESB modernisation** — Strangler-fig in progress: two architectures behind one gateway, and a gate that has to hold across both. | 9 | 1,500 rps | 300ms | 99.5% | $10k/mo | ✅ |
| **Partner API portal** — External consumers you have a contract with, which turns the rate limiter from a safety valve into a commercial instrument. | 10 | 3,000 rps | 400ms | 99.5% | $15k/mo | ✅ |
| **Document processing** — OCR then extraction then redaction, in series, each measured in seconds. A pipeline whose latency budget is dominated by two models. | 10 | 30 rps | 4000ms | 99.5% | $80k/mo | ❌ |
| **Approval workflows** — Humans are the slow component and the orchestrator has to survive them being on holiday. State outlives every process here. | 9 | 400 rps | 1000ms | 99.5% | $8k/mo | ❌ |
| **Hybrid cloud migration** — Two data centres with different physics and a link between them whose latency is on the request path more often than the diagram suggests. | 11 | 4,000 rps | 1000ms | 99.5% | $25k/mo | ⚠️ |
| **Disaster recovery** — A standby sized for the day it is needed rather than the days it is not. Run the region-loss scenario and see whether two replicas were ever going to be enough. | 11 | 6,000 rps | 2000ms | 99.5% | $15k/mo | ⚠️ |

---

## What still isn't good enough

- **The cost model dominates at high request rates.** Per-request pricing means a
  CDN or an LLM on the hot path prices in the hundreds of thousands a month at
  internet scale. That is arithmetically right and worth seeing, but it makes the
  budget SLO the loudest gate in several templates when latency is the
  interesting one.
- **Availability tops out around three nines for most of these.** The composition
  is honest — a single-instance cache or gateway caps the whole chain — but it
  means a trading template and a blog template both promise 99.5%, which reads
  oddly. The sizing pass optimises for utilisation, not for redundancy; a second
  pass that adds replicas where a single instance is the availability ceiling
  would be the obvious next thing.
- **Every template shares one scenario set** — availability-zone loss, a retry
  storm against SQL, an app crash. A real estate declares its own failure modes.
  These three are a floor, not a substitute.
