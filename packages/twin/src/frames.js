// The frame — one contract for live and replay.
//
// A frame is a single instant of the system as the twin sees it: per-node and
// per-edge rates, latencies and error rates. The live heatmap consumes frames;
// the time-travel scrubber consumes frames; the DES *emits* frames. One shape,
// three producers, one renderer — which is the only reason "reproduce this
// incident in the simulator" is a button rather than a project.
//
// Storage arithmetic for the server tier: ~200 nodes+edges × ~40 B × 0.1 fps
// ≈ 70 MB/day/system at 10s resolution. Ninety days of retention is a rounding
// error, which is why the scrubber can afford to be honest about history
// instead of sampling it away.

export const RESOLUTIONS = { live: 1000, replay: 10000, retention: 60000 }

export function emptyFrame(ts = Date.now()) {
  return { ts, nodes: {}, edges: {} }
}

/**
 * A bounded ring of frames. The browser tier keeps a few minutes; anything
 * longer is a range query against the vendor's own TSDB, which is the replay
 * store we do not have to build.
 */
export class FrameBuffer {
  constructor(capacity = 900) {
    this.capacity = capacity
    this.frames = []
  }
  push(frame) {
    this.frames.push(frame)
    if (this.frames.length > this.capacity) this.frames.splice(0, this.frames.length - this.capacity)
    return frame
  }
  get latest() { return this.frames[this.frames.length - 1] || null }
  get span() {
    if (this.frames.length < 2) return 0
    return this.frames[this.frames.length - 1].ts - this.frames[0].ts
  }
  at(ts) {
    if (!this.frames.length) return null
    let best = this.frames[0]
    for (const f of this.frames) {
      if (Math.abs(f.ts - ts) < Math.abs(best.ts - ts)) best = f
    }
    return best
  }
  range(from, to) { return this.frames.filter((f) => f.ts >= from && f.ts <= to) }
  clear() { this.frames = [] }
}

/** Downsample frames to a coarser resolution by averaging within buckets. */
export function rollup(frames, resolutionMs) {
  if (!frames.length) return []
  const buckets = new Map()
  for (const f of frames) {
    const key = Math.floor(f.ts / resolutionMs) * resolutionMs
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(f)
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([ts, group]) => mergeFrames(ts, group))
}

function mergeFrames(ts, group) {
  const out = emptyFrame(ts)
  const acc = (target, key, src) => {
    if (!target[key]) target[key] = { rps: 0, p50: 0, p99: 0, errRate: 0, saturation: 0, queueDepth: 0, inflight: 0, _n: 0 }
    const t = target[key]
    t.rps += src.rps || 0
    t.p50 += src.p50 || 0
    // A max over p99s is the honest aggregate: averaging tail latencies across
    // buckets invents a calmer system than the one that existed.
    t.p99 = Math.max(t.p99, src.p99 || 0)
    t.errRate += src.errRate || 0
    t.saturation = Math.max(t.saturation, src.saturation || 0)
    t.queueDepth = Math.max(t.queueDepth, src.queueDepth || 0)
    t.inflight = Math.max(t.inflight, src.inflight || 0)
    t._n++
  }
  for (const f of group) {
    for (const [id, v] of Object.entries(f.nodes || {})) acc(out.nodes, id, v)
    for (const [id, v] of Object.entries(f.edges || {})) acc(out.edges, id, v)
  }
  for (const map of [out.nodes, out.edges]) {
    for (const v of Object.values(map)) {
      const n = v._n || 1
      v.rps /= n; v.p50 /= n; v.errRate /= n
      delete v._n
    }
  }
  return out
}

/** Turn a frame into the `fx`-shaped overrides the simulators understand, so a
 *  live moment can be replayed through the engines exactly as it happened. */
export function frameToWorkload(frame, ir, id = 'observed') {
  const sources = ir.nodes.filter((n) => n.capacity?.source)
  const entryIds = new Set(ir.edges.filter((e) => sources.some((s) => s.id === e.from)).map((e) => e.to))
  let rps = 0
  for (const id2 of entryIds) rps += frame.nodes?.[id2]?.rps || 0
  if (!rps) rps = Math.max(...Object.values(frame.nodes || {}).map((n) => n.rps || 0), 1)
  return { id, arrival: { dist: 'const', rps: Math.round(rps) } }
}
