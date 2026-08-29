// The verdict bar.
//
// One line, above everything, answering the question the tool exists for. It
// carries the same three states the CLI exits with, so what you read here and
// what a pull request gets are the same judgement rendered twice.

import React from 'react'
import { label as sloLabel } from '@archsim/core'

const MARK = { pass: '✓', risk: '!', fail: '✕' }
const WORD = {
  pass: 'all gates hold',
  risk: 'eating the error budget',
  fail: 'violation',
}

export default function Verdict({ busy, result, base, variant, onVariant, comparable }) {
  const v = busy ? 'busy' : result?.verdict || 'busy'
  const failed = result?.evaluation?.failed?.length || 0
  const risky = result?.evaluation?.risky?.length || 0

  let headline = 'sampling worlds…'
  if (!busy && result?.evaluation) {
    headline = v === 'fail'
      ? `${failed} ${WORD.fail}${failed > 1 ? 's' : ''}`
      : v === 'risk'
        ? `${risky} risk${risky > 1 ? 's' : ''} — ${WORD.risk}`
        : WORD.pass
  }

  const fix = result?.quickFix?.steps?.length ? collapse(result.quickFix.steps) : null

  return (
    <div className={`verdict ${v}`}>
      <span className="mark">
        <span aria-hidden="true">{busy ? '…' : MARK[v]}</span>
        {headline}
      </span>

      {!busy && fix && (
        <span className="fixline">
          Cheapest fix: {fix} — <b>{money(result.quickFix.costDelta)}/mo</b>
          {result.quickFix.fullyResolved ? ', which restores every gate.' : '.'}
        </span>
      )}

      {!busy && !fix && result?.evaluation && (
        <span className="fixline muted">
          {result.evaluation.results.length} SLOs · {result.mc.runs} sampled worlds · {result.mc.scenarios.length} scenarios
        </span>
      )}

      <span className="spacer" />

      {comparable && (
        <div className="seg" role="group" aria-label="Which version to judge">
          <button className={variant === 'main' ? 'on' : ''} onClick={() => onVariant('main')}>main</button>
          <button className={variant === 'pr' ? 'on' : ''} onClick={() => onVariant('pr')}>this PR</button>
        </div>
      )}
    </div>
  )
}

/** A distribution read at a glance: how much of the sampled space holds. */
export function Dist({ holdPct, verdict, passPct = 95, was = null }) {
  if (holdPct === null || holdPct === undefined) return <span className="muted">—</span>
  return (
    <div className={`dist ${verdict}`}>
      <span className="pct">{holdPct.toFixed(0)}%</span>
      <div className="track" title={`${holdPct.toFixed(0)}% of sampled worlds hold this SLO. The marker is the ${passPct}% pass threshold.`}>
        <div className="fill" style={{ width: `${Math.max(0, Math.min(100, holdPct))}%` }} />
        <div className="needle" style={{ left: `${passPct}%` }} />
      </div>
      {was !== null && was !== undefined && (
        <span className="was">{was.toFixed(0)}% on main</span>
      )}
    </div>
  )
}

export { sloLabel }

function collapse(steps) {
  const out = []
  for (const s of steps) {
    const m = /^(.*?) (\d+)→(\d+) replicas$/.exec(s.describe)
    const prev = out[out.length - 1]
    if (m && prev?.m && prev.m[1] === m[1] && prev.m[3] === m[2]) {
      prev.m = [prev.m[0], m[1], prev.m[2], m[3]]
      prev.text = `${m[1]} ${prev.m[2]}→${m[3]} replicas`
      continue
    }
    out.push({ text: s.describe, m })
  }
  return out.map((o) => o.text.replace(/`/g, '')).join(', then ')
}

const money = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}$${Math.abs(Math.round(v)).toLocaleString()}`
