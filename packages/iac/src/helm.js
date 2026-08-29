// Helm charts.
//
// A rendered chart — `helm template` output — is ordinary Kubernetes YAML and
// already ingests. This module is for the case where you have the chart and not
// the render: a repository with `Chart.yaml`, `values.yaml` and a `templates/`
// directory, and no Helm binary in the loop.
//
// The temptation is to implement Go templates. Resist it. Go's template
// language has conditionals, ranges, pipelines, named sub-templates, `include`,
// `tpl`, and a hundred-odd Sprig functions; a partial implementation does not
// fail on the parts it does not support, it silently renders something *else*,
// and a manifest that is silently wrong is worse than one that was never read.
//
// So the rule here is: substitute the values that can be substituted, and
// refuse — loudly, by name and line — the moment control flow appears. A chart
// of plain `{{ .Values.x }}` substitutions renders exactly. A chart with an
// `{{- if .Values.ingress.enabled }}` block comes back as a refusal that says
// which file and which construct, and points at `helm template`, which is the
// tool that already does this correctly.

import { parseYamlDocs } from './yaml.js'
import { k8sToIR } from './ingest.js'

/** Constructs that change the *shape* of the output rather than a value in it. */
const CONTROL_FLOW = [
  { re: /\{\{-?\s*if\b/, what: 'if' },
  { re: /\{\{-?\s*range\b/, what: 'range' },
  { re: /\{\{-?\s*with\b/, what: 'with' },
  { re: /\{\{-?\s*define\b/, what: 'define' },
  { re: /\{\{-?\s*block\b/, what: 'block' },
  { re: /\{\{-?\s*template\b/, what: 'template' },
  { re: /\{\{-?\s*include\b/, what: 'include' },
  { re: /\{\{-?\s*tpl\b/, what: 'tpl' },
  { re: /\{\{-?\s*toYaml\b/, what: 'toYaml' },
]

/**
 * A chart, from the files a caller already read.
 *
 * @param files `[{ path, text }]` — Chart.yaml, values.yaml and templates/*
 * @returns `{ rendered: [{path, text}], refused: [{path, line, what}], chart, values }`
 */
export function renderChart(files, opts = {}) {
  const find = (name) => files.find((f) => f.path.replace(/\\/g, '/').endsWith(name))
  const chartFile = find('Chart.yaml') || find('Chart.yml')
  const valuesFile = find('values.yaml') || find('values.yml')

  const chart = chartFile ? firstDoc(chartFile.text) : null
  const declared = valuesFile ? firstDoc(valuesFile.text) : {}
  // Overrides layer on top of the chart's own defaults, exactly as `-f` does.
  const values = deepMerge(declared || {}, opts.values || {})

  const rendered = []
  const refused = []

  for (const f of files) {
    const p = f.path.replace(/\\/g, '/')
    if (!/\/templates\/.+\.(ya?ml)$/.test(p)) continue
    // `_helpers.tpl` and friends define named templates; they render nothing.
    if (/\/_/.test(p)) continue

    const flow = findControlFlow(f.text)
    if (flow) {
      refused.push({ path: f.path, line: flow.line, what: flow.what })
      continue
    }
    rendered.push({
      path: f.path,
      text: substitute(f.text, {
        values,
        chart: chartContext(chart),
        release: opts.release || { Name: opts.releaseName || 'release', Namespace: opts.namespace || 'default' },
      }),
    })
  }

  return { rendered, refused, chart, values }
}

/**
 * Helm exposes `Chart.yaml` through a Go struct, so its fields are capitalised
 * — `.Chart.Name` reads the file's `name` key. Without this every
 * `{{ .Chart.Name }}` renders as itself and the component is called
 * `{{ .Chart.Name }}-api` on the canvas, which is how you know a renderer is
 * lying to you.
 */
function chartContext(chart) {
  if (!chart) return {}
  const out = {}
  for (const [k, v] of Object.entries(chart)) out[k.charAt(0).toUpperCase() + k.slice(1)] = v
  return out
}

function findControlFlow(text) {
  const lines = String(text).split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    for (const c of CONTROL_FLOW) if (c.re.test(lines[i])) return { line: i + 1, what: c.what }
  }
  return null
}

/**
 * `{{ .Values.a.b }}`, `{{ .Chart.Name }}`, `{{ .Release.Name }}` and the
 * `| default x` / `| quote` pipelines — the substitutions that cannot change
 * the document's structure. Anything else present after control flow has been
 * ruled out is left as-is, which the YAML reader then sees as an opaque string;
 * that is visible in the output rather than silently dropped.
 */
export function substitute(text, ctx) {
  return String(text).replace(/\{\{-?\s*([^}]+?)\s*-?\}\}/g, (whole, expr) => {
    const [pathPart, ...pipes] = expr.split('|').map((s) => s.trim())
    let value = lookup(pathPart, ctx)

    for (const pipe of pipes) {
      const [fn, ...args] = pipe.split(/\s+/)
      if (fn === 'default') { if (value === undefined || value === null || value === '') value = literal(args.join(' ')) }
      else if (fn === 'quote') { return JSON.stringify(String(value ?? '')) }
      else if (fn === 'upper') value = String(value ?? '').toUpperCase()
      else if (fn === 'lower') value = String(value ?? '').toLowerCase()
      else if (fn === 'trim') value = String(value ?? '').trim()
      else if (fn === 'int' || fn === 'toString') value = value
      else return whole // an unknown pipeline is left visible, not guessed
    }

    if (value === undefined || value === null) return whole
    if (typeof value === 'object') return whole
    return String(value)
  })
}

function lookup(expr, ctx) {
  const e = expr.trim()
  if (/^["'].*["']$/.test(e)) return e.slice(1, -1)
  if (!e.startsWith('.')) return undefined
  const path = e.slice(1).split('.')
  const root = path.shift()
  const base = root === 'Values' ? ctx.values
    : root === 'Chart' ? ctx.chart
      : root === 'Release' ? ctx.release
        : undefined
  let cur = base
  for (const seg of path) {
    if (cur === undefined || cur === null) return undefined
    cur = cur[seg]
  }
  return cur
}

const literal = (s) => {
  const t = String(s).trim()
  if (/^-?\d+$/.test(t)) return Number(t)
  if (/^["'].*["']$/.test(t)) return t.slice(1, -1)
  if (t === 'true') return true
  if (t === 'false') return false
  return t
}

const firstDoc = (text) => parseYamlDocs(text, '').find((d) => d.value && typeof d.value === 'object')?.value || {}

function deepMerge(a, b) {
  const out = { ...a }
  for (const [k, v] of Object.entries(b || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && a?.[k] && typeof a[k] === 'object'
      ? deepMerge(a[k], v)
      : v
  }
  return out
}

/**
 * Chart → IR, through the Kubernetes path.
 *
 * The report carries every refusal, so a chart that is half-renderable produces
 * half an architecture and says which half is missing and why — rather than a
 * plausible-looking whole that is quietly wrong.
 */
export function helmToIR(files, opts = {}) {
  const { rendered, refused, chart, values } = renderChart(files, opts)
  const objects = []
  const warnings = []

  for (const f of rendered) {
    for (const doc of parseYamlDocs(f.text, f.path)) {
      const obj = doc.value
      if (obj && typeof obj === 'object' && obj.kind && obj.apiVersion) objects.push(obj)
    }
  }

  for (const r of refused) {
    warnings.push({
      address: r.path,
      msg: `skipped: '${r.what}' at line ${r.line} is Go-template control flow, which changes the shape of the manifest rather than a value in it. Run \`helm template\` and ingest the output — ArchSim will not guess at what a conditional block renders to.`,
    })
  }

  const { ir, report } = k8sToIR(objects, {
    ...opts,
    file: opts.file || (chart?.name ? `${chart.name}/templates` : 'chart/templates'),
    name: opts.name || chart?.name || 'helm-chart',
  })
  report.warnings.push(...warnings)
  report.chart = chart ? { name: chart.name, version: chart.version, appVersion: chart.appVersion } : null
  report.rendered = rendered.length
  report.refused = refused.length
  report.values = values
  return { ir, report }
}

/** Does this file list look like a chart? */
export const looksLikeChart = (files) =>
  files.some((f) => /(^|\/)Chart\.ya?ml$/.test(String(f.path).replace(/\\/g, '/')))
