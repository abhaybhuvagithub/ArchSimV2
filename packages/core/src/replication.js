// What a replica count actually buys you.
//
// The engine used to answer this one way for everything: availability was
// `1 - (1-a)^n`, the probability that at least one replica is up. That is
// correct for a stateless tier behind a load balancer and wrong — badly, and in
// the flattering direction — for anything consensus-backed.
//
// A Raft or Paxos group needs a *majority* reachable, not one member. With
// per-replica availability 0.99:
//
//   replicas   any-one (what the engine said)   majority (what is true)
//          2                        0.999900                   0.980100
//          3                        0.999999                   0.999702
//          5                        1.000000                   0.999990
//
// At three replicas that understated unavailability by 298×, and at five by
// about 98,500×. Worse than the magnitude is the direction: the old model said
// a second replica improves availability. For a quorum system it makes it
// worse — you have doubled the number of machines that must both be up. A tool
// that says "add a replica" there is giving advice that damages the system.
//
// This is the arithmetic behind Raft, Paxos, ZooKeeper, etcd and Spanner, which
// is why it is the first thing a distributed systems course covers after
// failure models, and why it was the gap worth closing first.

/** n choose k, iteratively, so it stays exact for the counts replicas take. */
export function choose(n, k) {
  if (k < 0 || k > n) return 0
  let r = 1
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1)
  return r
}

/** How many replicas must be reachable for the group to serve. */
export const quorumOf = (n) => Math.floor(n / 2) + 1

/**
 * P(at least `need` of `n` independent replicas are up), each up with prob `a`.
 * The binomial tail — the closed form the self-test checks against.
 */
export function atLeast(a, n, need) {
  let sum = 0
  for (let k = need; k <= n; k++) sum += choose(n, k) * a ** k * (1 - a) ** (n - k)
  return sum
}

/**
 * Availability of a group of `n` replicas under a replication mode.
 *
 * @param {number} a  per-replica availability
 * @param {number} n  replica count
 * @param {'stateless'|'leader'|'quorum'} [mode]
 */
export function availabilityOf(a, n, mode = 'stateless') {
  if (n <= 0) return 0
  if (mode === 'quorum') return atLeast(a, n, quorumOf(n))
  if (mode === 'leader') {
    // One replica serves and a standby takes over. Redundancy helps, but the
    // failover is neither instant nor certain: FAILOVER_SUCCESS is the fraction
    // of failures where promotion actually completes in time. Modelling it as
    // perfect would be the same flattery in a different place.
    const anyUp = 1 - (1 - a) ** n
    const needsFailover = anyUp - a
    return a + needsFailover * FAILOVER_SUCCESS
  }
  return 1 - (1 - a) ** n
}

/**
 * How often a leader failover completes before the caller gives up.
 *
 * Deliberately not 1. Promotion has to detect the failure, elect, and let
 * clients rediscover; published post-mortems put a well-run automatic failover
 * in the tens of seconds, which is long enough that some requests inside the
 * window are lost. 0.95 is a modelled figure, not a measured one, and it is
 * flagged as such by the node's provenance class rather than presented as fact.
 */
export const FAILOVER_SUCCESS = 0.95

/**
 * The latency multiplier a quorum write pays — which, for the p50, is none.
 *
 * The intuition says a majority write must be slower than a single one: you
 * wait for the q-th fastest of n responses rather than the first. The intuition
 * is right about the tail and wrong about the median, and the arithmetic says
 * why. A majority of an odd group is ⌊n/2⌋+1 of n, and the q-th of n order
 * statistic sits near the q/(n+1) quantile — which for 2-of-3 and 3-of-5 is
 * exactly 0.5. The median of a quorum write is the median of one replica.
 *
 * So this returns 1 for every odd group, and it is deliberately *not* wired
 * into the simulate hot path: a multiplication that is always by one is a cost
 * with no effect and a claim with no content. It is kept, exported and checked
 * because "quorum does not move your p50" is a real and slightly surprising
 * result, and because the even-n case does move it.
 *
 * Where quorum genuinely costs latency is the tail — you now need the second
 * of three to be fast, not just the fastest — and the engine models tails
 * through `physicalEffects`, not here. That is honest work left undone rather
 * than work quietly approximated.
 */
export function quorumLatencyMul(n, mode = 'stateless', cv = 0.5) {
  if (mode !== 'quorum' || n <= 1) return 1
  const q = quorumOf(n)
  const p = q / (n + 1)
  const sigma = Math.sqrt(Math.log(1 + cv * cv))
  return Math.exp(sigma * probit(p))
}

/** Inverse standard normal CDF — Acklam's rational approximation. */
export function probit(p) {
  if (p <= 0 || p >= 1) return 0
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00]
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01]
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00]
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00]
  const pl = 0.02425
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p))
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  if (p > 1 - pl) return -probit(1 - p)
  const q = p - 0.5
  const r = q * q
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
    / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
}

/**
 * The advice the arithmetic implies, in words, for one node.
 *
 * Worth stating in the studio rather than only in the number, because "an even
 * number of quorum replicas is strictly worse than one fewer" is the sort of
 * thing people do not believe until it is spelled out.
 */
export function replicationNote(n, mode) {
  if (mode !== 'quorum') return null
  if (n <= 0) return null
  if (n === 1) return 'A single member is not a quorum — it cannot survive any failure.'
  if (n % 2 === 0) {
    return `${n} members tolerate the same ${Math.floor(n / 2) - 1 + 1 - 1} failure(s) as ${n - 1}, `
      + `and are less available, because ${quorumOf(n)} must be up rather than ${quorumOf(n - 1)}. Use ${n - 1} or ${n + 1}.`
  }
  return `${n} members need ${quorumOf(n)} up and tolerate ${n - quorumOf(n)} failure(s).`
}
