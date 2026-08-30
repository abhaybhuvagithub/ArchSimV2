// The jargon this tool uses, defined.
//
// ArchSim puts p99, SLO, DES, ULID, CDC, mTLS, IR and a dozen more on screen
// and assumes you know all of them. Some of those are genuinely load-bearing:
// someone who reads "p99" as "99% of the time it is this fast" will
// misunderstand every verdict the gate gives them, because it means the
// opposite — one request in a hundred is *worse* than this.
//
// So each entry gives the expansion, what it actually means, and — where there
// is one — the misunderstanding worth heading off. The third field is the
// reason this is not a glossary anyone could have pasted in.

/**
 * @typedef {object} Acronym
 * @property {string} short     the term as it appears on screen
 * @property {string} long      what it stands for
 * @property {string} group     where it belongs
 * @property {string} means     one or two sentences on what it is
 * @property {string} [gotcha]  the mistake people actually make with it
 */

/** @type {Acronym[]} */
export const ACRONYMS = [
  /* ── Measuring ────────────────────────────────────────────────────────── */
  { short: 'p50', long: '50th percentile (median)', group: 'Measuring',
    means: 'Half of requests are faster than this, half slower. The typical experience.',
    gotcha: 'It is not the average. An average is dragged around by a few very slow requests; a median is not, which is why latency is quoted as percentiles.' },
  { short: 'p99', long: '99th percentile', group: 'Measuring',
    means: 'One request in a hundred is slower than this figure.',
    gotcha: 'It does not mean "99% of the time the system is this fast, so it is basically fine". At 10,000 rps, the p99 is the experience of 100 requests every second. On a page that makes 20 calls, most page loads contain at least one of them.' },
  { short: 'rps', long: 'requests per second', group: 'Measuring',
    means: 'Arrival rate. Everything in the simulator is driven by it.',
    gotcha: 'Peak rps is what sizing must survive, and it is usually two to ten times the daily average. A design sized to the mean fails every afternoon.' },
  { short: 'CV', long: 'coefficient of variation', group: 'Measuring',
    means: 'Standard deviation divided by the mean — how spread out the service times are.',
    gotcha: 'It matters more than the mean near saturation. Two components with identical average latency queue very differently if one is consistent and the other is erratic.' },
  { short: 'SLO', long: 'service level objective', group: 'Measuring',
    means: 'The target you hold yourself to — "p99 under 300ms", "availability at least 99.9%". ArchSim gates on these.',
    gotcha: 'An SLO is a decision about what you will spend to avoid, not a prediction. An objective nobody would fund a fix for is decoration.' },
  { short: 'SLA', long: 'service level agreement', group: 'Measuring',
    means: 'A contractual promise to someone else, usually with money attached to breaking it.',
    gotcha: 'Your SLO should be stricter than your SLA. If they are equal you have no room to notice trouble before your customer does.' },
  { short: 'SLI', long: 'service level indicator', group: 'Measuring',
    means: 'The measurement an SLO is written against — the actual number coming from the system.' },

  /* ── Queueing ─────────────────────────────────────────────────────────── */
  { short: 'M/M/1', long: 'Markovian arrivals, Markovian service, 1 server', group: 'Queueing',
    means: "Kendall's notation for the simplest queue. ArchSim's analytic engine is M/M/1-flavoured below saturation.",
    gotcha: 'The letters are assumptions, not decoration: memoryless arrivals and service. Real traffic is burstier, which is why the discrete-event engine exists.' },
  { short: 'G/G/c', long: 'general arrivals, general service, c servers', group: 'Queueing',
    means: 'A queue with arbitrary distributions and c parallel servers. What the discrete-event engine actually simulates.' },
  { short: 'DES', long: 'discrete-event simulation', group: 'Queueing',
    means: 'Simulating the system one event at a time — each arrival, each completion — rather than solving equations about it. Slower, and it captures things the equations cannot: retry storms, breakers flapping, workers starving.',
    gotcha: 'Use it past the knee. Below it the analytic engine agrees and is a thousand times faster.' },
  { short: "Little's law", long: 'L = λW', group: 'Queueing',
    means: 'Items in the system = arrival rate × time each spends there. It ties concurrency, throughput and latency together, so any two of them fix the third.',
    gotcha: 'It is the invariant the whole catalog is checked against. If a component claims a capacity and a latency that imply an impossible concurrency, the arithmetic is wrong somewhere.' },
  { short: 'Erlang-C', long: 'Erlang C formula', group: 'Queueing',
    means: 'Closed-form probability that an arrival has to wait in an M/M/c queue. ArchSim validates its engines against it.' },
  { short: 'the knee', long: '—', group: 'Queueing',
    means: 'The utilisation past which latency stops rising gently and starts rising vertically. Around 70–80% for most components.',
    gotcha: 'Running at 95% utilisation is not "efficient use of resources". It is running at a point where a 5% traffic increase multiplies your latency.' },

  /* ── Reliability ──────────────────────────────────────────────────────── */
  { short: 'AZ', long: 'availability zone', group: 'Reliability',
    means: 'One datacentre-ish failure domain inside a cloud region. Zones are meant to fail independently.',
    gotcha: 'Spreading across three zones costs a third of capacity when one fails. Across two, it costs half.' },
  { short: 'quorum', long: '—', group: 'Reliability',
    means: 'A majority of a replica group — ⌊n/2⌋+1. Raft, Paxos, ZooKeeper and etcd need one reachable to make progress.',
    gotcha: 'Two members are worse than one: you now need both. Only odd counts buy anything, and 4 tolerates exactly as many failures as 3 while being less available.' },
  { short: 'MTTR', long: 'mean time to recovery', group: 'Reliability',
    means: 'How long it takes to get back after a failure. Usually a far better thing to improve than mean time between failures.' },
  { short: 'blast radius', long: '—', group: 'Reliability',
    means: 'What else stops working when this stops working. The reason a shared dependency is more dangerous than a busy one.' },
  { short: 'grey failure', long: '—', group: 'Reliability',
    means: 'A component that is failing but still passing health checks — answering slowly, or wrongly, rather than not at all.',
    gotcha: 'The worst kind, because your load balancer keeps sending it traffic. A health check that only asks "are you alive" cannot see it.' },
  { short: 'backpressure', long: '—', group: 'Reliability',
    means: 'Telling the caller to slow down instead of accepting work you cannot finish. Queueing without it just moves the failure somewhere less visible.' },

  /* ── Architecture ─────────────────────────────────────────────────────── */
  { short: 'IR', long: 'intermediate representation', group: 'Architecture',
    means: "ArchSim's single source of truth: one document describing the architecture, which both the diagram and the code are projections of." },
  { short: 'ULID', long: 'universally unique lexicographically sortable identifier', group: 'Architecture',
    means: 'The identity every node and edge carries. Sortable by creation time, unlike a UUID.',
    gotcha: 'Never derived from a label. Renaming a component must not change what it is, or every diff would report a delete and an add.' },
  { short: 'IaC', long: 'infrastructure as code', group: 'Architecture',
    means: 'Terraform, CloudFormation, Pulumi, Helm — infrastructure declared in files rather than clicked into a console.' },
  { short: 'HCL', long: 'HashiCorp configuration language', group: 'Architecture',
    means: "Terraform's syntax. ArchSim parses it into a concrete syntax tree so it can patch bytes rather than regenerate files." },
  { short: 'CST', long: 'concrete syntax tree', group: 'Architecture',
    means: 'A parse tree that keeps every comment, blank line and quirk of formatting.',
    gotcha: 'Why ArchSim can edit one attribute of your Terraform and leave the rest of the file byte-identical. An abstract syntax tree would lose your comments.' },
  { short: 'CDC', long: 'change data capture', group: 'Architecture',
    means: "Streaming a database's changes out as events, usually by reading its write-ahead log.",
    gotcha: 'Replication lag is the only metric that matters and it is invisible until it is a crisis.' },
  { short: 'CQRS', long: 'command query responsibility segregation', group: 'Architecture',
    means: 'Separate paths for writes and reads, so each can be scaled and modelled independently.' },
  { short: 'BFF', long: 'backend for frontend', group: 'Architecture',
    means: 'A per-client API layer that aggregates the calls one screen needs, so a mobile client makes one round trip instead of twelve.' },
  { short: 'saga', long: '—', group: 'Architecture',
    means: 'A long transaction split into steps, each with a compensating action, because you cannot hold a lock across services.',
    gotcha: 'The compensations are code paths nobody tests until the day they matter.' },
  { short: 'outbox', long: 'transactional outbox', group: 'Architecture',
    means: 'Writing the event into the same database transaction as the data, and publishing it from there. The only honest way to commit and publish atomically.' },

  /* ── Traffic ──────────────────────────────────────────────────────────── */
  { short: 'CDN', long: 'content delivery network', group: 'Traffic',
    means: 'Caches near your users that absorb requests before they reach you.',
    gotcha: 'The hit rate is the whole design. At 90% your origin sees a tenth of the load; at 50% it sees half.' },
  { short: 'LB', long: 'load balancer', group: 'Traffic',
    means: 'Spreads requests across replicas. Also a dependency, and also a single point of failure if there is one of it.' },
  { short: 'GSLB', long: 'global server load balancing', group: 'Traffic',
    means: 'Steering traffic between regions, usually by DNS or anycast.' },
  { short: 'WAF', long: 'web application firewall', group: 'Traffic',
    means: 'Inspects requests for attacks before they reach the application. On the request path, so it is also latency and also a dependency.' },
  { short: 'thundering herd', long: '—', group: 'Traffic',
    means: 'Everything retrying or reconnecting at the same instant after an outage.',
    gotcha: 'It routinely finishes the job the original outage started. Jittered backoff exists entirely because of this.' },
  { short: 'stampede', long: 'cache stampede', group: 'Traffic',
    means: 'A popular cache key expires and every request for it hits the origin at once.' },

  /* ── Security ─────────────────────────────────────────────────────────── */
  { short: 'mTLS', long: 'mutual TLS', group: 'Security',
    means: 'Both sides present a certificate, so the server knows who is calling and not only the reverse.' },
  { short: 'HSM', long: 'hardware security module', group: 'Security',
    means: 'A tamper-resistant box that holds keys and signs things without ever revealing them.',
    gotcha: 'Deliberately slow and genuinely rate-limited. Putting one on a hot path is a capacity decision, not just a security one.' },
  { short: 'PII', long: 'personally identifiable information', group: 'Security',
    means: 'Data that identifies a person. Usually the reason a component has to live inside a particular boundary.' },
  { short: 'SIEM', long: 'security information and event management', group: 'Security',
    means: 'Where security-relevant logs are collected and correlated.' },
  { short: 'OPA', long: 'open policy agent', group: 'Security',
    means: 'A policy engine that evaluates rules — often written in Rego — against a request or a change.' },

  /* ── Operating ────────────────────────────────────────────────────────── */
  { short: 'drift', long: '—', group: 'Operating',
    means: 'Where the model and reality disagree — either your IaC versus what is deployed, or the simulator versus what telemetry measures.',
    gotcha: "The second kind is the more interesting: it is the model telling you it is wrong, which is the only way a model earns trust." },
  { short: 'digital twin', long: '—', group: 'Operating',
    means: 'A live model of the running system, fed by its telemetry, so its predictions can be checked against what actually happened.' },
  { short: 'OTel', long: 'OpenTelemetry', group: 'Operating',
    means: 'The vendor-neutral standard for emitting traces, metrics and logs.' },
  { short: 'error budget', long: '—', group: 'Operating',
    means: 'The unreliability an SLO permits. 99.9% availability is an error budget of about 43 minutes a month.',
    gotcha: 'It is meant to be spent. A team that never uses its budget is shipping too slowly, not doing well.' },
  { short: 'gate', long: 'architecture gate', group: 'Operating',
    means: 'A check in CI that simulates the change and fails the build if it breaks an SLO — the same idea as a test, applied to capacity and availability.' },
]

/** The groups, in the order they are worth reading. */
export const ACRONYM_GROUPS = [...new Set(ACRONYMS.map((a) => a.group))]

/** Substring search over the term, its expansion, and both explanations. */
export function searchAcronyms(query) {
  const q = (query || '').trim().toLowerCase()
  if (!q) return ACRONYMS
  return ACRONYMS.filter((a) =>
    `${a.short} ${a.long} ${a.group} ${a.means} ${a.gotcha || ''}`.toLowerCase().includes(q))
}
