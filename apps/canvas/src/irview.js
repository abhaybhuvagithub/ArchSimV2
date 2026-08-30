// Mapping the IR document back to the things on the canvas.
//
// The studio's central claim is that the IR is the source of truth and the
// diagram is one projection of it. You could not see the IR. This is the half
// of that fix which is worth testing on its own: given the serialized document,
// which lines belong to which node or edge?
//
// It is done by scanning rather than by re-parsing, because the text is what
// gets displayed and a second parse could disagree with it. The scan tracks
// brace depth, so a nested object inside a node — capacity, bindings, attrs —
// stays inside its parent's range instead of ending it early.

/**
 * Line ranges for every object in the document that carries an `id`.
 *
 * @param {string} text  the serialized IR, one object per line-ish (JSON, 2-space)
 * @returns {Map<string, {start: number, end: number}>} id → 0-based inclusive line range
 */
export function irLineRanges(text) {
  const lines = text.split('\n')
  const ranges = new Map()

  // Every open brace pushes the line it started on. When a brace closes, if the
  // object it closes declared an id, that id spans from its opening line to
  // this one.
  /** @type {{line: number, id: string|null}[]} */
  const stack = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // Strings can contain braces. The IR's ids, labels and addresses are
    // ordinary text, but an attrs value could hold anything, so brace counting
    // ignores whatever sits inside quotes.
    let inStr = false
    let escaped = false
    for (let c = 0; c < line.length; c++) {
      const ch = line[c]
      if (escaped) { escaped = false; continue }
      if (ch === '\\') { escaped = true; continue }
      if (ch === '"') { inStr = !inStr; continue }
      if (inStr) continue
      if (ch === '{') stack.push({ line: i, id: null })
      else if (ch === '}') {
        const open = stack.pop()
        if (open?.id) ranges.set(open.id, { start: open.line, end: i })
      }
    }
    // `"id": "01J..."` claims the object currently being built.
    const m = line.match(/^\s*"id"\s*:\s*"([^"]+)"/)
    if (m && stack.length) stack[stack.length - 1].id = m[1]
  }
  return ranges
}

/** The serialized document plus its line index, computed once together. */
export function irDocument(ir) {
  const text = JSON.stringify(ir, null, 2)
  return { text, lines: text.split('\n'), ranges: irLineRanges(text) }
}

/**
 * Which id owns a given line, innermost first.
 *
 * Hovering a line in the document should highlight the node it belongs to, and
 * a line inside `capacity` belongs to the node, not to the document.
 */
export function ownerOfLine(ranges, line) {
  let best = null
  for (const [id, r] of ranges) {
    if (line < r.start || line > r.end) continue
    if (!best || (r.end - r.start) < (best.span)) best = { id, span: r.end - r.start }
  }
  return best?.id ?? null
}
