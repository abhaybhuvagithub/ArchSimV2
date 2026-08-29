// ArchSim v2 studio.
//
// One IR, three views: the canvas you are looking at, the infrastructure code it
// came from, and production as the twin sees it. Nothing here owns the system —
// the IR does, and each of the three is a projection with a way back.

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { normalizeIR, validateIR, irHash, parseIR } from '@archsim/ir'
import { kinds, capacityFor } from '@archsim/core'
import { planJsonToIR, hclToIR, k8sToIR, k8sObjects, parseYamlDocs } from '@archsim/iac'
import { Twin, syntheticSource, reproduceInSimulator } from '@archsim/twin'
import Canvas from './Canvas.jsx'
import Inspector from './Inspector.jsx'
import { SimulatePanel, GatePanel, DesPanel, TwinPanel, CodePanel } from './Panels.jsx'
import { autoLayout } from './layout.js'
import { EXAMPLE_PLAN, EXAMPLE_PLAN_PR, EXAMPLE_HCL, EXAMPLE_K8S, EXAMPLE_SLOS } from './examples.js'
import Verdict from './Verdict.jsx'
import { useGate } from './useGate.js'

const TABS = ['Simulate', 'Gate', 'Chaos (DES)', 'Twin', 'Code']

const GATE_CONFIG = { runs: 200, seed: 42, thresholds: { passPct: 95, riskPct: 80 }, scenarios: EXAMPLE_SLOS.scenarios }

export default function App() {
  // The studio opens on a worked example with two versions of the same estate —
  // `main` and a pull request that shrinks it — because the gate's argument only
  // lands when you can see a verdict move.
  const [variants] = useState(() => ({ main: loadPlan(EXAMPLE_PLAN), pr: loadPlan(EXAMPLE_PLAN_PR) }))
  const [variant, setVariant] = useState('pr')
  const [comparable, setComparable] = useState(true)
  const [ir, setIr] = useState(() => variants.pr)
  const [baseIR, setBaseIR] = useState(() => variants.pr)
  const [sources, setSources] = useState(() => [{ path: 'main.tf', text: EXAMPLE_HCL }])
  const gate = useGate(ir, GATE_CONFIG, comparable && variant === 'pr' ? variants.main : null)
  const [selected, setSelected] = useState(null)
  const [tab, setTab] = useState('Simulate')
  const [rps, setRps] = useState(4000)
  const [scenario, setScenario] = useState(null)
  const [importErr, setImportErr] = useState(null)

  // ── the twin ──────────────────────────────────────────────────────────────
  const [twin, setTwin] = useState(null)
  const [frame, setFrame] = useState(null)
  const [ghosts, setGhosts] = useState([])
  const [drift, setDrift] = useState([])
  const [incident, setIncident] = useState(null)
  const [scrubIndex, setScrubIndex] = useState(0)

  useEffect(() => {
    if (!twin) return
    const off = twin.onFrame((f) => {
      if (f) setFrame(f)
      setGhosts(twin.ghosts)
      setDrift(twin.drift())
    })
    return off
  }, [twin])

  const connectTwin = useCallback(async () => {
    const t0 = Date.now() - 600000
    const src = syntheticSource(ir, { seed: 7, rps, incidentAt: t0 + 300000 })
    const t = new Twin(ir, src, { tickMs: 4000 })
    for (let i = 0; i < 10; i++) await t.tick(t0 + i * 5000)     // warm the buffer
    const window = await t.loadRange(t0 + 280000, t0 + 520000, 10000)
    setIncident({ frames: window, repro: reproduceInSimulator(ir, window, { id: 'incident-replay', baselineFrames: t.buffer.frames }) })
    setScrubIndex(0)
    t.start()
    setTwin(t)
    setFrame(t.buffer.latest)
    setGhosts(t.ghosts)
    setDrift(t.drift())
    setTab('Twin')
  }, [ir, rps])

  useEffect(() => () => twin?.stop(), [twin])

  // ── IR editing ────────────────────────────────────────────────────────────
  const update = useCallback((next) => setIr(normalizeIR(next)), [])

  const onNodeChange = useCallback((node) => {
    update({ ...ir, nodes: ir.nodes.map((n) => (n.id === node.id ? node : n)) })
  }, [ir, update])

  const onMove = useCallback((id, layout) => {
    setIr((cur) => ({ ...cur, nodes: cur.nodes.map((n) => (n.id === id ? { ...n, layout } : n)) }))
  }, [])

  const onDelete = useCallback((id) => {
    setSelected(null)
    update({ ...ir, nodes: ir.nodes.filter((n) => n.id !== id), edges: ir.edges.filter((e) => e.from !== id && e.to !== id) })
  }, [ir, update])

  const onConnect = useCallback((from, to) => {
    if (ir.edges.some((e) => e.from === from && e.to === to)) return
    update({ ...ir, edges: [...ir.edges, { id: `${from}->${to}`, from, to, callSemantics: 'sync', confidence: 'high', attrs: { reason: 'drawn on the canvas' } }] })
  }, [ir, update])

  const addNode = useCallback((kind) => {
    const id = `canvas-${Date.now().toString(36)}`
    update({
      ...ir,
      nodes: [...ir.nodes, {
        id, kind, label: kind, capacity: { ...capacityFor(kind), replicas: 2 },
        bindings: [], attrs: {}, layout: { x: 60, y: 60 },
      }],
    })
    setSelected(id)
  }, [ir, update])

  const onCalibrate = useCallback((nodeId) => {
    if (!twin) return
    const applied = twin.calibrate(nodeId)
    if (applied) { setIr(normalizeIR(twin.ir)); setDrift(twin.drift()) }
  }, [twin])

  // ── import ────────────────────────────────────────────────────────────────
  const importText = useCallback((text, name = 'pasted') => {
    setImportErr(null)
    try {
      const trimmed = text.trim()
      let next
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        const json = JSON.parse(trimmed)
        if (json.irVersion === '2.0') next = parseIR(trimmed)
        else if (json.planned_values || json.configuration || json.values) next = planJsonToIR(json, { file: name }).ir
        else next = k8sToIR(k8sObjects(json), { file: name }).ir
      } else if (/^\s*(resource|provider|terraform|variable|module)\b/m.test(trimmed)) {
        next = hclToIR([{ path: name, text }], { managed: 'partial' }).ir
        setSources([{ path: name, text }])
      } else {
        next = k8sToIR(parseYamlDocs(text, name).map((d) => d.value).filter(Boolean), { file: name }).ir
      }
      const laid = autoLayout(normalizeIR({ ...next, slos: next.slos.length ? next.slos : EXAMPLE_SLOS.slos, workloads: next.workloads.length ? next.workloads : EXAMPLE_SLOS.workloads }))
      setIr(laid)
      setBaseIR(laid)
      setSelected(null)
      // Their infrastructure has no "main" to compare against until they commit
      // a lockfile, so the comparison retires rather than comparing their design
      // to our example.
      setComparable(false)
      setTwin((t) => { t?.stop(); return null })
      setFrame(null); setGhosts([]); setDrift([]); setIncident(null)
    } catch (err) {
      setImportErr(err.message)
    }
  }, [])

  const validation = useMemo(() => validateIR(ir, { kinds: kinds() }), [ir])

  const switchVariant = useCallback((v) => {
    setVariant(v)
    setIr(variants[v])
    setBaseIR(variants[v])
    setSelected(null)
  }, [variants])

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <strong>ArchSim v2</strong>
          <span className="tag">digital twin studio</span>
        </div>
        <div className="topactions">
          <select onChange={(e) => { if (e.target.value) { importText(e.target.value === 'plan' ? EXAMPLE_PLAN : e.target.value === 'hcl' ? EXAMPLE_HCL : EXAMPLE_K8S, e.target.value === 'k8s' ? 'checkout.yaml' : 'main.tf'); e.target.value = '' } }} defaultValue="">
            <option value="">Load an example…</option>
            <option value="plan">Terraform plan JSON (exact)</option>
            <option value="hcl">Raw HCL (best-effort)</option>
            <option value="k8s">Kubernetes manifests</option>
          </select>
          <label className="filebtn">
            Import file
            <input type="file" accept=".json,.tf,.yaml,.yml" onChange={(e) => {
              const f = e.target.files?.[0]
              if (!f) return
              f.text().then((t) => importText(t, f.name))
            }} />
          </label>
          <button onClick={connectTwin} className={twin ? 'live' : ''}>{twin ? '● live' : 'Connect telemetry'}</button>
          <span className="hash" title="Content address of the IR. Two runs that print the same hash simulated the same architecture.">{irHash(ir)}</span>
        </div>
      </header>

      <Verdict busy={gate.busy} result={gate.result} base={gate.base}
               variant={variant} onVariant={switchVariant} comparable={comparable} />

      {importErr && <div className="banner error">Could not read that: {importErr}</div>}
      {validation.errors.length > 0 && <div className="banner error">{validation.errors.length} IR error(s): {validation.errors[0].path} {validation.errors[0].msg}</div>}

      <div className="body">
        <aside className="palette">
          <h4>Add</h4>
          {['lb', 'gateway', 'app', 'micro', 'worker', 'cache', 'sql', 'nosql', 'queue', 'kafka', 'blob', 'search', 'llm'].map((k) => (
            <button key={k} onClick={() => addNode(k)}>{k}</button>
          ))}
          <h4>Counts</h4>
          <div className="counts">
            <div>{ir.nodes.length} components</div>
            <div>{ir.edges.length} connections</div>
            <div>{ir.edges.filter((e) => e.confidence && e.confidence !== 'high').length} inferred, unconfirmed</div>
            <div>{ir.passthrough.length} passthrough blocks</div>
          </div>
          {validation.warnings.length > 0 && (
            <details className="warnings">
              <summary>{validation.warnings.length} caveats</summary>
              {validation.warnings.slice(0, 8).map((w, i) => <p key={i}>{w.msg}</p>)}
            </details>
          )}
        </aside>

        <main className="stage">
          <Canvas ir={ir} frame={frame} ghosts={ghosts} selected={selected}
                  onSelect={setSelected} onMove={onMove} onConnect={onConnect} />
        </main>

        <aside className="side">
          <Inspector ir={ir} nodeId={selected} onChange={onNodeChange} onDelete={onDelete} drift={drift} onCalibrate={onCalibrate} />
        </aside>
      </div>

      <div className="deck">
        <nav className="tabs">
          {TABS.map((t) => <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{t}</button>)}
        </nav>
        {tab === 'Simulate' && <SimulatePanel ir={ir} rps={rps} setRps={setRps} scenario={scenario} setScenario={setScenario} />}
        {tab === 'Gate' && <GatePanel gate={gate} config={GATE_CONFIG} variant={variant} comparable={comparable} />}
        {tab === 'Chaos (DES)' && <DesPanel ir={ir} rps={rps} scenario={scenario} />}
        {tab === 'Twin' && <TwinPanel twin={twin} frames={twin?.buffer.frames || []} ghosts={ghosts} drift={drift}
                                     onCalibrate={onCalibrate} incident={incident} scrubIndex={scrubIndex}
                                     onScrub={(i) => { setScrubIndex(i); setFrame(incident?.frames[i] || null) }} />}
        {tab === 'Code' && <CodePanel baseIR={baseIR} ir={ir} sources={sources} />}
      </div>
    </div>
  )
}

function loadPlan(planText) {
  const { ir } = planJsonToIR(JSON.parse(planText), { file: 'tfplan.json', name: 'checkout' })
  return autoLayout(normalizeIR({ ...ir, slos: EXAMPLE_SLOS.slos, workloads: EXAMPLE_SLOS.workloads }))
}
