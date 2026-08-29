# Two engines, one ladder

They are not rivals. The analytic engine answers steady-state questions in about
a millisecond, which is the only reason five hundred sampled worlds fit inside a
PR comment. The discrete-event engine answers the time-dependent questions the
steady-state model cannot express. Same IR in; a trace out instead of a summary.

| | analytic (`@archsim/core`) | discrete-event (`@archsim/des`) |
|---|---|---|
| answers | steady state | behaviour over time |
| cost | ~1ms | ~0.5s for 20 simulated seconds |
| used by | the canvas, Monte-Carlo, the gate | escalation, chaos scenarios, postmortems |
| sees | utilization, drops, availability, an end-to-end latency estimate | queues draining, storms feeding back, breakers flapping, workers held |

## The analytic engine

Carried over from ArchSim 1.8 unchanged in physics, because that is the code the
998-check suite spent a year holding honest. Traffic propagates through the
graph; each node splits read and write capacity (single-leader replication raises
the read ceiling and leaves the write one alone), applies storage-engine and
consistency multipliers, and pays an M/M/1-flavoured queueing delay. Past the
knee the queueing term stops being a model of anything and is clamped — which is
exactly the region where the DES should take over.

## The discrete-event engine

Each node is **G/G/c with a bounded queue**: `c` workers, FIFO queue bounded at
`K`, service time drawn from the node's latency distribution. A full queue sheds
— backpressure made visible rather than assumed away.

The mechanism worth reading the code for is one line: **on a sync call the worker
is held for the whole downstream wait.**

### Worker pools are derived, not declared

```
c = capacity_ceiling × E[hold]_baseline
```

where `E[hold]` is the node's own mean service time plus the time its workers
spend waiting on synchronous downstream calls *at nominal speed*. A capacity
figure implicitly assumes this — an app rated at 2,000 rps was sized knowing it
calls a database — so it is what worker count must be derived from. Deriving `c`
from own service time alone would declare every proxy starved on the first tick,
which is a bug wearing a finding's clothes.

Faults are deliberately excluded from that baseline. Sizing the pool against the
degraded system would let a design re-provision itself at the exact moment real
infrastructure cannot.

### Thread starvation

```
ρ = λ · E[hold] / c
```

A downstream slowdown inflates `E[hold]`, so a node can starve at **unchanged λ
and healthy CPU** — the grey failure that pages nobody until the front door
drowns. From the suite:

```
db slowed 15× at unchanged arrival rate
  app utilization  30% → 100%
  p99              73ms → 49,478ms
  starvation: `gateway` is 98% utilized but 100% of that is workers *waiting*
```

Timeouts and breakers are precisely caps on `E[hold]`. The DES lets you watch the
cap work.

### Retry storms

```
λ_eff(t) = λ(t) + Σ_k p_fail(t − d_k) · λ_retry_k(t − d_k),   d_k = timeout + backoff_k
```

The analytic engine *asserts* a duplication factor; the DES *produces* one.
Timeouts raise `p_fail`, which raises `λ_eff` after delay `d`, which raises
utilization → latency → more timeouts. With naive retries the fixed point is
saturation:

```
retries on app→db multiplied demand 4.00× while the error rate stayed at 100%
— the loop is feeding itself, not recovering
```

A retry budget (retries ≤ `budgetPct` of successes) damps it, and the trace shows
the damping. Full-jitter exponential backoff is the default emitted policy
because synchronised retries produce visible combs without it.

### Circuit breakers

A per-edge sliding-window state machine. The non-obvious result, measured rather
than asserted:

```
an open breaker never raises upstream p99    176.6ms → 136.1ms
```

An open breaker fails fast at zero latency, which *shrinks* the caller's hold
time. The breaker is a latency firewall — that is the cascade-severing mechanism,
and the DES is where it stops being a slogan.

### Partitions

A partition resolves affected calls as **timeouts, not instant errors** — the
expensive kind of failure, holding a worker for the full `timeoutMs` and feeding
starvation and amplification simultaneously. Modelling a partition as a fast
error would flatter the design.

## Validation

Three layers, all in `npm run verify`:

**Closed-form agreement.** Where M/M/c has an exact answer, the engine is held to
Erlang-C:

```
ρ=0.30  theory 21.98ms  observed 21.79ms  (0.9% apart)
ρ=0.60  theory 31.25ms  observed 30.80ms  (1.4% apart)
ρ=0.85  theory 72.07ms  observed 74.83ms  (3.8% apart)
```

**Cross-engine consistency.** Below the knee both engines agree within the band.
Divergence *beyond* the knee is expected and documented — that divergence is the
DES's reason to exist.

**Metamorphic properties.** Relations that must hold whatever the numbers:
doubling workers never raises p99; a retry budget never raises the steady-state
error rate; an open breaker never raises upstream p99.

**Invariants inside the engine.** Little's law (`L = λ·W`) is asserted per node
during the run. When it fails, the report says the numbers are suspect instead of
presenting a confident p99 built on a broken loop.

## Percentiles

t-digest. A 12,000 rps system over five simulated minutes is 3.6 million
completed requests; keeping every latency to sort at the end costs hundreds of
megabytes and makes long horizons impossible. A fixed-size digest costs kilobytes
and is accurate where it matters — the tails, because p99 is the number in the
SLO.

## Escalation

The Monte-Carlo runner flags a world as interesting — utilization past the knee,
errors in the upper decile, a retry scenario — and `escalate()` runs that exact
world through the DES for a time-resolved trace. The frames it emits are shaped
exactly like telemetry frames from the twin, so a simulated incident and a
replayed one render through the same code path.
