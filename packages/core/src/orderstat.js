// Order statistics — what happens when you wait for the k-th of m answers.
//
// This is the arithmetic behind three separate things the engine needs and had
// been guessing at: the latency of a quorum write, the benefit of a hedged
// request, and the tail of any fan-out where the caller waits for some but not
// all of its callees.
//
// The trick is that no new distribution theory is required. If a single draw
// exceeds t with probability p, then "at least k of m are below t" is the same
// binomial tail already written down for quorum availability. So:
//
//     P(X₍ₖ₎ ≤ t) = atLeast(F(t), m, k)
//
// which is monotone in F(t), so the quantile can be found by inverting that sum
// for u = F(t) and then pushing u back through the distribution. Exact, and it
// reuses a function the suite already validates against a simulation.

import { atLeast } from './replication.js'
import { probit } from './replication.js'

/** σ of the underlying normal for a lognormal with this coefficient of variation. */
export const sigmaOf = (cv) => Math.sqrt(Math.log(1 + cv * cv))

/** The p-quantile of a lognormal with the given median. */
export const lognormalQuantile = (median, cv, p) => median * Math.exp(sigmaOf(cv) * probit(p))

/**
 * The u such that `atLeast(u, m, k) === target`, by bisection.
 *
 * atLeast is strictly increasing in u on (0,1) for 1 ≤ k ≤ m, so bisection is
 * both safe and enough: 60 halvings put it well inside double precision.
 */
export function inverseAtLeast(target, m, k) {
  if (target <= 0) return 0
  if (target >= 1) return 1
  let lo = 0
  let hi = 1
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (atLeast(mid, m, k) < target) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/**
 * The p-quantile of the k-th smallest of m independent lognormal draws.
 *
 * @param {number} median  median of a single draw, ms
 * @param {number} cv      coefficient of variation of a single draw
 * @param {number} m       how many are in flight
 * @param {number} k       how many you wait for
 * @param {number} p       the quantile wanted, e.g. 0.99
 */
export function orderStatQuantile(median, cv, m, k, p) {
  if (m <= 0 || k <= 0) return 0
  const kk = Math.min(k, m)
  if (m === 1) return lognormalQuantile(median, cv, p)
  return lognormalQuantile(median, cv, inverseAtLeast(p, m, kk))
}

/**
 * What a quorum write actually costs.
 *
 * The leader does its own work, then replicates and waits for a majority to
 * acknowledge. A majority of n includes the leader, so it waits for k = q − 1
 * of the n − 1 followers.
 *
 * Two consequences, and the first corrects something this engine said earlier.
 *
 * **It does move the median.** An earlier note here concluded that quorum does
 * not, on the grounds that the majority-th of an odd group is the median. That
 * was true of the order statistic and wrong about the write, because it left
 * out the round trip: a single-replica write never leaves the leader, and a
 * quorum write is not finished until other machines have answered. The
 * replication round trip is a real cost the previous model simply omitted.
 *
 * **It improves the tail.** Waiting for k of m is hedging: the chance that a
 * majority are *all* slow is far below the chance that one is. With three
 * members the leader needs only the faster of two followers, so a single
 * straggler costs nothing. This is the same effect that makes tied and hedged
 * requests work, and the engine had no way to express it.
 *
 * @param {object} opts
 * @param {number} opts.serviceMs  the leader's own service time, median
 * @param {number} opts.rttMs      median round trip to a follower, including its fsync
 * @param {number} opts.replicas   members of the group
 * @param {number} [opts.cv]       variability of both
 * @param {number} [opts.p]        which quantile to report
 */
export function quorumWriteLatency({ serviceMs, rttMs, replicas, cv = 0.5, p = 0.5 }) {
  const n = Math.max(1, Math.round(replicas))
  if (n === 1) return lognormalQuantile(serviceMs, cv, p)
  const need = Math.floor(n / 2) + 1 - 1 // the leader is one of the majority
  const followers = n - 1
  // The leader's own work and the wait for followers are independent, and their
  // medians add only approximately. At the coefficients of variation components
  // actually have, the error is small and in the conservative direction; the
  // check measures it rather than assuming it away.
  return lognormalQuantile(serviceMs, cv, p) + orderStatQuantile(rttMs, cv, followers, need, p)
}

/**
 * How much of the tail a hedged request removes.
 *
 * Send the same request to `copies` replicas and take the first answer: the
 * p-quantile becomes the p-quantile of the *minimum*, which is dramatically
 * better far out in the tail and barely different at the median.
 *
 * @returns {number} the ratio of hedged latency to unhedged, at quantile p
 */
export function hedgeBenefit(cv, copies, p) {
  if (copies <= 1) return 1
  const one = lognormalQuantile(1, cv, p)
  const best = orderStatQuantile(1, cv, copies, 1, p)
  return best / one
}
