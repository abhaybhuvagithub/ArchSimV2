// ArchIR 2.0 — vocabulary and defaults.
//
// The IR is the single source of truth. The canvas and the code are both
// projections of it; neither owns the system. Everything here is data the
// simulators, the IaC compiler, the gate and the twin all read from one place.

export const IR_VERSION = '2.0'

/** How a caller treats the callee. Decides whether a worker is held (§5.6). */
export const CALL_SEMANTICS = ['sync', 'async', 'fanout-parallel', 'fanout-sequential']

export const PROTOCOLS = ['http', 'grpc', 'sql', 'amqp', 'kafka', 'custom']

/**
 * The political contract with platform teams.
 *   full     → ArchSim may regenerate this block
 *   partial  → ArchSim edits only mapped attributes (count, instance_type…)
 *   observed → read-only: render, never write
 * 'observed' is what lets a brownfield estate be rendered without asking
 * anyone's permission to own it — the adoption unlock.
 */
export const MANAGED = ['full', 'partial', 'observed']

export const IAC_LANGS = ['hcl', 'k8s', 'plan-json']

/**
 * Where a number came from. v1 stated this as a disclaimer; v2 samples it.
 * Tighter classes carry tighter Monte-Carlo priors (see DEFAULT_JITTER).
 */
export const PROVENANCE_CLASSES = {
  telemetry: { label: 'Measured in production', jitter: { capPct: 10, latPct: 10 } },
  benchmark: { label: 'Published benchmark', jitter: { capPct: 25, latPct: 25 } },
  vendor: { label: 'Vendor-stated figure', jitter: { capPct: 30, latPct: 30 } },
  modeled: { label: 'Modelled estimate', jitter: { capPct: 40, latPct: 40 } },
}

/** v1's blanket ±40% honesty band, now a per-node prior telemetry can tighten. */
export const DEFAULT_JITTER = { capPct: 40, latPct: 40 }

export const SLO_METRICS = [
  'p99_ms', 'p95_ms', 'p50_ms', 'error_rate', 'availability', 'throughput_rps', 'monthly_cost_usd',
]

export const ARRIVAL_DISTS = ['const', 'poisson', 'diurnal', 'spike']

export const LATENCY_DISTS = ['const', 'exponential', 'lognormal']

export const CONFIDENCE = ['high', 'medium', 'low']

export const TELEMETRY_CONFIDENCE = ['declared', 'matched', 'heuristic']

export const DEFAULT_RETRY = { max: 0, backoffMs: 50, jitter: 'full', budgetPct: 10 }

export const DEFAULT_BREAKER = { windowSec: 10, errThreshold: 0.5, minSamples: 20, halfOpenProbes: 1, cooloffMs: 5000 }

/** A node with no explicit capacity still has to simulate. */
export const FALLBACK_CAPACITY = {
  replicas: 1,
  capPerReplica: 5000,
  latencyMs: { dist: 'lognormal', p50: 10, cv: 0.5 },
  availability: 0.999,
  concurrency: 64,
  queueDepth: 256,
  provenance: { cls: 'modeled', basis: 'IR fallback — no catalog seed and no telemetry', refs: [] },
  jitter: { ...DEFAULT_JITTER },
}
