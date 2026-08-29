// The inspector edits the IR, and every field here is one the simulators read.
//
// The provenance block is not decoration. A number's class decides how wide its
// Monte-Carlo band is, so "where did this come from" is a question with a
// numerical consequence, and the panel says it in the same place you change the
// value.

import React from 'react'
import { kindName, kinds, capacityFor } from '@archsim/core'
import { PROVENANCE_CLASSES } from '@archsim/ir'

export default function Inspector({ ir, nodeId, onChange, onDelete, drift, onCalibrate }) {
  const node = ir.nodes.find((n) => n.id === nodeId)
  if (!node) {
    return (
      <div className="inspector empty">
        <h3>Nothing selected</h3>
        <p>Click a component to inspect it. Shift-drag from one component to another to connect them.</p>
        <p className="muted">
          Everything on this canvas is a projection of the IR — the same document the CLI gates and the compiler
          writes back into Terraform. Edit here, then look at the <strong>Code</strong> tab to see the patch it produces.
        </p>
      </div>
    )
  }

  const cap = { ...node.capacity, ...(node.overrides || {}) }
  const set = (patch) => onChange({ ...node, ...patch })
  const setCap = (patch) => onChange({ ...node, capacity: { ...node.capacity, ...patch } })
  const nodeDrift = drift?.find((d) => d.nodeId === node.id)

  return (
    <div className="inspector">
      <header>
        <input className="title" value={node.label} onChange={(e) => set({ label: e.target.value })} aria-label="Label" />
        <button className="danger" onClick={() => onDelete(node.id)} title="Deleting here never deletes code — it becomes a removal proposal in the diff">Remove</button>
      </header>

      <label>
        Kind
        <select value={node.kind} onChange={(e) => set({ kind: e.target.value, capacity: { ...capacityFor(e.target.value), replicas: node.capacity.replicas } })}>
          {kinds().map((k) => <option key={k} value={k}>{kindName(k)}</option>)}
        </select>
      </label>

      <div className="row">
        <label>
          Replicas
          <input type="number" min="0" value={cap.replicas}
                 onChange={(e) => setCap({ replicas: Math.max(0, Number(e.target.value) || 0) })} />
        </label>
        <label>
          Capacity <span className="unit">rps/replica</span>
          <input type="number" min="0" value={cap.capPerReplica === Infinity ? '' : cap.capPerReplica}
                 onChange={(e) => setCap({ capPerReplica: Number(e.target.value) || 0 })} />
        </label>
      </div>

      <div className="row">
        <label>
          Service time <span className="unit">p50 ms</span>
          <input type="number" min="0" step="0.5" value={cap.latencyMs.p50}
                 onChange={(e) => setCap({ latencyMs: { ...cap.latencyMs, p50: Number(e.target.value) || 0 } })} />
        </label>
        <label>
          Availability
          <input type="number" min="0" max="1" step="0.0001" value={cap.availability}
                 onChange={(e) => setCap({ availability: Number(e.target.value) || 0 })} />
        </label>
      </div>

      <div className="row">
        <label>
          Workers <span className="unit">concurrency</span>
          <input type="number" min="0" value={cap.concurrency}
                 onChange={(e) => setCap({ concurrency: Number(e.target.value) || 0 })} />
        </label>
        <label>
          Queue limit <span className="unit">K</span>
          <input type="number" min="0" value={cap.queueDepth}
                 onChange={(e) => setCap({ queueDepth: Number(e.target.value) || 0 })} />
        </label>
      </div>

      <section className={`provenance prov-${cap.provenance.cls}`}>
        <h4>
          {PROVENANCE_CLASSES[cap.provenance.cls]?.label || cap.provenance.cls}
          <span className="band">±{cap.jitter.capPct}% band</span>
        </h4>
        <p>{cap.provenance.basis || 'no basis recorded'}</p>
        {cap.provenance.refs?.map((r) => <a key={r} href={r} target="_blank" rel="noreferrer">{shortUrl(r)}</a>)}
        {cap.provenance.cls === 'modeled' && (
          <p className="warn">
            This is a prior, not a measurement of your system. The gate samples it ±{cap.jitter.capPct}% —
            connect telemetry and one click replaces it with what production actually does.
          </p>
        )}
      </section>

      {nodeDrift && (
        <section className="drift">
          <h4>The model and production disagree</h4>
          <p>{nodeDrift.msg}</p>
          <button onClick={() => onCalibrate(node.id)}>
            Calibrate from telemetry → {Math.round(nodeDrift.impliedCeiling)} rps
          </button>
        </section>
      )}

      <section className="bindings">
        <h4>Where this lives in code</h4>
        {node.bindings?.length ? node.bindings.map((b) => (
          <div key={`${b.file}:${b.address}`} className={`binding managed-${b.managed}`}>
            <code>{b.address}</code>
            <span className="file">{b.file}</span>
            <span className={`chip ${b.managed}`} title={managedHelp(b.managed)}>{b.managed}</span>
          </div>
        )) : <p className="muted">No binding. This component exists on the canvas but not in any code ArchSim has read — the emitter will offer to generate it.</p>}
      </section>

      {node.telemetry && (
        <section className="bindings">
          <h4>Where this lives in production</h4>
          <div className={`binding conf-${node.telemetry.confidence}`}>
            <code>{node.telemetry.service || `${node.telemetry.k8s?.namespace}/${node.telemetry.k8s?.workload}` || node.telemetry.promSelector}</code>
            <span className="chip">{node.telemetry.confidence}</span>
          </div>
        </section>
      )}

      {Object.keys(node.attrs || {}).length > 0 && (
        <details className="attrs">
          <summary>Attributes</summary>
          <pre>{JSON.stringify(node.attrs, null, 2)}</pre>
        </details>
      )}
    </div>
  )
}

function managedHelp(m) {
  return {
    observed: 'Read-only. ArchSim renders this resource and will never write to it — the default, so a brownfield estate can be imported without granting anyone write access.',
    partial: 'ArchSim may patch mapped attributes (replica counts) in place. Comments and formatting are untouched.',
    full: 'ArchSim may regenerate this block.',
  }[m] || m
}

const shortUrl = (u) => String(u).replace(/^https?:\/\//, '').slice(0, 48)
