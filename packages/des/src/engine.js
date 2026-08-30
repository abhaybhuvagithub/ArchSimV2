// The discrete-event engine.
//
// Position: a fidelity ladder, not a replacement. The analytic engine answers
// steady-state questions in microseconds and stays the interactive and
// Monte-Carlo workhorse. This one answers the *time-dependent* questions the
// steady-state model cannot express — storms that feed back, breakers that flap,
// queues that drain after a burst, thread pools strangled by a slow dependency.
// Same IR in; a trace out.
//
// Node model: G/G/c with a bounded queue. `c` workers, FIFO queue bounded at
// `K`, service time drawn from the node's latency distribution. When the queue
// is full the node sheds — backpressure made visible rather than assumed away.
//
// The one mechanism worth reading the code for is `hold_worker`: on a *sync*
// call the worker stays occupied for the whole downstream wait. That single
// line is the thread-starvation channel (§5.6), and it is why a node can
// saturate at unchanged arrival rate and healthy CPU.

import { EventHeap } from './heap.js'
import { TDigest } from './tdigest.js'
import { rng, lognormal, exponential } from '@archsim/core'
import { effectiveCap, isSourceNode } from '@archsim/core'

const ARRIVAL = 'ARRIVAL'
const COMPLETE = 'COMPLETE'
const CALL_RESULT = 'CALL_RESULT'
const TIMEOUT = 'TIMEOUT'
const PROBE = 'PROBE'
const SOURCE = 'SOURCE'
const FRAME = 'FRAME'

export const OK = 'ok'
export const SHED = 'shed'
export const TIMED_OUT = 'timeout'
export const BREAKER_OPEN = 'breaker'
export const FAILED = 'failed'

/**
 * @typedef {object} DesOpts
 * @property {any}    [workload]  workload: arrival distribution and rps
 * @property {number} [horizonMs] simulated milliseconds (default 60_000)
 * @property {number} [seed]      integer seed (default 42)
 * @property {any}    [fx]        compiled faults from the core package
 * @property {number} [frameMs]   telemetry frame interval (default 1000)
 * @property {number} [maxEvents] hard stop, so a pathological design cannot hang the process
 * @property {'derive'|'declared'} [concurrencyMode]
 *
 * @param {any} ir ArchIR
 * @param {DesOpts} [opts]
 *
 * On concurrencyMode:
 *   derive   — c = replicas × capPerReplica × serviceTime, i.e. Little's law at
 *              the capacity ceiling. This is what makes the DES and the analytic
 *              engine agree below the knee, which is a stated validation gate.
 *   declared — use the IR's `capacity.concurrency` as written. Where that
 *              implies a different ceiling than `capPerReplica`, the run reports
 *              the discrepancy instead of quietly picking one.
 */
export function runDES(ir, opts = {}) {
  const horizon = opts.horizonMs ?? 60000
  const frameMs = opts.frameMs ?? 1000
  const r = rng(opts.seed ?? 42)
  const fx = opts.fx || { node: {}, cut: new Set(), rpsMul: 1 }
  const workload = opts.workload || ir.workloads?.[0] || { id: 'default', arrival: { dist: 'const', rps: 100 } }

  // Baseline hold time per node: its own service time plus the time its workers
  // spend *waiting* on synchronous downstream calls at nominal speed. This is
  // what a capacity figure implicitly assumes — an app rated at 2,000 rps was
  // sized knowing it calls a database — so it is what worker count must be
  // derived from. Deriving `c` from own service time alone would declare every
  // proxy starved on the first tick, which is a bug wearing a finding's clothes.
  //
  // Faults are deliberately excluded: the pool was sized before the incident.
  // Sizing it against the degraded system would let the design re-provision
  // itself in response to the fault, which is the one thing real infrastructure
  // cannot do at the moment it matters.
  const baselineHold = holdTimeBaseline(ir)

  const nodes = new Map()
  const discrepancies = []
  for (const n of ir.nodes) {
    const cap = effectiveCap(n)
    const f = fx.node[n.id] || {}
    const serviceMs = Math.max(0.001, (cap.latencyMs?.p50 ?? 10) * (f.latMul ?? 1))
    const meanService = meanServiceMs(serviceMs, cap.latencyMs?.dist || 'lognormal', cap.latencyMs?.cv ?? 0.5)
    const ceiling = Math.max(1e-9, cap.capPerReplica * cap.replicas * (f.capMul ?? 1))
    // Little's law at the capacity ceiling: c = λ_max × E[S]. This is what makes
    // the two engines agree below the knee, which is a validation gate, not a
    // coincidence we hope for.
    const derived = Math.max(1, Math.round((ceiling * (baselineHold.get(n.id) ?? meanService)) / 1000))
    const declared = Math.max(1, (cap.concurrency || derived) * Math.max(1, cap.replicas))
    const c = opts.concurrencyMode === 'declared' ? declared : derived
    if (opts.concurrencyMode === 'declared' && Math.abs(declared - derived) / derived > 0.5 && !isSourceNode(n)) {
      discrepancies.push({
        nodeId: n.id, label: n.label, declaredConcurrency: declared, impliedCeilingRps: (declared * 1000) / serviceMs,
        statedCapacityRps: ceiling,
        msg: `\`${n.label}\` declares ${declared} workers at ${serviceMs.toFixed(1)}ms service time, which is a ceiling of ${Math.round((declared * 1000) / serviceMs)} rps — but its capacity figure says ${Math.round(ceiling)} rps. One of the two is wrong.`,
      })
    }
    nodes.set(n.id, {
      node: n, cap, source: isSourceNode(n),
      c, K: Math.max(0, (cap.queueDepth || 0) * Math.max(1, cap.replicas)),
      serviceMs, dist: cap.latencyMs?.dist || 'lognormal', cv: cap.latencyMs?.cv ?? 0.5,
      drop: f.drop ?? 0, dup: f.dup ?? 0,
      inflight: 0, held: 0, queue: [],
      m: newNodeMetrics(),
      latency: new TDigest(),
    })
  }

  const outEdges = new Map()
  const edgeState = new Map()
  for (const e of ir.edges) {
    if (fx.cut?.has(e.id)) continue
    if (!outEdges.has(e.from)) outEdges.set(e.from, [])
    outEdges.get(e.from).push(e)
    edgeState.set(e.id, {
      edge: e,
      breaker: e.breaker ? { state: 'closed', window: [], openedAt: -1, probesOut: 0 } : null,
      budget: { successes: 0, retries: 0 },
      m: { calls: 0, errors: 0, timeouts: 0, retries: 0, shortCircuited: 0, opens: 0, closes: 0 },
      latency: new TDigest(),
    })
  }

  const heap = new EventHeap()
  let now = 0
  const global = { completed: 0, failed: 0, shed: 0, arrived: 0 }
  const latency = new TDigest()
  const frames = []
  const timeline = []
  let visitSeq = 0
  let reqSeq = 0

  const sources = ir.nodes.filter((n) => isSourceNode(n))
  const entryFor = (srcId) => (outEdges.get(srcId) || []).map((e) => e.to)

  // ── scheduling helpers ────────────────────────────────────────────────────
  const at = (t, ev) => heap.push(t, ev)

  const sampleService = (st) => {
    if (st.dist === 'const') return st.serviceMs
    // The IR states a *median*. An exponential's mean is its median over ln 2;
    // a lognormal's is its median times sqrt(1+cv²). Getting this conversion
    // wrong is a silent 44% capacity error, so it lives in one place.
    if (st.dist === 'exponential') return exponential(r, st.serviceMs / Math.LN2)
    return lognormal(r, st.serviceMs, st.cv)
  }

  const rateAt = (t) => arrivalRate(workload, t, horizon) * (fx.rpsMul || 1)

  // ── admission ─────────────────────────────────────────────────────────────
  function arrive(visit) {
    const st = nodes.get(visit.nodeId)
    if (!st) return finishVisit(visit, FAILED)
    st.m.arrived++
    if (st.drop > 0 && r() < st.drop) { st.m.shed++; return finishVisit(visit, FAILED) }
    if (st.inflight + st.held < st.c) {
      startService(visit, st)
    } else if (st.queue.length < st.K) {
      visit.queuedAt = now
      st.queue.push(visit)
    } else {
      // Backpressure made visible: the request is rejected here rather than
      // waiting for a timeout somewhere upstream. This is the good failure mode.
      st.m.shed++
      finishVisit(visit, SHED)
    }
  }

  function startService(visit, st) {
    st.inflight++
    visit.startedAt = now
    at(now + sampleService(st), { kind: COMPLETE, visit })
  }

  function drain(st) {
    while (st.queue.length && st.inflight + st.held < st.c) {
      const next = st.queue.shift()
      next.queueWaitMs = now - next.queuedAt
      startService(next, st)
    }
  }

  // ── downstream calls ──────────────────────────────────────────────────────
  function onComplete(visit) {
    const st = nodes.get(visit.nodeId)
    st.inflight--
    const downstream = (outEdges.get(visit.nodeId) || [])
    const sync = downstream.filter((e) => e.callSemantics !== 'async')
    const async = downstream.filter((e) => e.callSemantics === 'async')

    for (const e of async) issueCall(e, visit, null)   // fire and forget: no worker held

    if (!sync.length) { drain(st); return finishVisit(visit, OK) }

    // The worker is HELD across sync calls. Everything in §5.6 follows from here.
    st.held++
    visit.join = {
      pending: 0, failed: 0,
      sequential: sync.some((e) => e.callSemantics === 'fanout-sequential'),
      queue: sync.slice(),
    }
    if (visit.join.sequential) {
      const first = visit.join.queue.shift()
      visit.join.pending = 1
      issueCall(first, visit, visit.join)
    } else {
      visit.join.pending = sync.length
      for (const e of sync) issueCall(e, visit, visit.join)
    }
  }

  function issueCall(edge, parentVisit, join, attempt = 0) {
    const es = edgeState.get(edge.id)
    if (!es) return
    es.m.calls++

    // Circuit breaker: an open breaker fails fast, at zero latency, which
    // SHRINKS the caller's hold time. The breaker is a latency firewall — the
    // DES is where that stops being a slogan and becomes a measured effect.
    if (es.breaker && es.breaker.state === 'open') {
      es.m.shortCircuited++
      es.m.errors++
      return at(now, { kind: CALL_RESULT, call: { edge, parentVisit, join, attempt, es, startedAt: now, settled: false }, status: BREAKER_OPEN })
    }

    const call = { id: ++visitSeq, edge, parentVisit, join, attempt, es, startedAt: now, settled: false }
    const visit = {
      id: ++visitSeq, nodeId: edge.to, req: parentVisit.req, call,
      arrivedAt: now, queuedAt: now, startedAt: -1,
    }
    call.visit = visit
    at(now, { kind: ARRIVAL, visit })
    if (edge.timeoutMs) at(now + edge.timeoutMs, { kind: TIMEOUT, call })
  }

  function onCallResult(call, status) {
    if (call.settled) return
    call.settled = true
    const es = call.es
    const ok = status === OK
    const latencyMs = now - call.startedAt
    if (ok) { es.budget.successes++; es.latency.push(latencyMs) } else es.m.errors++
    recordBreaker(es, ok)

    // Retry, if policy and budget allow. This is where storms are born, and
    // where a budget is the difference between recovery and amplification.
    const policy = call.edge.retry
    if (!ok && policy?.max > 0 && call.attempt < policy.max && retryAllowed(es, policy)) {
      es.budget.retries++
      es.m.retries++
      const delay = backoff(policy, call.attempt, r)
      return at(now + delay, { kind: 'RETRY', call })
    }

    const join = call.join
    if (!join) return // async call: nobody is waiting
    if (!ok) join.failed++
    join.pending--
    if (join.sequential && ok && join.queue.length) {
      join.pending = 1
      return issueCall(join.queue.shift(), call.parentVisit, join)
    }
    if (join.pending <= 0) {
      const parent = call.parentVisit
      const st = nodes.get(parent.nodeId)
      st.held--
      drain(st)
      finishVisit(parent, join.failed > 0 ? FAILED : OK)
    }
  }

  function finishVisit(visit, status) {
    const st = nodes.get(visit.nodeId)
    if (st) {
      if (status === OK) st.m.completed++
      else st.m.errors++
      const total = now - visit.arrivedAt
      st.latency.push(total)
      st.m.sojournSum += total
      st.m.sojournCount++
    }
    if (visit.call) return onCallResult(visit.call, status)
    // top of the tree: the user's request is done
    if (status === OK) { global.completed++; latency.push(now - visit.req.t0) }
    else if (status === SHED) global.shed++
    else global.failed++
  }

  // ── breaker ───────────────────────────────────────────────────────────────
  function recordBreaker(es, ok) {
    const b = es.breaker
    if (!b) return
    const p = es.edge.breaker
    b.window.push({ t: now, ok })
    const cutoff = now - (p.windowSec ?? 10) * 1000
    while (b.window.length && b.window[0].t < cutoff) b.window.shift()
    if (b.state === 'halfOpen') {
      b.state = ok ? 'closed' : 'open'
      if (ok) { es.m.closes++; b.window = [] } else { es.m.opens++; b.openedAt = now; at(now + (p.cooloffMs ?? 5000), { kind: PROBE, es }) }
      return
    }
    if (b.state !== 'closed') return
    const n = b.window.length
    if (n < (p.minSamples ?? 20)) return
    const errRate = b.window.filter((x) => !x.ok).length / n
    if (errRate > (p.errThreshold ?? 0.5)) {
      b.state = 'open'
      b.openedAt = now
      es.m.opens++
      at(now + (p.cooloffMs ?? 5000), { kind: PROBE, es })
    }
  }

  function retryAllowed(es, policy) {
    const budgetPct = policy.budgetPct ?? 0
    if (budgetPct <= 0) return true // unbudgeted: the storm is allowed to happen, and the trace shows it
    // Retries may not exceed budgetPct of successes over the run. The small
    // constant keeps a cold start from deadlocking on zero successes.
    return es.budget.retries < 10 + (budgetPct / 100) * es.budget.successes
  }

  // ── source arrivals ───────────────────────────────────────────────────────
  const entries = new Map(sources.map((s) => [s.id, entryFor(s.id)]))
  for (const s of sources) if (entries.get(s.id).length) at(0, { kind: SOURCE, srcId: s.id })
  at(frameMs, { kind: FRAME })

  // ── the loop ──────────────────────────────────────────────────────────────
  let guard = 0
  const maxEvents = opts.maxEvents ?? 8_000_000
  while (heap.size && guard < maxEvents) {
    const top = heap.pop()
    if (top.t > horizon) break
    accrue(nodes, top.t - now)
    now = top.t
    guard++
    const ev = top.event
    switch (ev.kind) {
      case SOURCE: {
        const targets = entries.get(ev.srcId)
        const lambda = rateAt(now) / Math.max(1, sources.length)
        if (lambda > 0) {
          const gap = exponential(r, 1000 / lambda)
          at(now + gap, { kind: SOURCE, srcId: ev.srcId })
          const req = { id: ++reqSeq, t0: now }
          global.arrived++
          const target = targets[Math.floor(r() * targets.length)]
          const st = nodes.get(target)
          const copies = 1 + (st?.dup ? (r() < st.dup ? 1 : 0) : 0)
          for (let i = 0; i < copies; i++) {
            at(now, { kind: ARRIVAL, visit: { id: ++visitSeq, nodeId: target, req, call: null, arrivedAt: now, queuedAt: now, startedAt: -1 } })
          }
        }
        break
      }
      case ARRIVAL: arrive(ev.visit); break
      case COMPLETE: onComplete(ev.visit); break
      case CALL_RESULT: onCallResult(ev.call, ev.status); break
      case 'RETRY':
        issueCall(ev.call.edge, ev.call.parentVisit, ev.call.join, ev.call.attempt + 1)
        break
      case TIMEOUT: {
        const c = ev.call
        if (c.settled) break
        c.es.m.timeouts++
        onCallResult(c, TIMED_OUT)
        break
      }
      case PROBE: {
        const b = ev.es.breaker
        if (b && b.state === 'open') b.state = 'halfOpen'
        break
      }
      case FRAME: {
        frames.push(snapshot(now, nodes, edgeState, frameMs))
        timeline.push(instant(now, nodes, edgeState, global))
        if (now + frameMs <= horizon) at(now + frameMs, { kind: FRAME })
        break
      }
      default: break
    }
  }
  accrue(nodes, Math.max(0, Math.min(horizon, now) - now))

  return buildResult({ ir, now: Math.max(now, 1), nodes, edgeState, global, latency, frames, timeline, discrepancies, workload, opts, guard })
}

// ── metrics ─────────────────────────────────────────────────────────────────

function newNodeMetrics() {
  return { arrived: 0, completed: 0, errors: 0, shed: 0, busyIntegral: 0, queueIntegral: 0, heldIntegral: 0, sojournSum: 0, sojournCount: 0 }
}

function accrue(nodes, dt) {
  if (dt <= 0) return
  for (const st of nodes.values()) {
    st.m.busyIntegral += (st.inflight + st.held) * dt
    st.m.queueIntegral += st.queue.length * dt
    st.m.heldIntegral += st.held * dt
  }
}

/** A DES frame is shaped exactly like a telemetry frame from the twin, so a
 *  replayed incident and a simulated one render through the same code path. */
function snapshot(ts, nodes, edgeState, frameMs) {
  const nodeFrame = {}
  const dt = Math.max(1, frameMs) / 1000
  for (const [id, st] of nodes) {
    if (st.source) continue
    const done = st.m.completed - (st.lastCompleted || 0)
    st.lastCompleted = st.m.completed
    nodeFrame[id] = {
      rps: done / dt, p50: st.latency.quantile(50), p99: st.latency.quantile(99),
      errRate: st.m.arrived ? st.m.errors / st.m.arrived : 0,
      queueDepth: st.queue.length, inflight: st.inflight + st.held,
      saturation: st.c ? (st.inflight + st.held) / st.c : 0,
    }
  }
  const edgeFrame = {}
  for (const [id, es] of edgeState) {
    const calls = es.m.calls - (es.lastCalls || 0)
    es.lastCalls = es.m.calls
    edgeFrame[id] = { rps: calls / dt, p99: es.latency.quantile(99), errRate: es.m.calls ? es.m.errors / es.m.calls : 0, breaker: es.breaker?.state || null }
  }
  return { ts, nodes: nodeFrame, edges: edgeFrame }
}

function instant(ts, nodes, edgeState, global) {
  const rows = {}
  for (const [id, st] of nodes) {
    if (st.source) continue
    rows[id] = { inflight: st.inflight + st.held, queue: st.queue.length, shed: st.m.shed, errors: st.m.errors, completed: st.m.completed }
  }
  const breakers = {}
  for (const [id, es] of edgeState) if (es.breaker) breakers[id] = es.breaker.state
  return { ts, nodes: rows, breakers, completed: global.completed, failed: global.failed, shed: global.shed }
}

function buildResult({ ir, now, nodes, edgeState, global, latency, frames, timeline, discrepancies, workload, opts, guard }) {
  const seconds = now / 1000
  const perNode = {}
  const invariants = []
  for (const [id, st] of nodes) {
    if (st.source) continue
    const utilization = st.c ? st.m.busyIntegral / (st.c * now) : 0
    const L = st.m.busyIntegral / now + st.m.queueIntegral / now
    const lambdaEff = st.m.sojournCount / seconds
    const W = st.m.sojournCount ? st.m.sojournSum / st.m.sojournCount / 1000 : 0
    perNode[id] = {
      label: st.node.label, kind: st.node.kind,
      workers: st.c, queueLimit: st.K,
      arrived: st.m.arrived, completed: st.m.completed, errors: st.m.errors, shed: st.m.shed,
      throughputRps: st.m.completed / seconds,
      utilization,
      avgQueue: st.m.queueIntegral / now,
      avgHeldWorkers: st.m.heldIntegral / now,
      heldFraction: st.m.busyIntegral > 0 ? st.m.heldIntegral / st.m.busyIntegral : 0,
      latency: st.latency.summary(),
      little: { L, lambdaEff, W, LW: lambdaEff * W },
    }
    // Little's law is not a nicety here: it is a self-check on the engine. If
    // L ≠ λW beyond tolerance, the run is wrong and the report says so rather
    // than presenting a confident p99 built on a broken loop.
    if (st.m.sojournCount > 200) {
      const rel = Math.abs(L - lambdaEff * W) / Math.max(1e-9, L)
      if (rel > 0.15) invariants.push({ nodeId: id, label: st.node.label, law: 'little', L, LW: lambdaEff * W, relErr: rel })
    }
  }

  const perEdge = {}
  for (const [id, es] of edgeState) {
    perEdge[id] = {
      from: es.edge.from, to: es.edge.to,
      calls: es.m.calls, errors: es.m.errors, timeouts: es.m.timeouts, retries: es.m.retries,
      shortCircuited: es.m.shortCircuited, breakerOpens: es.m.opens, breakerCloses: es.m.closes,
      breakerState: es.breaker?.state || null,
      errRate: es.m.calls ? es.m.errors / es.m.calls : 0,
      amplification: es.m.calls > 0 ? es.m.calls / Math.max(1, es.m.calls - es.m.retries) : 1,
      latency: es.latency.summary(),
    }
  }

  const answered = global.completed + global.failed + global.shed
  return {
    engine: 'des',
    horizonMs: now,
    events: guard,
    workload: workload.id,
    seed: opts.seed ?? 42,
    offeredRps: global.arrived / seconds,
    throughputRps: global.completed / seconds,
    errorRate: answered ? (global.failed + global.shed) / answered : 0,
    shedRate: answered ? global.shed / answered : 0,
    latency: latency.summary(),
    p50_ms: latency.quantile(50),
    p95_ms: latency.quantile(95),
    p99_ms: latency.quantile(99),
    nodes: perNode,
    edges: perEdge,
    frames,
    timeline,
    invariants,
    discrepancies,
  }
}

/** λ(t) for the declared workload. */
/**
 * E[hold] per node at nominal speed, from the call graph:
 *
 *   hold(n) = E[S_n] + (sync downstream: max for parallel fan-out, sum for
 *                       sequential; async calls are not waited on)
 *
 * A cycle contributes its own service time once and stops, because a model that
 * recurses forever on a retry loop is not a model.
 */
export function holdTimeBaseline(ir, fx = { node: {} }) {
  const byId = new Map(ir.nodes.map((n) => [n.id, n]))
  const out = new Map()
  for (const e of ir.edges) {
    if (fx.cut?.has(e.id)) continue
    if (!out.has(e.from)) out.set(e.from, [])
    out.get(e.from).push(e)
  }
  const memo = new Map()
  const visit = (id, seen) => {
    if (memo.has(id)) return memo.get(id)
    const n = byId.get(id)
    if (!n) return 0
    const cap = effectiveCap(n)
    const f = fx.node?.[id] || {}
    const own = isSourceNode(n) ? 0 : meanServiceMs((cap.latencyMs?.p50 ?? 10) * (f.latMul ?? 1), cap.latencyMs?.dist || 'lognormal', cap.latencyMs?.cv ?? 0.5)
    if (seen.has(id)) return own
    seen.add(id)
    const sync = (out.get(id) || []).filter((e) => e.callSemantics !== 'async')
    let wait = 0
    if (sync.length) {
      const child = sync.map((e) => visit(e.to, seen))
      wait = sync.some((e) => e.callSemantics === 'fanout-sequential')
        ? child.reduce((a, b) => a + b, 0)
        : Math.max(...child)
    }
    seen.delete(id)
    const total = own + wait
    memo.set(id, total)
    return total
  }
  for (const n of ir.nodes) out.set(n.id, out.get(n.id) || [])
  for (const n of ir.nodes) memo.set(n.id, visit(n.id, new Set()))
  return memo
}

/** Mean service time from a stated median, per distribution. */
export function meanServiceMs(p50, dist, cv) {
  if (dist === 'const') return p50
  if (dist === 'exponential') return p50 / Math.LN2
  return p50 * Math.sqrt(1 + (cv ?? 0.5) ** 2)
}

export function arrivalRate(workload, t, horizon) {
  const a = workload.arrival || { dist: 'const', rps: 100 }
  switch (a.dist) {
    case 'diurnal': {
      const peak = a.params?.peakFactor ?? 3
      const period = a.params?.periodMs ?? horizon
      const phase = (t % period) / period
      const shape = 0.5 + 0.5 * Math.sin(2 * Math.PI * (phase - 0.25))
      return a.rps * (1 + (peak - 1) * Math.pow(shape, 3))
    }
    case 'spike': {
      const start = a.params?.atMs ?? horizon * 0.4
      const dur = a.params?.durationMs ?? horizon * 0.15
      const factor = a.params?.factor ?? 5
      return t >= start && t < start + dur ? a.rps * factor : a.rps
    }
    default: return a.rps
  }
}

/** Full-jitter exponential backoff is the default because synchronised retries
 *  produce visible combs in the trace without it. */
export function backoff(policy, attempt, r) {
  const base = policy.backoffMs ?? 50
  const ceil = base * Math.pow(2, attempt)
  if (policy.jitter === 'none') return ceil
  if (policy.jitter === 'equal') return ceil / 2 + r() * (ceil / 2)
  return r() * ceil
}
