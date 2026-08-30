// Compose the candidate list and check it is what it claims to be.

import { writeFileSync } from 'node:fs'
import { ARCHETYPES, VARIANTS } from './systems.mjs'
import { CATEGORIES } from './catalog.mjs'

const rows = []
for (const [category, { variants, systems }] of Object.entries(CATEGORIES)) {
  for (const [slug, name, archetype, why] of systems) {
    for (const v of variants) {
      const [suffix, extraNodes, vWhy] = VARIANTS[v]
      const arch = ARCHETYPES[archetype]
      if (!arch) throw new Error(`${slug}: unknown archetype ${archetype}`)
      const nodes = [arch.nodes, extraNodes].filter(Boolean).join(',')
      rows.push({
        id: suffix ? `${slug}-${v}` : slug,
        name: suffix ? `${name} — ${suffix}` : name,
        category,
        base: name,
        variant: suffix || 'base',
        archetype,
        why,
        constraint: vWhy,
        shape: arch.about,
        nodes,
        edges: arch.edges,
        components: nodes.split(',').length,
      })
    }
  }
}

/* ── the checks that decide whether this list is worth anything ──────────── */

const problems = []
const ids = new Set()
for (const r of rows) {
  if (ids.has(r.id)) problems.push(`duplicate id ${r.id}`)
  ids.add(r.id)
  if (!r.why || r.why.length < 25) problems.push(`${r.id}: reason too thin`)
  if (r.why === r.shape) problems.push(`${r.id}: reason just restates the archetype`)
}
if (rows.length !== 1000) problems.push(`expected 1000 rows, got ${rows.length}`)

// The honest number: how many genuinely different *shapes* are in here, as
// opposed to the same shape with a different name on it.
const shapes = new Set(rows.map((r) => `${r.archetype}|${r.variant}`))
const bases = new Set(rows.map((r) => r.base))

if (problems.length) {
  console.error(problems.slice(0, 10).join('\n'))
  console.error(`\n${problems.length} problems`)
  process.exit(1)
}

writeFileSync(new URL('./candidates.json', import.meta.url), JSON.stringify(rows, null, 0))

console.log(`${rows.length} candidates`)
console.log(`${bases.size} distinct systems × 4 constraints each`)
console.log(`${Object.keys(CATEGORIES).length} categories, ${Object.keys(ARCHETYPES).length} archetypes, ${Object.keys(VARIANTS).length} constraints`)
console.log(`${shapes.size} distinct (archetype × constraint) combinations — that is how many are structurally different`)
for (const [c, { systems }] of Object.entries(CATEGORIES)) {
  console.log(`  ${c.padEnd(28)} ${systems.length * 4}`)
}
