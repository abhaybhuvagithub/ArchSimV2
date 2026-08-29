// The template gallery.
//
// A hundred architectures is only useful if the right one is two keystrokes
// away, so this is a search box with results under it rather than a grid of
// cards to scroll. Each row states what the design costs and what it promises,
// because choosing between "Checkout" and "Payment gateway" is a decision about
// those numbers, not about the names.

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { TEMPLATES, CATEGORIES, searchTemplates } from '@archsim/templates'
import { useFocusTrap } from './Overlays.jsx'

const money = (n) => (n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${n}`)
const rate = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k rps` : `${n} rps`)
const pct = (a) => `${(a * 100).toFixed(a >= 0.9999 ? 3 : a >= 0.999 ? 2 : 1)}%`

export default function Templates({ open, onClose, onPick }) {
  const [q, setQ] = useState('')
  const [cat, setCat] = useState('All')
  const [active, setActive] = useState(0)
  const ref = useRef(null)
  const inputRef = useRef(null)
  useFocusTrap(open, ref)

  useEffect(() => { if (open) { setQ(''); setCat('All'); setActive(0); setTimeout(() => inputRef.current?.focus(), 30) } }, [open])

  const results = useMemo(() => {
    const found = searchTemplates(q)
    return cat === 'All' ? found : found.filter((t) => t.category === cat)
  }, [q, cat])

  useEffect(() => { setActive(0) }, [q, cat])

  if (!open) return null

  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, results.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter' && results[active]) { e.preventDefault(); onPick(results[active]) }
  }

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="sheet gallery" ref={ref} role="dialog" aria-modal="true" aria-label="Architecture templates" onKeyDown={onKey}>
        <input
          ref={inputRef}
          className="cmdinput"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`Search ${TEMPLATES.length} architectures — try "queue", "ledger", "streaming"`}
          aria-label="Search templates"
        />

        <div className="cats">
          {['All', ...CATEGORIES].map((c) => (
            <button key={c} className={c === cat ? 'chip on' : 'chip'} onClick={() => setCat(c)}>{c}</button>
          ))}
        </div>

        <div className="cmdlist gallerylist">
          {results.length === 0 && (
            <p className="empty">Nothing matches “{q}”. The search covers names, categories, descriptions and component kinds — “kafka” and “ledger” both work.</p>
          )}
          {results.map((t, i) => (
            <button
              key={t.id}
              className={i === active ? 'trow active' : 'trow'}
              onMouseEnter={() => setActive(i)}
              onClick={() => onPick(t)}
            >
              <div className="tmain">
                <strong>{t.name}</strong>
                <span className="tcat">{t.category}</span>
              </div>
              <p className="tabout">{t.about}</p>
              <div className="tfacts">
                <span>{t.components} components</span>
                <span>{rate(t.rps)}</span>
                <span>p99 ≤ {t.p99}ms</span>
                <span>{pct(t.availability)}</span>
                <span>{money(t.cost)}/mo budget</span>
              </div>
            </button>
          ))}
        </div>

        <footer className="cmdfoot">
          <span>{results.length} of {TEMPLATES.length}</span>
          <span className="hint">↑↓ to move · ↵ to open · Esc to close</span>
        </footer>
      </div>
    </>
  )
}
