// @archsim/core — the analytic fast path.
//
// Zero DOM references, zero dependencies. The web app is now the first
// *consumer* of this package rather than its owner; the CLI and the CI gate are
// the others, and they all get the same physics because there is only one copy
// of it.

export * from './catalog.js'
export * from './physics.js'
export * from './simulate.js'
export * from './faults.js'
export * from './pricing.js'
export * from './rng.js'
export * from './montecarlo.js'
export * from './slo.js'
export * from './quickfix.js'
export * from './wiring.js'
export * from './taxonomy.js'
export * from './seed.js'
export { availabilityOf, quorumOf, atLeast, choose, quorumLatencyMul, probit, replicationNote, FAILOVER_SUCCESS } from './replication.js'
export { ACRONYMS, ACRONYM_GROUPS, searchAcronyms } from './acronyms.js'
export { telemetryCoverage, telemetryNote, SIGNALS, SIGNAL_KINDS, OBSERVABILITY_KINDS } from './telemetry.js'
