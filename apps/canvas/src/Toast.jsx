// Snackbars.
//
// Material's rule, and the right one: a snackbar confirms something that already
// happened and offers at most one way to undo it. It never asks a question, and
// it never carries the only copy of information the user needs.
//
// Everything here is announced through a polite live region, because a
// confirmation nobody can hear is a confirmation that did not happen.

import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'

const ToastCtx = createContext(() => {})
export const useToast = () => useContext(ToastCtx)

let seq = 0

export function ToastHost({ children }) {
  const [items, setItems] = useState([])
  const timers = useRef(new Map())

  const dismiss = useCallback((id) => {
    setItems((xs) => xs.map((t) => (t.id === id ? { ...t, leaving: true } : t)))
    setTimeout(() => setItems((xs) => xs.filter((t) => t.id !== id)), 180)
    const h = timers.current.get(id)
    if (h) { clearTimeout(h); timers.current.delete(id) }
  }, [])

  const push = useCallback((message, opts = {}) => {
    const id = ++seq
    const item = { id, message, tone: opts.tone || null, action: opts.action || null, actionLabel: opts.actionLabel || null }
    // Three at a time. A stack taller than that is a log, and a log belongs
    // somewhere you can scroll.
    setItems((xs) => [...xs.slice(-2), item])
    const ms = opts.duration ?? (opts.action ? 8000 : 4200)
    timers.current.set(id, setTimeout(() => dismiss(id), ms))
    return id
  }, [dismiss])

  const value = useMemo(() => Object.assign(push, { dismiss }), [push, dismiss])

  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="toasts" role="region" aria-label="Notifications">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.tone || ''} ${t.leaving ? 'leaving' : ''}`}>
            <span>{t.message}</span>
            {t.action && (
              <button onClick={() => { t.action(); dismiss(t.id) }}>{t.actionLabel || 'Undo'}</button>
            )}
          </div>
        ))}
      </div>
      <div aria-live="polite" className="sr-only">
        {items.map((t) => <span key={t.id}>{t.message}</span>)}
      </div>
    </ToastCtx.Provider>
  )
}
