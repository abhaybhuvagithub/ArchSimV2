// Overlays: the command palette, the shortcut reference, and the guided tour.
//
// All three share one discipline — focus is trapped while they are open and
// returned to whatever opened them, Escape closes the topmost one only, and
// nothing here is reachable by mouse alone.

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

/* ── focus management ─────────────────────────────────────────────────────── */

export function useFocusTrap(open, ref) {
  const previous = useRef(null)
  useEffect(() => {
    if (!open) return
    previous.current = document.activeElement
    const el = ref.current
    const focusables = () => [...(el?.querySelectorAll(
      'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])',
    ) || [])]
    const first = focusables()[0]
    first?.focus()
    const onKey = (e) => {
      if (e.key !== 'Tab') return
      const list = focusables()
      if (!list.length) return
      const idx = list.indexOf(document.activeElement)
      if (e.shiftKey && (idx <= 0)) { e.preventDefault(); list[list.length - 1].focus() }
      else if (!e.shiftKey && idx === list.length - 1) { e.preventDefault(); list[0].focus() }
    }
    el?.addEventListener('keydown', onKey)
    return () => {
      el?.removeEventListener('keydown', onKey)
      // Returning focus is the half everyone forgets, and it is the half that
      // decides whether the keyboard user is left stranded at the top of the page.
      previous.current?.focus?.()
    }
  }, [open, ref])
}

/* ── command palette ──────────────────────────────────────────────────────── */

export function CommandPalette({ open, onClose, commands }) {
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const ref = useRef(null)
  useFocusTrap(open, ref)

  useEffect(() => { if (open) { setQ(''); setActive(0) } }, [open])

  const matches = useMemo(() => rank(commands, q), [commands, q])

  useEffect(() => { setActive(0) }, [q])

  const run = useCallback((cmd) => {
    if (!cmd) return
    onClose()
    // Let the overlay unmount before the command changes the page underneath it.
    setTimeout(() => cmd.run(), 0)
  }, [onClose])

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(matches.length - 1, i + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); run(matches[active]) }
  }

  if (!open) return null
  let lastGroup = null

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="sheet" ref={ref} role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={onKeyDown}>
        <input
          className="cmdinput" value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Search commands…" aria-label="Search commands" autoFocus
          aria-controls="cmdlist" aria-activedescendant={matches[active] ? `cmd-${matches[active].id}` : undefined}
        />
        <div className="cmdlist" id="cmdlist" role="listbox">
          {matches.length === 0 && <div className="cmdempty">Nothing matches “{q}”.</div>}
          {matches.map((c, i) => {
            const head = c.group !== lastGroup ? (lastGroup = c.group) : null
            return (
              <React.Fragment key={c.id}>
                {head && <div className="cmdgroup">{head}</div>}
                <button
                  id={`cmd-${c.id}`} role="option" aria-selected={i === active}
                  className={`cmditem ${i === active ? 'active' : ''}`}
                  onMouseEnter={() => setActive(i)} onClick={() => run(c)}
                >
                  <span>{c.title}{c.desc && <span className="desc"> — {c.desc}</span>}</span>
                  {c.keys && <span className="hint">{c.keys}</span>}
                </button>
              </React.Fragment>
            )
          })}
        </div>
      </div>
    </>
  )
}

/** Subsequence matching, scored so a prefix beats a scattered match. */
function rank(commands, q) {
  const query = q.trim().toLowerCase()
  if (!query) return commands
  const out = []
  for (const c of commands) {
    const hay = `${c.title} ${c.desc || ''} ${c.group}`.toLowerCase()
    const idx = hay.indexOf(query)
    if (idx >= 0) { out.push({ c, score: idx === 0 ? 0 : 1 + idx / 100 }); continue }
    let i = 0, score = 6
    for (const ch of query) {
      const at = hay.indexOf(ch, i)
      if (at < 0) { score = Infinity; break }
      score += (at - i) / 200
      i = at + 1
    }
    if (score !== Infinity) out.push({ c, score })
  }
  return out.sort((a, b) => a.score - b.score).map((x) => x.c)
}

/* ── shortcut reference ───────────────────────────────────────────────────── */

export function Shortcuts({ open, onClose, rows }) {
  const ref = useRef(null)
  useFocusTrap(open, ref)
  if (!open) return null
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="sheet" ref={ref} role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
        <h3>Keyboard</h3>
        <div className="keys">
          {rows.map((r) => (
            <div className="krow" key={r.keys}>
              <span>{r.what}</span>
              <kbd>{r.keys}</kbd>
            </div>
          ))}
        </div>
        <div className="sheetfoot">
          <span className="muted" style={{ flex: 1, fontSize: 12.5 }}>Every control is reachable by Tab, in reading order.</span>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </>
  )
}

/* ── guided tour ──────────────────────────────────────────────────────────── */

/**
 * A spotlight tour that *does the thing* at each step rather than describing it.
 * Steps carry a `before` hook, so the step about comparing versions actually
 * switches version while you watch.
 */
export function Tour({ steps, index, onIndex, onClose }) {
  const [rect, setRect] = useState(null)
  const cardRef = useRef(null)
  const [cardPos, setCardPos] = useState({ top: 120, left: 40 })
  const step = steps[index]

  useEffect(() => { step?.before?.() }, [index]) // eslint-disable-line react-hooks/exhaustive-deps

  const measure = useCallback(() => {
    if (!step) return
    const el = step.target ? document.querySelector(step.target) : null
    if (!el) { setRect(null); return }
    const r = el.getBoundingClientRect()
    // A target scrolled out of the viewport cannot be spotlit, and following it
    // off-screen takes the card with it. Centre instead: no spotlight is better
    // than a spotlight on something the reader cannot see.
    const visible = r.bottom > 40 && r.top < window.innerHeight - 40 && r.right > 0 && r.left < window.innerWidth
    if (!visible || (!r.width && !r.height)) { setRect(null); return }
    // The ring is drawn `pad` outside its target, which for a target as wide as
    // the window puts it past the edge and gives the whole page a horizontal
    // scrollbar. Keep the ring inside the viewport: the few padding pixels are
    // not worth a scrollbar on every step that highlights a full-width bar.
    const pad = step.pad ?? 8
    const left = Math.max(0, r.left - pad)
    const top = Math.max(0, r.top - pad)
    setRect({
      top,
      left,
      width: Math.min(r.width + pad * 2, window.innerWidth - left),
      height: Math.min(r.height + pad * 2, window.innerHeight - top),
    })
  }, [step])

  useLayoutEffect(() => {
    // A frame's grace so a step that switches tabs measures the element it asked
    // for rather than the one that was there a moment ago.
    const t = setTimeout(measure, 90)
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => { clearTimeout(t); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true) }
  }, [measure])

  useLayoutEffect(() => {
    const card = cardRef.current
    if (!card) return
    const cw = card.offsetWidth, ch = card.offsetHeight
    const vw = window.innerWidth, vh = window.innerHeight
    // Clamp last, always. Every branch below is a *preference*; this is the
    // guarantee. Without it a tall card beside a target near the bottom lands
    // at a negative top and the reader is looking at a step they cannot read —
    // which is exactly how a longer tour breaks a placement that worked when
    // every step was two sentences.
    const clamp = (t, l) => ({
      top: Math.max(16, Math.min(t, Math.max(16, vh - ch - 16))),
      left: Math.max(16, Math.min(l, Math.max(16, vw - cw - 16))),
    })
    if (!rect) { setCardPos(clamp(vh / 2 - ch / 2, vw / 2 - cw / 2)); return }
    // Prefer below, then above, then beside — whichever fits without clipping.
    let top = rect.top + rect.height + 14
    if (top + ch > vh - 16) top = rect.top - ch - 14
    if (top < 16) top = rect.top
    setCardPos(clamp(top, rect.left + rect.width / 2 - cw / 2))
  }, [rect, index])

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose() }
      else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); index < steps.length - 1 ? onIndex(index + 1) : onClose() }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); onIndex(Math.max(0, index - 1)) }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [index, steps.length, onIndex, onClose])

  if (!step) return null
  const last = index === steps.length - 1

  return (
    <>
      {rect
        ? <div className="spotlight" style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }} />
        : <div className="scrim" />}
      <div className="tourcard" ref={cardRef} style={cardPos} role="dialog" aria-modal="true" aria-label={`Tour step ${index + 1} of ${steps.length}`}>
        <h3>{step.title}</h3>
        <p>{step.body}</p>
        {/*
          Progress used to be one dot per step. Seventeen dots is not something
          anyone counts, and they took 187px of a 322px row — which pushed Next
          off the edge of the card and made the tour's own primary action
          something you had to scroll sideways to reach.

          A bar says the same thing in any width, and the buttons get a row of
          their own so the one you need is always the one you can see.
        */}
        <div className="tourprogress">
          <div className="tourbar" role="progressbar" aria-valuenow={index + 1} aria-valuemin={1} aria-valuemax={steps.length}>
            <i style={{ width: `${((index + 1) / steps.length) * 100}%` }} />
          </div>
          <span className="tourstep">{index + 1}/{steps.length}</span>
        </div>
        <div className="tourfoot">
          <button className="btn" onClick={onClose}>{last ? 'Done' : 'Skip'}</button>
          <span className="spacer" />
          {index > 0 && <button className="btn" onClick={() => onIndex(index - 1)}>Back</button>}
          {!last && <button className="btn primary" onClick={() => onIndex(index + 1)} autoFocus>Next</button>}
        </div>
      </div>
    </>
  )
}
