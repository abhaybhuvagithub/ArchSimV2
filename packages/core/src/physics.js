// Storage engine, consistency guarantee and read/write capacity split.
//
// Carried over from ArchSim 1.8 (`src/ddia2.js`). The point of this module is
// that these properties change the *numbers*. Until they fed the simulator,
// choosing linearizable cost nothing on the canvas, which is exactly backwards:
// the whole reason these are hard choices is that they cost throughput and
// latency.
//
// In v2 they live in `IRNode.attrs` — set by the canvas inspector, or inferred
// by the IaC mapper (an `aws_db_instance` with `multi_az = true` and a single
// writer is single-leader replication whether or not anyone drew it that way).

export const ENGINES = {
  btree: { label: 'B-tree', readMul: 1.15, writeMul: 0.8, capMul: 1, latMul: 1, tailMul: 1 },
  lsm: { label: 'LSM-tree', readMul: 0.9, writeMul: 2.2, capMul: 1.6, latMul: 1.1, tailMul: 2.2 },
  memory: { label: 'In-memory', readMul: 4, writeMul: 3, capMul: 3, latMul: 0.25, tailMul: 1.1 },
  column: { label: 'Column-oriented', readMul: 1.4, writeMul: 0.15, capMul: 0.5, latMul: 1.6, tailMul: 1.3 },
}

export const CONSISTENCY = {
  eventual: { label: 'Eventual', capMul: 1, latMul: 1 },
  causal: { label: 'Causal', capMul: 0.9, latMul: 1.15 },
  linearizable: { label: 'Linearizable', capMul: 0.6, latMul: 1.6 },
}

export const DEFAULT_READ_FRACTION = 0.5

export function physicalEffects(node) {
  const a = node?.attrs || {}
  const e = ENGINES[a.engine] || null
  const c = CONSISTENCY[a.consistency] || null
  return {
    engine: a.engine || null,
    consistency: a.consistency || null,
    capMul: (e?.capMul ?? 1) * (c?.capMul ?? 1),
    latMul: (e?.latMul ?? 1) * (c?.latMul ?? 1),
    tailMul: e?.tailMul ?? 1,
  }
}

/**
 * Reads and writes have separate ceilings. Combining them by the mix that
 * actually arrives is what makes single-leader replication show its true shape:
 * followers raise the read ceiling and leave the write one alone.
 */
export function capacitySplit(node, baseCap, replicas) {
  const a = node?.attrs || {}
  const e = ENGINES[a.engine] || null
  const c = CONSISTENCY[a.consistency] || null
  const r = Math.max(replicas, 0)
  const consist = c?.capMul ?? 1
  // Only claim writes are bottlenecked when the design actually says so — a
  // replica count with no declared mode keeps the simple behaviour rather than
  // being silently retro-fitted with a bottleneck it never claimed to have.
  const writeReplicas = a.replication === 'leader' ? Math.min(r, 1) : r
  return {
    readCap: baseCap * r * (e?.readMul ?? 1) * consist,
    writeCap: baseCap * writeReplicas * (e?.writeMul ?? 1) * consist,
    writesScale: a.replication !== 'leader',
  }
}

export function readFractionOf(edge) {
  const v = Number(edge?.readFrac)
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : DEFAULT_READ_FRACTION
}

export function effectiveCapacity(readCap, writeCap, readMix) {
  const r = Math.min(1, Math.max(0, readMix))
  const w = 1 - r
  if (readCap <= 0 && writeCap <= 0) return 0
  if (r === 1) return readCap
  if (w === 1) return writeCap
  if (readCap <= 0 || writeCap <= 0) return 0
  return 1 / (r / readCap + w / writeCap)
}
