// The jargon, defined.
//
// The studio puts p99, SLO, DES, ULID, CDC and mTLS on screen and assumes you
// know all of them. Some of that is genuinely load-bearing: someone who reads
// p99 as "99% of the time it is this fast" will misread every verdict the gate
// gives them, because it means very nearly the opposite.
//
// So the entries lead with what the term means and then, where there is one,
// the misunderstanding worth heading off. The second part is the reason this is
// a panel rather than a link to a glossary.

import React, { useMemo, useState } from 'react'
import { ACRONYMS, ACRONYM_GROUPS, searchAcronyms } from '@archsim/core'

export default function AcronymsPanel() {
  const [query, setQuery] = useState('')
  const hits = useMemo(() => searchAcronyms(query), [query])
  const searching = query.trim().length > 0
  const groups = useMemo(
    () => ACRONYM_GROUPS.map((g) => ({ name: g, rows: hits.filter((a) => a.group === g) })).filter((g) => g.rows.length),
    [hits],
  )

  return (
    <div className="panel acronyms">
      <div className="controls">
        <input
          className="acsearch"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${ACRONYMS.length} terms — try “percentile”, “quorum”, “retry”`}
          aria-label="Search the glossary"
        />
        {searching && <button className="btn" onClick={() => setQuery('')}>Clear</button>}
        <span className="note">
          {searching
            ? `${hits.length} of ${ACRONYMS.length}.`
            : 'Every term the studio puts on screen, and the mistake each one invites.'}
        </span>
      </div>

      {!groups.length && (
        <p className="muted">
          Nothing matches “{query}”. The search covers the term, what it stands for, and both explanations.
        </p>
      )}

      {groups.map((g) => (
        <section key={g.name} className="acgroup">
          <h4>{g.name}</h4>
          <dl className="aclist">
            {g.rows.map((a) => (
              <div className="acrow" key={a.short}>
                <dt>
                  <b>{a.short}</b>
                  {a.long !== '—' && <span className="aclong">{a.long}</span>}
                </dt>
                <dd>
                  <p>{a.means}</p>
                  {a.gotcha && <p className="acgotcha"><span>Worth knowing</span> {a.gotcha}</p>}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  )
}
