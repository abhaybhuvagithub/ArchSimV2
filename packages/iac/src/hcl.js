// A concrete syntax tree for HCL — concrete meaning comments, formatting and
// byte offsets survive.
//
// Why not a full HCL evaluator: raw HCL is a programming language. `for_each`,
// `dynamic`, functions, module indirection, provider-shaped variables — a tool
// that tries to evaluate all of it is a tool that spends three years being
// almost right. Mode A (plan JSON) exists precisely so we never have to.
//
// What this parser is for is Mode B and, more importantly, *emission*: to
// rewrite `count = 7` without disturbing the comment above it, we need the byte
// range of that expression and nothing else. Anything this parser does not
// understand it stores verbatim and hands back unchanged, which is the whole
// anti-tarpit rule in one sentence.

export function parseHCL(text, file = '') {
  const p = new Parser(text, file)
  return { file, text, body: p.parseBody(0, text.length), errors: p.errors }
}

class Parser {
  constructor(text, file) {
    this.s = text
    this.i = 0
    this.file = file
    this.errors = []
  }

  parseBody(from, to) {
    this.i = from
    const items = []
    while (this.i < to) {
      this.skipTrivia(to, items)
      if (this.i >= to) break
      const start = this.i
      const item = this.parseItem(to)
      if (!item) {
        // Unparseable line: keep it verbatim rather than dropping it.
        const end = this.lineEnd(to)
        if (end <= start) { this.i = start + 1; continue }
        items.push({ type: 'raw', start, end, text: this.s.slice(start, end) })
        this.i = end
        continue
      }
      items.push(item)
    }
    return items
  }

  parseItem(to) {
    const start = this.i
    const ident = this.readIdent()
    if (!ident) return null
    this.skipInline()
    // attribute:  name = expr
    if (this.s[this.i] === '=' && this.s[this.i + 1] !== '=') {
      this.i++
      this.skipInline()
      const valueStart = this.i
      const valueEnd = this.readExpression(to)
      const raw = this.s.slice(valueStart, valueEnd)
      this.i = valueEnd
      return {
        type: 'attribute', name: ident, start, end: valueEnd,
        valueStart, valueEnd, raw, value: literal(raw),
        dynamic: isDynamic(raw),
      }
    }
    // block:  name "label" "label" { ... }
    const labels = []
    while (this.i < to) {
      this.skipInline()
      if (this.s[this.i] === '"') { labels.push(this.readStringLiteral()); continue }
      if (this.s[this.i] === '{') break
      const w = this.readIdent()
      if (w) { labels.push(w); continue }
      break
    }
    this.skipInline()
    if (this.s[this.i] !== '{') return null
    const bodyStart = this.i + 1
    const bodyEnd = this.matchBrace(this.i)
    if (bodyEnd < 0) { this.errors.push({ file: this.file, at: start, msg: 'unbalanced {' }); return null }
    const inner = new Parser(this.s, this.file)
    const items = inner.parseBody(bodyStart, bodyEnd)
    this.errors.push(...inner.errors)
    this.i = bodyEnd + 1
    return { type: 'block', name: ident, labels, start, end: this.i, bodyStart, bodyEnd, items }
  }

  readIdent() {
    const m = /^[A-Za-z_][A-Za-z0-9_.\-]*/.exec(this.s.slice(this.i))
    if (!m) return null
    this.i += m[0].length
    return m[0]
  }

  /**
   * Consume a quoted string, including its interpolations.
   *
   * `"${formatlist("arn:aws:ssm:%s", var.x)}"` is one string, and a scanner that
   * stops at the next quote stops in the middle of it — after which every brace
   * in the file is counted wrong and the enclosing block never closes. HCL
   * strings nest arbitrarily (`"${jsonencode({k = "v"})}"`), so interpolations
   * are tracked by depth and inner strings are consumed recursively.
   */
  readStringLiteral() {
    const start = this.i
    this.i++ // opening quote
    let interp = 0
    while (this.i < this.s.length) {
      const c = this.s[this.i]
      if (c === '\\') { this.i += 2; continue }
      // ${…} interpolation and %{…} template directive
      if ((c === '$' || c === '%') && this.s[this.i + 1] === '{') { interp++; this.i += 2; continue }
      if (interp > 0) {
        if (c === '"') { this.readStringLiteral(); continue }
        if (c === '{') interp++
        else if (c === '}') interp--
        this.i++
        continue
      }
      if (c === '"') { this.i++; break }
      this.i++
    }
    return this.s.slice(start + 1, this.i - 1)
  }

  /** Consume one expression, respecting nesting, strings and heredocs. */
  readExpression(to) {
    let depth = 0
    while (this.i < to) {
      const c = this.s[this.i]
      if (c === '"') { this.readStringLiteral(); continue }
      if (c === '<' && this.s.slice(this.i, this.i + 2) === '<<') { this.skipHeredoc(to); continue }
      if (c === '#' || (c === '/' && this.s[this.i + 1] === '/')) { if (depth === 0) break; this.skipToLineEnd(to); continue }
      if (c === '/' && this.s[this.i + 1] === '*') { this.skipBlockComment(to); continue }
      if (c === '{' || c === '[' || c === '(') { depth++; this.i++; continue }
      if (c === '}' || c === ']' || c === ')') {
        if (depth === 0) break
        depth--; this.i++; continue
      }
      if (c === '\n' && depth === 0) break
      this.i++
    }
    // trim trailing whitespace out of the value range so patches stay tight
    let end = this.i
    while (end > 0 && /\s/.test(this.s[end - 1])) end--
    return end
  }

  skipHeredoc(to) {
    const m = /^<<[-~]?([A-Za-z0-9_]+)\r?\n/.exec(this.s.slice(this.i))
    if (!m) { this.i += 2; return }
    const tag = m[1]
    this.i += m[0].length
    // `<<-` allows an indented terminator, so anchoring on "\nEOT" would run off
    // the end of the file and take the enclosing block's closing brace with it.
    const close = new RegExp(`\\n[ \\t]*${tag}[ \\t]*(?=\\r?\\n|$)`)
    const rest = this.s.slice(this.i)
    const found = close.exec(rest)
    this.i = found ? this.i + found.index + found[0].length : to
  }

  matchBrace(open) {
    let depth = 0
    let j = open
    while (j < this.s.length) {
      const c = this.s[j]
      if (c === '"') { const save = this.i; this.i = j; this.readStringLiteral(); j = this.i; this.i = save; continue }
      if (c === '#' || (c === '/' && this.s[j + 1] === '/')) { while (j < this.s.length && this.s[j] !== '\n') j++; continue }
      if (c === '/' && this.s[j + 1] === '*') { const e = this.s.indexOf('*/', j + 2); j = e < 0 ? this.s.length : e + 2; continue }
      if (c === '<' && this.s.slice(j, j + 2) === '<<') { const save = this.i; this.i = j; this.skipHeredoc(this.s.length); j = this.i; this.i = save; continue }
      if (c === '{') depth++
      if (c === '}') { depth--; if (depth === 0) return j }
      j++
    }
    return -1
  }

  skipInline() { while (this.i < this.s.length && (this.s[this.i] === ' ' || this.s[this.i] === '\t')) this.i++ }
  skipToLineEnd(to) { while (this.i < to && this.s[this.i] !== '\n') this.i++ }
  skipBlockComment(to) { const e = this.s.indexOf('*/', this.i + 2); this.i = e < 0 ? to : e + 2 }
  lineEnd(to) { let j = this.i; while (j < to && this.s[j] !== '\n') j++; return Math.min(to, j + 1) }

  /** Comments and blank lines are items too: emission re-plays them verbatim. */
  skipTrivia(to, items) {
    while (this.i < to) {
      const c = this.s[this.i]
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { this.i++; continue }
      if (c === '#' || (c === '/' && this.s[this.i + 1] === '/')) {
        const start = this.i
        this.skipToLineEnd(to)
        items.push({ type: 'comment', start, end: this.i, text: this.s.slice(start, this.i) })
        continue
      }
      if (c === '/' && this.s[this.i + 1] === '*') {
        const start = this.i
        this.skipBlockComment(to)
        items.push({ type: 'comment', start, end: this.i, text: this.s.slice(start, this.i) })
        continue
      }
      return
    }
  }
}

/** Terraform address for a resource/module/data block. */
export function addressOf(block, modulePrefix = '') {
  const p = modulePrefix ? `${modulePrefix}.` : ''
  switch (block.name) {
    case 'resource': return `${p}${block.labels[0]}.${block.labels[1]}`
    case 'data': return `${p}data.${block.labels[0]}.${block.labels[1]}`
    case 'module': return `${p}module.${block.labels[0]}`
    case 'variable': return `${p}var.${block.labels[0]}`
    case 'output': return `${p}output.${block.labels[0]}`
    case 'provider': return `${p}provider.${block.labels[0]}`
    default: return `${p}${block.name}${block.labels.length ? '.' + block.labels.join('.') : ''}`
  }
}

/** Flatten a block body into {attrs, blocks} with the CST nodes retained. */
export function bodyOf(block) {
  const attrs = {}
  const blocks = []
  for (const item of block.items || []) {
    if (item.type === 'attribute') attrs[item.name] = item
    else if (item.type === 'block') blocks.push(item)
  }
  return { attrs, blocks }
}

/** Attribute values as plain JS where we can, `undefined` where we cannot. */
export function attrValue(attrNode) {
  if (!attrNode) return undefined
  return attrNode.dynamic ? undefined : attrNode.value
}

export function isDynamic(raw) {
  const t = raw.trim()
  if (/^-?\d+(\.\d+)?$/.test(t)) return false
  if (/^(true|false|null)$/.test(t)) return false
  if (/^"(?:[^"\\$]|\\.)*"$/.test(t)) return false // plain string, no interpolation
  return true
}

export function literal(raw) {
  const t = raw.trim()
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t)
  if (t === 'true') return true
  if (t === 'false') return false
  if (t === 'null') return null
  const m = /^"((?:[^"\\]|\\.)*)"$/.exec(t)
  if (m && !m[1].includes('${')) return m[1].replace(/\\(.)/g, '$1')
  // simple literal list of strings/numbers
  if (t.startsWith('[') && t.endsWith(']')) {
    const inner = t.slice(1, -1).trim()
    if (!inner) return []
    const parts = splitTopLevel(inner)
    const vals = parts.map((x) => literal(x))
    if (vals.every((v) => v !== undefined)) return vals
  }
  return undefined
}

function splitTopLevel(s) {
  const out = []
  let depth = 0, start = 0, inStr = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue }
    if (c === '"') { inStr = true; continue }
    if ('[{('.includes(c)) depth++
    if (']})'.includes(c)) depth--
    if (c === ',' && depth === 0) { out.push(s.slice(start, i)); start = i + 1 }
  }
  out.push(s.slice(start))
  return out.map((x) => x.trim()).filter(Boolean)
}

/**
 * Surgical patch: replace byte ranges, leaving every other byte untouched.
 * Edits are applied back-to-front so earlier offsets stay valid.
 */
export function applyEdits(text, edits) {
  const sorted = edits.slice().sort((a, b) => b.start - a.start)
  let out = text
  for (const e of sorted) {
    if (e.start < 0 || e.end > out.length || e.start > e.end) throw new Error(`edit out of range: ${e.start}..${e.end}`)
    out = out.slice(0, e.start) + e.replacement + out.slice(e.end)
  }
  return out
}

/** Walk every block in a parsed file, depth-first, with its parent chain. */
export function* walkBlocks(parsed, items = parsed.body, parents = []) {
  for (const item of items) {
    if (item.type !== 'block') continue
    yield { block: item, parents }
    yield* walkBlocks(parsed, item.items, [...parents, item])
  }
}
