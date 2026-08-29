// Instance class → capacity.
//
// `db.r5.large` is not a number, and pretending otherwise is how a tool ends up
// quietly confident. What we can say honestly: sizes within a family scale
// roughly linearly with vCPU, and the catalog figure is anchored at a reference
// size. So we scale the catalog seed by the ratio of the requested size to the
// reference size, keep the family as a modest modifier, and tag the result
// `vendor` provenance with the basis spelled out — which is why every gate
// report can say where a number came from.
//
// An unrecognised size does not become a guess. It stays at the catalog seed
// and the node is marked 'modeled', which widens its Monte-Carlo band.

const SIZE_UNITS = {
  nano: 0.25, micro: 0.5, small: 1, medium: 2, large: 4, xlarge: 8,
  '2xlarge': 16, '3xlarge': 24, '4xlarge': 32, '6xlarge': 48, '8xlarge': 64,
  '9xlarge': 72, '12xlarge': 96, '16xlarge': 128, '24xlarge': 192, '32xlarge': 256,
  metal: 256,
}

// Rough per-family throughput bias vs a general-purpose instance of the same size.
const FAMILY_BIAS = {
  t: 0.7,   // burstable — credits run out, and that is the point
  m: 1.0,   // general purpose
  c: 1.25,  // compute optimized
  r: 1.1,   // memory optimized
  x: 1.15,
  i: 1.3,   // storage optimized (IO bound work)
  d: 1.2,
  z: 1.35,
  g: 1.0,   // GPU — capacity is model-bound, not instance-bound
  p: 1.0,
}

const REFERENCE_UNITS = 4 // catalog seeds are anchored at a `large`

/**
 * @returns {{units:number|null, factor:number, basis:string, family:string|null}}
 */
export function parseInstanceClass(str) {
  if (!str || typeof str !== 'string') return { units: null, factor: 1, basis: 'no instance class declared', family: null }
  const parts = str.trim().toLowerCase().split('.')
  // db.r5.large → [db, r5, large];  m5.2xlarge → [m5, 2xlarge]
  const size = parts[parts.length - 1]
  const fam = parts.length >= 2 ? parts[parts.length - 2] : null
  const units = SIZE_UNITS[size]
  if (units === undefined) {
    return { units: null, factor: 1, basis: `unrecognised instance class '${str}' — kept the catalog seed rather than guessing`, family: fam }
  }
  const familyLetter = fam ? fam[0] : 'm'
  const bias = FAMILY_BIAS[familyLetter] ?? 1
  const factor = (units / REFERENCE_UNITS) * bias
  return {
    units, factor, family: fam,
    basis: `${str}: ${units} size-units × ${bias} family bias vs the catalog's reference \`large\``,
  }
}

/** Scale a catalog capacity seed to a declared instance class. */
export function sizeFromInstanceClass(seed, instanceClass, refs = []) {
  const { factor, basis, units } = parseInstanceClass(instanceClass)
  if (units === null) {
    return { ...seed, provenance: { cls: 'modeled', basis, refs }, jitter: { capPct: 40, latPct: 40 } }
  }
  return {
    ...seed,
    capPerReplica: Math.round(seed.capPerReplica * factor),
    // Bigger instances do not make a query faster; they make more of them fit.
    // Only burstable classes get a latency penalty, and only a mild one.
    latencyMs: { ...seed.latencyMs, p50: seed.latencyMs.p50 * (factor < 0.5 ? 1.3 : 1) },
    concurrency: Math.max(1, Math.round((seed.concurrency || 64) * factor)),
    queueDepth: Math.max(1, Math.round((seed.queueDepth || 256) * factor)),
    provenance: { cls: 'vendor', basis, refs },
    jitter: { capPct: 30, latPct: 30 },
  }
}

/** Kubernetes resource requests/limits → concurrency and capacity scaling. */
export function sizeFromK8sResources(seed, resources) {
  const cpu = cpuCores(resources?.limits?.cpu ?? resources?.requests?.cpu)
  if (!cpu) {
    return { ...seed, provenance: { cls: 'modeled', basis: 'no CPU request or limit declared — capacity is the catalog seed, not a measurement', refs: [] } }
  }
  const factor = cpu / 2 // catalog seeds anchored at ~2 vCPU per replica
  return {
    ...seed,
    capPerReplica: Math.max(1, Math.round(seed.capPerReplica * factor)),
    concurrency: Math.max(1, Math.round((seed.concurrency || 64) * factor)),
    provenance: { cls: 'benchmark', basis: `${cpu} vCPU per replica (from resources.${resources?.limits?.cpu ? 'limits' : 'requests'}.cpu) scaled against a 2-vCPU reference`, refs: [] },
    jitter: { capPct: 30, latPct: 30 },
  }
}

export function cpuCores(v) {
  if (v === undefined || v === null) return null
  const s = String(v)
  if (s.endsWith('m')) return Number(s.slice(0, -1)) / 1000
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

export function memoryBytes(v) {
  if (!v) return null
  const m = /^(\d+(?:\.\d+)?)([KMGTP]i?)?$/.exec(String(v))
  if (!m) return null
  const mult = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, K: 1e3, M: 1e6, G: 1e9, T: 1e12 }
  return Number(m[1]) * (mult[m[2]] || 1)
}

/** Lambda memory → capacity: AWS allocates CPU proportional to memory. */
export function sizeFromLambdaMemory(seed, memoryMb = 128) {
  const factor = memoryMb / 1024
  return {
    ...seed,
    capPerReplica: Math.max(1, Math.round(seed.capPerReplica * Math.max(0.15, factor))),
    latencyMs: { ...seed.latencyMs, p50: seed.latencyMs.p50 / Math.max(0.25, Math.min(4, factor)) },
    provenance: { cls: 'vendor', basis: `${memoryMb} MB Lambda: CPU is allocated proportionally to memory, so this scales both throughput and service time`, refs: ['https://docs.aws.amazon.com/lambda/latest/dg/configuration-memory.html'] },
    jitter: { capPct: 30, latPct: 30 },
  }
}
