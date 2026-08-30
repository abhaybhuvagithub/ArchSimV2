// The IR, visible at last.
//
// ArchSim's whole pitch is that the IR is the source of truth and the diagram
// is one projection of it. Until now you could not look at it — the Code tab
// shows the *IaC patch* the change produces, which is a different document.
//
// The panel is read-only on purpose. The IR is edited through the canvas and
// the inspector, which is where the invariants live: a free-text editor over a
// document with ULID identity and a content hash would let someone break both
// in a way nothing downstream could recover from. What this gives you instead
// is the ability to see, for any box on the canvas, exactly what it is.

import React, { useEffect, useMemo, useRef } from 'react'
import { irDocument, ownerOfLine } from './irview.js'

export default function IRPanel({ ir, hovered, onHover, selected, onSelect }) {
  const doc = useMemo(() => irDocument(ir), [ir])
  const listRef = useRef(null)

  // Highlighting a node from the canvas is only useful if its lines are on
  // screen. Scroll to them — but only when the hover came from elsewhere,
  // which is why this keys on `hovered` and not on pointer events here.
  useEffect(() => {
    if (!hovered) return
    const range = doc.ranges.get(hovered)
    if (!range) return
    listRef.current?.querySelector(`[data-line="${range.start}"]`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [hovered, doc])

  const range = hovered ? doc.ranges.get(hovered) : null
  const selRange = selected ? doc.ranges.get(selected) : null
  const inRange = (i, r) => r && i >= r.start && i <= r.end

  return (
    <section className="irpanel" aria-label="The intermediate representation">
      <header className="irhead">
        <h4>ArchIR</h4>
        <span className="irmeta">
          {ir.nodes.length} nodes · {ir.edges.length} edges · {doc.lines.length} lines
        </span>
      </header>

      <div className="irbody" ref={listRef} onPointerLeave={() => onHover?.(null)}>
        {doc.lines.map((text, i) => {
          const owner = ownerOfLine(doc.ranges, i)
          const cls = [
            'irline',
            inRange(i, range) ? 'hot' : '',
            inRange(i, selRange) ? 'sel' : '',
          ].filter(Boolean).join(' ')
          return (
            <div
              key={i}
              className={cls}
              data-line={i}
              onPointerEnter={() => onHover?.(owner)}
              onClick={() => owner && onSelect?.(owner)}
            >
              <span className="irnum">{i + 1}</span>
              <code>{text || ' '}</code>
            </div>
          )
        })}
      </div>

      <p className="irfoot">
        Read-only. The IR is edited through the canvas and the inspector, where the invariants live.
      </p>
    </section>
  )
}
