# ArchSim v2 — Enterprise Digital Twin Platform

**One IR. Three projections: the canvas, the infrastructure code, and production.**

HashiCorp owns provisioning. Datadog owns observation. The seam between them —
*"will this change hold up, and can you prove it before merge?"* — is unowned.
ArchSim v2 is the shape of that seam.

[![CI](https://github.com/abhaybhuvagithub/ArchSimV2/actions/workflows/ci.yml/badge.svg)](https://github.com/abhaybhuvagithub/ArchSimV2/actions/workflows/ci.yml)
· 410 checks · 6,762 real Terraform files scanned clean · zero runtime dependencies · Node 20+

---

## What it does

```bash
npx archsim gate --plan tfplan.json --base archsim.lock.json --slo .archsim/slo.yaml
```

```markdown
## 🏗️ ArchSim Architecture Gate — ❌ 2 violations
**Change:** `aws_db_instance.main replicas 2→1` · `aws_db_instance.main resized (11000→5500 rps/replica)` · `aws_instance.checkout replicas 6→3`

| SLO | main | this PR | verdict |
|---|---|---|---|
| availability >= 99.900% (nominal) | 100% of runs | **100% of runs** | ✅ |
| monthly_cost_usd <= $4,000        | $1,555       | **$1,133**      | ✅ |
| error_rate <= 0.10% (worst: az)   | 100% of runs | **69% of runs** | ❌ under `az` |
| p99_ms <= 800ms (worst: az)       | 97% of runs  | **62% of runs** | ❌ under `az` |

**Cheapest fix found** (convergent, from the quick-fix engine): `checkout` 3→6 replicas
restores every gate at **+$211/mo** — 50% of the savings this PR banks.

400 runs · seed 42 · reproduce: `archsim replay --seed 42`
```

Two things in that comment are the whole product.

**The verdict is a probability, not a point estimate.** Capacity figures are
priors with error bars, so a model built on them cannot honestly say
"p99 = 812ms". It can say *p99 ≤ 800ms holds in 62% of sampled worlds, and held
in 97% on main* — and that is a claim the model can actually support.

**It prices the repair.** Failing a pull request is cheap. Failing it with
"+$211/mo restores both gates, which is 50% of the saving you were chasing" is a
decision somebody can make in the thirty seconds they have.

---

## The idea

Every architecture diagram is out of date, and every one of them is a claim
nobody checks. ArchSim v2 makes the diagram derivable from the code, the code
patchable from the diagram, and both answerable to production:

```
   Terraform / Kubernetes ──ingest──▶  ArchIR  ◀──edit── canvas
                           ◀─patch──    │    │
                                        │    └──gate──▶ pull request verdict
                             telemetry ─┘              (+ the price of the fix)
```

The IR is the single source of truth. The canvas and the code are both
projections of it; neither owns the system.

---

## The packages

| Package | What it is |
|---|---|
| [`@archsim/ir`](packages/ir) | ArchIR 2.0 — schema, validator, ULID identity, v1 migration, structural diff, three-way merge. Zero dependencies of any kind. |
| [`@archsim/core`](packages/core) | The analytic engine, carried over from ArchSim 1.8: steady-state simulation, the 117-component catalog, chaos faults, the cost model, the Monte-Carlo runner, SLO evaluation and the convergent quick-fix engine. |
| [`@archsim/iac`](packages/iac) | The bidirectional compiler. Terraform plan JSON, raw HCL and Kubernetes in; surgical CST patches back out. |
| [`@archsim/des`](packages/des) | The discrete-event engine: G/G/c with bounded queues, retry storms, circuit breakers, thread starvation, partitions — validated against Erlang-C. |
| [`@archsim/twin`](packages/twin) | Twin Lite: browser-pull telemetry, binding resolution, ghost-node discovery, model calibration, incident time-travel. |
| [`@archsim/cli`](packages/cli) | `archsim` — the headless engine and the CI gate. |
| [`apps/canvas`](apps/canvas) | The studio. A consumer of the packages, not their owner. |

---

## Quick start

```bash
npm install

# what does my infrastructure look like?
node packages/cli/bin/archsim.mjs ingest --plan examples/terraform/tfplan.json --out archsim.lock.json

# will it hold?
node packages/cli/bin/archsim.mjs init                      # writes .archsim/slo.yaml
node packages/cli/bin/archsim.mjs gate --ir archsim.lock.json

# what happens over time, not just in steady state?
node packages/cli/bin/archsim.mjs des --ir archsim.lock.json --rps 6000 --scenario retry:kind:sql

# the studio
npm run dev
```

Exit codes are the contract: `0` pass · `1` SLO violation · `2` error-budget
risk · `3` the tool itself failed — which is never reported as a clean pass.

### In CI

```yaml
- run: terraform show -json tfplan > tfplan.json
- uses: abhaybhuvagithub/ArchSimV2@main
  with:
    plan: tfplan.json
    base: archsim.lock.json      # the twin lockfile, committed next to the Terraform
    slo: .archsim/slo.yaml
```

---

## What makes the answers trustworthy

### Nothing is ever dropped

Bidirectional IaC dies when a tool destroys code it did not model. The rule here
is structural rather than aspirational: anything the mapping tables do not
understand is stored verbatim and re-emitted byte for byte, and an edit is a
byte-range patch of one expression — never a regeneration of a file.

```
[comments-around-count] a replica change patches exactly one line     ✓
[heredoc-with-braces]   every byte outside the edit is identical      ✓
[dynamic-block]         comments and formatting survive the patch     ✓
[dynamic-count]         a computed count is refused, not overwritten  ✓
```

Seventeen deliberately hostile fixtures — CRLF, tabs, unicode comments, heredocs
containing braces, `dynamic` blocks, `for_each`, no trailing newline — are held
to that on every push, plus seven more that real repositories taught us.

Because fixtures you write yourself only test what you already thought of, the
compiler is also run over whole repositories:

```bash
ARCHSIM_SCAN_ROOT=~/src node test/scan.mjs
```

Against 6,762 files of real Terraform — the terraform-aws-modules suite,
cloudposse components, Azure quickstarts and the AWS provider's own corpus:
**61,623 blocks, 14,018 resources, 0 parse errors, 0 lost bytes, 0 crashes**, and
every one of 3,832 module directories produces a graph that validates and
simulates. The first run of that scan found four bugs in an afternoon that the
hand-written suite could not reach: `module` blocks crashing the ingest, string
interpolations containing quotes unbalancing a file, provisioning glue drawn as
architecture, and a single shared module connecting everything to everything.
All four are fixtures now.

### `observed` mode: adoption without ownership

Every binding carries `managed: 'observed' | 'partial' | 'full'`. The default is
`observed`: ArchSim renders a brownfield estate and will not write to it. The
gate delivers value before write access is ever requested — which is the
adoption unlock every tool that demands ownership fumbles.

### Honesty is a number, not a disclaimer

ArchSim 1.x shipped a blanket "±40%" caveat. Useful, and unable to fail a build.
Here the band is a per-node prior with a provenance class:

| class | what it means | Monte-Carlo band |
|---|---|---|
| `telemetry` | measured in your production | ±10% |
| `benchmark` | a published benchmark | ±25% |
| `vendor` | a vendor-stated figure or instance class | ±30% |
| `modeled` | our estimate | ±40% |

Each run of the gate draws a world from those priors. Connect telemetry and one
click replaces a prior with a measurement, narrows its band, and every future
verdict gets sharper. **The model learns from production; the honesty band earns
its keep.**

### The engines are held to theory

The analytic engine answers steady state in about a millisecond, which is what
makes 500 sampled worlds affordable in a PR. The discrete-event engine answers
the time-dependent questions it cannot express — a storm that feeds back, a
breaker that flaps, a queue that drains after a burst, a thread pool strangled by
a slow dependency. They are a fidelity ladder, not rivals, and both are checked:

```
DES matches Erlang-C at ρ=0.85                     theory 72.07ms vs observed 74.83ms (3.8% apart)
the two engines agree at 600 rps (below the knee)  ✓
doubling workers never raises p99                  ✓
a retry budget never raises the error rate         ✓
an open breaker never raises upstream p99          176.6ms → 136.1ms
Little's law holds inside the engine               ✓
```

That last property is the non-obvious one made measurable: **an open breaker
*improves* upstream p99**, because failing fast beats waiting. And the grey
failure nobody gets paged for:

```
db slowed 15× at unchanged arrival rate
  app utilization  30% → 100%      CPU unchanged, workers held on a downstream call
  p99              73ms → 49,478ms
  starvation: `gateway` is 98% utilized but 100% of that is workers *waiting*
```

### Every claim is a check

```bash
npm run verify     # 410/410 checks passed.
```

That is the strategy, inherited from ArchSim 1.x and pointed at bigger claims:
round-trips proven byte-identical, gate verdicts seeded-reproducible, the DES
validated against closed forms, the twin's calibration held to its own
arithmetic. Anything this README asserts is one of those checks.

---

## The loop that is the point

```
incident → replay → simulation → gate
```

The twin records frames. An incident is a window over them. Scrub to T−4min,
watch the failure bloom edge by edge, then **reproduce it in the simulator** —
the frame's workload and the incident's fault signature become a scenario:

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

Paste that into `.archsim/slo.yaml` and the postmortem becomes a regression test
the gate enforces on every future pull request. It fails before the fix and
passes after it.

---

## Status

| Phase | Scope | State |
|---|---|---|
| 0 | IR 2.0 frozen; `@archsim/core` extracted from 1.8; v1 share links and templates migrate | ✅ |
| 1 | Plan-JSON, K8s and static-HCL ingest; 120 mapping rules across AWS/GCP/Azure/K8s; edge inference with confidence | ✅ |
| 2 | CST patcher, generator, three-way merge, the hostile round-trip corpus | ✅ |
| 3 | `archsim` CLI, the gate, Monte-Carlo, md/json/SARIF, GitHub Action, priced repairs | ✅ |
| 4 | Discrete-event engine, chaos scenarios, closed-form and metamorphic validation | ✅ |
| 5 | Twin Lite: PromQL/Datadog/OTLP pull, ghost nodes, calibration, time-travel replay | ✅ |
| — | Hardening against real repositories (`test/scan.mjs`), 158 mapping rules | ✅ |
| 6 | Twin Server: gateway → Kafka → ClickHouse, long retention, fleet-scale rollups | planned |

Design document: [`docs/DESIGN.md`](docs/DESIGN.md). Deeper notes on
[the IR](docs/IR.md), [the gate](docs/GATE.md), [the engines](docs/ENGINES.md)
and [the twin](docs/TWIN.md).

## Lineage

ArchSim 1.x — [System Design Studio](https://github.com/abhaybhuvagithub/ArchSim-System-Design-Studio)
([live](https://abhaybhuvagithub.github.io/ArchSim-System-Design-Studio/)) — is
where the physics, the catalog, the fault library, the cost model and the
"every claim is a check" discipline come from. v2 is that engine, extracted from
the browser and pointed at production.

MIT licensed.
