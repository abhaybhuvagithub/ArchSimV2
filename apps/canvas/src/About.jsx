// What this is, for someone who has just opened it.
//
// This exists because Abhay asked "what's ArchIR, when is it enabled, and why
// is it advanced" — three questions the interface should have answered itself.
// A panel headed with a bare acronym and no sentence beside it is a defect, not
// a design choice, and the honest fix is not only to answer here but to stop
// the interface asking the question.
//
// It is deliberately short and deliberately says what the tool cannot do. A
// simulator that only tells you what it is good at is a simulator you should
// not trust with a decision.

import React, { useRef } from 'react'
import { useFocusTrap } from './Overlays.jsx'

export default function About({ open, onClose, onTour, onGlossary }) {
  const ref = useRef(null)
  useFocusTrap(open, ref)
  if (!open) return null

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="sheet about" ref={ref} role="dialog" aria-modal="true" aria-label="About ArchSim">
        <h3>What this is</h3>

        <p className="aboutlede">
          You draw the parts of a system and how they call each other. ArchSim works out how fast it
          would be, what it would cost, and what happens when a piece of it fails.
        </p>

        <section>
          <h4>The three things on screen</h4>
          <dl className="aboutlist">
            <div>
              <dt>The diagram</dt>
              <dd>Boxes are components, lines are calls. Drag one in from the left; click one to change it.</dd>
            </div>
            <div>
              <dt>The bar at the top</dt>
              <dd>
                The verdict. It runs every time you change something, and says whether the design still
                meets the targets set for it — and what the cheapest repair would cost.
              </dd>
            </div>
            <div>
              <dt>The tabs at the bottom</dt>
              <dd>
                The detail behind the verdict. <b>Simulate</b> is the one to start with: move the load
                slider and watch what gives.
              </dd>
            </div>
          </dl>
        </section>

        <section>
          <h4>What is ArchIR?</h4>
          <p>
            It is the file behind the picture — <b>Arch</b>itecture <b>I</b>ntermediate
            <b> R</b>epresentation. One document listing every component, every connection and every
            capacity figure.
          </p>
          <p className="muted">
            It matters because the diagram is not the real thing: the document is. The picture, the
            simulation, and the Terraform ArchSim reads and writes are three views of that one file,
            which is why the drawing cannot quietly drift away from the code.
          </p>
          <p>
            <b>Where to find it:</b> View → Tri-view puts it beside the canvas. It is off by default,
            and hidden below 1400px wide where there is no room for it.
          </p>
          <p className="muted">
            <b>Why it is marked advanced:</b> it is several hundred lines of JSON, it is read-only, and
            nothing in it is a thing you need in order to use the studio — everything it contains is
            editable through the diagram and the inspector, in words. It is there for the moment you
            want to know exactly what the tool thinks your system is, or to compare two designs
            precisely. Until then it is noise, which is why it does not open with the app.
          </p>
        </section>

        <section>
          <h4>What it cannot tell you</h4>
          <p className="muted">
            Every number here comes from a model, not from your system. The component figures are
            catalog estimates — each one says where it came from when you hover it — and the
            simulation is arithmetic about queues, not a measurement. It is useful for comparing two
            designs and for finding the part that gives way first. It is not a prediction of what your
            production estate will do on Tuesday.
          </p>
        </section>

        <div className="sheetfoot">
          <span className="muted" style={{ flex: 1, fontSize: 12.5 }}>
            Every term the studio uses is defined in the Acronyms tab.
          </span>
          {onGlossary && <button className="btn" onClick={() => { onGlossary(); onClose() }}>Open the glossary</button>}
          {onTour && <button className="btn" onClick={() => { onTour(); onClose() }}>Take the tour</button>}
          <button className="btn primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </>
  )
}
