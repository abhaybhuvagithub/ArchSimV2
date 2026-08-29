// @archsim/ir — the contract every subsystem speaks.
// Hand-written declarations; the runtime is plain ESM so the gate can ship to
// an airgapped runner without a build step.

export type CanonicalKind = string // v1 catalog taxonomy, frozen + extended
export type NodeId = string        // ULID
export type EdgeId = string

export interface ArchIR {
  irVersion: '2.0'
  meta: { name: string; createdBy: string; updatedAt: string; [k: string]: unknown }

  nodes: IRNode[]
  edges: IREdge[]

  workloads: Workload[]          // traffic models the simulators consume
  slos: SLOSpec[]                // gates the CI engine enforces
  deployments?: DeploymentCtx[]  // cloud/region/env context

  /** Round-trip survival: source text the mappers chose not to model. */
  passthrough: PassthroughBlock[]
}

export interface IRNode {
  id: NodeId                     // stable ULID — never derived from label
  kind: CanonicalKind
  label: string

  capacity: CapacityModel        // the simulation contract
  bindings: IaCBinding[]         // where this node lives in code (>=0)
  telemetry?: TelemetryBinding   // how observability maps back
  layout?: { x: number; y: number }       // canvas projection only
  overrides?: Partial<CapacityModel>      // user/telemetry calibration
  attrs: Record<string, unknown>          // typed per-kind extension bag
}

export interface LatencyDist {
  dist: 'const' | 'exponential' | 'lognormal'
  p50: number
  cv: number
}

export interface CapacityModel {
  replicas: number
  capPerReplica: number          // rps — seeded from catalog, provenance-tagged
  latencyMs: LatencyDist
  availability: number           // per-replica
  concurrency: number            // worker/thread pool size (DES)
  queueDepth: number             // bounded queue K (DES backpressure)
  cacheHit?: number
  source?: boolean               // traffic origin
  provenance: { cls: 'benchmark' | 'vendor' | 'modeled' | 'telemetry'; basis: string; refs: string[] }
  jitter: { capPct: number; latPct: number }  // Monte-Carlo prior — default ±40
}

export interface RetryPolicy { max: number; backoffMs: number; jitter: 'none' | 'full' | 'equal'; budgetPct: number }
export interface BreakerPolicy { windowSec: number; errThreshold: number; minSamples: number; halfOpenProbes: number; cooloffMs: number }

export interface IREdge {
  id: EdgeId
  from: NodeId
  to: NodeId
  callSemantics: 'sync' | 'async' | 'fanout-parallel' | 'fanout-sequential'
  protocol?: 'http' | 'grpc' | 'sql' | 'amqp' | 'kafka' | 'custom'
  weight?: number
  readFrac?: number
  timeoutMs?: number
  retry?: RetryPolicy
  breaker?: BreakerPolicy
  confidence?: 'high' | 'medium' | 'low'
  attrs?: Record<string, unknown>
}

export interface IaCBinding {
  lang: 'hcl' | 'k8s' | 'plan-json'
  file: string
  address: string                // 'module.web.aws_lb.main' | 'apps/v1:Deployment:prod/checkout'
  range?: { startByte: number; endByte: number }  // CST anchor for surgical edits
  managed: 'full' | 'partial' | 'observed'
}

export interface PassthroughBlock {
  lang: 'hcl' | 'k8s'
  file: string
  text: string                   // verbatim — re-emitted byte-for-byte
  anchorAfter?: string
}

export interface TelemetryBinding {
  service?: string
  k8s?: { namespace: string; workload: string }
  promSelector?: string
  ddScope?: string
  confidence: 'declared' | 'matched' | 'heuristic'
}

export interface SLOSpec {
  id: string
  scope: 'system' | { node: NodeId } | { edge: EdgeId }
  metric: 'p99_ms' | 'p95_ms' | 'p50_ms' | 'error_rate' | 'availability' | 'throughput_rps' | 'monthly_cost_usd'
  op: '<=' | '>='
  threshold: number
  under: string | 'all'
  /** Chaos scenarios this SLO must survive. Omitted = all declared scenarios. */
  scenarios?: string[]
}

export interface Workload {
  id: string
  arrival: { dist: 'const' | 'poisson' | 'diurnal' | 'spike'; rps: number; params?: Record<string, number> }
  mix?: { readPct: number }
}

export interface DeploymentCtx { id: string; cloud?: string; region?: string; env?: string; azs?: number }

export declare function createIR(meta?: Partial<ArchIR['meta']>): ArchIR
export declare function normalizeIR(ir: ArchIR): ArchIR
export declare function validateIR(ir: ArchIR, opts?: { kinds?: string[] }): { ok: boolean; errors: Array<{ path: string; msg: string }>; warnings: Array<{ path: string; msg: string }> }
export declare function irHash(ir: ArchIR): string
export declare function serializeIR(ir: ArchIR): string
export declare function parseIR(text: string): ArchIR
export declare function diffIR(before: ArchIR, after: ArchIR): unknown
export declare function threeWayMerge(base: ArchIR, canvas: ArchIR, code: ArchIR): { merged: ArchIR; conflicts: unknown[]; decisions: unknown[] }
export declare function fromV1(payload: unknown, capacityFor?: (kind: string) => unknown, meta?: object): ArchIR
export declare function ulid(now?: number, rng?: () => number): string
export declare function ulidFrom(seedText: string, epoch?: number): string
