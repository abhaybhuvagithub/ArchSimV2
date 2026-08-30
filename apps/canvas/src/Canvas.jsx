// The canvas is a projection of the IR — not its owner.
//
// Every visual affordance here maps to something the IR already carries, and
// nothing is drawn that the data cannot justify:
//   · a dashed edge is a low-confidence inference, and it says why on hover
//   · a hatched border is a `modeled` provenance class — a prior, not a fact
//   · the heat of a node is observed traffic over its *modelled* ceiling, which
//     is exactly where production and the model get to disagree in public
//   · an amber ring is a component this change moved, against `main`
//   · a ghost node is a service the telemetry sees and the diagram does not

import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { kindGlyph, kindName } from '@archsim/core'
import { edgePath } from './layout.js'
import { requestOrder, circled } from './arrange.js'

const W = 150
const H = 44
const MIN_Z = 0.3
const MAX_Z = 2.6

const Canvas = forwardRef(function Canvas({
  ir, frame, ghosts = [], selected, multi = [], search = '', changed = null,
  stepNumbers = false,
  onSelect, onMove, onConnect, onViewChange,
}, apiRef) {
  const svgRef = useRef(null)
  const wrapRef = useRef(null)
  const [drag, setDrag] = useState(null)
  const [pan, setPan] = useState(null)
  const [linkFrom, setLinkFrom] = useState(null)
  const [view, setView] = useState({ x: 0, y: 0, z: 1 })
  // True once the reader has moved the view themselves, after which an
  // automatic refit would be the tool taking the wheel back.
  const touched = useRef(false)
  const pos = (n) => n.layout || { x: 40, y: 40 }

  // The connections in the order a request travels them, so the ①②③ toggle can
  // put the sequence back into a picture that otherwise only shows topology.
  const stepOf = useMemo(() => {
    if (!stepNumbers) return null
    const map = new Map()
    requestOrder(ir).forEach((e, i) => map.set(e.id || `${e.from}->${e.to}`, i + 1))
    return map
  }, [ir, stepNumbers])

  const content = useMemo(() => {
    const xs = ir.nodes.map((n) => pos(n).x)
    const ys = ir.nodes.map((n) => pos(n).y)
    return {
      minX: Math.min(0, ...xs) - 40,
      minY: Math.min(0, ...ys) - 40,
      maxX: Math.max(900, ...xs.map((x) => x + W)) + 60,
      maxY: Math.max(520, ...ys.map((y) => y + H)) + 90,
    }
  }, [ir.nodes])

  // Measure the SVG, not its wrapper. The element carries a `min-height`, so on
  // a short viewport the wrapper is clipped to what fits while the drawing
  // surface stays taller — measuring the wrapper then maps a small viewBox onto
  // a large element and the diagram is drawn several times too big, entirely
  // outside the strip the reader can see.
  const size = () => {
    const r = svgRef.current?.getBoundingClientRect() || wrapRef.current?.getBoundingClientRect()
    return { w: r?.width || 900, h: r?.height || 520 }
  }

  /** Screen point → design coordinates, at the current view. */
  const toDesign = useCallback((evt) => {
    const rect = svgRef.current.getBoundingClientRect()
    return {
      x: (evt.clientX - rect.left) / view.z + view.x,
      y: (evt.clientY - rect.top) / view.z + view.y,
    }
  }, [view])

  const fit = useCallback(() => {
    const { w, h } = size()
    const cw = content.maxX - content.minX
    const ch = content.maxY - content.minY
    const z = Math.max(MIN_Z, Math.min(1.4, Math.min(w / cw, h / ch)))
    touched.current = false
    setView({ z, x: content.minX - (w / z - cw) / 2, y: content.minY - (h / z - ch) / 2 })
  }, [content])

  const zoomBy = useCallback((factor, anchor = null) => {
    touched.current = true
    setView((v) => {
      const z = Math.max(MIN_Z, Math.min(MAX_Z, v.z * factor))
      if (z === v.z) return v
      const { w, h } = size()
      const ax = anchor ? anchor.x : v.x + w / v.z / 2
      const ay = anchor ? anchor.y : v.y + h / v.z / 2
      // Keep the anchor point under the cursor while the scale changes.
      return { z, x: ax - (ax - v.x) * (v.z / z), y: ay - (ay - v.y) * (v.z / z) }
    })
  }, [])

  useImperativeHandle(apiRef, () => ({
    fit,
    toDesign,
    zoomIn: () => zoomBy(1.25),
    zoomOut: () => zoomBy(1 / 1.25),
    reset: () => { touched.current = true; setView({ x: content.minX, y: content.minY, z: 1 }) },
    svg: () => svgRef.current,
    view,
    centerOn: (node) => {
      touched.current = true
      const p = pos(node)
      const { w, h } = size()
      setView((v) => ({ ...v, x: p.x + W / 2 - w / v.z / 2, y: p.y + H / 2 - h / v.z / 2 }))
    },
  }), [fit, zoomBy, toDesign, content, view])

  useEffect(() => { const t = setTimeout(fit, 60); return () => clearTimeout(t) }, [ir.meta?.name]) // eslint-disable-line
  useEffect(() => { onViewChange?.(view) }, [view, onViewChange])

  // The viewBox is derived from a measurement taken during render, so nothing
  // re-derives it when the element changes size on its own: a window resize, a
  // phone rotating, a banner appearing above the stage. Watch the element.
  // Refit only while the view is still the one we chose — once someone has
  // panned or zoomed, moving the diagram under them would be rude.
  const [, bump] = useState(0)
  useEffect(() => {
    const el = svgRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let first = true
    const ro = new ResizeObserver(() => {
      if (first) { first = false; return }
      if (touched.current) bump((n) => n + 1)
      else fit()
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [fit])

  // Non-passive so the page does not scroll while the canvas zooms.
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onWheel = (e) => {
      if (!e.ctrlKey && !e.metaKey && Math.abs(e.deltaX) > Math.abs(e.deltaY)) return
      e.preventDefault()
      const rect = svgRef.current.getBoundingClientRect()
      const anchor = { x: (e.clientX - rect.left) / view.z + view.x, y: (e.clientY - rect.top) / view.z + view.y }
      zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, anchor)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [view, zoomBy])

  const matches = useCallback((n) => {
    if (!search.trim()) return true
    const q = search.trim().toLowerCase()
    return n.label.toLowerCase().includes(q) || n.kind.toLowerCase().includes(q)
      || (n.bindings || []).some((b) => b.address.toLowerCase().includes(q))
  }, [search])

  const onPointerDownNode = (n) => (e) => {
    e.stopPropagation()
    if (e.shiftKey && linkFrom) return
    onSelect(n.id, { additive: e.metaKey || e.ctrlKey })
    if (e.altKey) { setLinkFrom(n.id); return }
    const p = toDesign(e)
    setDrag({ id: n.id, dx: p.x - pos(n).x, dy: p.y - pos(n).y })
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }

  const onPointerDownBg = (e) => {
    if (e.target.closest('g.node')) return
    const rect = svgRef.current.getBoundingClientRect()
    setPan({ sx: e.clientX - rect.left, sy: e.clientY - rect.top, ox: view.x, oy: view.y })
  }

  const onPointerMove = (e) => {
    if (drag) {
      const p = toDesign(e)
      // Snap to an 8px grid so a design that was dragged still lines up.
      const snap = (v) => Math.round(v / 8) * 8
      onMove(drag.id, { x: snap(p.x - drag.dx), y: snap(p.y - drag.dy) })
      return
    }
    if (pan) {
      const rect = svgRef.current.getBoundingClientRect()
      const dx = (e.clientX - rect.left - pan.sx) / view.z
      const dy = (e.clientY - rect.top - pan.sy) / view.z
      // A click that deselects is not a pan; only actual movement counts as the
      // reader taking over the view.
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) touched.current = true
      setView((v) => ({ ...v, x: pan.ox - dx, y: pan.oy - dy }))
    }
  }

  const finishLink = (n) => (e) => {
    if (!linkFrom || linkFrom === n.id) return
    e.stopPropagation()
    onConnect?.(linkFrom, n.id)
    setLinkFrom(null)
  }

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && linkFrom) setLinkFrom(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [linkFrom])

  const { w, h } = size()
  const viewBox = `${view.x} ${view.y} ${w / view.z} ${h / view.z}`

  return (
    <div className="canvaswrap" ref={wrapRef} style={{ width: '100%', height: '100%' }}>
      <svg
        ref={svgRef}
        className="canvas"
        viewBox={viewBox}
        onPointerDown={onPointerDownBg}
        onPointerMove={onPointerMove}
        onPointerUp={() => { setDrag(null); setPan(null) }}
        onPointerLeave={() => { setDrag(null); setPan(null) }}
        onClick={(e) => { if (!e.target.closest('g.node')) { onSelect(null); setLinkFrom(null) } }}
        role="img"
        aria-label={`Architecture canvas: ${ir.nodes.length} components, ${ir.edges.length} connections`}
        style={{ cursor: pan ? 'grabbing' : 'default', touchAction: 'none' }}
      >
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" className="arrowhead" />
          </marker>
          <pattern id="modelled" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
            <line x1="0" y="0" x2="0" y2="6" className="hatch" />
          </pattern>
        </defs>

        {ir.edges.map((e) => {
          const a = ir.nodes.find((n) => n.id === e.from)
          const b = ir.nodes.find((n) => n.id === e.to)
          if (!a || !b) return null
          const obs = frame?.edges?.[e.id]
          const conf = e.confidence || 'high'
          const dim = search.trim() && !(matches(a) || matches(b))
          const step = stepOf?.get(e.id || `${e.from}->${e.to}`)
          return (
            <g key={e.id} className={`edge conf-${conf} sem-${e.callSemantics}`} opacity={dim ? 0.15 : 1}>
              <path d={edgePath(pos(a), pos(b), W, H)} markerEnd="url(#arrow)"
                    strokeWidth={obs?.rps ? Math.min(6, 1 + Math.log10(1 + obs.rps)) : 1.6} />
              <title>
                {`${a.label} → ${b.label}\n${e.callSemantics}${e.protocol ? ` over ${e.protocol}` : ''}\nconfidence: ${conf}${e.attrs?.reason ? `\nwhy: ${e.attrs.reason}` : ''}${conf !== 'high' ? '\n\nDashed because ArchSim inferred this rather than being told. Confirm it and the confidence is written back into the code.' : ''}`}
              </title>
              {step && (
                // Drawn at the midpoint of the chord rather than of the curve:
                // close enough on these arcs, and it does not have to be
                // recomputed when the drawing style changes.
                <g className="stepnum" transform={`translate(${(pos(a).x + pos(b).x) / 2 + W / 2}, ${(pos(a).y + pos(b).y) / 2 + H / 2})`}>
                  <circle r="10" />
                  <text textAnchor="middle" dominantBaseline="central">{step}</text>
                </g>
              )}
            </g>
          )
        })}

        {ir.nodes.map((n) => {
          const p = pos(n)
          const obs = frame?.nodes?.[n.id]
          const heat = obs?.saturation ?? null
          const modelled = n.capacity.provenance?.cls === 'modeled'
          const isChanged = changed?.has(n.id)
          const cls = [
            'node', `kind-${n.kind}`,
            selected === n.id || multi.includes(n.id) ? 'selected' : '',
            linkFrom === n.id ? 'linking' : '',
            isChanged ? 'changed' : '',
            search.trim() && !matches(n) ? 'dimmed' : '',
            heat === null ? '' : heat > 0.85 ? 'hot' : heat > 0.6 ? 'warm' : 'cool',
          ].filter(Boolean).join(' ')
          return (
            <g key={n.id} className={cls} transform={`translate(${p.x} ${p.y})`}
               onPointerDown={onPointerDownNode(n)} onClick={finishLink(n)} style={{ cursor: 'grab' }}>
              {isChanged && <rect className="changering" x="-5" y="-5" width={W + 10} height={H + 10} rx="12" />}
              <rect width={W} height={H} rx="8" />
              {modelled && <rect width={W} height={H} rx="8" fill="url(#modelled)" opacity="0.28" pointerEvents="none" />}
              <text className="glyph" x="12" y={H / 2 + 6}>{kindGlyph(n.kind)}</text>
              <text className="label" x="36" y={H / 2 - 2}>{truncate(n.label, 15)}</text>
              <text className="sub" x="36" y={H / 2 + 13}>{kindName(n.kind)} · {n.capacity.replicas}×</text>
              {obs && <text className="obs" x={W} y={-5} textAnchor="end">{Math.round(obs.rps)} rps</text>}
              {n.attrs?.badge && <text className="badge" x="4" y={H + 14}>{n.attrs.badge}</text>}
              <title>
                {`${n.label} (${kindName(n.kind)})\n`
                  + `${n.capacity.replicas} × ${fmt(n.capacity.capPerReplica)} rps, p50 ${n.capacity.latencyMs.p50}ms\n`
                  + `provenance: ${n.capacity.provenance.cls} — ${n.capacity.provenance.basis}\n`
                  + `Monte-Carlo band: ±${n.capacity.jitter.capPct}%\n`
                  + (isChanged ? 'CHANGED by this pull request\n' : '')
                  + (n.bindings?.[0] ? `code: ${n.bindings[0].address} (${n.bindings[0].managed})` : 'no IaC binding — this exists on the canvas but not in code')}
              </title>
            </g>
          )
        })}

        {ghosts.map((g, i) => (
          <g key={g.name} className="node ghost" transform={`translate(${content.maxX - 190} ${content.minY + 60 + i * 70})`}>
            <rect width={W} height={H} rx="8" strokeDasharray="5 4" />
            <text className="glyph" x="12" y={H / 2 + 6}>👻</text>
            <text className="label" x="36" y={H / 2 - 2}>{truncate(g.name, 14)}</text>
            <text className="sub" x="36" y={H / 2 + 13}>{Math.round(g.rps)} rps · unmapped</text>
            <title>{`${g.name} is sending telemetry but is not in the diagram or the code ArchSim read.\nThe twin found it; your architecture review did not.`}</title>
          </g>
        ))}

        {linkFrom && <text className="hint" x={view.x + 16} y={view.y + h / view.z - 16}>click a second component to connect · Esc to cancel</text>}
      </svg>
    </div>
  )
})

export default Canvas

/** A live overview with the viewport drawn on it, and click-to-jump. */
export function Minimap({ ir, view, size = { w: 168, h: 104 }, changed, onJump }) {
  const nodes = ir.nodes
  if (!nodes.length) return null
  const xs = nodes.map((n) => n.layout?.x ?? 0)
  const ys = nodes.map((n) => n.layout?.y ?? 0)
  const minX = Math.min(...xs) - 40, minY = Math.min(...ys) - 40
  const maxX = Math.max(...xs) + W + 60, maxY = Math.max(...ys) + H + 60
  const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY)

  const onClick = (e) => {
    const r = e.currentTarget.getBoundingClientRect()
    onJump?.({
      x: minX + ((e.clientX - r.left) / r.width) * bw,
      y: minY + ((e.clientY - r.top) / r.height) * bh,
    })
  }

  return (
    <svg className="minimap" width={size.w} height={size.h} viewBox={`${minX} ${minY} ${bw} ${bh}`}
         preserveAspectRatio="xMidYMid meet" onClick={onClick} role="img" aria-label="Canvas overview">
      {nodes.map((n) => (
        <rect key={n.id} className={`mini-node ${changed?.has(n.id) ? 'changed' : ''}`}
              x={n.layout?.x ?? 0} y={n.layout?.y ?? 0} width={W} height={H} rx="6" />
      ))}
      {view && <rect className="viewport" x={view.x} y={view.y} width={view.w} height={view.h} rx="4" />}
    </svg>
  )
}

const truncate = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s))
const fmt = (v) => (v === Infinity ? '∞' : Math.round(v).toLocaleString())
