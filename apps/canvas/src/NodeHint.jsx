// What a node is, while your cursor is on it.
//
// There was a hint already: an SVG `<title>`, which the browser renders as a
// native tooltip. That has four problems, and the last is the real one.
// It waits about a second. It cannot be styled. It never appears on keyboard
// focus. And it showed the node's *configuration* — replicas, capacity,
// provenance — while saying nothing about how that configuration is actually
// doing under the current load.
//
// Utilisation is the number that decides whether a design works, and it was not
// in the tooltip at all. So the card leads with it, and says where it sits
// relative to the knee, because 0.9 means something very different from 0.5 and
// the number alone does not say so.

import React from 'react'
import { kindName, kindGlyph, replicationNote, isSourceNode } from '@archsim/core'
import { loadBand } from './nodehint.js'

const pct = (v) => `${Math.round(v * 100)}%`
const rate = (n) => (!Number.isFinite(n) ? '∞' : n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(Math.round(n)))

export default function NodeHint({ node, at, stat, drift, changed, reachable = true }) {
  if (!node || !at) return null
  const cap = node.capacity

  // Clamped, for the same reason the tour card is: a card that follows its
  // target off the edge of the window has hidden itself.
  const W = 300
  const M = 12
  const left = Math.min(Math.max(M, at.left), (typeof window !== 'undefined' ? window.innerWidth : 1200) - W - M)
  const below = at.bottom + 10
  const above = at.top - 10
  const roomBelow = (typeof window !== 'undefined' ? window.innerHeight : 800) - below
  const top = roomBelow > 210 ? below : Math.max(M, above - 210)

  // A source is the traffic generator, not a thing being loaded. "This client
  // population may be larger than it needs to be" is not advice.
  const source = isSourceNode(node)
  const l = !source && Number.isFinite(stat?.util) ? loadBand(stat.util, reachable) : null
  const note = replicationNote(cap.replicas, cap.replication)
  const binding = node.bindings?.[0]

  return (
    <div className="nodehint" style={{ left, top, width: W }} role="tooltip">
      <header>
        <span className="nhglyph" aria-hidden="true">{kindGlyph(node.kind)}</span>
        <b>{node.label}</b>
        <span className="nhkind">{kindName(node.kind)}</span>
      </header>

      {l && (
        <div className={`nhload tone-${l.tone}`}>
          <div className="nhbar"><i style={{ width: `${Math.min(100, stat.util * 100)}%` }} /></div>
          <div className="nhloadtext">
            <b>{pct(stat.util)} utilised</b>
            <span>{l.say}</span>
          </div>
        </div>
      )}

      {source && (
        <p className="nhsource">Traffic enters here — {rate(stat?.in ?? 0)} rps into the design.</p>
      )}

      <dl className="nhfacts">
        {!source && <div><dt>Serving</dt><dd>{rate(stat?.in ?? 0)} of {rate(stat?.capacity ?? cap.replicas * cap.capPerReplica)} rps</dd></div>}
        <div><dt>Latency</dt><dd>{Math.round(stat?.latency ?? cap.latencyMs.p50)}ms{stat && stat.latency > cap.latencyMs.p50 * 1.15 ? ` (queueing — ${cap.latencyMs.p50}ms alone)` : ''}</dd></div>
        {!source && <div><dt>Shape</dt><dd>{cap.replicas} × {rate(cap.capPerReplica)} rps{cap.replication !== 'stateless' ? `, ${cap.replication}` : ''}</dd></div>}
        {stat?.dropped > 0 && <div><dt>Dropping</dt><dd className="tone-breach">{rate(stat.dropped)} rps</dd></div>}
      </dl>

      {note && <p className="nhnote">{note}</p>}

      {drift && (
        <p className="nhdrift">
          <span>Drift</span> the model and production disagree here — {drift}
        </p>
      )}

      {changed && <p className="nhchanged">Changed by this pull request.</p>}

      {/* The provenance line stays, because it is the difference between a
          number that was measured and one this tool made up. */}
      <p className="nhprov">
        {cap.provenance.cls} · ±{cap.jitter.capPct}% band — {cap.provenance.basis}
      </p>
      <p className="nhcode">
        {binding ? `${binding.address} (${binding.managed})` : 'No IaC binding — on the canvas, not in code.'}
      </p>
    </div>
  )
}
