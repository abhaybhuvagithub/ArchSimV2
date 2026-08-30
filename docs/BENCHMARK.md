# The 1,000-scenario benchmark

`npm run benchmark` — 100 architectures × 10 operating conditions, every one
actually simulated. Takes about two and a half seconds.

This is the version of "a thousand" that was worth building. A thousand
*templates* would have been 877 renames of the same queueing problem
(see `docs/candidates/`). A thousand simulation *runs* over architectures that
already exist produce a thousand answers nobody had.

## How the conditions are chosen

Each cell isolates one variable. Three profiles vary load with no faults; seven
hold load at the design point and vary the fault.

The first draft did not do this, and the result was worthless: retry-storm ran
at 2.5× load and cache-stampede at 4×, so those cells measured the load rather
than the fault, and 98% of the library failed both. **A benchmark where almost
everything fails carries exactly as much information as one where almost
everything passes.**

The load multipliers are derived, not chosen. `test/calibrate-templates.mjs`
sizes every template to `TARGET_UTIL = 0.65` at its diurnal peak, so
`1 / 0.65 ≈ 1.54` is precisely where utilisation reaches 100%. A multiplier
picked because it made the table look interesting would tell you about the
author rather than the architectures. A check asserts the benchmark's constant
still matches the calibrator's.

The faults are the engine's own thirteen. Node-scoped faults are left
untargeted so the engine picks the node it would pick in the studio, rather
than a kind guessed here that half the templates do not contain.

## What it found

| Condition | pass | risk | fail | the question |
|---|---:|---:|---:|---|
| Design point | 98% | 0% | 2% | Does it work at all, on a good day? |
| At the knee, 1.54× | 5% | 3% | 92% | What happens where utilisation reaches 100%? |
| Overload, 3.1× | 1% | 0% | 99% | Well past the knee, what breaks first? |
| Zone loss | 87% | 10% | 3% | Does losing a third of every tier stay in budget? |
| Region loss | 41% | 10% | 49% | Can the surviving half carry the whole load? |
| Grey failure | 86% | 11% | 3% | Does one slow-but-healthy instance poison the pool? |
| Retry storm | 95% | 3% | 2% | Do retries amplify a small failure into a large one? |
| Cache stampede | 77% | 5% | 18% | What reaches the origin when the cache stops absorbing? |
| Network partition | 98% | 0% | 2% | Do calls fail fast, or hold a worker for the timeout? |
| Thundering herd | 16% | 5% | 79% | Does everything reconnecting at once finish the job? |

Four results are worth arguing with rather than filing.

**The knee is a cliff, not a slope.** 98% of the library passes at the design
point and 5% passes at 1.54×. There is essentially no ground in between. That
is a finding about the *calibration*, not about the architectures: sizing every
template to 65% utilisation leaves about a third of headroom, and a third of
headroom is gone the moment traffic is half again what you planned. It is worth
asking whether 65% is the right target, or whether the templates should be
sized to survive a stated multiple of their peak instead.

**Thundering herd is the second most destructive condition, at nominal load.**
79% fail, and 77 of those failures are `error_rate` rather than latency or
cost. Everything reconnecting at once finishes the job the outage started, and
the library is largely not defended against it. That is a real gap in the
templates, not a quirk of the model.

**Region loss fails half the library**, also on `error_rate`. This confirms
something already written down as a known weakness: template sizing optimises
for utilisation, not redundancy, so the surviving region is not sized to carry
the whole load. The benchmark now puts a number on it.

**Two templates fail their own design point** — *Agent workflow* and
*Regulatory reporting*, both on `availability`. They pass no condition at all.
That is a defect in those two templates and should be fixed rather than
explained.

Across all 1,000 runs, what actually breaks: `error_rate` 219 times,
`monthly_cost_usd` 160, `p99_ms` 156, `availability` 20.

## Reading the matrix

```bash
npm run benchmark                        # the summary above
node test/benchmark.mjs --json out.json  # every cell, with what each breached
node test/benchmark.mjs --runs 40        # more Monte-Carlo samples per cell
```

Each cell records the template, the condition, the verdict, which SLOs were
breached, and — for node-scoped faults — which component the engine chose to
break, so a failure names a part rather than only a profile.

## What it does not tell you

Every number here comes from the model. Nothing in this matrix has been
compared against a real system under a real failure, so it says which
architectures the *simulator* believes are fragile. That is worth having and it
is not the same claim.
