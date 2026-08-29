// The canvas is a projection of the IR — not its owner.
//
// Every visual affordance here maps to something the IR already carries, and
// nothing is drawn that the data cannot justify:
//   · a dashed edge is a low-confidence inference, and it says why on hover
//   · a hatched border is a `modeled` provenance class — a prior, not a fact
//   · the heat of a node is observed traffic over its *modelled* ceiling, which
//     is exactly where production and the model get to disagree in public
//   · a ghost node is a service the telemetry sees and the diagram does not

import React, { useCallback, useRef, useState } from 'react'
import { kindGlyph, kindName } from '@archsim/core'
import { edgePath } from './layout.js'

const W = 150
const H = 44

export default function Canvas({ ir, frame, ghosts = [], selected, onSelect, onMove, onConnect }) {
  const svgRef = useRef(null)
  const [drag, setDrag] = useState(null)
  const [linkFrom, setLinkFrom] = useState(null)
  const pos = (n) => n.layout || { x: 40, y: 40 }

  const toSvg = useCallback((evt) => {
    const rect = svgRef.current.getBoundingClientRect()
    return { x: evt.clientX - rect.left, y: evt.clientY - rect.top }
  }, [])

  const onPointerDown = (n) => (e) => {
    e.stopPropagation()
    onSelect(n.id)
    if (e.shiftKey) { setLinkFrom(n.id); return }
    const p = toSvg(e)
    setDrag({ id: n.id, dx: p.x - pos(n).x, dy: p.y - pos(n).y })
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }

  const onPointerMove = (e) => {
    if (!drag) return
    const p = toSvg(e)
    onMove(drag.id, { x: Math.round(p.x - drag.dx), y: Math.round(p.y - drag.dy) })
  }

  const finishLink = (n) => (e) => {
    if (!linkFrom || linkFrom === n.id) return
    e.stopPropagation()
    onConnect?.(linkFrom, n.id)
    setLinkFrom(null)
  }

  const bounds = ir.nodes.reduce((b, n) => {
    const p = pos(n)
    return { w: Math.max(b.w, p.x + W + 80), h: Math.max(b.h, p.y + H + 120) }
  }, { w: 900, h: 520 })

  return (
    <svg
      ref={svgRef}
      className="canvas"
      viewBox={`0 0 ${bounds.w} ${bounds.h}`}
      onPointerMove={onPointerMove}
      onPointerUp={() => setDrag(null)}
      onPointerLeave={() => setDrag(null)}
      onClick={() => { onSelect(null); setLinkFrom(null) }}
      role="img"
      aria-label="Architecture canvas"
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
        return (
          <g key={e.id} className={`edge conf-${conf} sem-${e.callSemantics}`}>
            <path d={edgePath(pos(a), pos(b), W, H)} markerEnd="url(#arrow)" strokeWidth={obs?.rps ? Math.min(6, 1 + Math.log10(1 + obs.rps)) : 1.6} />
            <title>
              {`${a.label} → ${b.label}\n${e.callSemantics}${e.protocol ? ` over ${e.protocol}` : ''}\nconfidence: ${conf}${e.attrs?.reason ? `\nwhy: ${e.attrs.reason}` : ''}${conf !== 'high' ? '\n\nDashed because ArchSim inferred this rather than being told. Confirm it and the confidence is written back into the code.' : ''}`}
            </title>
          </g>
        )
      })}

      {ir.nodes.map((n) => {
        const p = pos(n)
        const obs = frame?.nodes?.[n.id]
        const heat = obs?.saturation ?? null
        const modelled = n.capacity.provenance?.cls === 'modeled'
        const cls = [
          'node',
          `kind-${n.kind}`,
          selected === n.id ? 'selected' : '',
          linkFrom === n.id ? 'linking' : '',
          heat === null ? '' : heat > 0.85 ? 'hot' : heat > 0.6 ? 'warm' : 'cool',
        ].join(' ')
        return (
          <g key={n.id} className={cls} transform={`translate(${p.x} ${p.y})`}
             onPointerDown={onPointerDown(n)} onClick={finishLink(n)} style={{ cursor: 'grab' }}>
            <rect width={W} height={H} rx="8" />
            {modelled && <rect width={W} height={H} rx="8" fill="url(#modelled)" opacity="0.28" pointerEvents="none" />}
            <text className="glyph" x="12" y={H / 2 + 6}>{kindGlyph(n.kind)}</text>
            <text className="label" x="36" y={H / 2 - 2}>{truncate(n.label, 15)}</text>
            <text className="sub" x="36" y={H / 2 + 13}>
              {kindName(n.kind)} · {n.capacity.replicas}×
            </text>
            {/* Observed rate sits above the box: inside it, a long service name
                and a five-digit rate fight for the same pixels, and the number
                you actually came to read is the one that loses. */}
            {obs && <text className="obs" x={W} y={-5} textAnchor="end">{Math.round(obs.rps)} rps</text>}
            {n.attrs?.badge && <text className="badge" x="4" y={H + 14}>{n.attrs.badge}</text>}
            <title>
              {`${n.label} (${kindName(n.kind)})\n`
                + `${n.capacity.replicas} × ${fmt(n.capacity.capPerReplica)} rps, p50 ${n.capacity.latencyMs.p50}ms\n`
                + `provenance: ${n.capacity.provenance.cls} — ${n.capacity.provenance.basis}\n`
                + `Monte-Carlo band: ±${n.capacity.jitter.capPct}%\n`
                + (n.bindings?.[0] ? `code: ${n.bindings[0].address} (${n.bindings[0].managed})` : 'no IaC binding — this exists on the canvas but not in code')}
            </title>
          </g>
        )
      })}

      {ghosts.map((g, i) => (
        <g key={g.name} className="node ghost" transform={`translate(${bounds.w - 190} ${60 + i * 70})`}>
          <rect width={W} height={H} rx="8" strokeDasharray="5 4" />
          <text className="glyph" x="12" y={H / 2 + 6}>👻</text>
          <text className="label" x="36" y={H / 2 - 2}>{truncate(g.name, 14)}</text>
          <text className="sub" x="36" y={H / 2 + 13}>{Math.round(g.rps)} rps · unmapped</text>
          <title>{`${g.name} is sending telemetry but is not in the diagram or the code ArchSim read.\nThe twin found it; your architecture review did not.`}</title>
        </g>
      ))}

      {linkFrom && <text className="hint" x="16" y={bounds.h - 16}>click a second component to connect · Esc to cancel</text>}
    </svg>
  )
}

const truncate = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s))
const fmt = (v) => (v === Infinity ? '∞' : Math.round(v).toLocaleString())
