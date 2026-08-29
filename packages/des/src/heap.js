// Binary min-heap of events, ordered by time then by a monotonic sequence
// number.
//
// The tie-break is not a detail. Two events scheduled for the same instant must
// come out in a defined order or the same seed produces different traces on
// different machines — and a chaos engine that cannot reproduce its own findings
// is a random number generator with a diagram.

export class EventHeap {
  constructor() {
    this.items = []
    this.seq = 0
  }

  get size() { return this.items.length }

  push(t, event) {
    const node = { t, seq: this.seq++, event }
    const a = this.items
    a.push(node)
    let i = a.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (before(a[i], a[p])) { [a[i], a[p]] = [a[p], a[i]]; i = p } else break
    }
  }

  pop() {
    const a = this.items
    if (!a.length) return null
    const top = a[0]
    const last = a.pop()
    if (a.length) {
      a[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1, r = l + 1
        let m = i
        if (l < a.length && before(a[l], a[m])) m = l
        if (r < a.length && before(a[r], a[m])) m = r
        if (m === i) break
        ;[a[i], a[m]] = [a[m], a[i]]
        i = m
      }
    }
    return top
  }
}

const before = (x, y) => (x.t !== y.t ? x.t < y.t : x.seq < y.seq)
