// Seeded randomness. Everything stochastic in ArchSim draws from here, so
// `--seed 42` means the gate posts the same comment twice on a re-run and
// `archsim replay --seed 42 --run 371` reproduces exactly the world that failed.
//
// A gate whose verdict wobbles between runs is a gate people learn to ignore.

/** mulberry32 — small, fast, good enough for Monte-Carlo priors. */
export function rng(seed = 1) {
  let a = (seed >>> 0) || 1
  return function next() {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Derive an independent stream per run so runs are order-independent. */
export function streamFor(seed, run, salt = 0) {
  let h = (seed >>> 0) ^ Math.imul(run + 1, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 16), 0x27d4eb2d) >>> 0
  return rng(h)
}

export const uniform = (r, lo, hi) => lo + (hi - lo) * r()

/**
 * Symmetric triangular draw inside ±pct. Chosen over a uniform draw because the
 * band is an honesty band, not a claim that every value in it is equally
 * likely: the catalog figure is the mode, and the edges are the edges.
 */
export function bandDraw(r, pct) {
  const u = r() + r() - 1 // triangular on [-1, 1], peak at 0
  return 1 + (pct / 100) * u
}

export function normal(r, mean = 0, sd = 1) {
  const u = Math.max(1e-12, r())
  const v = r()
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

/** Lognormal fitted so that median = p50 and coefficient of variation = cv. */
export function lognormal(r, p50, cv) {
  const sigma = Math.sqrt(Math.log(1 + cv * cv))
  const mu = Math.log(Math.max(1e-9, p50))
  return Math.exp(normal(r, mu, sigma))
}

export const exponential = (r, meanMs) => -Math.log(1 - Math.max(1e-12, r())) * meanMs

export function poisson(r, lambda) {
  if (lambda > 30) return Math.max(0, Math.round(normal(r, lambda, Math.sqrt(lambda))))
  const L = Math.exp(-lambda)
  let k = 0, p = 1
  do { k++; p *= r() } while (p > L)
  return k - 1
}

/** Percentile of an unsorted sample array. */
export function percentile(samples, p) {
  if (!samples.length) return 0
  const s = samples.slice().sort((a, b) => a - b)
  const i = (p / 100) * (s.length - 1)
  const lo = Math.floor(i), hi = Math.ceil(i)
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo)
}

export const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
