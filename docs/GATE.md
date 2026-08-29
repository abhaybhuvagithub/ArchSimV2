# The CI Architecture Gate

```
plan → IR → diff against main's lockfile → Monte-Carlo across workloads and
scenarios → SLOs evaluated on the resulting distributions → a verdict, a priced
repair, and an exit code.
```

## Setup

```bash
archsim init                                    # writes .archsim/slo.yaml
archsim ingest --plan tfplan.json --out archsim.lock.json
git add .archsim/slo.yaml archsim.lock.json     # both belong in the repo
```

The lockfile is the IR of `main`. Regenerate it when `main` moves; the gate
compares against it so the comment can say what *changed*, not only what is true.

## `.archsim/slo.yaml`

```yaml
gate:
  runs: 500        # sampled worlds per workload × scenario
  seed: 42         # same seed, same comment
  passPct: 95      # holds in >= 95% of worlds -> pass
  riskPct: 80      # holds in >= 80% -> warn (exit 2); below -> fail (exit 1)
  quickFix: true

slos:
  - id: latency
    metric: p99_ms
    op: "<="
    threshold: 800
    under: peak

  - id: availability
    metric: availability
    op: ">="
    threshold: 0.999
    scenarios: [nominal]     # only meaningful in steady state

workloads:
  - id: peak
    arrival: {dist: diurnal, rps: 12000, params: {peakFactor: 4}}
    mix: {readPct: 80}

scenarios:
  - fault: az                # one availability zone dark
  - fault: retry             # duplicate storm on the hottest write path
    target: "kind:sql"
```

Metrics: `p50_ms` `p95_ms` `p99_ms` `error_rate` `availability` `throughput_rps`
`monthly_cost_usd`. Targets: `kind:sql`, `label:checkout`,
`address:aws_db_instance.main`, or a node id. `archsim faults` lists the library.

An SLO with no `scenarios` must survive *every* declared scenario — the strict
reading of "will this hold up". Scope it when a target only means something in
steady state.

**A typo is an error, not a silent skip.** A misspelled metric name aborts the
run rather than degrading into "no SLO", because a gate that passes for the wrong
reason is worse than no gate.

## Three verdicts

| verdict | condition | exit |
|---|---|---|
| pass | holds in ≥ `passPct` of sampled worlds | 0 |
| risk | holds in ≥ `riskPct` — eating the error budget | 2 |
| fail | below that | 1 |
| — | the tool itself failed | 3 |

Exit 3 is never reported as a clean pass. That is the one outcome a gate is not
allowed to fudge.

## Why a probability

Every capacity figure in the model is a prior with a band (see
[IR.md](IR.md#provenance-and-the-honesty-band)). Each run draws a world: every
node's capacity and latency from its own prior, an arrival realization from the
declared distribution, and the scenario's faults. Five hundred worlds × four
scenarios lands inside PR-comment latency because the analytic engine answers in
about a millisecond.

So the verdict is *"p99 ≤ 800ms holds in 62% of sampled worlds (was 97% on
main)"*. A point estimate from priors this wide would be false precision with a
decimal point stapled to it.

Determinism: `--seed` plus canonical, sorted-input hashing means a re-run posts
the same comment. The seed is printed, so any world is reproducible locally:

```bash
archsim replay --seed 42 --run 371 --ir archsim.lock.json
```

## The priced repair

When something fails, the convergent quick-fix engine searches: add replicas
(+1, doubled, or sized to the observed load), widen a worker pool, insert a cache
in front of a hot store, add a retry budget. At each step it keeps the change
that buys the most SLO improvement per dollar and stops when everything passes.

```
Cheapest fix found: `checkout` 3→6 replicas
restores every gate at +$211/mo — 50% of the savings this PR banks.
```

No competitor's PR bot does that. Every other gate can tell you a check failed.

## Output formats

`--format md,json,sarif`.

SARIF matters more than it looks: it puts a violation on the line of Terraform
that caused it, in the **Files changed** view. A finding attached to
`main.tf:112` gets fixed; a finding in a comment gets scrolled past. Every rule
the reporter emits is declared in the SARIF driver, because GitHub silently drops
results whose rule id is undeclared.

## GitHub Action

```yaml
- run: terraform plan -out tfplan && terraform show -json tfplan > tfplan.json
- uses: abhaybhuvagithub/ArchSimV2@main
  with:
    plan: tfplan.json
    base: archsim.lock.json
    slo: .archsim/slo.yaml
    runs: 500
    fail-on-risk: false
```

Mode A needs a plan — and for the gate that dependency is free, because a plan
already exists in every Terraform pipeline. For repos without one, `hcl:` runs
Mode B and says loudly where a `count` could not be resolved.

## GitLab

```yaml
architecture-gate:
  image: node:20
  script:
    - terraform show -json tfplan > tfplan.json
    - npx archsim gate --plan tfplan.json --base archsim.lock.json --format md,json --out gate-report.md
  artifacts:
    paths: [gate-report.md, gate-report.json]
  allow_failure: false
```

## Trying it on your own repositories first

```bash
ARCHSIM_SCAN_ROOT=~/src node test/scan.mjs
```

Runs the compiler over every `.tf` file it finds and reports parse failures, lost
bytes, non-surgical patches and — per module directory — whether the resulting
graph has arrows. Nothing is written. It is the honest way to find out how much
of *your* estate the mapping tables understand before you wire a gate into CI,
and the unmapped census it prints is the list of rules worth contributing.

## Airgapped runners

The CLI has no runtime dependencies outside `@archsim/*` — asserted in the suite
— and no build step. Copy the repository onto the runner and run
`node packages/cli/bin/archsim.mjs`. `archsim selftest` holds the engine against
closed-form queueing theory before it votes on anything.
