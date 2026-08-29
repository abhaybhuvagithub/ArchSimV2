// t-digest — percentiles in bounded memory at any simulation horizon.
//
// A discrete-event run of a 12,000 rps system for five simulated minutes is
// 3.6 million completed requests. Keeping every latency to sort at the end
// costs hundreds of megabytes and makes long horizons impossible; keeping a
// fixed-size digest costs kilobytes and is accurate exactly where we care —
// the tails, because p99 is the number in the SLO.
//
// This is the merging variant: buffer incoming values, sort, merge with the
// existing centroids, and compress with the k1 scale function so centroids near
// q=0 and q=1 stay small while the middle is allowed to be coarse.

const DEFAULT_COMPRESSION = 200

export class TDigest {
  constructor(compression = DEFAULT_COMPRESSION) {
    this.compression = compression
    this.centroids = []   // [{mean, weight}] sorted by mean
    this.buffer = []
    this.n = 0
    this.min = Infinity
    this.max = -Infinity
  }

  push(x) {
    if (!Number.isFinite(x)) return
    this.buffer.push(x)
    this.n++
    if (x < this.min) this.min = x
    if (x > this.max) this.max = x
    if (this.buffer.length >= this.compression * 10) this.flush()
  }

  flush() {
    if (!this.buffer.length) return
    const incoming = this.buffer.map((mean) => ({ mean, weight: 1 }))
    this.buffer = []
    const merged = mergeSorted(this.centroids, incoming.sort((a, b) => a.mean - b.mean))
    this.centroids = compress(merged, this.compression, this.n)
  }

  /** @param p 0..100 */
  quantile(p) {
    this.flush()
    if (!this.n) return 0
    if (this.n === 1) return this.centroids[0]?.mean ?? this.min
    const q = Math.min(1, Math.max(0, p / 100))
    if (q === 0) return this.min
    if (q === 1) return this.max
    const target = q * this.n
    let cum = 0
    for (let i = 0; i < this.centroids.length; i++) {
      const c = this.centroids[i]
      const centre = cum + c.weight / 2
      if (target <= centre) {
        if (i === 0) return interp(this.min, c.mean, target / Math.max(1e-9, centre))
        const prev = this.centroids[i - 1]
        const prevCentre = cum - prev.weight / 2
        return interp(prev.mean, c.mean, (target - prevCentre) / Math.max(1e-9, centre - prevCentre))
      }
      cum += c.weight
    }
    return this.max
  }

  get mean() {
    this.flush()
    if (!this.n) return 0
    return this.centroids.reduce((a, c) => a + c.mean * c.weight, 0) / this.n
  }

  summary() {
    return {
      count: this.n,
      min: this.n ? this.min : 0,
      max: this.n ? this.max : 0,
      mean: this.mean,
      p50: this.quantile(50),
      p95: this.quantile(95),
      p99: this.quantile(99),
      p999: this.quantile(99.9),
    }
  }
}

function mergeSorted(a, b) {
  const out = []
  let i = 0, j = 0
  while (i < a.length && j < b.length) out.push(a[i].mean <= b[j].mean ? a[i++] : b[j++])
  while (i < a.length) out.push(a[i++])
  while (j < b.length) out.push(b[j++])
  return out
}

/** k1 scale function: bounded centroid weight as a function of quantile. */
function compress(centroids, compression, total) {
  if (!centroids.length) return centroids
  const out = []
  let cum = 0
  let current = { ...centroids[0] }
  let qLimit = qLimitFor(k(cum / total, compression) + 1, compression)
  for (let i = 1; i < centroids.length; i++) {
    const c = centroids[i]
    const proposed = current.weight + c.weight
    if ((cum + proposed) / total <= qLimit) {
      current.mean = (current.mean * current.weight + c.mean * c.weight) / proposed
      current.weight = proposed
    } else {
      cum += current.weight
      out.push(current)
      current = { ...c }
      qLimit = qLimitFor(k(cum / total, compression) + 1, compression)
    }
  }
  out.push(current)
  return out
}

const k = (q, c) => (c / (2 * Math.PI)) * Math.asin(2 * Math.min(1, Math.max(0, q)) - 1)
const qLimitFor = (kv, c) => (Math.sin(Math.min(Math.PI / 2, Math.max(-Math.PI / 2, (2 * Math.PI * kv) / c))) + 1) / 2
const interp = (a, b, t) => a + (b - a) * Math.min(1, Math.max(0, t))
