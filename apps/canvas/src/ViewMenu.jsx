// The View menu, carried over from ArchSim 1.x.
//
// Same six things, in the same order, because someone who has used v1 should
// find them where they left them: Arrange, Fit, step numbers, light mode, the
// three palettes, and screen-reader mode.
//
// Two of those are worth defending. Step numbers exist because a diagram shows
// you *what* connects to what and hides *when* — numbering the connections in
// request order puts the sequence back without a second diagram. And
// screen-reader mode is under View rather than in a settings panel because it
// is a way of viewing the design, not a preference about the application.

import React, { useEffect, useRef, useState } from 'react'
import { PALETTES } from './persist.js'

export { PALETTES } from './persist.js'

export default function ViewMenu({
  onArrange, onFit, stepNumbers, setStepNumbers, theme, cycleTheme,
  palette, setPalette, srMode, setSrMode,
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e) => { if (!ref.current?.contains(e.target)) setOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') { setOpen(false); ref.current?.querySelector('button')?.focus() } }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  const dark = theme === 'dark' || (theme === 'system' && typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches)

  const item = (label, note, onClick, checked = null) => (
    <button className="menu-item" onClick={() => { onClick(); setOpen(false) }} role="menuitem">
      <span className="menu-check">{checked === true ? '✓' : ''}</span>
      <span>
        <b>{label}</b>
        <span className="menu-note">{note}</span>
      </span>
    </button>
  )

  return (
    <div className="menuwrap" ref={ref}>
      <button
        className={open ? 'menubtn on' : 'menubtn'}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        id="view-menu"
      >View ▾</button>

      {open && (
        <div className="menu" role="menu">
          {item('⧉ Arrange', 'Clean left-to-right layers with fewer crossing lines', onArrange)}
          {item('⤢ Fit', 'Fit the whole diagram in view', onFit)}
          {item('①②③ Step numbers', 'Number the connections in request order', () => setStepNumbers(!stepNumbers), stepNumbers)}
          {item(dark ? '☀️ Light mode' : '🌙 Dark mode', 'Switches this palette between dark and light', cycleTheme)}

          <div className="menu-label">Palette</div>
          {PALETTES.map((p) => (
            <button
              key={p.id}
              className="menu-item"
              role="menuitemradio"
              aria-checked={palette === p.id}
              onClick={() => { setPalette(p.id); setOpen(false) }}
            >
              <span className="menu-check">{palette === p.id ? '✓' : ''}</span>
              <span className="swatch" style={{ background: p.swatch }} />
              <span><b>{p.name}</b>{p.note && <span className="menu-note">{p.note}</span>}</span>
            </button>
          ))}

          <div className="menu-sep" />
          {item('♿ Screen-reader mode', 'Text equivalent of the diagram, stronger focus, no motion', () => setSrMode(!srMode), srMode)}
        </div>
      )}
    </div>
  )
}

/**
 * The diagram, in words.
 *
 * Screen-reader mode does not simply expose the SVG — an SVG of boxes and
 * curves has no reading order and no notion of "downstream". This walks the
 * graph in request order and states each hop, which is the thing the picture is
 * actually communicating.
 */
export function TextEquivalent({ ir, order }) {
  const byId = new Map(ir.nodes.map((n) => [n.id, n]))
  const label = (id) => byId.get(id)?.label || id
  const kind = (id) => byId.get(id)?.kind || ''

  const sources = ir.nodes.filter((n) => n.capacity?.source)
  const stranded = ir.nodes.filter((n) => !ir.edges.some((e) => e.from === n.id || e.to === n.id))

  return (
    <section className="texteq" aria-label="Text equivalent of the diagram">
      <h3>The diagram, in words</h3>
      <p>
        {ir.nodes.length} components and {ir.edges.length} connections.
        {sources.length ? ` Traffic enters at ${sources.map((n) => n.label).join(', ')}.` : ''}
      </p>
      <ol>
        {order.map((e, i) => (
          <li key={e.id || i}>
            <b>{label(e.from)}</b> ({kind(e.from)}) calls <b>{label(e.to)}</b> ({kind(e.to)})
            {e.callSemantics === 'async' ? ', asynchronously' : ''}
            {e.confidence && e.confidence !== 'high' ? ' — inferred, not read from your code' : ''}.
          </li>
        ))}
      </ol>
      {stranded.length > 0 && (
        <p>
          Not connected to anything: {stranded.map((n) => n.label).join(', ')}. These cost money and carry no traffic.
        </p>
      )}
      <h4>Components</h4>
      <ul>
        {ir.nodes.map((n) => (
          <li key={n.id}>
            <b>{n.label}</b> — {n.kind}, {n.capacity.replicas} replica{n.capacity.replicas === 1 ? '' : 's'},
            {' '}{Math.round(n.capacity.capPerReplica).toLocaleString()} requests per second each,
            {' '}{n.capacity.latencyMs?.p50}ms median.
          </li>
        ))}
      </ul>
    </section>
  )
}
