#!/usr/bin/env node
// The dependency boundary, checked.
//
// ArchSim's central claim is that the CLI runs anywhere Node runs: no build
// step, no install, nothing to vet. That is a promise about the *import graph*,
// and until now it was enforced by people remembering it. One `import yaml from
// 'yaml'` in a file nobody re-reads and the promise is quietly gone — the tests
// would still pass, because the dependency would be sitting in node_modules
// from something else in the workspace.
//
// So this reads what the code actually imports and holds it to four rules:
//
//   1. No package under packages/ imports anything outside the workspace,
//      Node builtins excepted. The canvas may — it ships through a bundler.
//   2. Every cross-package import is declared in that package's package.json.
//      An undeclared one works here, because npm workspaces hoists, and breaks
//      the moment anyone installs a package on its own.
//   3. No import cycles between packages.
//   4. Every relative import resolves to a file that exists.
//
// It runs on the source, not on an installed tree, so it gives the same answer
// on a clean checkout as it does here.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { builtinModules } from 'node:module'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUILTIN = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)])

/** Packages that are allowed third-party imports, and why. */
const BUNDLED = new Set([
  'apps/canvas', // ships through Vite; React is a build input, not a runtime install
])

const problems = []
const fail = (rule, where, msg) => problems.push({ rule, where, msg })

/* ── read the workspace ───────────────────────────────────────────────────── */

const walk = (dir, out = []) => {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'dist' || e.startsWith('.')) continue
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(js|mjs|jsx)$/.test(e)) out.push(p)
  }
  return out
}

const pkgDirs = [
  ...readdirSync(join(ROOT, 'packages')).map((d) => `packages/${d}`),
  'apps/canvas',
].filter((d) => existsSync(join(ROOT, d, 'package.json')))

/** @type {Map<string, {dir: string, name: string, deps: Set<string>, files: string[]}>} */
const pkgs = new Map()
for (const dir of pkgDirs) {
  const manifest = JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8'))
  pkgs.set(manifest.name, {
    dir,
    name: manifest.name,
    deps: new Set(Object.keys(manifest.dependencies || {})),
    files: walk(join(ROOT, dir)),
  })
}
const byName = new Map([...pkgs].map(([n, p]) => [n, p]))

/* ── read every import ────────────────────────────────────────────────────── */

// Deliberately a regex and not a parser: the alternative is a dependency, in a
// script whose entire job is to keep dependencies out.
const IMPORT_RE = /(?:^|\n)\s*(?:import\b[^'"\n]*?from\s*|import\s*|export\b[^'"\n]*?from\s*)['"]([^'"]+)['"]/g
const REQUIRE_RE = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g

const importsOf = (file) => {
  const src = readFileSync(file, 'utf8')
  const out = []
  for (const re of [IMPORT_RE, REQUIRE_RE]) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(src))) out.push(m[1])
  }
  return out
}

/** package name -> set of workspace packages it imports */
const graph = new Map([...pkgs.keys()].map((n) => [n, new Set()]))

for (const pkg of pkgs.values()) {
  const bundled = BUNDLED.has(pkg.dir)
  for (const file of pkg.files) {
    const rel = relative(ROOT, file)
    for (const spec of importsOf(file)) {
      if (BUILTIN.has(spec)) continue

      if (spec.startsWith('.')) {
        // Rule 4: a relative import that does not resolve.
        const target = resolve(dirname(file), spec)
        const hit = [target, `${target}.js`, `${target}.jsx`, `${target}.mjs`, join(target, 'index.js')]
          .some((p) => existsSync(p) && statSync(p).isFile())
        if (!hit) fail('resolves', rel, `imports '${spec}', which is not a file`)
        continue
      }

      const owner = [...pkgs.keys()].find((n) => spec === n || spec.startsWith(`${n}/`))
      if (owner) {
        // Rule 2: cross-package imports must be declared.
        if (owner !== pkg.name && !pkg.deps.has(owner)) {
          fail('declared', rel, `imports ${owner}, which ${pkg.name} does not list as a dependency`)
        }
        if (owner !== pkg.name) graph.get(pkg.name).add(owner)
        continue
      }

      // Rule 1: everything else is third-party.
      if (!bundled) fail('zero-dep', rel, `imports '${spec}' — ${pkg.name} must run with nothing installed`)
    }
  }
}

/* ── rule 3: cycles ───────────────────────────────────────────────────────── */

const cycles = []
const seen = new Set()
const stack = []
const visit = (n) => {
  const at = stack.indexOf(n)
  if (at !== -1) { cycles.push([...stack.slice(at), n].join(' → ')); return }
  if (seen.has(n)) return
  seen.add(n); stack.push(n)
  for (const next of graph.get(n) || []) visit(next)
  stack.pop()
}
for (const n of graph.keys()) visit(n)
for (const c of [...new Set(cycles)]) fail('acyclic', 'workspace', `import cycle: ${c}`)

/* ── report ───────────────────────────────────────────────────────────────── */

const runtimePkgs = [...pkgs.values()].filter((p) => !BUNDLED.has(p.dir))
const fileCount = runtimePkgs.reduce((n, p) => n + p.files.length, 0)

if (!problems.length) {
  console.log(`deps: ${runtimePkgs.length} packages, ${fileCount} files — no third-party import, no undeclared`)
  console.log('      cross-package import, no cycle, no unresolved path.')
  process.exit(0)
}

const RULES = {
  'zero-dep': 'A package outside the canvas imported something that is not in the workspace.',
  declared: 'A cross-package import is missing from that package.json. It works here only because npm hoists.',
  acyclic: 'Two packages import each other.',
  resolves: 'A relative import points at nothing.',
}
for (const rule of Object.keys(RULES)) {
  const hits = problems.filter((p) => p.rule === rule)
  if (!hits.length) continue
  console.error(`\n${rule}: ${RULES[rule]}`)
  for (const h of hits) console.error(`  ${h.where}: ${h.msg}`)
}
console.error(`\n${problems.length} problem${problems.length === 1 ? '' : 's'}.`)
process.exit(1)
