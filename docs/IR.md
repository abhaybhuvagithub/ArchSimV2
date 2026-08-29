# ArchIR 2.0

The IR is the single source of truth. The canvas and the infrastructure code are
both projections of it; neither owns the system.

JSON schema: [`packages/ir/schema/archir-2.0.schema.json`](../packages/ir/schema/archir-2.0.schema.json).
TypeScript declarations: [`packages/ir/types/ir.d.ts`](../packages/ir/types/ir.d.ts).

## Four design principles

**1. Address-anchored identity.** Every node carries a ULID that is never derived
from its label, plus the *native address* of its IaC origin (`aws_lb.main`,
`apps/v1:Deployment:prod/checkout`). Rename a node on the canvas, rename the
Terraform resource, move it between modules — nothing is orphaned, because
identity lives in the binding rather than the name.

Ingest derives ids deterministically from the address (`ulidFrom`), so
re-planning the same repository twice produces the same IR, byte for byte. A
gate that reported churn no human caused would be a gate people mute.

**2. Opaque passthrough — the anti-tarpit rule.** Anything the mappers do not
understand is preserved verbatim and re-emitted untouched. Bidirectional IaC dies
when a tool destroys code it did not model; we refuse that failure class
structurally rather than by being careful.

**3. Simulation semantics are first-class.** Capacity, latency, availability,
worker pools, queue bounds and call semantics live *in the IR*, seeded from the
v1 catalog, overridable per node, and later calibrated by telemetry.

**4. Everything versioned, everything diffable.** The IR is a JSON document
designed to live in git next to the Terraform. `git diff` on it is readable, and
`irHash` is a content address printed in every gate report.

## The shape

```jsonc
{
  "irVersion": "2.0",
  "meta": { "name": "checkout", "createdBy": "archsim-iac", "updatedAt": "…" },

  "nodes": [{
    "id": "0000000000ADAM9XR731MPMKRW",     // ULID, never derived from the label
    "kind": "sql",                           // v1 catalog taxonomy, frozen + extended
    "label": "checkout-db",
    "capacity": {
      "replicas": 2,
      "capPerReplica": 11000,
      "latencyMs": { "dist": "lognormal", "p50": 10, "cv": 0.5 },
      "availability": 0.9995,
      "concurrency": 176,                    // worker pool width (DES)
      "queueDepth": 704,                     // bounded queue K (DES backpressure)
      "provenance": {
        "cls": "vendor",
        "basis": "db.r6g.xlarge: 8 size-units × 1.1 family bias vs the catalog's reference `large`",
        "refs": ["https://aws.amazon.com/rds/pricing/"]
      },
      "jitter": { "capPct": 30, "latPct": 30 }   // the Monte-Carlo prior
    },
    "bindings": [{
      "lang": "plan-json",
      "file": "tfplan.json",
      "address": "aws_db_instance.main",
      "managed": "observed"
    }],
    "telemetry": { "service": "checkout-db", "confidence": "declared" },
    "attrs": { "tfType": "aws_db_instance", "replication": "leader" }
  }],

  "edges": [{
    "id": "…", "from": "…", "to": "…",
    "callSemantics": "sync",                 // sync holds a worker; async does not
    "protocol": "sql",
    "timeoutMs": 250,
    "retry": { "max": 2, "backoffMs": 50, "jitter": "full", "budgetPct": 10 },
    "breaker": { "windowSec": 10, "errThreshold": 0.5, "minSamples": 20, "cooloffMs": 5000 },
    "confidence": "high",
    "attrs": { "reason": "environment variable DATABASE_URL" }
  }],

  "workloads": [{ "id": "peak", "arrival": { "dist": "diurnal", "rps": 12000, "params": { "peakFactor": 4 } } }],
  "slos": [{ "id": "latency", "scope": "system", "metric": "p99_ms", "op": "<=", "threshold": 800, "under": "peak" }],
  "passthrough": [{ "lang": "hcl", "file": "main.tf", "text": "provider \"aws\" {\n  region = var.region\n}\n" }]
}
```

## `managed` — the political contract

| value | meaning |
|---|---|
| `observed` | read-only. Render it, never write to it. **The default.** |
| `partial` | ArchSim may patch mapped attributes (replica counts) in place. |
| `full` | ArchSim may regenerate this block. |

`observed` is what lets a platform team import a brownfield estate without
granting anyone write access to their Terraform. Value arrives before trust is
requested, which is the opposite of how most IaC tooling asks to be adopted.

## Provenance and the honesty band

`provenance.cls` is not documentation — it sets the width of the Monte-Carlo
prior, so "where did this number come from" has a numerical consequence:

| class | band | source |
|---|---|---|
| `telemetry` | ±10% | measured in the user's production |
| `benchmark` | ±25% | a published benchmark, or a declared CPU request |
| `vendor` | ±30% | a vendor SLA or an instance class |
| `modeled` | ±40% | our estimate — ArchSim 1.x's blanket honesty band |

A node whose replica count had to be guessed is demoted to `modeled` even if its
instance class was known exactly: a confident capacity figure multiplied by an
invented replica count is false precision.

## Diff, merge and the lockfile

`archsim.lock.json` is the committed IR of `main` — the "twin lockfile". The gate
diffs against it so a comment can say *was 97%, now 62%* rather than only stating
what is true today.

`threeWayMerge(base, canvas, code)` reconciles simultaneous edits like git:

```
canvas changed, code didn't  → take canvas → emit patch
code changed, canvas didn't  → take code   → update canvas
both changed, same value     → converge silently
both changed, differently    → CONFLICT — surfaced, never auto-resolved
```

The last line is load-bearing. A tool that silently picks a winner on `replicas`
will one day halve someone's database fleet and be technically correct about it.
Conflicts on fields that cost money are flagged as such.

## Migration from ArchSim 1.x

v1's share payload `{v, r, n[], e[]}` is the embryonic IR — nodes as plain data,
edges as pairs, traffic as a scalar. `fromV1(payload, capacityFor)` grows it up,
carrying inspector state (storage engine, consistency, replication mode) into
`attrs`, where the analytic engine still reads it. `toV1(ir)` projects back, so
old share links keep working. Both directions are in the suite.
