// The bottom deck: the same engines the CLI runs, in a browser.
//
// There is no second implementation here. Simulate calls `@archsim/core`, Gate
// calls the same Monte-Carlo runner and SLO evaluator the CI job calls, DES
// calls `@archsim/des`. If a verdict differs between this panel and a pull
// request, that is a bug rather than a difference of opinion — which is the
// entire reason the engine was extracted from the app in Phase 0.

import React, { useMemo, useState } from 'react'
import { simulate, capacityReport, costReport, compileFaults, FAULTS, label as sloLabel, telemetryCoverage, telemetryNote, SIGNALS } from '@archsim/core'
import { toSlider, fromSlider, shortRps, STEPS, MIN_RPS, MAX_RPS } from './loadscale.js'
import { Dist } from './Verdict.jsx'
import { rowsWithBaseline } from './useGate.js'
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
      <div className="controls loadrow">
        {/* A slider, because the question people actually ask is "what happens
            if this doubles" and typing a number is a poor way to explore that.
            The box stays for anyone who knows their real peak to the request. */}
        <label className="loadctl">
          <span>Offered load</span>
          <input
            type="range" min="0" max={STEPS} step="1"
            value={toSlider(rps)}
            onChange={(e) => setRps(fromSlider(e.target.value))}
            aria-label="Offered load, requests per second"
          />
          <input
            className="loadnum" type="number" min={MIN_RPS} max={MAX_RPS}
            value={rps}
            onChange={(e) => setRps(Math.max(MIN_RPS, Math.min(MAX_RPS, Number(e.target.value) || MIN_RPS)))}
            title="Type an exact figure — the slider moves in round numbers, this does not."
            aria-label="Offered load in requests per second, exact"
          />
          <span className="loadunit">rps</span>
        </label>
        <label>Scenario
          <select value={scenario || ''} onChange={(e) => setScenario(e.target.value || null)}>
            <option value="">nominal</option>
            {FAULTS.map((f) => <option key={f.id} value={f.id}>{f.icon} {f.name}</option>)}
          </select>
        </label>
        {fx.applied.length > 0 && <span className="note">{FAULTS.find((f) => f.id === scenario)?.hint}</span>}
      </div>

      <div className="stats">
        <Stat label="QPS" value={shortRps(rps)} />
        <Stat label="p50" value={`${sim.p50.toFixed(0)} ms`} />
        <Stat label="p95" value={`${sim.p95.toFixed(0)} ms`} />
        <Stat label="p99" value={`${sim.p99.toFixed(0)} ms`} />
        {/* Success rather than "dropped: 0". The same fact, but the reader does
            not have to invert it, and the failing case still shouts. */}
        <Stat label="success" value={`${(100 - (sim.totalDropped / Math.max(1, rps)) * 100).toFixed(2)}%`}
              warn={sim.totalDropped > 0} />
        <Stat label="availability" value={`${(sim.sysAvail * 100).toFixed(3)}%`} />
        <Stat label="cost" value={`$${money(cost.total)}/mo`} />
      </div>

      <Telemetry ir={ir} />

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

export function GatePanel({ gate, config, variant, comparable }) {
  const { busy, result, base } = gate
  const rows = rowsWithBaseline(result, base)

  if (busy && !result) return <div className="panel"><p className="muted">Sampling {config.runs} worlds across {config.scenarios.length + 1} scenarios…</p></div>
  if (result?.error) return <div className="panel"><p className="risk">{result.error}</p></div>
  if (!rows.length) return <div className="panel"><p className="muted">No SLOs on this design. Add them to <code>.archsim/slo.yaml</code> — a gate with no thresholds has no opinion.</p></div>

  return (
    <div className="panel">
      <div className="controls">
        <span className="note">
          The same Monte-Carlo the CI job runs, on the same seed. A verdict here and a verdict on a pull request
          are the same computation — and the bar is a proportion of sampled worlds, not a point estimate.
          The marker sits at the {config.thresholds.passPct}% pass threshold.
        </span>
      </div>

      <table className="grid">
        <thead>
          <tr>
            <th>SLO</th>
            <th style={{ width: '38%' }}>holds in</th>
            <th>worst scenario</th>
            <th>drives</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.slo.id} className={r.verdict === 'fail' ? 'hot' : ''}>
              <td>{sloLabel(r.slo)}</td>
              <td>
                <Dist holdPct={r.holdPct} verdict={r.verdict} passPct={config.thresholds.passPct}
                      was={comparable && variant === 'pr' ? r.was?.holdPct ?? null : null} />
              </td>
              <td>{r.drivingScenario || '—'}</td>
              <td>{{ pass: 'exit 0', fail: 'exit 1', risk: 'exit 2', skip: '—' }[r.verdict]}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {result.quickFix?.steps?.length > 0 && (
        <div className="fix">
          <strong>Cheapest fix:</strong> {result.quickFix.steps.map((s) => s.describe.replace(/`/g, '')).join(', then ')}
          {' — '}{result.quickFix.costDelta >= 0 ? '+' : '−'}${Math.abs(Math.round(result.quickFix.costDelta)).toLocaleString()}/mo
          {result.quickFix.fullyResolved ? ', which restores every gate.' : ', which improves but does not clear every gate.'}
          {base && (() => {
            const saved = base.mc.cost.total - result.mc.cost.total
            return saved > 0
              ? ` That is ${Math.round((100 * result.quickFix.costDelta) / saved)}% of the $${Math.round(saved).toLocaleString()}/mo this change saves.`
              : null
          })()}
        </div>
      )}

      {result.risks.map((r, i) => <p key={i} className="risk">{r.msg.replace(/`/g, '')}</p>)}
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

/** $117,412 → "117k". A cost row is scanned, not audited. */
function money(n) {
  if (!Number.isFinite(n)) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(Math.round(n))
}

/**
 * What the design can see about itself.
 *
 * Deliberately not a decorative "🔭 traces, metrics, logs" — printed
 * unconditionally that says the same thing about a design with a full
 * observability stack and one with nothing, which is worse than saying nothing.
 * It reads the design, and a signal with no component behind it is dimmed and
 * explains what you will be missing at three in the morning.
 */
function Telemetry({ ir }) {
  const cover = telemetryCoverage(ir)
  return (
    <div className="telemetry">
      <span className="telescope" aria-hidden="true">🔭</span>
      {SIGNALS.map((sig) => {
        const has = cover[sig].length > 0
        return (
          <span key={sig} className={has ? 'sig on' : 'sig off'} title={telemetryNote(sig, cover[sig])}>
            {has ? '●' : '○'} {sig}
          </span>
        )
      })}
      {SIGNALS.every((s) => !cover[s].length) && (
        <span className="note">Nothing here reports on itself — an incident starts with a customer telling you.</span>
      )}
    </div>
  )
}

function Stat({ label, value, warn }) {
  return (
    <div className={`stat${warn ? ' warn' : ''}`}>
      <span className="v">{value}</span>
      <span className="k">{label}</span>
    </div>
  )
}
