# Changelog

## 2.0.0

The pivot from an interview-preparation studio to an enterprise digital-twin
platform. Phases 0–5 of [`docs/DESIGN.md`](docs/DESIGN.md).

### The IR (`@archsim/ir`)

- **ArchIR 2.0** — versioned, IaC-bound, SLO-carrying. Published JSON schema and
  TypeScript declarations. Zero dependencies.
- ULID identity, never derived from labels, deterministic from an IaC address so
  re-ingesting the same repository produces the same document byte for byte.
- `managed: observed | partial | full` per binding — brownfield estates render
  read-only by default.
- Provenance classes drive Monte-Carlo band width: v1's blanket ±40% honesty
  disclaimer is now a per-node prior that telemetry can tighten.
- Canonical serialization, content-addressed `irHash`, structural diff, three-way
  merge with conflicts surfaced rather than auto-resolved.
- Migration from ArchSim 1.x share payloads and templates, both directions.

### The analytic engine (`@archsim/core`)

- Extracted from ArchSim 1.8 with the physics unchanged: capacity split, storage
  engine and consistency multipliers, M/M/1-flavoured queueing, availability
  composition, retry duplication. No DOM references, no dependencies.
- 117-component catalog carried over, extended with the DES contract
  (`concurrency`, `queueDepth`, `cv`).
- Chaos fault library, now CI-addressable with `kind:` / `label:` / `address:`
  target selectors.
- Cost model with dated, self-escalating list prices.
- Monte-Carlo runner: parameters, arrival realizations and scenarios sampled per
  world; seeded and reproducible.
- SLO evaluation as a proportion of worlds, with three verdicts (pass / risk /
  fail) and per-scenario detail.
- Convergent quick-fix engine — finds and **prices** the cheapest repair.

### The IaC compiler (`@archsim/iac`)

- Mode A: Terraform plan JSON and live Kubernetes JSON. Exact — `count`
  expansion is folded back into replica counts.
- Mode B: raw HCL through a hand-written CST parser (comments, formatting and
  byte offsets preserved) and a range-aware YAML reader. Unresolvable counts
  degrade to 1× with a badge and a widened band, never an invented number.
- 120 mapping rules across AWS, GCP, Azure and Kubernetes, as data rather than
  code. Unmapped resources become custom components with full passthrough.
- Edge inference through *connectors only* — a listener or a target-group
  attachment carries traffic; a VPC does not, and hopping through one would
  produce a hairball. Every edge carries a confidence and a reason.
- Emission patches byte ranges rather than regenerating files. Deletions become
  removal proposals. Observed bindings, dynamic expressions and HPA-managed
  replica counts are refused with an explanation.

### The discrete-event engine (`@archsim/des`)

- G/G/c with bounded queues; worker pools derived from baseline hold time.
- Retry storms with budgets, circuit breakers, thread starvation, partitions.
- t-digest percentiles; Little's law asserted inside the run.
- Validated against Erlang-C, cross-checked against the analytic engine below the
  knee, and held to three metamorphic properties.

### The gate (`@archsim/cli`)

- `archsim gate | ingest | simulate | des | diff | emit | merge | validate |
  replay | migrate | init | faults | coverage | selftest`.
- Markdown (sticky PR comment), JSON and SARIF reports.
- GitHub Action and a GitLab template.
- Exit codes: 0 pass · 1 violation · 2 error-budget risk · 3 tool failure.
- No runtime dependencies and no build step — it ships to airgapped runners.

### The twin (`@archsim/twin`)

- Twin Lite: PromQL, Datadog and OTLP adapters that pull from the browser. No
  ArchSim servers, no data custody.
- Binding resolution ladder (declared → matched → heuristic), ghost-node
  discovery, trace-derived edges.
- Drift detection and one-click calibration; calibration refuses to lower a
  ceiling without an observed knee.
- Incident time-travel: scrubber, fault signatures, and "reproduce in simulator"
  emitting valid gate configuration.

### The studio (`apps/canvas`)

- React canvas projecting the IR: dashed inferred edges with reasons, hatched
  modelled priors, live heatmap, ghost nodes.
- Panels for simulate, gate, discrete-event chaos, twin and the code patch —
  each calling the same packages the CLI calls.

### Verification

- 376 checks, including a 17-fixture hostile round-trip corpus for HCL and four
  for YAML.
- CI gates ArchSim's own example estate: the baseline must pass, and the
  regression plan must fail with a priced repair.
