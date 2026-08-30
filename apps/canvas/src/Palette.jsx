// The component palette.
//
// It used to list thirteen kinds. The catalog has 117, every one of them with
// real capacity and latency figures — so 104 components existed in the engine
// and could not be reached from the canvas. That is not a missing feature, it is
// most of the product being invisible.
//
// Search covers the description as well as the name, deliberately. Someone who
// does not know the phrase "CDC connector" may well type "replication lag", and
// the sentence explaining the component is the only place those words appear.

import React, { useMemo, useState } from 'react'
import { CATALOG, COMPONENT_CATEGORIES, TAXONOMY, kindsIn, searchKinds, kindGlyph, kindName, describeKind, specOf } from '@archsim/core'

/** Categories that are open before anyone touches anything. */
const OPEN_BY_DEFAULT = new Set(['Traffic', 'Compute', 'Data', 'Messaging'])

const rate = (n) => (!Number.isFinite(n) ? '∞' : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

export default function Palette({ onAdd, counts, warnings, stranded, onConnectStranded }) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(() => new Set(OPEN_BY_DEFAULT))

  const matches = useMemo(() => new Set(searchKinds(query, CATALOG)), [query])
  const searching = query.trim().length > 0

  const groups = useMemo(() => COMPONENT_CATEGORIES
    .map((c) => ({ name: c, kinds: kindsIn(c).filter((k) => matches.has(k)) }))
    .filter((g) => g.kinds.length), [matches])

  const total = Object.keys(TAXONOMY).length
  const shown = groups.reduce((n, g) => n + g.kinds.length, 0)

  const toggle = (name) => setOpen((s) => {
    const next = new Set(s)
    next.has(name) ? next.delete(name) : next.add(name)
    return next
  })

  return (
    <aside className="palette">
      <div className="palettesearch">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${total} components…`}
          aria-label="Search components to add"
        />
        {searching && (
          <button className="iconbtn" onClick={() => setQuery('')} aria-label="Clear the component search">×</button>
        )}
      </div>
      <p className="palettehint">
        {searching
          ? `${shown} of ${total}. Click to place, or drag onto the canvas.`
          : 'Click to place, or drag onto the canvas.'}
      </p>

      {groups.map((g) => {
        // A search result opens every group it matched: collapsing the answer
        // behind a disclosure is the classic way to make a search box useless.
        const expanded = searching || open.has(g.name)
        return (
          <section className="palettegroup" key={g.name}>
            <button
              className="grouphead"
              onClick={() => toggle(g.name)}
              aria-expanded={expanded}
              disabled={searching}
            >
              <span className="caret">{expanded ? '▾' : '▸'}</span>
              <span>{g.name}</span>
              <span className="groupcount">{g.kinds.length}</span>
            </button>
            {expanded && g.kinds.map((k) => {
              const spec = specOf(k)
              return (
                <button
                  key={k}
                  className="palitem"
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData('application/x-archsim-kind', k)
                    e.dataTransfer.effectAllowed = 'copy'
                  }}
                  onClick={() => onAdd(k)}
                  title={`${kindName(k)} — ${describeKind(k)}\n\n${rate(spec.cap)} rps per replica · ${spec.lat}ms median · ${((1 - (spec.avail ?? 1)) * 100).toFixed(3)}% failure`}
                >
                  <span className="palglyph" aria-hidden="true">{kindGlyph(k)}</span>
                  <span className="palbody">
                    <b>{kindName(k)}</b>
                    <span className="palfacts">{rate(spec.cap)} rps · {spec.lat}ms</span>
                  </span>
                </button>
              )
            })}
          </section>
        )
      })}

      {!groups.length && (
        <p className="palettehint">
          Nothing matches “{query}”. The search covers names, categories and the description of what each component is
          for — try “replication lag”, “queue” or “latency”.
        </p>
      )}

      <h4>Counts</h4>
      <div className="counts">
        <div>{counts.nodes} components</div>
        <div>{counts.edges} connections</div>
        <div>{counts.inferred} inferred, unconfirmed</div>
        <div>{counts.passthrough} passthrough blocks</div>
      </div>
      {stranded > 0 && (
        <button className="btn stranded" onClick={onConnectStranded}>
          Connect {stranded} unconnected
        </button>
      )}
      {warnings.length > 0 && (
        <details className="warnings">
          <summary>{warnings.length} caveats</summary>
          {warnings.slice(0, 8).map((w, i) => <p key={i}>{w.msg}</p>)}
        </details>
      )}
    </aside>
  )
}
