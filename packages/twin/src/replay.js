// Incident time-travel, and the loop that makes it worth building.
//
// An incident bookmark is `{tStart, tEnd, annotations[]}`. The scrubber requests
// frames over that window and feeds the identical overlay renderer at whatever
// speed you choose — same code path live and replayed, by construction.
//
// The workflow that matters is what comes after the scrubbing. Scrub to T−4min,
// watch the retry storm bloom edge by edge, then press **Reproduce in
// simulator**: the frame's workload and the incident's fault signature seed a
// discrete-event run, and that run becomes a scenario in `.archsim/slo.yaml`.
// The postmortem turns into a regression test the CI gate enforces forever.
//
//   incident → replay → simulation → gate
//
// That closed loop is the platform. Everything else is a component of it.

import { rollup } from './frames.js'
import { frameToWorkload } from './frames.js'

export function bookmark({ id, tStart, tEnd, title, annotations = [] }) {
  return { id: id || `incident-${tStart}`, tStart, tEnd, title: title || 'incident', annotations }
}

export class Scrubber {
  constructor(frames, { speed = 1, resolutionMs = 10000 } = {}) {
    this.frames = rollup(frames, resolutionMs)
    this.index = 0
    this.speed = speed
    this.timer = null
    this.listeners = new Set()
  }
  get current() { return this.frames[this.index] || null }
  get length() { return this.frames.length }
  onFrame(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn) }
  seek(i) {
    this.index = Math.max(0, Math.min(this.frames.length - 1, i))
    this.emit()
    return this.current
  }
  seekTo(ts) {
    let best = 0
    this.frames.forEach((f, i) => { if (Math.abs(f.ts - ts) < Math.abs(this.frames[best].ts - ts)) best = i })
    return this.seek(best)
  }
  step(delta = 1) { return this.seek(this.index + delta) }
  play(intervalMs = 500) {
    this.pause()
    this.timer = setInterval(() => {
      if (this.index >= this.frames.length - 1) return this.pause()
      this.step(1)
    }, intervalMs / Math.max(0.1, this.speed))
    if (typeof this.timer?.unref === 'function') this.timer.unref()
    return this
  }
  pause() { if (this.timer) { clearInterval(this.timer); this.timer = null } return this }
  emit() { for (const fn of this.listeners) fn(this.current, this.index) }
}

/**
 * Read a fault signature out of an incident window.
 *
 * This is deliberately conservative: it names what the frames actually show —
 * a tier that slowed, a tier that shed, an edge whose error rate climbed — and
 * maps those to the fault library. It does not diagnose root cause. A tool that
 * guesses at causes in a postmortem is a tool that gets argued with instead of
 * used.
 */
export function faultSignature(ir, frames, { baselineFrames = [] } = {}) {
  const base = summarize(ir, baselineFrames.length ? baselineFrames : frames.slice(0, Math.max(1, Math.floor(frames.length * 0.15))))
  const peak = summarize(ir, frames)
  const findings = []

  for (const node of ir.nodes) {
    const b = base[node.id], p = peak[node.id]
    if (!b || !p) continue
    if (p.p99 > b.p99 * 3 && p.rps <= b.rps * 1.3) {
      findings.push({ fault: 'slow', target: `label:${node.label}`, why: `p99 on \`${node.label}\` went ${b.p99.toFixed(0)}ms → ${p.p99.toFixed(0)}ms at unchanged traffic` })
    }
    if (p.errRate > Math.max(0.01, b.errRate * 5)) {
      findings.push({ fault: 'crash', target: `label:${node.label}`, why: `errors on \`${node.label}\` reached ${(p.errRate * 100).toFixed(1)}%` })
    }
    if (p.rps > b.rps * 2.5) {
      findings.push({ fault: 'surge', why: `traffic into \`${node.label}\` went ${Math.round(b.rps)} → ${Math.round(p.rps)} rps` })
    }
    if (p.saturation > 0.95 && p.rps < b.rps) {
      findings.push({ fault: 'retry', target: `label:${node.label}`, why: `\`${node.label}\` saturated while serving *less* traffic — the extra load is duplicates` })
    }
  }
  return dedupe(findings)
}

/**
 * Turn an incident into a runnable scenario, and into the YAML that pins it in
 * CI. The point is not the simulation; the point is that the next PR to
 * re-create this shape fails before it merges.
 */
export function reproduceInSimulator(ir, frames, { id = 'incident', baselineFrames = [] } = {}) {
  const signature = faultSignature(ir, frames, { baselineFrames })
  const peakFrame = frames.reduce((best, f) => (totalRps(f) > totalRps(best) ? f : best), frames[0])
  const workload = frameToWorkload(peakFrame, ir, `${id}-peak`)
  const scenario = { id, faults: signature.map(({ fault, target }) => ({ fault, ...(target ? { target } : {}) })) }
  return {
    scenario,
    workload,
    signature,
    yaml: toYaml(scenario, workload),
    note: signature.length
      ? `Reproduces ${signature.length} observed condition(s) at the incident's peak of ${Math.round(workload.arrival.rps)} rps.`
      : 'The frames show no condition the fault library models — the incident was not a capacity or failure event as far as the twin can tell.',
  }
}

function toYaml(scenario, workload) {
  const lines = ['workloads:']
  lines.push(`  - id: ${workload.id}`)
  lines.push(`    arrival: {dist: ${workload.arrival.dist}, rps: ${Math.round(workload.arrival.rps)}}`)
  lines.push('')
  lines.push('scenarios:')
  if (!scenario.faults.length) lines.push(`  # nothing modelled from this incident`)
  for (const f of scenario.faults) {
    lines.push(`  - fault: ${f.fault}${f.target ? `\n    target: "${f.target}"` : ''}`)
  }
  return lines.join('\n') + '\n'
}

function summarize(ir, frames) {
  const out = {}
  for (const f of frames) {
    for (const [id, v] of Object.entries(f.nodes || {})) {
      if (!out[id]) out[id] = { rps: 0, p99: 0, errRate: 0, saturation: 0, n: 0 }
      const o = out[id]
      o.rps += v.rps || 0
      o.p99 = Math.max(o.p99, v.p99 || 0)
      o.errRate = Math.max(o.errRate, v.errRate || 0)
      o.saturation = Math.max(o.saturation, v.saturation || 0)
      o.n++
    }
  }
  for (const o of Object.values(out)) o.rps /= Math.max(1, o.n)
  return out
}

const totalRps = (f) => Object.values(f?.nodes || {}).reduce((a, n) => a + (n.rps || 0), 0)

function dedupe(findings) {
  const seen = new Set()
  return findings.filter((f) => {
    const k = `${f.fault}|${f.target || ''}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}
