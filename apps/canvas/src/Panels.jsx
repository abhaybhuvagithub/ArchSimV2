// The bottom deck: the same engines the CLI runs, in a browser.
//
// There is no second implementation here. Simulate calls `@archsim/core`, Gate
// calls the same Monte-Carlo runner and SLO evaluator the CI job calls, DES
// calls `@archsim/des`. If a verdict differs between this panel and a pull
// request, that is a bug rather than a difference of opinion — which is the
// entire reason the engine was extracted from the app in Phase 0.

import React, { useMemo, useState } from 'react'
import { simulate, capacityReport, costReport, compileFaults, runMonteCarlo, evaluateSLOs, structuralRisks, findCheapestFix, FAULTS, label as sloLabel } from '@archsim/core'
import { runDES, analyzeStarvation, analyzeStorm, analyzeBreakers } from '@archsim/des'
import { emitChanges } from '@archsim/iac'
import { serializeIR, irHash } from '@archsim/ir'

export function SimulatePanel({ ir, rps, setRps, scenario, setScenario }) {
  const { sim, cap, cost, fx } = useMemo(() => {
    const anchor = simulate(ir, rps)
    const fx = compileFaults(scenario ? [{ fault: scenario }] : [], ir, anchor)
    const sim = simulate(ir, rps, { fx })
    return { sim, cap: capacityReport(ir, sim), cost: costReport(ir, sim), fx }
  }, [ir, rps, scenario])

  return (
    <div className="panel">
      <div className="controls">
        <label>Offered load <input type="number" min="1" step="100" value={rps} onChange={(e) => setRps(Math.max(1, Number(e.target.value) || 1))} /> rps</label>
        <label>Scenario
          <select value={scenario || ''} onChange={(e) => setScenario(e.target.value || null)}>
            <option value="">nominal</option>
            {FAULTS.map((f) => <option key={f.id} value={f.id}>{f.icon} {f.name}</option>)}
          </select>
        </label>
        {fx.applied.length > 0 && <span className="note">{FAULTS.find((f) => f.id === scenario)?.hint}</span>}
      </div>

      <div className="stats">
        <Stat label="p50" value={`${sim.p50.toFixed(1)}ms`} />
        <Stat label="p95" value={`${sim.p95.toFixed(1)}ms`} />
        <Stat label="p99" value={`${sim.p99.toFixed(1)}ms`} />
        <Stat label="availability" value={`${(sim.sysAvail * 100).toFixed(3)}%`} />
        <Stat label="dropped" value={`${sim.totalDropped.toFixed(0)} rps`} warn={sim.totalDropped > 0} />
        <Stat label="cost" value={`$${Math.round(cost.total).toLocaleString()}/mo`} />
      </div>

      <table className="grid">
        <thead><tr><th>component</th><th>in</th><th>util</th><th>replicas</th><th>needed</th><th>basis</th></tr></thead>
        <tbody>
          {cap.rows.slice(0, 14).map((r) => (
            <tr key={r.id} className={r.util > 0.8 ? 'hot' : ''}>
              <td>{r.label}</td>
              <td>{Math.round(r.in)}</td>
              <td>{(r.util * 100).toFixed(0)}%</td>
              <td>{r.replicas}</td>
              <td>{r.needed}</td>
              <td className={`prov prov-${r.provenance}`}>{r.provenance}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function GatePanel({ ir, config }) {
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)

  const run = () => {
    setBusy(true)
    // Deferred a tick so the button paints its busy state before the runner
    // takes the thread. 400 runs is fast, not free.
    setTimeout(() => {
      const mc = runMonteCarlo(ir, { runs: config.runs, seed: config.seed, scenarios: config.scenarios })
      const evaluation = evaluateSLOs(ir, mc, { thresholds: config.thresholds })
      const risks = structuralRisks(ir, mc)
      const quickFix = evaluation.ok && !evaluation.risky.length
        ? null
        : findCheapestFix(ir, { mcOpts: { runs: Math.min(config.runs, 120), seed: config.seed, scenarios: config.scenarios }, thresholds: config.thresholds })
      setResult({ mc, evaluation, risks, quickFix })
      setBusy(false)
    }, 10)
  }

  return (
    <div className="panel">
      <div className="controls">
        <button className="primary" onClick={run} disabled={busy}>{busy ? 'sampling worlds…' : `Run the gate (${config.runs} runs, seed ${config.seed})`}</button>
        <span className="note">The same Monte-Carlo the CI job runs. A verdict here and a verdict on a pull request are the same computation.</span>
      </div>

      {!ir.slos?.length && <p className="muted">No SLOs on this IR. Load the example, or add them to <code>.archsim/slo.yaml</code> — a gate with no thresholds has no opinion.</p>}

      {result && (
        <>
          <table className="grid">
            <thead><tr><th>SLO</th><th>holds in</th><th>worst scenario</th><th></th></tr></thead>
            <tbody>
              {result.evaluation.results.map((r) => (
                <tr key={r.slo.id} className={r.verdict}>
                  <td>{sloLabel(r.slo)}</td>
                  <td>{r.holdPct === null ? '—' : `${r.holdPct.toFixed(0)}% of worlds`}</td>
                  <td>{r.drivingScenario || '—'}</td>
                  <td>{{ pass: '✅', fail: '❌', risk: '⚠️', skip: '—' }[r.verdict]}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {result.quickFix?.steps?.length > 0 && (
            <div className="fix">
              <strong>Cheapest fix:</strong> {result.quickFix.steps.map((s) => s.describe.replace(/`/g, '')).join(', then ')}
              {' — '}{result.quickFix.costDelta >= 0 ? '+' : '−'}${Math.abs(Math.round(result.quickFix.costDelta)).toLocaleString()}/mo
              {result.quickFix.fullyResolved ? ', which restores every gate.' : ', which improves but does not clear every gate.'}
            </div>
          )}

          {result.risks.map((r, i) => <p key={i} className="risk">{r.msg.replace(/`/g, '')}</p>)}
        </>
      )}
    </div>
  )
}

export function DesPanel({ ir, rps, scenario }) {
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const [horizon, setHorizon] = useState(30)

  const run = () => {
    setBusy(true)
    setTimeout(() => {
      const fx = compileFaults(scenario ? [{ fault: scenario }] : [], ir, simulate(ir, rps))
      const res = runDES(ir, { workload: { id: 'canvas', arrival: { dist: 'const', rps } }, horizonMs: horizon * 1000, seed: 42, fx })
      setResult({ res, storm: analyzeStorm(res), starvation: analyzeStarvation(res), breakers: analyzeBreakers(res) })
      setBusy(false)
    }, 10)
  }

  return (
    <div className="panel">
      <div className="controls">
        <label>Horizon <input type="number" min="5" max="300" value={horizon} onChange={(e) => setHorizon(Number(e.target.value) || 30)} /> s</label>
        <button className="primary" onClick={run} disabled={busy}>{busy ? 'running events…' : 'Run discrete-event trace'}</button>
        <span className="note">Time-resolved: storms that feed back, breakers that flap, workers held across a slow dependency.</span>
      </div>

      {result && (
        <>
          <div className="stats">
            <Stat label="served" value={`${result.res.throughputRps.toFixed(0)} rps`} />
            <Stat label="p99" value={`${result.res.p99_ms.toFixed(0)}ms`} />
            <Stat label="errors" value={`${(result.res.errorRate * 100).toFixed(2)}%`} warn={result.res.errorRate > 0.01} />
            <Stat label="events" value={result.res.events.toLocaleString()} />
          </div>

          <Timeline timeline={result.res.timeline} />

          <table className="grid">
            <thead><tr><th>component</th><th>workers</th><th>util</th><th>held on downstream</th><th>queue</th><th>p99</th><th>shed</th></tr></thead>
            <tbody>
              {Object.entries(result.res.nodes).sort((a, b) => b[1].utilization - a[1].utilization).slice(0, 12).map(([id, n]) => (
                <tr key={id} className={n.utilization > 0.85 ? 'hot' : ''}>
                  <td>{n.label}</td><td>{n.workers}</td><td>{(n.utilization * 100).toFixed(0)}%</td>
                  <td>{(n.heldFraction * 100).toFixed(0)}%</td><td>{n.avgQueue.toFixed(0)}</td>
                  <td>{n.latency.p99.toFixed(0)}ms</td><td>{n.shed}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <p className="finding">{result.starvation.verdict}</p>
          <p className="finding">{result.storm.verdict}</p>
          <p className="finding">{result.breakers.verdict}</p>
          {result.res.invariants.length > 0 && (
            <p className="risk">
              {result.res.invariants.length} invariant violation(s): Little&apos;s law did not hold inside the engine,
              so treat these numbers as suspect rather than precise.
            </p>
          )}
        </>
      )}
    </div>
  )
}

function Timeline({ timeline }) {
  if (!timeline?.length) return null
  const w = 640, h = 90
  const maxQ = Math.max(1, ...timeline.map((t) => Math.max(...Object.values(t.nodes).map((n) => n.queue))))
  const points = timeline.map((t, i) => {
    const q = Math.max(...Object.values(t.nodes).map((n) => n.queue))
    return `${(i / Math.max(1, timeline.length - 1)) * w},${h - (q / maxQ) * h}`
  }).join(' ')
  return (
    <svg className="timeline" viewBox={`0 0 ${w} ${h}`} role="img" aria-label="Worst queue depth over time">
      <polyline points={points} fill="none" />
      <text x="4" y="12">worst queue depth over the run (peak {maxQ})</text>
    </svg>
  )
}

export function TwinPanel({ twin, frames, ghosts, drift, onCalibrate, onScrub, scrubIndex, incident }) {
  return (
    <div className="panel">
      <div className="controls">
        <span className="note">
          Twin Lite: the canvas pulls from your own Prometheus or Datadog on a tick. No ArchSim server, no data custody.
          This session runs a deterministic synthetic source so the whole path is exercisable without a cluster.
        </span>
      </div>

      {drift.length > 0 && (
        <div className="drift-list">
          <h4>Where the model is lying</h4>
          {drift.map((d) => (
            <div key={d.nodeId} className="drift-row">
              <span>{d.msg.replace(/`/g, '')}</span>
              <button onClick={() => onCalibrate(d.nodeId)}>Calibrate</button>
            </div>
          ))}
        </div>
      )}

      {ghosts.length > 0 && (
        <div className="ghost-list">
          <h4>Services production knows about and the diagram does not</h4>
          {ghosts.map((g) => <div key={g.name}>👻 <strong>{g.name}</strong> — {Math.round(g.rps)} rps, p99 {Math.round(g.p99)}ms</div>)}
        </div>
      )}

      {incident && (
        <div className="incident">
          <h4>Incident replay</h4>
          <input type="range" min="0" max={Math.max(0, incident.frames.length - 1)} value={scrubIndex}
                 onChange={(e) => onScrub(Number(e.target.value))} />
          <span className="ts">{new Date(incident.frames[scrubIndex]?.ts || 0).toISOString().slice(11, 19)} UTC</span>
          <pre className="yaml">{incident.repro.yaml}</pre>
          <p className="note">{incident.repro.note} Paste this into <code>.archsim/slo.yaml</code> and the gate enforces it on every future pull request — the postmortem becomes a regression test.</p>
        </div>
      )}

      {!drift.length && !ghosts.length && <p className="muted">No drift and no unmapped services in the frames collected so far.</p>}
    </div>
  )
}

export function CodePanel({ baseIR, ir, sources }) {
  const out = useMemo(() => {
    try { return emitChanges(baseIR, ir, sources) } catch (e) { return { error: e.message, patches: [], generated: [], removals: [], unpatchable: [] } }
  }, [baseIR, ir, sources])

  return (
    <div className="panel">
      <div className="controls">
        <span className="note">
          Patch, don&apos;t regenerate. Only the bytes of a changed attribute move; comments, ordering and everything
          ArchSim did not model are left exactly as they were.
        </span>
      </div>

      {out.error && <p className="risk">{out.error}</p>}
      {!out.patches.length && !out.generated.length && !out.removals.length && !out.unpatchable.length && (
        <p className="muted">No changes to write. Edit a replica count in the inspector to see the patch it produces.</p>
      )}

      {out.patches.map((p) => (
        <div key={p.file}>
          <h4>{p.file}</h4>
          {p.edits.map((e, i) => <div key={i} className="edit">{e.why}</div>)}
          <pre className="diff">{diffPreview(p.before, p.after)}</pre>
        </div>
      ))}

      {out.generated.map((g) => (
        <div key={g.nodeId}>
          <h4>new — {g.file}</h4>
          <pre className="diff">{g.text}</pre>
        </div>
      ))}

      {out.removals.map((r) => (
        <p key={r.nodeId} className="risk">Removal proposal: {r.proposal}. {r.note}</p>
      ))}

      {out.unpatchable.map((u, i) => <p key={i} className="risk">{u.reason.replace(/`/g, '')}</p>)}

      <details>
        <summary>IR ({irHash(ir)})</summary>
        <pre className="diff">{serializeIR(ir).slice(0, 4000)}</pre>
      </details>
    </div>
  )
}

function diffPreview(before, after) {
  const a = before.split('\n'), b = after.split('\n')
  const out = []
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue
    for (let j = Math.max(0, i - 2); j < i; j++) out.push(`  ${a[j]}`)
    out.push(`- ${a[i] ?? ''}`)
    out.push(`+ ${b[i] ?? ''}`)
    for (let j = i + 1; j < Math.min(a.length, i + 3); j++) out.push(`  ${a[j]}`)
    out.push('')
  }
  return out.join('\n') || '(no textual change)'
}

function Stat({ label, value, warn }) {
  return (
    <div className={`stat${warn ? ' warn' : ''}`}>
      <span className="v">{value}</span>
      <span className="k">{label}</span>
    </div>
  )
}
