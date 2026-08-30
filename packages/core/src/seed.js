// Catalog → IR capacity seeding.
//
// The IR package deliberately knows nothing about component physics, so this is
// the bridge: give it a kind, get back a CapacityModel with the catalog figures
// and a provenance class that says where they came from. Every ingest path
// (IaC, v1 migration, canvas) goes through here, so a `sql` node means the same
// thing whether it was drawn, imported from Terraform, or migrated from a v1
// share link.

import { CATALOG, specOf } from './catalog.js'

/**
 * Components whose replicas form a consensus group rather than a pool.
 *
 * These are the kinds where a replica count means "members of a Raft or Paxos
 * group" — a majority must be reachable, so the availability arithmetic is the
 * binomial tail rather than 1-(1-a)^n, and an even member count is worse than
 * one fewer. Getting this wrong understated a three-member group's
 * unavailability by 298×.
 *
 * Deliberately a short list. A SQL database is *usually* leader-follower rather
 * than quorum, and a design that runs one in a consensus configuration should
 * say so on the node rather than have it assumed here. Guessing wrong in the
 * pessimistic direction is still guessing.
 */
const QUORUM_KINDS = new Set(['zk', 'registry', 'config'])

/** Vendor SLAs and published benchmarks get tighter priors than our estimates. */
const VENDOR_KINDS = new Set(['lb', 'gateway', 'cdn', 'dns', 'sql', 'nosql', 'blob', 'queue', 'kafka', 'search', 'cache'])

export function capacityFor(kind, extra = {}) {
  const spec = specOf(kind) || CATALOG.custom
  const known = !!CATALOG[kind]
  const cls = extra.provenanceCls || (known ? (VENDOR_KINDS.has(kind) ? 'vendor' : 'benchmark') : 'modeled')
  return {
    replicas: 1,
    capPerReplica: spec.cap,
    latencyMs: { dist: 'lognormal', p50: spec.lat, cv: spec.cv ?? 0.5 },
    availability: spec.avail,
    concurrency: spec.concurrency ?? 64,
    queueDepth: spec.queueDepth ?? 256,
    replication: QUORUM_KINDS.has(kind) ? 'quorum' : 'stateless',
    ...(spec.cacheHit ? { cacheHit: spec.cacheHit } : {}),
    ...(spec.source ? { source: true } : {}),
    provenance: {
      cls,
      basis: extra.basis || (known
        ? `ArchSim catalog seed for '${spec.name}' — not a measurement of your system`
        : `no catalog entry for '${kind}'; simulated conservatively as custom`),
      refs: extra.refs || [],
    },
    jitter: extra.jitter || (cls === 'vendor' ? { capPct: 30, latPct: 30 } : cls === 'benchmark' ? { capPct: 25, latPct: 25 } : { capPct: 40, latPct: 40 }),
    ...extra.capacity,
  }
}

export const kinds = () => Object.keys(CATALOG)
export const kindName = (k) => CATALOG[k]?.name || k
export const kindGlyph = (k) => CATALOG[k]?.glyph || '🧱'
