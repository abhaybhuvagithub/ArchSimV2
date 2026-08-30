# The candidate template library

A thousand architectures that could become ArchSim templates, and an honest
account of how many of them are worth building.

`node docs/candidates/generate.mjs` composes and validates the list.
`archsim-1000-templates.csv` is the same thing, ready for a spreadsheet.

## How it is built

Two axes, because a template is only worth having if it poses a different
*queueing* problem. "Uber for dogs" and "Uber for cats" are one template.

- **250 real systems** — things people actually run, spread across the ten
  existing categories, each with a sentence saying why it is its own problem.
  A booking engine is distinct because inventory cannot be oversold, so the hot
  row is real contention. A URL shortener is distinct because the write path is
  a rounding error against the reads.
- **4 constraints each** — read-heavy, write-heavy, strictly consistent,
  multi-region, audited, burst-tolerant, offline-first, high fan-out,
  cost-capped, sub-100ms, highly available. Each changes where the work queues,
  what cannot be cached, and what has to stay synchronous. Which four apply
  depends on the category: consistency matters in commerce, connectivity
  matters in IoT.

250 × 4 = 1,000.

## The number that matters

**123.**

That is how many distinct `(archetype × constraint)` combinations the thousand
rows contain. The other 877 are the same simulation with a different name on it.

That is not a defect in the list — a recognisable name is how someone finds the
right starting point, and "Payment gateway" will be opened by people who would
scroll past "transactional archetype, audited variant". But it does mean the
engineering value tops out at 123, and the 100 templates already in
`packages/templates` cover a good part of that.

So: **do not add these in bulk.** Adding a hundred more templates that nobody
opens makes the library worse, not better — every one is a thing that has to be
calibrated, gated, and kept true as the catalog changes. Thirteen of the
existing hundred already fail their own SLOs.

The useful move is to add one when someone asks for a shape that is missing,
and to use this list to find it quickly.

## What each row gives you

`nodes` and `edges` are in the notation `packages/templates/src/specs.js`
already uses — `kind:label` and `a>b>c` — so a chosen candidate can go straight
in. The numeric columns are deliberately absent: replica counts, thresholds and
cost are **derived** by `test/calibrate-templates.mjs` from the sized design,
not written by hand. Writing them by hand is how a template ends up asserting a
target it was never sized to meet.
