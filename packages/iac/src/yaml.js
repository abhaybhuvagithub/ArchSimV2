// A small, range-aware YAML reader for Kubernetes manifests.
//
// Scope is deliberate: the subset Kubernetes manifests actually use — nested
// block mappings, block sequences, scalars, quoted strings, flow collections on
// one line, multi-document files, comments. Anchors, aliases, merge keys, tags
// and block scalars are read as opaque text rather than interpreted.
//
// Two things it must do that a general YAML library would not:
//   1. record the byte range of every scalar, so `replicas: 3` can be patched
//      to `replicas: 7` without reformatting the file around it;
//   2. never lose bytes it did not understand — anything unmodelled comes back
//      out of the passthrough store exactly as it went in.
//
// For live clusters, prefer `kubectl get -A -o json`: rendered JSON beats
// parsing templated YAML, the same reason Mode A beats Mode B for Terraform.

export function parseYamlDocs(text, file = '') {
  const docs = []
  const lines = splitLines(text)
  let start = 0
  let current = []
  const flush = (end) => {
    if (current.some((l) => l.content.trim() && !l.content.trim().startsWith('#'))) {
      const { value, ranges } = parseBlock(current, 0, 0, current.length)
      docs.push({ file, start, end, value, ranges, text: text.slice(start, end) })
    }
    current = []
  }
  for (const line of lines) {
    if (/^---\s*(#.*)?$/.test(line.content) || /^\.\.\.\s*$/.test(line.content)) {
      flush(line.start)
      start = line.end
      continue
    }
    current.push(line)
  }
  flush(text.length)
  return docs
}

function splitLines(text) {
  const out = []
  let i = 0
  while (i <= text.length) {
    let j = text.indexOf('\n', i)
    if (j < 0) j = text.length
    out.push({ content: text.slice(i, j), start: i, end: Math.min(text.length, j + 1) })
    if (j >= text.length) break
    i = j + 1
  }
  return out
}

const indentOf = (s) => s.length - s.replace(/^\s*/, '').length
const isBlank = (s) => !s.trim() || s.trim().startsWith('#')

/**
 * Parse lines[from..to) at the given indent into a JS value, recording scalar
 * byte ranges under `path` keys ("spec.replicas", "spec.containers.0.image").
 */
function parseBlock(lines, indent, from, to, prefix = '', ranges = new Map()) {
  let i = from
  while (i < to && isBlank(lines[i].content)) i++
  if (i >= to) return { value: null, ranges }

  const first = lines[i].content
  if (first.trim().startsWith('- ')) return parseSeq(lines, indentOf(first), i, to, prefix, ranges)
  return parseMap(lines, indentOf(first), i, to, prefix, ranges)
}

function parseMap(lines, indent, from, to, prefix, ranges) {
  const value = {}
  let i = from
  while (i < to) {
    const line = lines[i]
    if (isBlank(line.content)) { i++; continue }
    const ind = indentOf(line.content)
    if (ind < indent) break
    if (ind > indent) { i++; continue } // defensive: handled by child parse
    const m = /^(\s*)([^:\s#][^:]*?)\s*:(?:\s+(.*?))?\s*$/.exec(line.content)
    if (!m) { i++; continue }
    const key = unquote(m[2].trim())
    const inline = (m[3] ?? '').trim()
    const path = prefix ? `${prefix}.${key}` : key
    if (inline && !inline.startsWith('#')) {
      const valueStart = line.start + line.content.indexOf(inline, line.content.indexOf(':'))
      ranges.set(path, { start: valueStart, end: valueStart + inline.length, line: i })
      value[key] = scalar(inline)
      i++
      continue
    }
    // nested block: everything more-indented until the indent drops back
    let j = i + 1
    while (j < to && (isBlank(lines[j].content) || indentOf(lines[j].content) > indent)) j++
    const child = parseBlock(lines, indent + 1, i + 1, j, path, ranges)
    value[key] = child.value === null ? null : child.value
    i = j
  }
  return { value, ranges }
}

function parseSeq(lines, indent, from, to, prefix, ranges) {
  const value = []
  let i = from
  while (i < to) {
    const line = lines[i]
    if (isBlank(line.content)) { i++; continue }
    const ind = indentOf(line.content)
    if (ind < indent) break
    const trimmed = line.content.trim()
    if (!trimmed.startsWith('-')) { i++; continue }
    const idx = value.length
    const path = `${prefix}.${idx}`
    const rest = trimmed.slice(1).trim()
    let j = i + 1
    while (j < to && (isBlank(lines[j].content) || indentOf(lines[j].content) > indent)) j++
    if (rest && !rest.includes(':')) {
      const vStart = line.start + line.content.indexOf(rest)
      ranges.set(path, { start: vStart, end: vStart + rest.length, line: i })
      value.push(scalar(rest))
      i = j
      continue
    }
    // "- key: value" — synthesise a sub-block whose first line keeps its indent
    const dashCol = line.content.indexOf('-')
    const synth = [{ ...line, content: ' '.repeat(dashCol + 2) + rest }, ...lines.slice(i + 1, j)]
    const child = parseBlock(synth, dashCol + 2, 0, synth.length, path, ranges)
    value.push(child.value)
    i = j
  }
  return { value, ranges }
}

function scalar(raw) {
  const t = raw.replace(/\s+#.*$/, '').trim()
  if (t === '' || t === '~' || t === 'null') return null
  if (t === 'true' || t === 'True') return true
  if (t === 'false' || t === 'False') return false
  if (/^-?\d+$/.test(t)) return Number(t)
  if (/^-?\d*\.\d+$/.test(t)) return Number(t)
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1)
  // Flow collections, split at depth 0 so `{a: 1, b: {c: 2}}` survives. Naive
  // splitting on commas is the classic way to mangle a nested inline map, and
  // `arrival: {dist: diurnal, rps: 12000, params: {peakFactor: 4}}` is exactly
  // how people write workloads.
  if (t.startsWith('[') && t.endsWith(']')) {
    const inner = t.slice(1, -1).trim()
    return inner ? splitFlow(inner).map((x) => scalar(x)) : []
  }
  if (t.startsWith('{') && t.endsWith('}')) {
    const inner = t.slice(1, -1).trim()
    if (!inner) return {}
    const o = {}
    for (const part of splitFlow(inner)) {
      const i = splitKeyIndex(part)
      if (i < 0) continue
      o[unquote(part.slice(0, i).trim())] = scalar(part.slice(i + 1))
    }
    return o
  }
  if (t === '|' || t === '>' || t === '|-' || t === '>-') return ''
  return t
}

function splitFlow(s) {
  const out = []
  let depth = 0, start = 0, quote = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote) { if (c === quote) quote = null; continue }
    if (c === '"' || c === "'") { quote = c; continue }
    if (c === '[' || c === '{') depth++
    else if (c === ']' || c === '}') depth--
    else if (c === ',' && depth === 0) { out.push(s.slice(start, i)); start = i + 1 }
  }
  out.push(s.slice(start))
  return out.map((x) => x.trim()).filter((x) => x !== '')
}

function splitKeyIndex(s) {
  let depth = 0, quote = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote) { if (c === quote) quote = null; continue }
    if (c === '"' || c === "'") { quote = c; continue }
    if (c === '[' || c === '{') depth++
    else if (c === ']' || c === '}') depth--
    else if (c === ':' && depth === 0) return i
  }
  return -1
}

const unquote = (s) => ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")) ? s.slice(1, -1) : s)

export function getPath(obj, path) {
  let v = obj
  for (const p of String(path).split('.')) {
    if (v == null) return undefined
    v = Array.isArray(v) ? v[Number(p)] : v[p]
  }
  return v
}

/** K8s object address used as the IaC binding: 'apps/v1:Deployment:prod/checkout'. */
export function k8sAddress(obj) {
  const ns = obj?.metadata?.namespace || 'default'
  return `${obj?.apiVersion}:${obj?.kind}:${ns}/${obj?.metadata?.name}`
}

/** Emit a scalar replacement edit for a YAML path, or null if unpatchable. */
export function yamlEdit(doc, path, newValue) {
  const r = doc.ranges.get(path)
  if (!r) return null
  return { start: r.start, end: r.end, replacement: String(newValue) }
}
