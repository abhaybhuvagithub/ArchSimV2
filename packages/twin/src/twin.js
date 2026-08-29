// The twin: a source, a resolver, a frame buffer, and the two things that make
// it more than a dashboard — drift detection and calibration.
//
// A live heatmap over a modelled ceiling is where the model gets caught lying.
// When observed p99 knees at 60% of modelled capacity, the capacity figure is
// wrong, and the twin says so and offers to fix it: one click writes the
// telemetry-derived number into `overrides`, flips provenance to 'telemetry',
// and tightens the Monte-Carlo band from ±40% to ±10%.
//
// That is the loop the whole platform turns on. The model learns from
// production; the honesty band earns its keep; and the next PR is gated against
// a system as it actually is rather than as the catalog imagines it.

import { FrameBuffer, emptyFrame, frameToWorkload } from './frames.js'
import { buildResolver, discoverGhosts, confirmBinding } from './bindings.js'
import { effectiveCap } from '@archsim/core'

export class Twin {
  constructor(ir, source, opts = {}) {
    this.ir = ir
    this.source = source
    this.resolve = buildResolver(ir)
    this.buffer = new FrameBuffer(opts.capacity ?? 900)
    this.tickMs = opts.tickMs ?? 5000
    this.ghosts = []
    this.unresolvedSeen = []
    this.timer = null
    this.listeners = new Set()
    this.lastError = null
  }

  onFrame(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn) }

  /** Fold a flat series list into one frame, resolving each series to a node. */
  ingestSeries(series, ts = Date.now()) {
    const frame = emptyFrame(ts)
    const unresolved = []
    for (const s of series) {
      const hit = this.resolve(s)
      if (!hit.node) { unresolved.push({ name: s.name, [s.metric]: s.value, rps: s.metric === 'rps' ? s.value : 0, p99: s.metric === 'p99' ? s.value : 0, errRate: s.metric === 'errRate' ? s.value : 0 }); continue }
      const id = hit.node.id
      frame.nodes[id] = frame.nodes[id] || { rps: 0, p50: 0, p99: 0, errRate: 0 }
      frame.nodes[id][s.metric] = s.value
      frame.nodes[id].confidence = hit.confidence
    }
    // saturation: real traffic against the *modelled* ceiling. This ratio is the
    // whole point — it is where the model and production disagree out loud.
    for (const [id, f] of Object.entries(frame.nodes)) {
      const node = this.ir.nodes.find((n) => n.id === id)
      if (!node) continue
      const cap = effectiveCap(node)
      const ceiling = cap.capPerReplica * cap.replicas
      f.saturation = ceiling && ceiling !== Infinity ? f.rps / ceiling : 0
    }
    this.unresolvedSeen = unresolved
    this.ghosts = discoverGhosts(unresolved)
    return frame
  }

  async tick(at = Date.now()) {
    try {
      const { series } = await this.source.sample(at)
      const frame = this.buffer.push(this.ingestSeries(series, at))
      this.lastError = null
      for (const fn of this.listeners) fn(frame, this)
      return frame
    } catch (err) {
      // A twin that silently stops updating is worse than one that says it
      // stopped: a stale heatmap looks exactly like a calm system.
      this.lastError = err?.message || String(err)
      for (const fn of this.listeners) fn(null, this)
      return null
    }
  }

  start() {
    if (this.timer) return this
    this.tick()
    this.timer = setInterval(() => this.tick(), this.tickMs)
    if (typeof this.timer?.unref === 'function') this.timer.unref()
    return this
  }

  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null } return this }

  /** Load history for the scrubber. A replay is a range query — nothing more. */
  async loadRange(from, to, stepMs = 10000) {
    const rows = await this.source.range(from, to, stepMs)
    const byTs = new Map()
    for (const r of rows) {
      if (!byTs.has(r.ts)) byTs.set(r.ts, [])
      byTs.get(r.ts).push(r)
    }
    const frames = [...byTs.entries()].sort((a, b) => a[0] - b[0]).map(([ts, series]) => this.ingestSeries(series, ts))
    return frames
  }

  drift() { return detectDrift(this.ir, this.buffer.frames) }

  calibrate(nodeId) {
    const { ir, applied } = calibrateNode(this.ir, this.buffer.frames, nodeId)
    this.ir = ir
    this.resolve = buildResolver(ir)
    return applied
  }

  confirm(nodeId, series) {
    const { ir, patch } = confirmBinding(this.ir, nodeId, series)
    this.ir = ir
    this.resolve = buildResolver(ir)
    return patch
  }
}

/**
 * Where the model is lying, and by how much.
 *
 * Two signals:
 *   knee   — observed p99 has climbed well past the node's own service time
 *            while saturation is still low. The real ceiling is below the
 *            modelled one.
 *   idle   — sustained traffic far under the modelled ceiling with flat latency:
 *            the ceiling may be understated, which is the cheaper mistake but
 *            still a mistake.
 */
export function detectDrift(ir, frames, { minFrames = 5 } = {}) {
  if (frames.length < minFrames) return []
  const out = []
  for (const node of ir.nodes) {
    if (node.capacity?.source) continue
    const seen = frames.map((f) => f.nodes[node.id]).filter(Boolean)
    if (seen.length < minFrames) continue
    const cap = effectiveCap(node)
    const modelled = cap.capPerReplica * cap.replicas
    const rps = avg(seen.map((s) => s.rps || 0))
    const p99 = avg(seen.map((s) => s.p99 || 0))
    const modelledP99 = cap.latencyMs.p50 * 3.2
    const saturation = modelled ? rps / modelled : 0

    if (p99 > modelledP99 * 1.8 && saturation < 0.7 && rps > 0) {
      // The knee arrived early. Solve the modelled queueing curve backwards for
      // the ceiling that would produce this p99 at this rate.
      const impliedCeiling = Math.max(1, rps / kneeUtilFor(p99, modelledP99))
      out.push({
        nodeId: node.id, label: node.label, kind: 'ceiling-overstated',
        observedRps: rps, observedP99: p99, modelledCeiling: modelled, impliedCeiling,
        ratio: impliedCeiling / modelled,
        msg: `\`${node.label}\` knees at ${Math.round(rps)} rps — ${(saturation * 100).toFixed(0)}% of its modelled ceiling. p99 is ${p99.toFixed(0)}ms against a modelled ${modelledP99.toFixed(0)}ms. The capacity figure is too generous by roughly ${(1 / Math.max(0.01, impliedCeiling / modelled)).toFixed(1)}×.`,
      })
    } else if (saturation > 0.9 && p99 < modelledP99 * 1.2) {
      out.push({
        nodeId: node.id, label: node.label, kind: 'ceiling-understated',
        observedRps: rps, observedP99: p99, modelledCeiling: modelled, impliedCeiling: rps / 0.7,
        ratio: (rps / 0.7) / modelled,
        msg: `\`${node.label}\` is serving ${Math.round(rps)} rps at a healthy p99 while the model says that is ${(saturation * 100).toFixed(0)}% of its ceiling. The model is pessimistic here — the gate is failing PRs it should pass.`,
      })
    }
  }
  return out
}

/** Invert the analytic queueing factor: what utilization explains this p99? */
function kneeUtilFor(observedP99, modelledP99) {
  const factor = Math.max(1.01, observedP99 / Math.max(1e-9, modelledP99))
  return Math.min(0.98, 1 - 1 / factor)
}

/**
 * Write measured capacity into the node's overrides. This is the moment a
 * number stops being a prior and becomes an observation, and the provenance
 * class and jitter band both have to move with it — otherwise the gate keeps
 * sampling ±40% around a figure we now actually know.
 */
export function calibrateNode(ir, frames, nodeId) {
  const node = ir.nodes.find((n) => n.id === nodeId)
  if (!node) return { ir, applied: null }
  const seen = frames.map((f) => f.nodes[nodeId]).filter(Boolean)
  if (seen.length < 3) return { ir, applied: null }

  const p50 = median(seen.map((s) => s.p50 || 0).filter(Boolean))
  const rps = Math.max(...seen.map((s) => s.rps || 0))
  const p99 = median(seen.map((s) => s.p99 || 0).filter(Boolean))
  const cap = effectiveCap(node)
  const modelledP99 = cap.latencyMs.p50 * 3.2
  const modelledCeiling = cap.capPerReplica * Math.max(1, cap.replicas)

  // Two very different situations, and conflating them is how a twin quietly
  // destroys a good capacity figure:
  //
  //   a knee was observed  — latency has climbed well past the modelled tail, so
  //     the curve can be inverted and the real ceiling is *below* the modelled
  //     one. This is a measurement, and it may lower the number.
  //   no knee was observed — the system was comfortable for the whole window.
  //     That is evidence the ceiling is at least the traffic we saw, and
  //     evidence of nothing else. It may only raise the number, never lower it:
  //     "we never pushed it hard" is not the same as "it cannot go faster".
  const kneed = p99 > modelledP99 * 1.5 && rps > 0
  const impliedCeiling = kneed
    ? Math.max(1, Math.round(rps / Math.max(0.1, kneeUtilFor(p99, modelledP99))))
    : Math.max(modelledCeiling, Math.round(rps / 0.7))

  const overrides = {
    ...(node.overrides || {}),
    capPerReplica: Math.max(1, Math.round(impliedCeiling / Math.max(1, cap.replicas))),
    ...(p50 ? { latencyMs: { dist: 'lognormal', p50, cv: estimateCv(p50, p99) } } : {}),
    provenance: {
      cls: 'telemetry',
      basis: kneed
        ? `calibrated from ${seen.length} observed frames: the latency knee arrived at ${Math.round(rps)} rps (p99 ${p99.toFixed(0)}ms against a modelled ${modelledP99.toFixed(0)}ms), which puts the real ceiling below the catalog figure`
        : `calibrated from ${seen.length} observed frames: sustained ${Math.round(rps)} rps at p99 ${p99.toFixed(0)}ms with no knee — a lower bound on the ceiling, not a measurement of it`,
      refs: [],
    },
    // A measurement deserves a tighter prior than a catalog guess. This is the
    // band narrowing, and it is the reason to connect telemetry at all — but a
    // lower bound is weaker evidence than an observed knee, and gets a wider
    // band to say so.
    jitter: kneed ? { capPct: 10, latPct: 10 } : { capPct: 25, latPct: 10 },
  }

  return {
    ir: { ...ir, nodes: ir.nodes.map((n) => (n.id === nodeId ? { ...n, overrides } : n)) },
    applied: {
      nodeId, label: node.label,
      from: { capPerReplica: cap.capPerReplica, p50: cap.latencyMs.p50, cls: cap.provenance.cls, jitter: cap.jitter },
      to: { capPerReplica: overrides.capPerReplica, p50, cls: 'telemetry', jitter: overrides.jitter },
      kneeObserved: kneed,
    },
  }
}

/** cv implied by the ratio of p99 to p50, assuming lognormal. */
function estimateCv(p50, p99) {
  if (!p50 || !p99 || p99 <= p50) return 0.5
  const z = 2.326 // Φ⁻¹(0.99)
  const sigma = Math.log(p99 / p50) / z
  return Math.min(4, Math.max(0.05, Math.sqrt(Math.exp(sigma * sigma) - 1)))
}

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
const median = (xs) => {
  if (!xs.length) return 0
  const s = xs.slice().sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export { frameToWorkload }
