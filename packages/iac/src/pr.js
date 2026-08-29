// Turning canvas edits into a pull request.
//
// `emitChanges` already produces surgical byte-range patches: the smallest edit
// to the source files that makes the code say what the canvas says. What is
// missing between that and a review is the packaging — a branch name, a commit
// message, a diff someone can read, and a body that says what the change does
// to the gate.
//
// This module produces that payload and stops. It does not call GitHub. A tool
// that opens pull requests on your behalf needs a token, and a token that can
// open a pull request can usually do a great deal more; the honest boundary is
// to hand back everything needed and let `gh`, or the Action, or a person, do
// the pushing. That also means the payload is reviewable before anything
// irreversible happens, which is the whole premise of the product.

import { irHash } from '@archsim/ir'

/**
 * A unified diff, computed from the before and after text of each file.
 *
 * A real diff algorithm is not needed here and would be worse: `emitChanges`
 * knows exactly which byte ranges it edited, so the hunks are known rather than
 * inferred. What this produces is a diff of the *lines those ranges fall in*,
 * with three lines of context, which is what a reviewer reads.
 */
export function unifiedDiff(file, before, after, context = 3) {
  if (before === after) return ''
  const a = before.split('\n')
  const b = after.split('\n')

  // Longest common prefix and suffix bound the changed region. For a surgical
  // patch — a handful of attribute values — this is the changed region exactly.
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length - 1
  let endB = b.length - 1
  while (endA > start && endB > start && a[endA] === b[endB]) { endA--; endB-- }

  const from = Math.max(0, start - context)
  const toA = Math.min(a.length - 1, endA + context)
  const toB = Math.min(b.length - 1, endB + context)

  const out = [`--- a/${file}`, `+++ b/${file}`]
  out.push(`@@ -${from + 1},${toA - from + 1} +${from + 1},${toB - from + 1} @@`)
  for (let i = from; i < start; i++) out.push(` ${a[i]}`)
  for (let i = start; i <= endA; i++) out.push(`-${a[i]}`)
  for (let i = start; i <= endB; i++) out.push(`+${b[i]}`)
  for (let i = endA + 1; i <= toA; i++) out.push(` ${a[i]}`)
  return out.join('\n') + '\n'
}

/**
 * The complete payload for a pull request.
 *
 * @param opts.emit    the result of `emitChanges`
 * @param opts.sources `{ [file]: originalText }`, only needed for files the
 *   emitter did not itself return a `before` for
 * @param opts.ir      the IR the change produces
 * @param opts.base    the IR before the change, if there is one
 * @param opts.gate    a gate result, if one was run — the body then states the verdict
 * @param opts.author  `{ name, email }` for the commit trailer
 */
export function pullRequestPayload(opts) {
  const { emit, sources = {}, ir, base = null, gate = null } = opts
  // `emitChanges` returns each patched file with the text before and after, so
  // the diff is exact rather than reconstructed. Generated files have no
  // "before" and read as pure additions.
  const changed = [
    ...(emit?.patches || []).filter((p) => p.changed).map((p) => ({ file: p.file, before: p.before, after: p.after })),
    ...(emit?.generated || []).map((g) => ({ file: g.file, before: sources[g.file] ?? '', after: (sources[g.file] ?? '') + g.text })),
  ]

  const summary = summarize(emit, base, ir)
  const branch = opts.branch || branchName(summary, ir)
  const title = opts.title || titleFor(summary)

  const diffs = changed.map((f) => unifiedDiff(f.file, f.before, f.after))

  return {
    branch,
    title,
    commitMessage: commitMessage(title, summary, ir, opts.author),
    body: prBody(summary, emit, gate, ir, base),
    files: changed.map((f) => ({ file: f.file, text: f.after })),
    diff: diffs.join(''),
    labels: labelsFor(summary, gate),
    summary,
    // Everything a caller needs to do the push itself, written out rather than
    // performed, so nothing irreversible happens inside ArchSim.
    script: ghScript(branch, title, changed.map((f) => f.file)),
  }
}

/**
 * Each edit already carries a `why` — `aws_ecs_service.checkout.desired_count:
 * 6 → 3` — written by the emitter at the moment it knew both values. Parsing it
 * back is better than re-deriving the same sentence from the IR and risking a
 * commit message that disagrees with the diff underneath it.
 */
function summarize(emit, base, ir) {
  const changes = []
  for (const patch of emit?.patches || []) {
    for (const e of patch.edits || []) {
      const m = /^(.*)\.([^.:]+):\s*(.*?)\s*→\s*(.*)$/.exec(e.why || '')
      changes.push(m
        ? { file: patch.file, address: m[1], field: m[2], from: m[3], to: m[4] }
        : { file: patch.file, address: null, field: 'value', from: '', to: e.replacement })
    }
  }
  const added = (emit?.generated || []).map((g) => g.label).filter(Boolean)
  const removed = (emit?.removals || []).map((r) => r.label)
  return { changes, added, removed, files: [...new Set(changes.map((c) => c.file))] }
}

function titleFor(s) {
  const parts = []
  if (s.changes.length === 1) {
    const c = s.changes[0]
    parts.push(`${c.address || c.file}: ${c.field} ${c.from} → ${c.to}`)
  } else if (s.changes.length > 1) {
    parts.push(`Adjust ${s.changes.length} infrastructure values across ${s.files.length} file${s.files.length > 1 ? 's' : ''}`)
  }
  if (s.added.length) parts.push(`add ${s.added.join(', ')}`)
  if (s.removed.length) parts.push(`remove ${s.removed.join(', ')}`)
  return parts.join('; ') || 'Update infrastructure to match the reviewed architecture'
}

/**
 * A branch name has to be stable for the same change and distinct for a
 * different one, or a second push either collides or litters. The IR hash is
 * both — same design, same branch; one replica different, different branch.
 */
export function branchName(summary, ir) {
  const slug = (summary.changes[0]?.address || summary.added[0] || summary.removed[0] || 'architecture')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
  return `archsim/${slug}-${irHash(ir).slice(0, 8)}`
}

function commitMessage(title, summary, ir, author) {
  const lines = [title, '']
  for (const c of summary.changes) {
    lines.push(`  ${c.address || c.file}: ${c.field} ${c.from} → ${c.to}`)
  }
  if (summary.added.length) lines.push(`  added: ${summary.added.join(', ')}`)
  if (summary.removed.length) lines.push(`  removed: ${summary.removed.join(', ')}`)
  lines.push('', `ArchSim-IR: ${irHash(ir)}`)
  if (author?.name) lines.push(`Co-authored-by: ${author.name} <${author.email || ''}>`)
  return lines.join('\n') + '\n'
}

function prBody(summary, emit, gate, ir, base) {
  const out = ['### What changed', '']

  if (summary.changes.length) {
    out.push('| File | Resource | Field | Before | After |', '|---|---|---|---:|---:|')
    for (const c of summary.changes) {
      out.push(`| \`${c.file}\` | \`${c.address || '—'}\` | ${c.field} | ${c.from} | ${c.to} |`)
    }
    out.push('')
  }
  if (summary.added.length) out.push(`**Added:** ${summary.added.map((l) => `\`${l}\``).join(', ')}`, '')
  if (summary.removed.length) {
    out.push(`**Removed from the canvas:** ${summary.removed.map((l) => `\`${l}\``).join(', ')}`, '',
      'Removal is a proposal, not a patch. ArchSim never emits a destroy — deleting infrastructure is a decision a person makes with the plan in front of them.', '')
  }
  if (!summary.changes.length && !summary.added.length && !summary.removed.length) {
    out.push('Nothing. The canvas and the code already agree.', '')
  }

  if (gate?.evaluation) {
    const rows = gate.evaluation.results
    const failed = rows.filter((r) => r.verdict === 'fail').length
    const risky = rows.filter((r) => r.verdict === 'risk').length
    out.push('### What it does to the gate', '')
    out.push(failed ? `❌ ${failed} SLO violation${failed > 1 ? 's' : ''} after this change.`
      : risky ? `⚠️ ${risky} SLO${risky > 1 ? 's' : ''} into the error budget after this change.`
        : '✅ Every SLO holds after this change.')
    out.push('')
    out.push('| SLO | Holds in | Verdict |', '|---|---:|:--:|')
    for (const r of rows) {
      const icon = { pass: '✅', fail: '❌', risk: '⚠️', skip: '—' }[r.verdict]
      out.push(`| ${r.slo.id} | ${r.holdPct == null ? '—' : `${r.holdPct.toFixed(0)}% of runs`} | ${icon} |`)
    }
    out.push('')
  }

  if (emit?.unpatchable?.length) {
    out.push('### What ArchSim would not write', '')
    out.push('Each of these is a change the canvas expressed and the emitter declined to make. A refusal with a reason beats a patch that silently drops a variable.', '')
    for (const u of emit.unpatchable) out.push(`- ${u.reason}`)
    out.push('')
  }
  if (emit?.removals?.length) {
    out.push('### Removal proposals', '')
    for (const r of emit.removals) out.push(`- ${r.proposal} — ${r.note}`)
    out.push('')
  }

  out.push('---', '', `<sub>Generated by ArchSim from the reviewed architecture. IR hash \`${irHash(ir)}\`${base ? `, against \`${irHash(base)}\`` : ''}. Every edit above is a byte-range replacement in the file named — nothing else in these files was reformatted.</sub>`)
  return out.join('\n') + '\n'
}

function labelsFor(summary, gate) {
  const labels = ['archsim']
  if (summary.removed.length) labels.push('needs-human-review')
  const rows = gate?.evaluation?.results || []
  if (rows.some((r) => r.verdict === 'fail')) labels.push('slo-violation')
  else if (rows.some((r) => r.verdict === 'risk')) labels.push('error-budget')
  return labels
}

/**
 * The commands, written out. Deliberately not run: opening a pull request needs
 * a token, and ArchSim taking a token it does not need is a worse trade than
 * printing four lines of shell.
 */
function ghScript(branch, title, files) {
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    `git switch -c ${shellQuote(branch)}`,
    `git add ${files.map(shellQuote).join(' ')}`,
    'git commit -F .archsim/pr/commit.txt',
    `git push -u origin ${shellQuote(branch)}`,
    `gh pr create --title ${shellQuote(title)} --body-file .archsim/pr/body.md`,
    '',
  ].join('\n')
}

const shellQuote = (s) => (/^[A-Za-z0-9._/-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`)
