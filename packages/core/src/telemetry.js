// Can you see this system when it breaks?
//
// Three signals answer different questions and none substitutes for another:
// metrics say *that* something is wrong, traces say *where*, logs say *what*.
// A design with metrics alone tells you the checkout is slow and leaves you
// guessing which of nine services did it.
//
// So this is not a badge. It reads the design and reports which of the three
// there is actually a component for, because "🔭 traces, metrics, logs" printed
// unconditionally would be decoration — it would say the same thing about a
// design with a full observability stack and one with nothing at all.

import { CATALOG } from './catalog.js'

/**
 * Which catalog kinds provide which signal.
 *
 * `otel` and `apm` appear under more than one deliberately: an OpenTelemetry
 * collector really does carry all three, and an APM agent really does produce
 * traces and metrics. Listing them once under a favourite would understate
 * what a design already has.
 */
export const SIGNAL_KINDS = {
  metrics: ['monitor', 'otel', 'apm', 'tsdb'],
  traces: ['tracing', 'otel', 'apm'],
  logs: ['logs', 'otel', 'siem'],
}

export const SIGNALS = Object.keys(SIGNAL_KINDS)

/**
 * What the design can see about itself.
 *
 * @param {{nodes: {kind: string, label: string}[]}} ir
 * @returns {{metrics: string[], traces: string[], logs: string[]}}
 *   the labels of the components providing each signal; empty means blind
 */
export function telemetryCoverage(ir) {
  /** @type {any} */
  const out = {}
  for (const signal of SIGNALS) {
    const kinds = new Set(SIGNAL_KINDS[signal])
    out[signal] = (ir?.nodes || []).filter((n) => kinds.has(n.kind)).map((n) => n.label)
  }
  return out
}

/**
 * The sentence to put beside the signal, in words rather than a tick.
 *
 * A missing signal is worth naming precisely, because the three failures feel
 * identical at three in the morning and are not.
 */
export function telemetryNote(signal, providers) {
  if (providers.length) return `${providers.join(', ')}`
  return {
    metrics: 'Nothing measures this design — an incident starts with someone noticing by hand.',
    traces: 'No tracing, so a slow request tells you it was slow and not which hop was.',
    logs: 'No log collection, so the detail of what actually happened is on the instances and gone when they are.',
  }[signal]
}

/** Every kind that provides at least one signal — used by the catalog checks. */
export const OBSERVABILITY_KINDS = [...new Set(Object.values(SIGNAL_KINDS).flat())]
  .filter((k) => CATALOG[k])
