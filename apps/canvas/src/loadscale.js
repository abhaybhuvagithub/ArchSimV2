// Mapping the load slider to requests per second.
//
// Linear would be useless. The interesting range runs from a few hundred rps to
// a few hundred thousand, and on a linear track the whole of "small service"
// occupies the first two pixels — you could not pick 2,000 rps if you wanted
// to. So the steps are logarithmic, which gives every order of magnitude the
// same amount of thumb.
//
// The first version computed the value from the track position and rounded it
// to two significant figures, and it stuck: near 4,600 rps a one-step move
// changed the raw figure by less than the rounding, so the value came back
// identical, the controlled input recomputed the same position, and the thumb
// snapped back. It looked like the slider had a ceiling.
//
// The round-trip test I had written passed throughout, because it checked the
// wrong property — that a value survives a round trip, not that *adjacent
// positions differ*. So the scale is now an explicit ladder of the values worth
// offering, and the slider is an index into it. A ladder cannot collide with
// itself, and "strictly increasing" is a property a check can state directly.

export const MIN_RPS = 10
export const MAX_RPS = 2_000_000

/**
 * Every value the slider can take: two significant figures per decade, which is
 * as much precision as a load figure carries. 10, 11 … 99, 100, 110 … and so on.
 */
export const LADDER = (() => {
  const out = []
  for (let mag = Math.log10(MIN_RPS); mag <= Math.log10(MAX_RPS); mag++) {
    const unit = 10 ** (mag - 1)
    for (let d = 10; d < 100; d++) {
      const v = Math.round(d * unit)
      if (v >= MIN_RPS && v <= MAX_RPS && v !== out[out.length - 1]) out.push(v)
    }
  }
  if (out[out.length - 1] !== MAX_RPS) out.push(MAX_RPS)
  return out
})()

export const STEPS = LADDER.length - 1

/** Nearest rung — used when someone types a figure the ladder does not contain. */
export function snap(rps) {
  if (!Number.isFinite(rps) || rps <= 0) return MIN_RPS
  const clamped = Math.max(MIN_RPS, Math.min(MAX_RPS, rps))
  let best = LADDER[0]
  for (const v of LADDER) if (Math.abs(v - clamped) < Math.abs(best - clamped)) best = v
  return best
}

/** rps → track position. */
export function toSlider(rps) {
  const target = snap(rps)
  const i = LADDER.indexOf(target)
  return i === -1 ? 0 : i
}

/** Track position → rps. */
export function fromSlider(pos) {
  const i = Math.max(0, Math.min(STEPS, Math.round(Number(pos) || 0)))
  return LADDER[i]
}

/** Readable short form: 4000 → "4k", 1_200_000 → "1.2M". */
export function shortRps(n) {
  if (!Number.isFinite(n)) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return String(Math.round(n))
}
