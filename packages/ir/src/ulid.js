// ULID — stable, sortable, opaque node identity.
//
// The IR's first design principle is that identity never derives from a label.
// Rename a node on the canvas, rename the Terraform resource, move it between
// modules: the ULID is what every binding, telemetry mapping and SLO points at,
// so none of those edits orphan anything.

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' // no I, L, O, U
const TIME_LEN = 10
const RAND_LEN = 16

function randByte(rng) {
  return Math.floor(rng() * 256)
}

/**
 * Generate a ULID. Pass a seeded rng (and fixed `now`) for reproducible IR
 * fixtures — the verification suite depends on that.
 */
export function ulid(now = Date.now(), rng = Math.random) {
  let time = ''
  let t = now
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    time = CROCKFORD[t % 32] + time
    t = Math.floor(t / 32)
  }
  let rand = ''
  for (let i = 0; i < RAND_LEN; i++) rand += CROCKFORD[randByte(rng) % 32]
  return time + rand
}

export const isUlid = (s) =>
  typeof s === 'string' && s.length === 26 && [...s].every((c) => CROCKFORD.includes(c))

/**
 * Deterministic ULID-shaped id derived from a string (an IaC address, usually).
 * Ingesting the same plan twice must produce the same IR, byte for byte, or the
 * gate's diff would report churn that no human caused.
 */
export function ulidFrom(seedText, epoch = 0) {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < seedText.length; i++) {
    h1 ^= seedText.charCodeAt(i)
    h1 = Math.imul(h1, 0x01000193) >>> 0
    h2 = (Math.imul(h2 ^ seedText.charCodeAt(i), 0x85ebca6b) + i) >>> 0
  }
  let state = (h1 ^ (h2 << 1)) >>> 0
  const rng = () => {
    state ^= state << 13; state >>>= 0
    state ^= state >>> 17
    state ^= state << 5; state >>>= 0
    return state / 0x100000000
  }
  return ulid(epoch, rng)
}
