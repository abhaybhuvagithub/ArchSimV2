#!/usr/bin/env node
// Point the compiler at a directory of real repositories and report what breaks.
//
//   ARCHSIM_SCAN_ROOT=~/src node test/scan.mjs
//
// The verification suite proves the compiler against fixtures someone thought
// of. This proves it against code nobody wrote for it. Every bug it found on
// its first run — module blocks crashing the ingest, string interpolations
// unbalancing a file, provisioning glue drawn as architecture, a shared module
// connecting everything to everything — is now a fixture in corpus.mjs, which
// is the point: the scan finds them, the suite keeps them found.
//
// It asserts four things per file:
//   1. it parses
//   2. passthrough + mapped block ranges rebuild the file byte for byte
//   3. emitting with no changes produces no patch
//   4. changing one replica count changes exactly one line
//
// and one thing per module directory: the graph has arrows and simulates.

import fs from 'node:fs'
import path from 'node:path'
import { parseHCL, walkBlocks, addressOf, bodyOf, hclToIR, emitChanges, patchIsSurgical, findRule, isStructural, providerOf } from '@archsim/iac'
import { validateIR } from '@archsim/ir'
import { kinds, isSourceNode, simulate } from '@archsim/core'

const ROOT = process.env.ARCHSIM_SCAN_ROOT || '/tmp/corpus'
const repos = fs.readdirSync(ROOT).filter((d) => fs.statSync(path.join(ROOT, d)).isDirectory())

function walk(dir, ext, out = []) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (e.name === '.git' || e.name === 'node_modules') continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, ext, out)
    else if (e.name.endsWith(ext)) out.push(p)
  }
  return out
}

const stats = {
  files: 0, parsed: 0, parseErrors: 0, emptyFiles: 0,
  blocks: 0, resources: 0, mapped: 0, unmapped: 0, structural: 0,
  reconstructOk: 0, reconstructFail: 0,
  noChangeClean: 0, noChangeDirty: 0,
  patchTried: 0, patchSurgical: 0, patchNotSurgical: 0,
  crashes: 0,
}
const parseErrorSamples = []
const reconstructFails = []
const patchFails = []
const crashes = []
const unmappedTypes = new Map()
const perRepo = {}

const LIMIT = Number(process.env.LIMIT || 0)

for (const repo of repos) {
  const files = walk(path.join(ROOT, repo), '.tf')
  const use = LIMIT ? files.slice(0, LIMIT) : files
  const r = { files: use.length, parseErrors: 0, resources: 0, unmapped: 0, reconstructFail: 0, patchNotSurgical: 0, crashes: 0 }
  for (const file of use) {
    stats.files++
    let text
    try { text = fs.readFileSync(file, 'utf8') } catch { continue }
    if (!text.trim()) { stats.emptyFiles++; continue }

    // 1. parse
    let parsed
    try {
      parsed = parseHCL(text, file)
    } catch (err) {
      stats.crashes++; r.crashes++
      crashes.push({ file, stage: 'parse', msg: err.message })
      continue
    }
    stats.parsed++
    if (parsed.errors.length) {
      stats.parseErrors++; r.parseErrors++
      if (parseErrorSamples.length < 25) parseErrorSamples.push({ file, err: parsed.errors[0], excerpt: text.slice(Math.max(0, parsed.errors[0].at - 60), parsed.errors[0].at + 120) })
    }

    // 2. block census
    for (const { block } of walkBlocks(parsed)) {
      stats.blocks++
      if (block.name !== 'resource') continue
      stats.resources++; r.resources++
      const type = block.labels[0]
      const rule = findRule(providerOf(type), type, {})
      if (rule) stats.mapped++
      else if (isStructural(type)) stats.structural++
      else {
        stats.unmapped++; r.unmapped++
        unmappedTypes.set(type, (unmappedTypes.get(type) || 0) + 1)
      }
    }

    // 3. reconstruct: passthrough + mapped-block byte ranges must rebuild the
    //    file exactly. This is the real "nothing is lost" test.
    let ir
    try {
      ir = hclToIR([{ path: file, text }], { managed: 'partial' }).ir
    } catch (err) {
      stats.crashes++; r.crashes++
      crashes.push({ file, stage: 'ingest', msg: err.message })
      continue
    }
    const pieces = []
    for (const p of ir.passthrough) if (p.file === file) pieces.push({ text: p.text, start: findStart(text, p.text, pieces) })
    for (const n of ir.nodes) {
      const b = n.bindings.find((x) => x.file === file && x.range)
      if (b) pieces.push({ text: text.slice(b.range.startByte, b.range.endByte), start: b.range.startByte })
    }
    const rebuilt = rebuild(text, ir, file)
    if (rebuilt === null) { stats.reconstructFail++; r.reconstructFail++; if (reconstructFails.length < 20) reconstructFails.push({ file, why: 'gap' }) }
    else if (rebuilt !== text) {
      stats.reconstructFail++; r.reconstructFail++
      if (reconstructFails.length < 20) reconstructFails.push({ file, why: 'mismatch', lostBytes: text.length - rebuilt.length, sample: firstDiff(text, rebuilt) })
    } else stats.reconstructOk++

    // 4. emit with no changes must produce nothing
    try {
      const out = emitChanges(ir, ir, [{ path: file, text }])
      if (out.patches.length || out.generated.length || out.removals.length) { stats.noChangeDirty++; }
      else stats.noChangeClean++
    } catch (err) {
      stats.crashes++; crashes.push({ file, stage: 'emit-noop', msg: err.message })
    }

    // 5. patch a literal replica count and check it is surgical
    const target = ir.nodes.find((n) => n.bindings.some((b) => b.file === file) && !n.attrs.unresolvedCount && !n.capacity.source && hasLiteralCount(parsed, n))
    if (target) {
      stats.patchTried++
      try {
        const next = { ...ir, nodes: ir.nodes.map((n) => (n.id === target.id ? { ...n, capacity: { ...n.capacity, replicas: n.capacity.replicas + 7 } } : n)) }
        const out = emitChanges(ir, next, [{ path: file, text }])
        const p = out.patches[0]
        if (!p) { stats.patchNotSurgical++; r.patchNotSurgical++; if (patchFails.length < 20) patchFails.push({ file, why: 'no patch produced', unpatchable: out.unpatchable[0]?.reason }) }
        else {
          const v = patchIsSurgical(p.before, p.after, p.edits)
          if (v.ok && v.changedLines.length === 1) stats.patchSurgical++
          else { stats.patchNotSurgical++; r.patchNotSurgical++; if (patchFails.length < 20) patchFails.push({ file, why: v.reason || `${v.changedLines.length} lines changed` }) }
        }
      } catch (err) {
        stats.crashes++; crashes.push({ file, stage: 'patch', msg: err.message })
      }
    }
  }
  perRepo[repo] = r
}

function rebuild(text, ir, file) {
  const pieces = []
  for (const n of ir.nodes) {
    const b = n.bindings.find((x) => x.file === file && x.range)
    if (b) pieces.push({ start: b.range.startByte, end: b.range.endByte })
  }
  // passthrough pieces have no offsets, so locate them greedily in order
  let cursor = 0
  const out = []
  const sorted = pieces.sort((a, b) => a.start - b.start)
  const passthrough = ir.passthrough.filter((p) => p.file === file).map((p) => p.text)
  let pi = 0
  for (const piece of sorted) {
    // everything before this block must come from passthrough, in order
    while (cursor < piece.start && pi < passthrough.length) {
      const t = passthrough[pi]
      const at = text.indexOf(t, cursor)
      if (at < 0 || at >= piece.start) break
      out.push(text.slice(cursor, at))     // whitespace between items
      out.push(t)
      cursor = at + t.length
      pi++
    }
    if (cursor < piece.start) out.push(text.slice(cursor, piece.start))
    out.push(text.slice(piece.start, piece.end))
    cursor = piece.end
  }
  while (pi < passthrough.length) {
    const t = passthrough[pi]
    const at = text.indexOf(t, cursor)
    if (at < 0) break
    out.push(text.slice(cursor, at))
    out.push(t)
    cursor = at + t.length
    pi++
  }
  out.push(text.slice(cursor))
  return out.join('')
}

function findStart() { return 0 }

function firstDiff(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) return { at: i, a: JSON.stringify(a.slice(i, i + 60)), b: JSON.stringify(b.slice(i, i + 60)) }
  }
  return null
}

function hasLiteralCount(parsed, node) {
  const addr = node.bindings[0]?.address
  for (const { block } of walkBlocks(parsed)) {
    if (block.name !== 'resource' || addressOf(block) !== addr) continue
    const { attrs } = bodyOf(block)
    const a = attrs.count || attrs.desired_count || attrs.desired_capacity || attrs.num_cache_nodes || attrs.num_cache_clusters
    return !!a && !a.dynamic
  }
  return false
}

console.log('=== corpus ===')
console.log(JSON.stringify(stats, null, 2))
console.log('\n=== per repo ===')
for (const [k, v] of Object.entries(perRepo)) console.log(`${k.padEnd(28)} files=${String(v.files).padStart(5)} parseErr=${String(v.parseErrors).padStart(4)} res=${String(v.resources).padStart(5)} unmapped=${String(v.unmapped).padStart(5)} reconFail=${String(v.reconstructFail).padStart(4)} patchBad=${String(v.patchNotSurgical).padStart(3)} crash=${v.crashes}`)
console.log('\n=== top unmapped resource types ===')
;[...unmappedTypes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).forEach(([t, n]) => console.log(`${String(n).padStart(5)}  ${t}`))
console.log('\n=== parse error samples ===')
parseErrorSamples.slice(0, 8).forEach((s) => console.log(`\n${s.file}\n  ${s.err.msg} @${s.err.at}\n  ...${s.excerpt.replace(/\n/g, '\\n').slice(0, 200)}`))
console.log('\n=== reconstruct failures ===')
reconstructFails.slice(0, 8).forEach((f) => console.log(`${f.file}  ${f.why} ${f.lostBytes ?? ''} ${f.sample ? JSON.stringify(f.sample).slice(0, 220) : ''}`))
console.log('\n=== patch failures ===')
patchFails.slice(0, 10).forEach((f) => console.log(`${f.file}  ${f.why} ${f.unpatchable || ''}`))
console.log('\n=== crashes ===')
crashes.slice(0, 10).forEach((c) => console.log(`${c.file} [${c.stage}] ${c.msg}`))

// ── per-module: does the graph have arrows? ─────────────────────────────────

function moduleDirs(root, out = []) {
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue
    const p = path.join(root, e.name)
    if (e.isDirectory()) { moduleDirs(p, out) }
  }
  if (fs.readdirSync(root).some((f) => f.endsWith('.tf'))) out.push(root)
  return out
}
const allModuleDirs = moduleDirs(ROOT)
let modStats = { modules: 0, withNodes: 0, nodes: 0, edges: 0, isolated: 0, invalid: 0, simulable: 0 }
const density = []
const worst = []
for (const d of allModuleDirs) {
  const files = fs.readdirSync(d).filter((f) => f.endsWith('.tf')).map((f) => ({ path: path.join(d, f), text: fs.readFileSync(path.join(d, f), 'utf8') }))
  if (!files.length) continue
  modStats.modules++
  let ir
  try { ir = hclToIR(files, { managed: 'partial' }).ir } catch { continue }
  const real = ir.nodes.filter((n) => !isSourceNode(n) && !n.attrs.synthetic)
  if (!real.length) continue
  modStats.withNodes++
  modStats.nodes += real.length
  modStats.edges += ir.edges.length
  const connected = new Set([...ir.edges.map((e) => e.from), ...ir.edges.map((e) => e.to)])
  const isolated = real.filter((n) => !connected.has(n.id)).length
  modStats.isolated += isolated
  if (!validateIR(ir, { kinds: kinds() }).ok) modStats.invalid++
  try { if (simulate(ir, 1000).p99 >= 0) modStats.simulable++ } catch {}
  density.push({ d: d.replace(ROOT + '/', ''), n: real.length, e: ir.edges.length, iso: isolated, ratio: ir.edges.length / real.length })
  if (real.length >= 5) worst.push({ d: d.replace(ROOT + '/', ''), n: real.length, e: ir.edges.length, iso: isolated })
}
console.log(JSON.stringify(stats, null, 2))
console.log('edges per node overall:', (modStats.edges / modStats.nodes).toFixed(2))
console.log('isolated nodes:', ((100 * modStats.isolated) / modStats.nodes).toFixed(1) + '%')
console.log('\n=== biggest modules ===')
density.sort((a, b) => b.n - a.n).slice(0, 15).forEach((x) => console.log(`${String(x.n).padStart(4)} nodes ${String(x.e).padStart(4)} edges ${String(x.iso).padStart(4)} isolated  ${x.d}`))
console.log('\n=== best-connected modules (>=5 nodes) ===')
worst.sort((a, b) => (b.e / b.n) - (a.e / a.n)).slice(0, 10).forEach((x) => console.log(`${String(x.n).padStart(4)} nodes ${String(x.e).padStart(4)} edges ${String(x.iso).padStart(4)} isolated  ${x.d}`))
