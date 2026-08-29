# The twin

A live heatmap over a modelled ceiling is where the model gets caught lying. That
is the whole proposition — not another dashboard, but the feedback loop that
makes every future gate verdict sharper.

## Twin Lite: the canvas pulls, nobody stores

Tier 1 is deliberately serverless. The browser range-queries Prometheus, the
Datadog API or an OTLP-HTTP collector on a 5–10 second tick. No ArchSim servers,
no data custody, an enterprise security review the size of zero.

That constraint buys more than it costs: because **a replay is just a range query
over the past**, the vendor's own TSDB is the replay store we never have to
build. Time-travel ships in Tier 1 rather than waiting for an ingest pipeline.

```js
import { Twin, prometheusSource } from '@archsim/twin'

const twin = new Twin(ir, prometheusSource({ baseUrl: 'https://prom.internal' }), { tickMs: 5000 })
twin.onFrame((frame) => render(frame))
twin.start()
```

The OTLP collector must allow CORS for the browser tier — one line of collector
config, and worth saying out loud because it is the single thing that blocks a
trial.

## The frame

One contract for live, replay and simulation:

```ts
interface TelemetryFrame {
  ts: number
  nodes: Record<NodeId, { rps; p50; p99; errRate; saturation?; queueDepth?; inflight? }>
  edges: Record<EdgeId, { rps; p99; errRate }>
}
```

The DES emits the same shape. One renderer, three producers — which is the only
reason "reproduce this incident in the simulator" is a button rather than a
project.

Storage arithmetic for the server tier: ~200 nodes+edges × ~40 B × 0.1 fps ≈
**70 MB/day/system** at 10s resolution. Ninety days of retention is a rounding
error, which is why the scrubber can afford to be honest about history rather
than sampling it away.

## The resolution ladder

| rung | how | rendering |
|---|---|---|
| **declared** | `archsim.io/node=<ulid>` resource attribute or label | solid |
| **matched** | `service.name` or `k8s.deployment.name` equals an IaC binding | solid |
| **heuristic** | fuzzy name match | dashed, until confirmed |

The compiler *emits* those annotations into generated IaC, so the two halves
close the loop: what we generated is what we can identify. Confirming a heuristic
binding writes it back as a declared one, so the guess is made once and never
re-litigated.

Edges come from traces: span pairs where `parent.service ≠ child.service`
aggregate into per-edge rate, p99 and error rate. `span.kind=client` plus
`peer.service` or `db.system` catches the uninstrumented sinks — the database
with no agent that is very definitely on the critical path.

## Ghost nodes

Series that match nothing become ghosts. This is not an error state; it is the
finding:

```
👻 fraud-scoring — 260 rps, p99 180ms · unmapped
```

The twin discovers what the diagram forgot. Half the value of a first session is
"your architecture review is missing four services that production knows about".

## Drift and calibration

```
`checkout-hook` is serving 516 rps at a healthy p99 while the model says that is
103% of its ceiling. The model is pessimistic here — the gate is failing PRs it
should pass.
```

Two signals: **ceiling overstated** (observed p99 knees well before the modelled
one, so the real ceiling is lower) and **ceiling understated** (sustained traffic
past the modelled ceiling at healthy latency).

One click calibrates: the telemetry-derived figure goes into `overrides`,
provenance flips to `telemetry`, and the Monte-Carlo band narrows from ±40% to
±10%. Every future gate verdict is sharper for it.

**Calibration refuses to lower a ceiling without evidence.** A window in which
the system was comfortable is evidence the ceiling is *at least* the traffic
observed, and evidence of nothing else — "we never pushed it hard" is not the
same as "it cannot go faster". Only an observed knee may lower a capacity figure,
and a lower bound gets a wider band (±25%) to say so.

## Incident time-travel

A bookmark is `{tStart, tEnd, annotations[]}`. The scrubber requests frames over
that window and feeds the identical overlay renderer at whatever speed you
choose. Scrub to T−4min and watch the failure bloom edge by edge.

Then press **Reproduce in simulator**. `faultSignature()` reads what the frames
actually show — a tier that slowed, a tier that shed, traffic that surged, a node
that saturated while serving *less* traffic (duplicates) — and maps those to the
fault library. It names conditions; it does not diagnose root cause. A tool that
guesses at causes in a postmortem is a tool that gets argued with instead of
used.

```yaml
workloads:
  - id: db-slowdown-2026-08-peak
    arrival: {dist: const, rps: 546}

scenarios:
  - fault: slow
    target: "label:checkout-db"
  - fault: crash
    target: "label:checkout-db"
```

That is valid `.archsim/slo.yaml` — asserted in the suite, because if the emitted
YAML did not parse as gate config the loop would be broken. Paste it in and the
postmortem becomes a regression test the gate enforces forever: it fails before
the fix and passes after it.

```
incident → replay → simulation → gate
```

That closed loop is the platform. Everything else is a component of it.

## Twin Server (Tier 2, planned)

```
OTel / Prometheus remote_write / Datadog
        → ingest gateway (authN, tenant, sampling)
        → Kafka
        → mapper workers (attributes → IR node/edge)
        → ClickHouse (1s / 10s / 1m rollups)
        → SSE fan-out → canvas overlay
                     → time-travel scrubber
```

For fleets and long retention. Note that this pipeline is the same shape as the
LLM-platform template in ArchSim's own library — accept fast, process behind a
log. We should run our own gate on it.
