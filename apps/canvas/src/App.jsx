// ArchSim v2 studio.
//
// One IR, three views: the canvas you are looking at, the infrastructure code it
// came from, and production as the twin sees it. Nothing here owns the system —
// the IR does, and each of the three is a projection with a way back.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { normalizeIR, validateIR, irHash, parseIR, diffIR } from '@archsim/ir'
import { kinds, capacityFor, suggestFor, suggestOrphans, orphans, suggestPlacement } from '@archsim/core'
import { planJsonToIR, hclToIR, k8sToIR, k8sObjects, parseYamlDocs } from '@archsim/iac'
import { Twin, syntheticSource, reproduceInSimulator } from '@archsim/twin'
import Canvas, { Minimap } from './Canvas.jsx'
import Inspector from './Inspector.jsx'
import { SimulatePanel, GatePanel, DesPanel, TwinPanel, CodePanel } from './Panels.jsx'
import { autoLayout } from './layout.js'
import { EXAMPLE_PLAN, EXAMPLE_PLAN_PR, EXAMPLE_HCL, EXAMPLE_K8S, EXAMPLE_SLOS } from './examples.js'
import Verdict from './Verdict.jsx'
import { useGate } from './useGate.js'
import { CommandPalette, Shortcuts, Tour } from './Overlays.jsx'
import Templates from './Templates.jsx'
import { template as buildTemplateIR } from '@archsim/templates'
import { useToast } from './Toast.jsx'
import { buildTour, SHORTCUTS } from './tour.js'
import * as persist from './persist.js'
import { downloadIR, saveFile, gateMarkdown, copyText, exportSVG, exportPNG, shareLink, readShareLink } from './exporters.js'

const TABS = ['Simulate', 'Gate', 'Chaos (DES)', 'Twin', 'Code']

/** A proposal from the wiring rules, as an IR edge that draws dashed. */
const asEdge = (e) => ({
  id: `${e.from}->${e.to}`,
  from: e.from,
  to: e.to,
  callSemantics: e.callSemantics,
  confidence: e.confidence,
  attrs: { reason: e.why, inferred: 'true' },
})

/** `cache`, then `cache-2` — never two components with the same name. */
function uniqueLabel(ir, kind) {
  const taken = new Set(ir.nodes.map((n) => n.label))
  if (!taken.has(kind)) return kind
  let i = 2
  while (taken.has(`${kind}-${i}`)) i++
  return `${kind}-${i}`
}

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
  const [multi, setMulti] = useState([])
  const [search, setSearch] = useState('')
  const [theme, setTheme] = useState(persist.initialTheme)
  const [palette, setPalette] = useState(false)
  const [dropping, setDropping] = useState(false)
  const [gallery, setGallery] = useState(false)
  const [keysOpen, setKeysOpen] = useState(false)
  const [tourStep, setTourStep] = useState(null)
  const [restore, setRestore] = useState(null)
  const [canvasView, setCanvasView] = useState({ x: 0, y: 0, z: 1 })
  const [busyExport, setBusyExport] = useState(false)
  const canvasApi = useRef(null)
  const searchRef = useRef(null)
  const toast = useToast()

  // Undo/redo. The stack holds whole IRs: they are small, structurally shared
  // by React's own copies, and a diff-based stack would be a second source of
  // truth about what changed.
  const history = useRef({ past: [], future: [] })
  const pushHistory = useCallback((prev) => {
    history.current.past.push(prev)
    if (history.current.past.length > 60) history.current.past.shift()
    history.current.future = []
  }, [])

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

  useEffect(() => { persist.applyTheme(theme) }, [theme])

  // Offer the last design back rather than restoring it silently — quietly
  // replacing what someone just opened is how a tool loses their trust.
  useEffect(() => {
    const shared = readShareLink()
    if (shared) {
      try {
        const laid = autoLayout(parseIR(shared))
        setIr(laid); setBaseIR(laid); setComparable(false)
        toast('Opened the design from this link.')
        return
      } catch { /* fall through to the saved design */ }
    }
    const saved = persist.loadDesign()
    if (saved) setRestore(saved)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const t = setTimeout(() => persist.saveDesign(ir, { variant, comparable }), 1200)
    return () => clearTimeout(t)
  }, [ir, variant, comparable])

  // ── IR editing ────────────────────────────────────────────────────────────
  const update = useCallback((next) => {
    setIr((prev) => { pushHistory(prev); return normalizeIR(next) })
  }, [pushHistory])

  const undo = useCallback(() => {
    const h = history.current
    if (!h.past.length) return toast('Nothing to undo.')
    setIr((cur) => { h.future.push(cur); return h.past.pop() })
    toast('Undone.', { action: () => redo(), actionLabel: 'Redo' })
  }, [toast]) // eslint-disable-line react-hooks/exhaustive-deps

  const redo = useCallback(() => {
    const h = history.current
    if (!h.future.length) return toast('Nothing to redo.')
    setIr((cur) => { h.past.push(cur); return h.future.pop() })
  }, [toast])

  const onNodeChange = useCallback((node) => {
    update({ ...ir, nodes: ir.nodes.map((n) => (n.id === node.id ? node : n)) })
  }, [ir, update])

  const onMove = useCallback((id, layout) => {
    setIr((cur) => ({ ...cur, nodes: cur.nodes.map((n) => (n.id === id ? { ...n, layout } : n)) }))
  }, [])

  const onDelete = useCallback((id) => {
    const ids = id ? [id] : multi.length ? multi : selected ? [selected] : []
    if (!ids.length) return
    const gone = ir.nodes.filter((n) => ids.includes(n.id)).map((n) => n.label)
    setSelected(null); setMulti([])
    update({ ...ir, nodes: ir.nodes.filter((n) => !ids.includes(n.id)), edges: ir.edges.filter((e) => !ids.includes(e.from) && !ids.includes(e.to)) })
    toast(`Removed ${gone.join(', ')} from the canvas — the code is untouched until you apply the removal proposal.`,
      { action: undo, actionLabel: 'Undo' })
  }, [ir, update, multi, selected, toast, undo])

  const onSelectNode = useCallback((id, opts = {}) => {
    if (!id) { setSelected(null); setMulti([]); return }
    if (opts.additive) setMulti((m) => (m.includes(id) ? m.filter((x) => x !== id) : [...m, id]))
    else { setSelected(id); setMulti([]) }
  }, [])

  const onConnect = useCallback((from, to) => {
    if (ir.edges.some((e) => e.from === from && e.to === to)) return
    update({ ...ir, edges: [...ir.edges, { id: `${from}->${to}`, from, to, callSemantics: 'sync', confidence: 'high', attrs: { reason: 'drawn on the canvas' } }] })
  }, [ir, update])

  /**
   * A component with no edges is dead weight: it costs money, adds no latency
   * and cannot fail anything, which is never what the person meant by adding
   * it. So a new component arrives wired in — dashed, because ArchSim guessed.
   */
  const addNode = useCallback((kind, layout = null) => {
    const id = `canvas-${Date.now().toString(36)}`
    const label = uniqueLabel(ir, kind)
    const node = {
      id, kind, label, capacity: { ...capacityFor(kind), replicas: 2 },
      bindings: [], attrs: {}, layout: layout || suggestPlacement(ir, kind),
    }
    const placed = { ...ir, nodes: [...ir.nodes, node] }
    const { edges, refusal } = suggestFor(placed, id, { both: true })
    update({ ...placed, edges: [...placed.edges, ...edges.map(asEdge)] })
    setSelected(id)

    if (edges.length) {
      toast(`Added ${label} and wired it in: ${edges.map((e) => e.describe).join(' · ')}. Dashed, because ArchSim inferred it — open the connection to confirm or change it.`,
        { action: undo, actionLabel: 'Undo' })
    } else if (refusal) {
      toast(`Added ${label}, deliberately unconnected. ${refusal}`, { action: undo, actionLabel: 'Undo' })
    } else {
      toast(`Added ${label}. Nothing on the canvas is a natural neighbour yet — alt-drag from one component to another to connect it.`,
        { action: undo, actionLabel: 'Undo' })
    }
  }, [ir, update, toast, undo])

  /** The same rules, applied to everything already stranded. */
  /**
   * Open a template. It replaces the canvas rather than merging into it — two
   * architectures on one canvas is not a design, it is a mess — and the toast
   * makes that reversible.
   */
  const openTemplate = useCallback((t) => {
    const next = buildTemplateIR(t.id)
    if (!next) return toast(`No template called ${t.id}.`, { tone: 'bad' })
    setGallery(false)
    setSelected(null); setMulti([]); setTwin(null); setGhosts([]); setDrift([])
    // The Simulate tab's offered load is the reader's dial, but leaving it on
    // the last design's number makes a 60-rps template look like it melts.
    setRps(t.rps)
    setScenario(null)
    update(next)
    setTimeout(() => canvasApi.current?.fit(), 80)
    toast(`Opened ${t.name} — ${t.components} components at ${t.rps.toLocaleString()} rps. The gate is already running against its own SLOs.`,
      { action: undo, actionLabel: 'Undo' })
  }, [update, toast, undo])

  const strandedCount = useMemo(() => orphans(ir).length, [ir])

  const connectOrphans = useCallback(() => {
    const stranded = orphans(ir)
    if (!stranded.length) return toast('Every component is already connected.')
    const { edges, refused } = suggestOrphans(ir)
    if (!edges.length) {
      return toast(`Nothing to wire: ${refused.length === stranded.length ? 'every' : 'each'} unconnected component here is a platform one, and ArchSim never puts those on the request path.`)
    }
    update({ ...ir, edges: [...ir.edges, ...edges.map(asEdge)] })
    const tail = refused.length ? ` ${refused.length} left alone — platform components stay off the request path.` : ''
    toast(`Wired ${edges.length} connection${edges.length > 1 ? 's' : ''}: ${edges.slice(0, 3).map((e) => e.describe).join(' · ')}${edges.length > 3 ? ` and ${edges.length - 3} more` : ''}.${tail} All dashed until you confirm them.`,
      { action: undo, actionLabel: 'Undo' })
  }, [ir, update, toast, undo])

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

  // Which components this pull request moved, so the canvas can ring them.
  const changed = useMemo(() => {
    if (!comparable || variant !== 'pr') return null
    try {
      const d = diffIR(variants.main, ir)
      return new Set([...d.nodes.changed.map((c) => c.id), ...d.nodes.added.map((n) => n.id)])
    } catch { return null }
  }, [comparable, variant, variants, ir])

  const cycleTheme = useCallback(() => {
    setTheme((t) => {
      const next = persist.THEMES[(persist.THEMES.indexOf(t) + 1) % persist.THEMES.length]
      toast(`Theme: ${next}`)
      return next
    })
  }, [toast])

  // Every export reports what actually happened. A save the viewer declined and
  // a save that silently failed look identical to the user unless the code says
  // which one it was.
  const say = useCallback((r, extra = '') => {
    if (!r) return
    toast(r.ok ? `${r.message}${extra}` : r.message, { tone: r.ok ? null : r.declined ? null : 'bad' })
  }, [toast])

  const doExport = useCallback(async (what) => {
    const svg = canvasApi.current?.svg?.()
    try {
      if (what === 'ir') say(await downloadIR(ir), ' Commit it next to your Terraform.')
      else if (what === 'report' || what === 'copy') {
        const md = gateMarkdown(gate.result, gate.base, GATE_CONFIG)
        if (!md) return toast('The gate has not finished sampling yet.')
        if (what === 'report') say(await saveFile('gate-report.md', md, 'text/markdown'))
        else {
          const ok = await copyText(md)
          toast(ok ? 'Copied the PR comment — the exact markdown CI posts.' : 'This browser would not give me the clipboard.', { tone: ok ? null : 'bad' })
        }
      }
      else if (what === 'svg') say(await exportSVG(svg))
      else if (what === 'png') { setBusyExport(true); say(await exportPNG(svg)) }
      else if (what === 'link') {
        const ok = await copyText(shareLink(ir))
        toast(ok ? 'Copied a link that carries the whole design.' : 'This browser would not give me the clipboard.', { tone: ok ? 'ok' : 'bad' })
      }
    } catch (err) {
      toast(err.message || 'That export failed.', { tone: 'bad' })
    } finally { setBusyExport(false) }
  }, [ir, gate, toast, say])

  const switchVariant = useCallback((v) => {
    setVariant(v)
    setIr(variants[v])
    setBaseIR(variants[v])
    setSelected(null)
    setMulti([])
  }, [variants])

  const startTour = useCallback(() => setTourStep(0), [])

  const tourSteps = useMemo(
    () => buildTour({ setTab, switchVariant, setSearch, canvasApi }),
    [switchVariant],
  )

  // First visit gets the tour offered, not forced. Once dismissed it stays
  // dismissed — a tour that reappears is an advert.
  useEffect(() => {
    if (persist.read('tourSeen')) return
    const t = setTimeout(() => {
      toast(`First time here? Take the ${tourSteps.length}-step tour.`, {
        action: startTour, actionLabel: 'Start tour', duration: 14000,
      })
      persist.write('tourSeen', true)
    }, 2200)
    return () => clearTimeout(t)
  }, [startTour, toast, tourSteps.length])

  const commands = useMemo(() => [
    { id: 'tour', group: 'Learn', title: 'Start the guided tour', keys: 'G', run: startTour },
    { id: 'keys', group: 'Learn', title: 'Keyboard shortcuts', keys: '?', run: () => setKeysOpen(true) },
    { id: 'main', group: 'Compare', title: 'Judge main', desc: 'the base branch', keys: 'M', run: () => switchVariant('main') },
    { id: 'pr', group: 'Compare', title: 'Judge this pull request', keys: 'M', run: () => switchVariant('pr') },
    ...TABS.map((t, i) => ({ id: `tab-${t}`, group: 'Go to', title: t, keys: String(i + 1), run: () => setTab(t) })),
    { id: 'twin', group: 'Go to', title: twin ? 'Telemetry is live' : 'Connect telemetry', desc: 'a deterministic demo source', run: connectTwin },
    { id: 'fit', group: 'Canvas', title: 'Fit to the design', keys: 'F', run: () => canvasApi.current?.fit() },
    { id: 'zin', group: 'Canvas', title: 'Zoom in', keys: '+', run: () => canvasApi.current?.zoomIn() },
    { id: 'zout', group: 'Canvas', title: 'Zoom out', keys: '−', run: () => canvasApi.current?.zoomOut() },
    { id: 'find', group: 'Canvas', title: 'Search components', keys: '/', run: () => searchRef.current?.focus() },
    { id: 'templates', group: 'Start', title: 'Browse 100 architecture templates', hint: 'L', keys: 'L', run: () => setGallery(true) },
    { id: 'connect', group: 'Edit', title: 'Connect every unconnected component', hint: 'Uses the wiring rules — platform components stay off the request path', keys: 'C', run: connectOrphans },
    { id: 'undo', group: 'Edit', title: 'Undo', keys: '⌘Z', run: undo },
    { id: 'redo', group: 'Edit', title: 'Redo', keys: '⇧⌘Z', run: redo },
    { id: 'theme', group: 'Edit', title: 'Cycle theme', desc: 'system, light, dark', keys: 'T', run: cycleTheme },
    { id: 'x-copy', group: 'Export', title: 'Copy the PR comment', desc: 'exactly what CI posts', run: () => doExport('copy') },
    { id: 'x-ir', group: 'Export', title: 'Download archsim.lock.json', run: () => doExport('ir') },
    { id: 'x-report', group: 'Export', title: 'Download the gate report', run: () => doExport('report') },
    { id: 'x-svg', group: 'Export', title: 'Export the canvas as SVG', run: () => doExport('svg') },
    { id: 'x-png', group: 'Export', title: 'Export the canvas as PNG', desc: '2× for slides', run: () => doExport('png') },
    { id: 'x-link', group: 'Export', title: 'Copy a share link', run: () => doExport('link') },
    ...['lb', 'gateway', 'app', 'micro', 'worker', 'cache', 'sql', 'nosql', 'queue', 'kafka', 'blob', 'search', 'llm']
      .map((k) => ({ id: `add-${k}`, group: 'Add a component', title: k, run: () => addNode(k) })),
  ], [startTour, switchVariant, twin, connectTwin, undo, redo, cycleTheme, doExport, addNode, connectOrphans])

  // ── keyboard ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable
      const mod = e.metaKey || e.ctrlKey

      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p); return }
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        e.shiftKey ? redo() : undo()
        return
      }
      if (e.key === 'Escape') {
        // One layer at a time, topmost first.
        if (gallery) return setGallery(false)
        if (palette) return setPalette(false)
        if (keysOpen) return setKeysOpen(false)
        if (tourStep !== null) return setTourStep(null)
        if (search) return setSearch('')
        return
      }
      if (typing) return
      if (e.key === '?') { e.preventDefault(); setKeysOpen(true) }
      else if (e.key === '/') { e.preventDefault(); searchRef.current?.focus() }
      else if (e.key >= '1' && e.key <= String(TABS.length)) setTab(TABS[Number(e.key) - 1])
      else if (e.key.toLowerCase() === 'f') canvasApi.current?.fit()
      else if (e.key === '+' || e.key === '=') canvasApi.current?.zoomIn()
      else if (e.key === '-') canvasApi.current?.zoomOut()
      else if (e.key === '0') canvasApi.current?.reset()
      else if (e.key.toLowerCase() === 'm' && comparable) switchVariant(variant === 'pr' ? 'main' : 'pr')
      else if (e.key.toLowerCase() === 't') cycleTheme()
      else if (e.key.toLowerCase() === 'g') startTour()
      else if (e.key.toLowerCase() === 'c') connectOrphans()
      else if (e.key.toLowerCase() === 'l') setGallery(true)
      else if ((e.key === 'Backspace' || e.key === 'Delete') && (selected || multi.length)) { e.preventDefault(); onDelete(null) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [gallery, palette, keysOpen, tourStep, search, undo, redo, comparable, variant, switchVariant, cycleTheme, startTour, selected, multi, onDelete, connectOrphans])

  const viewRect = useMemo(() => {
    const el = document.querySelector('.stage')
    if (!el || !canvasView.z) return null
    return { x: canvasView.x, y: canvasView.y, w: el.clientWidth / canvasView.z, h: el.clientHeight / canvasView.z }
  }, [canvasView])

  return (
    <div className="app">
      <a className="skip-link" href="#stage">Skip to the canvas</a>
      <header className="top">
        <div className="brand">
          <strong>ArchSim v2</strong>
          <span className="tag">digital twin studio</span>
        </div>
        <div className="topactions">
          <button id="templates-btn" onClick={() => setGallery(true)} title="Browse 100 architecture templates — L">Templates</button>
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
          <button className="iconbtn" onClick={() => setPalette(true)} title="Command palette — ⌘K" aria-label="Open the command palette">⌘</button>
          <button className="iconbtn" onClick={cycleTheme} title={`Theme: ${theme}. Press T to cycle.`} aria-label={`Theme: ${theme}. Cycle theme`}>
            {theme === 'dark' ? '◐' : theme === 'light' ? '☀' : '◑'}
          </button>
          <button className="iconbtn" onClick={startTour} title="Take the tour — G" aria-label="Start the guided tour">?</button>
          <span className="hash" title="Content address of the IR. Two runs that print the same hash simulated the same architecture.">{irHash(ir)}</span>
        </div>
      </header>

      <Verdict busy={gate.busy} result={gate.result} base={gate.base}
               variant={variant} onVariant={switchVariant} comparable={comparable} />

      {restore && (
        <div className="restore">
          <span>You were working on a design {persist.describeAge(restore.savedAt)}.</span>
          <span className="spacer" />
          <button className="btn primary" onClick={() => {
            try {
              const laid = autoLayout(parseIR(JSON.stringify(restore.ir)))
              setIr(laid); setBaseIR(laid); setComparable(false); setRestore(null)
              toast('Restored your design.')
            } catch { toast('That saved design could not be read.', { tone: 'bad' }); setRestore(null) }
          }}>Restore it</button>
          <button className="btn" onClick={() => { persist.clearDesign(); setRestore(null) }}>Discard</button>
        </div>
      )}

      {importErr && <div className="banner error">Could not read that: {importErr}</div>}
      {validation.errors.length > 0 && <div className="banner error">{validation.errors.length} IR error(s): {validation.errors[0].path} {validation.errors[0].msg}</div>}

      <div className="body">
        <aside className="palette">
          <h4>Add</h4>
          <p className="palettehint">Click to place, or drag onto the canvas.</p>
          {['lb', 'gateway', 'app', 'micro', 'worker', 'cache', 'sql', 'nosql', 'queue', 'kafka', 'blob', 'search', 'llm'].map((k) => (
            <button
              key={k}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('application/x-archsim-kind', k)
                e.dataTransfer.effectAllowed = 'copy'
              }}
              onClick={() => addNode(k)}
            >{k}</button>
          ))}
          <h4>Counts</h4>
          <div className="counts">
            <div>{ir.nodes.length} components</div>
            <div>{ir.edges.length} connections</div>
            <div>{ir.edges.filter((e) => e.confidence && e.confidence !== 'high').length} inferred, unconfirmed</div>
            <div>{ir.passthrough.length} passthrough blocks</div>
          </div>
          {strandedCount > 0 && (
            <button className="btn stranded" onClick={connectOrphans}>
              Connect {strandedCount} unconnected
            </button>
          )}
          {validation.warnings.length > 0 && (
            <details className="warnings">
              <summary>{validation.warnings.length} caveats</summary>
              {validation.warnings.slice(0, 8).map((w, i) => <p key={i}>{w.msg}</p>)}
            </details>
          )}
        </aside>

        <main
          className={`stage${dropping ? ' dropping' : ''}`}
          id="stage"
          onDragOver={(e) => {
            if (![...e.dataTransfer.types].includes('application/x-archsim-kind')) return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
            if (!dropping) setDropping(true)
          }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDropping(false) }}
          onDrop={(e) => {
            const kind = e.dataTransfer.getData('application/x-archsim-kind')
            setDropping(false)
            if (!kind) return
            e.preventDefault()
            // Land where it was dropped, in design coordinates, centred under
            // the cursor rather than hanging off its top-left corner.
            const p = canvasApi.current?.toDesign?.(e)
            addNode(kind, p ? { x: Math.round((p.x - 75) / 8) * 8, y: Math.round((p.y - 22) / 8) * 8 } : null)
          }}
        >
          <Canvas ref={canvasApi} ir={ir} frame={frame} ghosts={ghosts} selected={selected} multi={multi}
                  search={search} changed={changed}
                  onSelect={onSelectNode} onMove={onMove} onConnect={onConnect}
                  onViewChange={setCanvasView} />

          <div className="searchwrap">
            <input ref={searchRef} value={search} onChange={(e) => setSearch(e.target.value)}
                   placeholder="Search components  /" aria-label="Search components" />
            {search && <button className="iconbtn" onClick={() => setSearch('')} aria-label="Clear search">×</button>}
          </div>

          <Minimap ir={ir} view={viewRect} changed={changed}
                   onJump={(p) => canvasApi.current?.centerOn({ layout: { x: p.x - 75, y: p.y - 22 } })} />

          <div className="canvaschrome">
            <button className="iconbtn" onClick={() => canvasApi.current?.zoomOut()} aria-label="Zoom out">−</button>
            <span className="zoomlevel">{Math.round(canvasView.z * 100)}%</span>
            <button className="iconbtn" onClick={() => canvasApi.current?.zoomIn()} aria-label="Zoom in">+</button>
            <button className="iconbtn" onClick={() => canvasApi.current?.fit()} title="Fit to the design — F" aria-label="Fit canvas to the design">⤢</button>
            <button className="iconbtn" onClick={() => doExport('png')} disabled={busyExport} title="Export as PNG" aria-label="Export the canvas as a PNG">↓</button>
          </div>
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

      <Templates open={gallery} onClose={() => setGallery(false)} onPick={openTemplate} />
      <CommandPalette open={palette} onClose={() => setPalette(false)} commands={commands} />
      <Shortcuts open={keysOpen} onClose={() => setKeysOpen(false)} rows={SHORTCUTS} />
      {tourStep !== null && (
        <Tour steps={tourSteps} index={tourStep} onIndex={setTourStep} onClose={() => setTourStep(null)} />
      )}

      <div aria-live="polite" className="sr-only">
        {gate.busy ? 'Sampling worlds' : gate.result?.verdict === 'pass' ? 'All gates hold'
          : gate.result?.verdict === 'risk' ? 'Error budget at risk' : 'Gate violation'}
      </div>
    </div>
  )
}

function loadPlan(planText) {
  const { ir } = planJsonToIR(JSON.parse(planText), { file: 'tfplan.json', name: 'checkout' })
  return autoLayout(normalizeIR({ ...ir, slos: EXAMPLE_SLOS.slos, workloads: EXAMPLE_SLOS.workloads }))
}
