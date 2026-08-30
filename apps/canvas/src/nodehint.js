// How a utilisation figure should be read.
//
// Split out of the component because it is a judgement, not a rendering: these
// thresholds decide what advice the studio gives about every component on the
// canvas, and getting them wrong means confidently telling someone the wrong
// thing. Two of the bands here exist because the first draft did exactly that —
// it called 33% "idle, this may be larger than it needs to be", and it gave the
// same advice about a traffic source, which is not a thing that can be
// over-provisioned.

/**
 * Where utilisation sits, in words. The thresholds are the ones the engine
 * itself uses to decide when the analytic model stops being trustworthy.
 */
export function loadBand(util, reachable) {
  if (util >= 1) return { tone: 'breach', say: 'saturated — the queue grows without bound' }
  if (util >= 0.85) return { tone: 'breach', say: 'past the knee — latency is rising vertically' }
  if (util >= 0.7) return { tone: 'drift', say: 'at the knee — a small traffic rise costs a lot of latency' }
  if (util >= 0.35) return { tone: 'live', say: 'comfortable — room for a normal peak' }
  // Idle and unreachable look identical in the arithmetic and are completely
  // different problems. Telling someone to shrink a component sitting at zero
  // because nothing routes to it is advice pointed at the wrong thing.
  if (!reachable) return { tone: 'drift', say: 'no traffic reaches this — it is not on a path from any source' }
  if (util >= 0.08) return { tone: 'live', say: 'lightly loaded' }
  return { tone: 'live', say: 'barely used — worth asking whether it is sized for something real' }
}

