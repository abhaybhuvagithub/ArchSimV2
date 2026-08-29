// The Arrange tab.
//
// Every layout tool eventually becomes an argument about which arrangement is
// prettier. This one refuses to have that argument: it runs all five, scores
// each on the same four numbers, and shows you the ranking. You pick, but you
// pick knowing what you are trading.
//
// The alignment row is deliberately separate and deliberately greyed out until
// something is selected — "align left" with nothing selected is a button that
// either does nothing or does something enormous, and neither is what anyone
// wanted.

import React, { useMemo } from 'react'
import { rankLayouts, layoutQuality, ALIGNMENTS, align, distribute, snapAll, tighten } from './arrange.js'

const NUMBERS = [
  { key: 'crossings', label: 'crossings', hint: 'Edges that cross. Each one is a reader stopping to trace a line.' },
  { key: 'overlaps', label: 'overlaps', hint: 'Components sitting on top of each other. Anything above zero is a component you cannot read.' },
  { key: 'backward', label: 'backward', hint: 'Arrows pointing left on a canvas where left-to-right means traffic. A lie unless the traffic really does go back.' },
  { key: 'length', label: 'total edge px', hint: 'Ink. The least important of the four, and the one every layout tool optimises first.' },
]

export function ArrangePanel({ ir, apply, selected, multi, onFit }) {
  const ranked = useMemo(() => rankLayouts(ir), [ir])
  const current = useMemo(() => layoutQuality(ir), [ir])
  // `selected` and `multi` are separate in the canvas's model — a plain click
  // sets one, ⌘-click adds to the other — so a reader who clicks a component and
  // then ⌘-clicks a second has two selected and neither list has both.
  const selection = useMemo(
    () => [...new Set([...(selected ? [selected] : []), ...multi])],
    [selected, multi],
  )
  const best = ranked[0]

  const run = (layout) => { apply(layout.result, `Arranged: ${layout.name.toLowerCase()}.`); setTimeout(onFit, 60) }

  return (
    <div className="panel">
      <div className="controls">
        <span className="note">
          Five arrangements plus the one you have, scored on the same four numbers. The order is the ranking, not a
          preference — a force layout wins on a mesh and loses on a pipeline, and the numbers say which you have.
          Across the hundred templates the best algorithm beats the shipped arrangement 45 times and loses to it 4,
          which is why &ldquo;leave it alone&rdquo; is a row rather than an omission.
        </span>
      </div>

      <div className="arrangenow">
        <h4>This arrangement</h4>
        <div className="qualityrow">
          {NUMBERS.map((n) => (
            <div className="quality" key={n.key} title={n.hint}>
              <b className={n.key === 'overlaps' && current[n.key] > 0 ? 'bad' : n.key === 'crossings' && current[n.key] > 0 ? 'warn' : ''}>
                {current[n.key].toLocaleString()}
              </b>
              <span>{n.label}</span>
            </div>
          ))}
        </div>
        {current.overlaps > 0 && (
          <p className="note warnnote">
            {current.overlaps} component{current.overlaps > 1 ? 's are' : ' is'} sitting under another one. Any layout below fixes that.
          </p>
        )}
      </div>

      <h4>Rearrange</h4>
      <table className="arrangetable">
        <thead>
          <tr>
            <th>Layout</th>
            <th className="num">crossings</th>
            <th className="num">overlaps</th>
            <th className="num">backward</th>
            <th className="num">edge px</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {ranked.map((l) => (
            <tr key={l.id} className={l.id === best.id ? 'bestrow' : ''}>
              <td>
                <strong>{l.name}</strong>
                {l.id === best.id && <span className="chip ok">best here</span>}
                <p className="tabout">{l.about}</p>
              </td>
              <td className="num">{delta(l.quality.crossings, current.crossings)}</td>
              <td className="num">{delta(l.quality.overlaps, current.overlaps)}</td>
              <td className="num">{delta(l.quality.backward, current.backward)}</td>
              <td className="num">{l.quality.length.toLocaleString()}</td>
              <td>{l.current ? <span className="muted">in place</span> : <button className="btn" onClick={() => run(l)}>Apply</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h4>Tidy</h4>
      <div className="controls">
        <button className="btn" onClick={() => apply(snapAll(ir), 'Snapped every component to the grid.')}>Snap to grid</button>
        <button className="btn" onClick={() => { apply(tighten(ir), 'Pulled the design back to the top left.'); setTimeout(onFit, 60) }}>
          Tighten to origin
        </button>
        <span className="note">Tightening matters for exports: empty space above and left of the diagram is exported too.</span>
      </div>

      <h4>Align a selection</h4>
      <div className="controls">
        {ALIGNMENTS.map((a) => (
          <button
            key={a.id}
            className="btn"
            disabled={selection.length < 2}
            onClick={() => apply(align(ir, selection, a.id), `${a.name} — ${selection.length} components.`)}
          >{a.name}</button>
        ))}
        <button
          className="btn"
          disabled={selection.length < 3}
          onClick={() => apply(distribute(ir, selection), `Distributed ${selection.length} components evenly.`)}
        >Distribute evenly</button>
      </div>
      <p className="note">
        {selection.length >= 2
          ? `${selection.length} selected.`
          : 'Nothing selected. ⌘-click components on the canvas to build a selection — two for aligning, three for distributing.'}
      </p>
    </div>
  )
}

/**
 * A layout's number is only interesting next to the one it would replace, so
 * show the value and what it changes. Parentheses beat arrows here: the reader
 * is comparing five rows, and five columns of arrows is a puzzle.
 */
function delta(next, now) {
  const d = next - now
  return (
    <>
      {next.toLocaleString()}
      {d !== 0 && <span className={d < 0 ? 'better' : 'worse'}> ({d > 0 ? '+' : ''}{d})</span>}
    </>
  )
}

export default ArrangePanel
