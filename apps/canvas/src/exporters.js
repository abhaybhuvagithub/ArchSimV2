// Getting work out of the studio.
//
// Four exits, because four different people need the same design in four
// different shapes: the lockfile for CI, the report for a pull request, SVG for
// a document, PNG for a slide.

import { serializeIR, irHash } from '@archsim/ir'
import { label as sloLabel } from '@archsim/core'

/**
 * Saving a file, in two worlds.
 *
 * On GitHub Pages this page is an ordinary web page and an anchor with a
 * `download` attribute is the whole mechanism. Inside the claude.ai artifact
 * viewer that anchor is inert — the frame is never allowed to write to disk
 * directly — and the viewer mediates saves through a capability that asks the
 * person first. One build serves both, so the host path is tried and the anchor
 * is the fallback. Silently doing nothing, which is what an unadapted anchor
 * does in the viewer, is the one outcome not on the table.
 */
let hostSave
function downloadsHost() {
  if (hostSave === undefined) {
    hostSave = (async () => {
      try { return (await window.claude?.use?.('downloads')) || null } catch { return null }
    })()
  }
  return hostSave
}

const HOST_MESSAGES = {
  declined: 'Save declined.',
  rate_limited: 'A save prompt is already open — finish that one first.',
  too_large: 'That file is over the 16 MB the viewer will save.',
  rejected_extension: 'The viewer will not save that file type.',
  extension_not_enabled: 'That file type is not available to save here.',
  bad_request: 'The file could not be prepared.',
}

export async function saveFile(filename, text, type = 'application/json') {
  const host = await downloadsHost()
  if (host) {
    try {
      await host.save({ filename, data: text })
      return { ok: true, message: `Saved ${filename}.` }
    } catch (err) {
      const code = err?.code || 'unavailable'
      // A decline is a decision, not a failure, and never gets retried.
      return { ok: false, declined: code === 'declined', message: HOST_MESSAGES[code] || `Could not save ${filename}.` }
    }
  }
  try {
    const blob = new Blob([text], { type: `${type};charset=utf-8` })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    // Revoking immediately can cancel the download in some browsers; a tick is
    // enough and the object is small.
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    return { ok: true, message: `Downloaded ${filename}.` }
  } catch {
    return { ok: false, message: `This browser would not save ${filename}.` }
  }
}

/** Kept for callers that do not need the outcome. */
export const download = (filename, text, type) => saveFile(filename, text, type)

export const downloadIR = (ir) => saveFile('archsim.lock.json', serializeIR(ir))

/**
 * The exact markdown the CI job would post. Not a summary of it — the same
 * thing, so what you copy from the studio and what lands on a pull request
 * cannot drift.
 */
export function gateMarkdown(result, base, config) {
  if (!result?.evaluation) return ''
  const rows = result.evaluation.results
  const failed = rows.filter((r) => r.verdict === 'fail').length
  const risky = rows.filter((r) => r.verdict === 'risk').length
  const title = failed ? `❌ ${failed} violation${failed > 1 ? 's' : ''}` : risky ? `⚠️ ${risky} risk${risky > 1 ? 's' : ''}` : '✅ all gates hold'
  const before = new Map((base?.evaluation?.results || []).map((r) => [r.slo.id, r]))
  const out = [`## 🏗️ ArchSim Architecture Gate — ${title}`, '']
  out.push('| SLO | main | this PR | verdict |', '|---|---|---|---|')
  for (const r of rows) {
    const was = before.get(r.slo.id)
    const cell = (x) => (!x ? '—' : x.slo?.metric === 'monthly_cost_usd' || r.slo.metric === 'monthly_cost_usd'
      ? `$${Math.round(x.observed).toLocaleString()}`
      : `${x.holdPct?.toFixed(0) ?? '—'}% of runs`)
    const icon = { pass: '✅', fail: '❌', risk: '⚠️', skip: '—' }[r.verdict]
    out.push(`| ${sloLabel(r.slo)} | ${cell(was)} | **${cell(r)}** | ${icon} |`)
  }
  if (result.quickFix?.steps?.length) {
    const d = result.quickFix.costDelta
    out.push('', `**Cheapest fix found:** ${result.quickFix.steps.map((s) => s.describe).join(', then ')}`)
    out.push(`${result.quickFix.fullyResolved ? 'restores every gate' : 'improves but does not clear every gate'} at **${d >= 0 ? '+' : '−'}$${Math.abs(Math.round(d)).toLocaleString()}/mo**.`)
  }
  for (const risk of result.risks || []) out.push('', risk.msg)
  out.push('', `<sub>${result.mc.runs} runs · seed ${config.seed} · scenarios: ${result.mc.scenarios.join(', ')}</sub>`)
  return out.join('\n') + '\n'
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Clipboard access is denied in plenty of legitimate contexts. Fall back to
    // a selection the user can copy rather than failing silently.
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch { return false }
  }
}

/* ── canvas export ────────────────────────────────────────────────────────── */

/** Inline the computed colours so the SVG stands alone outside the app. */
function standaloneSVG(svgEl) {
  const clone = svgEl.cloneNode(true)
  const style = getComputedStyle(document.documentElement)
  const tokens = ['--text', '--muted', '--border', '--accent', '--ok', '--warn', '--bad', '--chip-bg', '--panel', '--bg']
  const vars = tokens.map((t) => `${t}: ${style.getPropertyValue(t).trim()};`).join(' ')
  const css = [...document.styleSheets].flatMap((sheet) => {
    try { return [...sheet.cssRules].map((r) => r.cssText) } catch { return [] }
  }).filter((t) => /\.node|\.edge|\.arrowhead|\.hatch|\.hint|\.mini/.test(t)).join('\n')

  const box = svgEl.viewBox.baseVal
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  clone.setAttribute('width', box.width || svgEl.clientWidth)
  clone.setAttribute('height', box.height || svgEl.clientHeight)
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'style')
  defs.textContent = `:root { ${vars} }\nsvg { background: ${style.getPropertyValue('--bg').trim()}; font-family: ${style.getPropertyValue('--font-body').trim() || 'system-ui'}; }\n${css}`
  clone.insertBefore(defs, clone.firstChild)
  return new XMLSerializer().serializeToString(clone)
}

export const exportSVG = (svgEl, name = 'architecture.svg') =>
  saveFile(name, standaloneSVG(svgEl), 'image/svg+xml')

/** 2× so it survives a projector and a retina screen. */
export function exportPNG(svgEl, name = 'architecture.png', scale = 2) {
  return new Promise((resolve, reject) => {
    const box = svgEl.viewBox.baseVal
    const w = (box.width || svgEl.clientWidth) * scale
    const h = (box.height || svgEl.clientHeight) * scale
    const svg = standaloneSVG(svgEl)
    const img = new Image()
    img.onload = () => {
      const c = document.createElement('canvas')
      c.width = w; c.height = h
      const ctx = c.getContext('2d')
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#fff'
      ctx.fillRect(0, 0, w, h)
      ctx.drawImage(img, 0, 0, w, h)
      c.toBlob(async (blob) => {
        if (!blob) return reject(new Error('the browser refused to rasterise the canvas'))
        const host = await downloadsHost()
        if (host) {
          try { await host.save({ filename: name, data: blob }); return resolve({ ok: true, message: `Saved ${name}.` }) }
          catch (err) {
            const code = err?.code || 'unavailable'
            return resolve({ ok: false, declined: code === 'declined', message: HOST_MESSAGES[code] || `Could not save ${name}.` })
          }
        }
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url; a.download = name
        document.body.appendChild(a); a.click(); a.remove()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
        resolve({ ok: true, message: `Exported ${name} at 2×.` })
      }, 'image/png')
    }
    img.onerror = () => reject(new Error('the canvas could not be rendered to an image'))
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  })
}

/* ── share link ───────────────────────────────────────────────────────────── */

export function shareLink(ir) {
  const payload = serializeIR(ir)
  const packed = btoa(unescape(encodeURIComponent(payload)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${location.origin}${location.pathname}#ir=${packed}`
}

export function readShareLink(hash = location.hash) {
  const raw = (hash || '').replace(/^#ir=/, '')
  if (!raw || raw === hash) return null
  try {
    return decodeURIComponent(escape(atob(raw.replace(/-/g, '+').replace(/_/g, '/'))))
  } catch { return null }
}

export { irHash }
