// ArchSim v2 studio.
//
// One IR, three views: the canvas you are looking at, the infrastructure code it
// came from, and production as the twin sees it. Nothing here owns the system —
// the IR does, and each of the three is a projection with a way back.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { normalizeIR, validateIR, irHash, parseIR, diffIR } from '@archsim/ir'
import { kinds, capacityFor, suggestFor, suggestOrphans, orphans, suggestPlacement, kindName, describeKind, simulate } from '@archsim/core'
import { planJsonToIR, hclToIR, k8sToIR, k8sObjects, parseYamlDocs, cfnToIR, pulumiToIR } from '@archsim/iac'
import { Twin, syntheticSource, reproduceInSimulator } from '@archsim/twin'
import Canvas, { Minimap } from './Canvas.jsx'
import Inspector from './Inspector.jsx'
import { SimulatePanel, GatePanel, DesPanel, TwinPanel, CodePanel } from './Panels.jsx'
import ArrangePanel from './ArrangePanel.jsx'
import { tidyIfWorse, rankLayouts, requestOrder } from './arrange.js'
import ViewMenu, { TextEquivalent, PALETTES } from './ViewMenu.jsx'
import Palette from './Palette.jsx'
import IRPanel from './IRPanel.jsx'
import AcronymsPanel from './Acronyms.jsx'
import { autoLayout } from './layout.js'
import { EXAMPLE_PLAN, EXAMPLE_PLAN_PR, EXAMPLE_HCL, EXAMPLE_K8S, EXAMPLE_CFN, EXAMPLE_SLOS } from './examples.js'
import Verdict from './Verdict.jsx'
import { useGate } from './useGate.js'
import { CommandPalette, Shortcuts, Tour } from './Overlays.jsx'
import Templates from './Templates.jsx'
import { template as buildTemplateIR } from '@archsim/templates'
import { useToast } from './Toast.jsx'
import { buildTour, SHORTCUTS } from './tour.js'
import * as persist from './persist.js'
import { downloadIR, saveFile, gateMarkdown, copyText, exportSVG, exportPNG, shareLink, readShareLink } from './exporters.js'

const TABS = ['Simulate', 'Gate', 'Chaos', 'Twin', 'Arrange', 'Code', 'Acronyms']

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
  const [cmdOpen, setCmdOpen] = useState(false)
  const [dropping, setDropping] = useState(false)
  const [gallery, setGallery] = useState(false)
  // Tidying after a drop is on by default and remembered, because the people who
  // hate it hate it immediately and should be able to turn it off once.
  const [autoTidy, setAutoTidy] = useState(() => persist.read('autoTidy', true))
  const [stepNumbers, setStepNumbers] = useState(() => persist.read('stepNumbers', false))
  const [palette, setPaletteState] = useState(() => persist.read('palette', 'kesar'))
  const [srMode, setSrModeState] = useState(() => persist.read('srMode', false))
  // Tri-view puts the IR beside the canvas. Off by default: 500 lines of JSON
  // is the right thing to have available and the wrong thing to greet someone
  // with, and it was taking a third of the screen from the diagram — the one
  // part of this that explains itself.
  const [triView, setTriViewState] = useState(() => persist.read('triView', false))
  const setTriView = (v) => { setTriViewState(v); persist.write('triView', v) }
  // Shared between the canvas and the IR view, in both directions.
  const [hovered, setHovered] = useState(null)

  // One nominal simulation, for the hover card. The gate samples hundreds of
  // worlds; this is the single deterministic run behind the numbers a hint
  // shows, so hovering never costs what gating costs.
  const nominalStats = useMemo(() => {
    try { return simulate(ir, rps).stats } catch { return null }
  }, [ir, rps])
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
  // Whether anything on screen is the reader's own doing yet. Used only to
  // change how the verdict introduces itself: the shipped example fails on
  // purpose, and greeting a first-time visitor with a red count of violations
  // they did not cause reads as an accusation rather than a demonstration.
  const [touched, setTouched] = useState(false)

  const update = useCallback((next) => {
    setTouched(true)
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
    const wired = { ...placed, edges: [...placed.edges, ...edges.map(asEdge)] }

    // Only tidy when the drop actually made the diagram worse — a component
    // landed on another, or the new connections crossed something. A drop into
    // empty space leaves the canvas exactly where it was, including wherever
    // the person chose to put the thing.
    const { ir: next, tidied, reason } = autoTidy ? tidyIfWorse(ir, wired) : { ir: wired, tidied: false, reason: null }
    update(next)
    setSelected(id)
    if (tidied) setTimeout(() => canvasApi.current?.fit(), 80)

    const tail = tidied ? ` ${reason}` : ''
    if (edges.length) {
      toast(`Added ${label} and wired it in: ${edges.map((e) => e.describe).join(' · ')}. Dashed, because ArchSim inferred it — open the connection to confirm or change it.${tail}`,
        { action: undo, actionLabel: 'Undo' })
    } else if (refusal) {
      toast(`Added ${label}, deliberately unconnected. ${refusal}${tail}`, { action: undo, actionLabel: 'Undo' })
    } else {
      toast(`Added ${label}. Nothing on the canvas is a natural neighbour yet — alt-drag from one component to another to connect it.${tail}`,
        { action: undo, actionLabel: 'Undo' })
    }
  }, [ir, update, toast, undo, autoTidy])

  /** The View menu's Arrange: the best-scoring layout, applied in one click. */
  const arrangeBest = useCallback(() => {
    const best = rankLayouts(ir)[0]
    if (best.id === 'current') return toast('Already the best arrangement of the five — nothing to gain by moving it.')
    update(best.result)
    setTimeout(() => canvasApi.current?.fit(), 60)
    toast(`Arranged: ${best.name.toLowerCase()}. Open the Arrange tab to see the other four scored against it.`,
      { action: undo, actionLabel: 'Undo' })
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

  useEffect(() => {
    document.documentElement.setAttribute('data-palette', palette)
    persist.write('palette', palette)
  }, [palette])

  useEffect(() => {
    // A single attribute, so the whole stylesheet can respond: no motion,
    // stronger focus, and the text equivalent revealed. Screen-reader mode is a
    // way of viewing the design, not a preference buried in a settings panel.
    document.documentElement.toggleAttribute('data-sr', !!srMode)
    persist.write('srMode', srMode)
  }, [srMode])

  useEffect(() => { persist.write('stepNumbers', stepNumbers) }, [stepNumbers])

  const strandedCount = useMemo(() => orphans(ir).length, [ir])

  const connectOrphans = useCallback(() => {
    const stranded = orphans(ir)
    if (!stranded.length) return toast('Every component is already connected.')
    const { edges, refused } = suggestOrphans(ir)
    if (!edges.length) {
      return toast(`Nothing to wire: ${refused.length === stranded.length ? 'every' : 'each'} unconnected component here is a platform one, and ArchSim never puts those on the request path.`)
    }
    const wired = { ...ir, edges: [...ir.edges, ...edges.map(asEdge)] }
    const { ir: next, tidied, reason } = autoTidy ? tidyIfWorse(ir, wired) : { ir: wired, tidied: false, reason: null }
    update(next)
    if (tidied) setTimeout(() => canvasApi.current?.fit(), 80)
    const tail = refused.length ? ` ${refused.length} left alone — platform components stay off the request path.` : ''
    toast(`Wired ${edges.length} connection${edges.length > 1 ? 's' : ''}: ${edges.slice(0, 3).map((e) => e.describe).join(' · ')}${edges.length > 3 ? ` and ${edges.length - 3} more` : ''}.${tail} All dashed until you confirm them.${tidied ? ` ${reason}` : ''}`,
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
      // Format is detected from the content, not the extension. A file called
      // `stack.json` can be a Terraform plan, a CloudFormation template, a
      // Pulumi export or a lockfile, and asking the reader which is asking them
      // to know something the file already says.
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        const json = JSON.parse(trimmed)
        if (json.irVersion === '2.0') next = parseIR(trimmed)
        else if (json.planned_values || json.configuration || json.values) next = planJsonToIR(json, { file: name }).ir
        else if (json.Resources && json.AWSTemplateFormatVersion !== undefined || (json.Resources && !Array.isArray(json.Resources))) next = cfnToIR([{ file: name, text }]).ir
        else if (json.deployment?.resources || json.checkpoint || Array.isArray(json.steps)) next = pulumiToIR(json, { file: name }).ir
        else next = k8sToIR(k8sObjects(json), { file: name }).ir
      } else if (/^\s*(resource|provider|terraform|variable|module)\b/m.test(trimmed)) {
        next = hclToIR([{ path: name, text }], { managed: 'partial' }).ir
        setSources([{ path: name, text }])
      } else if (/^\s*(AWSTemplateFormatVersion|Transform)\s*:/m.test(trimmed) || (/^\s*Resources\s*:/m.test(trimmed) && !/^\s*apiVersion\s*:/m.test(trimmed))) {
        next = cfnToIR([{ file: name, text }]).ir
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
    () => buildTour({ setTab, switchVariant, setSearch, canvasApi, setStepNumbers, setGallery }),
    [switchVariant],
  )

  // First visit gets the tour offered, not forced. Once dismissed it stays
  // dismissed — a tour that reappears is an advert.
  useEffect(() => {
    if (persist.read('tourSeen')) return
    const t = setTimeout(() => {
      toast('New here? This is a drawing of a system that tells you where it breaks.', {
        action: startTour, actionLabel: 'Show me', duration: 16000,
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
    { id: 'view-arrange', group: 'View', title: 'Arrange the canvas now', hint: 'The best-scoring layout, applied', run: arrangeBest },
    { id: 'view-fit', group: 'View', title: 'Fit the diagram in view', keys: 'F', run: () => canvasApi.current?.fit() },
    { id: 'view-steps', group: 'View', title: `${stepNumbers ? 'Hide' : 'Show'} step numbers`, hint: 'Number the connections in request order', run: () => setStepNumbers((v) => !v) },
    { id: 'view-sr', group: 'View', title: `${srMode ? 'Leave' : 'Enter'} screen-reader mode`, hint: 'Text equivalent of the diagram, stronger focus, no motion', run: () => setSrModeState((v) => !v) },
    ...PALETTES.map((pal) => ({ id: `palette-${pal.id}`, group: 'View', title: `Palette: ${pal.name}`, run: () => setPaletteState(pal.id) })),
    { id: 'arrange', group: 'Edit', title: 'Open the Arrange tab', hint: 'Five layouts, scored', keys: 'A', run: () => setTab('Arrange') },
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
    // Every component the catalog knows, not the thirteen the palette used to
    // show. ⌘K is the fastest way to add one whose name you already know.
    ...kinds().map((k) => ({
      id: `add-${k}`,
      group: 'Add a component',
      title: kindName(k),
      desc: describeKind(k),
      run: () => addNode(k),
    })),
  ], [startTour, switchVariant, twin, connectTwin, undo, redo, cycleTheme, doExport, addNode, connectOrphans, arrangeBest, stepNumbers, srMode])

  // ── keyboard ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable
      const mod = e.metaKey || e.ctrlKey

      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); setCmdOpen((o) => !o); return }
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        e.shiftKey ? redo() : undo()
        return
      }
      if (e.key === 'Escape') {
        // One layer at a time, topmost first.
        if (gallery) return setGallery(false)
        if (cmdOpen) return setCmdOpen(false)
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
      else if (e.key.toLowerCase() === 'a') setTab('Arrange')
      else if ((e.key === 'Backspace' || e.key === 'Delete') && (selected || multi.length)) { e.preventDefault(); onDelete(null) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [gallery, cmdOpen, keysOpen, tourStep, search, undo, redo, comparable, variant, switchVariant, cycleTheme, startTour, selected, multi, onDelete, connectOrphans])

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
          <ViewMenu
            onArrange={arrangeBest}
            onFit={() => canvasApi.current?.fit()}
            stepNumbers={stepNumbers}
            setStepNumbers={setStepNumbers}
            theme={theme}
            cycleTheme={cycleTheme}
            palette={palette}
            setPalette={setPaletteState}
            srMode={srMode}
            setSrMode={setSrModeState}
            triView={triView}
            setTriView={setTriView}
          />
          <button id="guide-btn" className="menubtn" onClick={startTour} title="Replay the guided tour — G">◷ Guide/Tour</button>
          <button id="templates-btn" onClick={() => setGallery(true)} title="Browse 100 architecture templates — L">Templates</button>
          <select onChange={(e) => { if (e.target.value) { importText(
              e.target.value === 'plan' ? EXAMPLE_PLAN
                : e.target.value === 'hcl' ? EXAMPLE_HCL
                  : e.target.value === 'cfn' ? EXAMPLE_CFN
                    : EXAMPLE_K8S,
              e.target.value === 'k8s' ? 'checkout.yaml' : e.target.value === 'cfn' ? 'Checkout.template.json' : 'main.tf',
            ); e.target.value = '' } }} defaultValue="">
            <option value="">Load an example…</option>
            <option value="plan">Terraform plan JSON (exact)</option>
            <option value="hcl">Raw HCL (best-effort)</option>
            <option value="k8s">Kubernetes manifests</option>
            <option value="cfn">CloudFormation / CDK synth</option>
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
          <button className="iconbtn" onClick={() => setCmdOpen(true)} title="Command palette — ⌘K" aria-label="Open the command palette">⌘</button>
          <button className="iconbtn" onClick={cycleTheme} title={`Theme: ${theme}. Press T to cycle.`} aria-label={`Theme: ${theme}. Cycle theme`}>
            {theme === 'dark' ? '◐' : theme === 'light' ? '☀' : '◑'}
          </button>
          <button className="iconbtn" onClick={startTour} title="Take the tour — G" aria-label="Start the guided tour">?</button>
          <span className="hash" title="Content address of the IR. Two runs that print the same hash simulated the same architecture.">{irHash(ir)}</span>
        </div>
      </header>

      <Verdict busy={gate.busy} result={gate.result} base={gate.base} pristine={!touched}
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

      <div className={triView ? 'body triview' : 'body'}>
        <Palette
          onAdd={addNode}
          onConnectStranded={connectOrphans}
          stranded={strandedCount}
          counts={{
            nodes: ir.nodes.length,
            edges: ir.edges.length,
            inferred: ir.edges.filter((e) => e.confidence && e.confidence !== 'high').length,
            passthrough: ir.passthrough.length,
          }}
          warnings={validation.warnings}
        />

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
                  search={search} changed={changed} stepNumbers={stepNumbers}
                  hovered={hovered} onHover={setHovered} stats={nominalStats}
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

        {triView && (
          <IRPanel ir={ir} hovered={hovered} onHover={setHovered} selected={selected} onSelect={onSelectNode} />
        )}

        <aside className="side">
          <Inspector ir={ir} nodeId={selected} onChange={onNodeChange} onDelete={onDelete} drift={drift} onCalibrate={onCalibrate} />
        </aside>
      </div>

      <div className="deck">
        <nav className="tabs">
          {TABS.map((t) => <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{t}</button>)}
        </nav>
        {srMode && <TextEquivalent ir={ir} order={requestOrder(ir)} />}
        {tab === 'Arrange' && (
          <ArrangePanel
            ir={ir}
            selected={selected}
            multi={multi}
            autoTidy={autoTidy}
            setAutoTidy={(v) => { setAutoTidy(v); persist.write('autoTidy', v) }}
            onFit={() => canvasApi.current?.fit()}
            apply={(next, message) => { update(next); toast(message, { action: undo, actionLabel: 'Undo' }) }}
          />
        )}
        {tab === 'Simulate' && <SimulatePanel ir={ir} rps={rps} setRps={setRps} scenario={scenario} setScenario={setScenario} />}
        {tab === 'Gate' && <GatePanel gate={gate} config={GATE_CONFIG} variant={variant} comparable={comparable} />}
        {tab === 'Chaos' && <DesPanel ir={ir} rps={rps} scenario={scenario} />}
        {tab === 'Twin' && <TwinPanel twin={twin} frames={twin?.buffer.frames || []} ghosts={ghosts} drift={drift}
                                     onCalibrate={onCalibrate} incident={incident} scrubIndex={scrubIndex}
                                     onScrub={(i) => { setScrubIndex(i); setFrame(incident?.frames[i] || null) }} />}
        {tab === 'Code' && <CodePanel baseIR={baseIR} ir={ir} sources={sources} />}
        {tab === 'Acronyms' && <AcronymsPanel />}
      </div>

      <Templates open={gallery} onClose={() => setGallery(false)} onPick={openTemplate} />
      <CommandPalette open={cmdOpen} onClose={() => setCmdOpen(false)} commands={commands} />
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
