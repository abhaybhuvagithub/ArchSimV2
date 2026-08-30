// Twin Lite — the canvas pulls, nobody stores.
//
// Tier 1 is deliberately serverless: the browser range-queries Prometheus, the
// Datadog API or an OTLP-HTTP collector on a 5–10 second tick. No ArchSim
// servers, no data custody, and an enterprise security review the size of zero.
//
// That constraint buys more than it costs. Because a replay is just a range
// query over the past, the vendor's own TSDB *is* the replay store — so
// time-travel ships in Tier 1 rather than waiting for the ingest pipeline.
//
// Every adapter takes an injected `fetch`, so the same code runs in the browser,
// in Node, and in tests against a recorded fixture.

import { emptyFrame } from './frames.js'

const RED = ['rps', 'p50', 'p99', 'errRate']

/**
 * Prometheus. Queries are templated per metric so a team can point them at
 * whatever their exporters actually emit — the default set assumes the
 * OpenTelemetry / RED conventions and is meant to be edited.
 */
export const PROM_DEFAULT_QUERIES = {
  rps: 'sum by (service) (rate(http_server_requests_total[1m]))',
  p50: 'histogram_quantile(0.5, sum by (service, le) (rate(http_server_duration_seconds_bucket[1m]))) * 1000',
  p99: 'histogram_quantile(0.99, sum by (service, le) (rate(http_server_duration_seconds_bucket[1m]))) * 1000',
  errRate: 'sum by (service) (rate(http_server_requests_total{status=~"5.."}[1m])) / clamp_min(sum by (service) (rate(http_server_requests_total[1m])), 0.001)',
}

export function prometheusSource({ baseUrl, queries = PROM_DEFAULT_QUERIES, fetchImpl, headers = {}, labelKey = 'service' }) {
  const doFetch = fetchImpl || globalThis.fetch
  const call = async (path, params) => {
    const url = `${baseUrl.replace(/\/$/, '')}${path}?${new URLSearchParams(params)}`
    const res = await doFetch(url, { headers })
    if (!res.ok) throw new Error(`prometheus ${res.status} ${res.statusText} for ${path}`)
    const body = await res.json()
    if (body.status !== 'success') throw new Error(`prometheus: ${body.error || 'query failed'}`)
    return body.data
  }

  return {
    name: 'prometheus',
    /** One instant. */
    async sample(at = Date.now()) {
      const frame = emptyFrame(at)
      const series = []
      for (const key of RED) {
        if (!queries[key]) continue
        const data = await call('/api/v1/query', { query: queries[key], time: Math.floor(at / 1000) })
        for (const r of data.result || []) {
          series.push({ metric: key, name: r.metric[labelKey], labels: r.metric, value: Number(r.value?.[1]) })
        }
      }
      return { frame, series }
    },
    /** A range — which is all a replay is. */
    async range(from, to, stepMs = 10000) {
      const out = []
      for (const key of RED) {
        if (!queries[key]) continue
        const data = await call('/api/v1/query_range', {
          query: queries[key],
          start: Math.floor(from / 1000),
          end: Math.floor(to / 1000),
          step: Math.max(1, Math.round(stepMs / 1000)),
        })
        for (const r of data.result || []) {
          for (const [ts, v] of r.values || []) {
            out.push({ ts: ts * 1000, metric: key, name: r.metric[labelKey], labels: r.metric, value: Number(v) })
          }
        }
      }
      return out
    },
  }
}

/** Datadog: the same shape, a different vocabulary. */
export function datadogSource({ site = 'api.datadoghq.com', apiKey, appKey, fetchImpl, queries = {} }) {
  const doFetch = fetchImpl || globalThis.fetch
  const headers = { 'DD-API-KEY': apiKey, 'DD-APPLICATION-KEY': appKey }
  const q = {
    rps: 'sum:trace.http.request.hits{*} by {service}.as_rate()',
    p50: 'p50:trace.http.request{*} by {service}',
    p99: 'p99:trace.http.request{*} by {service}',
    errRate: 'sum:trace.http.request.errors{*} by {service}.as_rate()',
    ...queries,
  }
  const call = async (query, from, to) => {
    const url = `https://${site}/api/v1/query?${new URLSearchParams({ query, from: String(Math.floor(from / 1000)), to: String(Math.floor(to / 1000)) })}`
    const res = await doFetch(url, { headers })
    if (!res.ok) throw new Error(`datadog ${res.status} ${res.statusText}`)
    return res.json()
  }
  return {
    name: 'datadog',
    async sample(at = Date.now()) {
      const series = []
      for (const key of RED) {
        const body = await call(q[key], at - 120000, at)
        for (const s of body.series || []) {
          const last = (s.pointlist || []).slice(-1)[0]
          if (!last) continue
          series.push({ metric: key, name: scopeName(s.scope), labels: { scope: s.scope }, value: Number(last[1]) })
        }
      }
      return { frame: emptyFrame(at), series }
    },
    async range(from, to) {
      const out = []
      for (const key of RED) {
        const body = await call(q[key], from, to)
        for (const s of body.series || []) {
          for (const [ts, v] of s.pointlist || []) out.push({ ts, metric: key, name: scopeName(s.scope), labels: { scope: s.scope }, value: Number(v) })
        }
      }
      return out
    },
  }
}

const scopeName = (scope) => String(scope || '').replace(/^.*service:/, '').split(',')[0]

/**
 * OTLP-HTTP. The collector must allow CORS for the browser tier — which is a
 * one-line collector config, and worth saying out loud because it is the single
 * thing that blocks a Tier-1 trial.
 */
export function otlpSource({ baseUrl, fetchImpl, headers = {} }) {
  const doFetch = fetchImpl || globalThis.fetch
  return {
    name: 'otlp',
    async sample(at = Date.now()) {
      const res = await doFetch(`${baseUrl.replace(/\/$/, '')}/v1/metrics/export`, { headers })
      if (!res.ok) throw new Error(`otlp ${res.status} ${res.statusText}`)
      const body = await res.json()
      return { frame: emptyFrame(at), series: flattenOtlp(body) }
    },
    async range() { throw new Error('OTLP collectors do not store history — point the twin at your TSDB for replay') },
  }
}

function flattenOtlp(body) {
  const out = []
  for (const rm of body.resourceMetrics || []) {
    const attrs = Object.fromEntries((rm.resource?.attributes || []).map((a) => [a.key, a.value?.stringValue ?? a.value?.intValue ?? a.value?.doubleValue]))
    for (const sm of rm.scopeMetrics || []) {
      for (const m of sm.metrics || []) {
        const points = m.sum?.dataPoints || m.gauge?.dataPoints || []
        for (const p of points) {
          out.push({
            metric: metricKey(m.name),
            name: attrs['service.name'],
            attributes: attrs,
            value: Number(p.asDouble ?? p.asInt ?? 0),
          })
        }
      }
    }
  }
  return out.filter((s) => s.metric)
}

function metricKey(name) {
  if (/requests?(_total)?$/.test(name)) return 'rps'
  if (/duration.*p99|p99/.test(name)) return 'p99'
  if (/duration/.test(name)) return 'p50'
  if (/error/.test(name)) return 'errRate'
  return null
}

/**
 * A deterministic source for demos, tests and offline work. It is honest about
 * what it is — nothing here claims to be production — and it makes the whole
 * twin path exercisable without a cluster, which is what keeps it tested.
 */
export function syntheticSource(ir, { seed = 1, rps = 2000, incidentAt = null } = {}) {
  let state = seed >>> 0
  const rand = () => {
    state ^= state << 13; state >>>= 0
    state ^= state >>> 17
    state ^= state << 5; state >>>= 0
    return state / 0x100000000
  }
  const services = ir.nodes.filter((n) => !n.capacity?.source)
  return {
    name: 'synthetic',
    async sample(at = Date.now()) {
      const series = []
      const incident = incidentAt !== null && at >= incidentAt && at < incidentAt + 240000
      for (const n of services) {
        const base = rps / Math.max(1, services.length)
        const jitter = 0.85 + 0.3 * rand()
        const sick = incident && (n.kind === 'sql' || n.kind === 'ledger')
        series.push({ metric: 'rps', name: n.label, attributes: { 'archsim.io/node': n.id }, value: base * jitter })
        series.push({ metric: 'p50', name: n.label, attributes: { 'archsim.io/node': n.id }, value: n.capacity.latencyMs.p50 * (sick ? 6 : 1) * jitter })
        series.push({ metric: 'p99', name: n.label, attributes: { 'archsim.io/node': n.id }, value: n.capacity.latencyMs.p50 * 3.2 * (sick ? 9 : 1) * jitter })
        series.push({ metric: 'errRate', name: n.label, attributes: { 'archsim.io/node': n.id }, value: sick ? 0.08 * jitter : 0.0004 * jitter })
      }
      // A service production knows about and the diagram does not.
      series.push({ metric: 'rps', name: 'fraud-scoring', attributes: { 'service.name': 'fraud-scoring' }, value: 240 * (0.9 + 0.2 * rand()) })
      series.push({ metric: 'p99', name: 'fraud-scoring', attributes: { 'service.name': 'fraud-scoring' }, value: 180 })
      series.push({ metric: 'errRate', name: 'fraud-scoring', attributes: { 'service.name': 'fraud-scoring' }, value: 0.002 })
      return { frame: emptyFrame(at), series }
    },
    async range(from, to, stepMs = 10000) {
      const out = []
      for (let t = from; t <= to; t += stepMs) {
        const { series } = await this.sample(t)
        for (const s of series) out.push({ ...s, ts: t })
      }
      return out
    },
  }
}
