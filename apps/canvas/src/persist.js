// Browser-local state: theme, the working design, and what the tour has seen.
//
// Every read and write is wrapped. `localStorage` throws outright in a few
// contexts — a private window with site data blocked, a thumbnail capture, an
// embedded frame with third-party storage disabled — and a studio that white
// screens because it could not remember a tab is a studio nobody trusts with an
// architecture.
//
// Nothing here is load-bearing. Lose all of it and the app opens on the example,
// which is exactly where a first-time visitor starts anyway.

const NS = 'archsim.v2.'

export function read(key, fallback = null) {
  try {
    const raw = localStorage.getItem(NS + key)
    return raw === null ? fallback : JSON.parse(raw)
  } catch { return fallback }
}

export function write(key, value) {
  try { localStorage.setItem(NS + key, JSON.stringify(value)); return true } catch { return false }
}

export function remove(key) {
  try { localStorage.removeItem(NS + key); return true } catch { return false }
}

/* ── theme ────────────────────────────────────────────────────────────────── */

export const THEMES = ['system', 'light', 'dark']

export function applyTheme(theme) {
  const root = document.documentElement
  if (theme === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', theme)
  write('theme', theme)
}

export function initialTheme() {
  const t = read('theme', 'system')
  return THEMES.includes(t) ? t : 'system'
}

/* ── the working design ───────────────────────────────────────────────────── */

/**
 * Autosave is deliberately *offered*, not applied. Silently restoring a design
 * over the one someone just opened is the behaviour that makes people stop
 * trusting a tool with their work.
 */
export function saveDesign(ir, meta) {
  return write('design', { savedAt: Date.now(), meta, ir })
}

export function loadDesign(maxAgeMs = 1000 * 60 * 60 * 24 * 14) {
  const d = read('design')
  if (!d?.ir || !d.savedAt) return null
  if (Date.now() - d.savedAt > maxAgeMs) return null
  return d
}

export const clearDesign = () => remove('design')

export function describeAge(ts) {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return 'a moment ago'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} minute${m > 1 ? 's' : ''} ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} hour${h > 1 ? 's' : ''} ago`
  const d = Math.round(h / 24)
  return `${d} day${d > 1 ? 's' : ''} ago`
}
