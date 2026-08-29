# Domain 1 — bi-directional IaC and ASTs

Features 1–25 of the enterprise expansion. Two notes on the brief before the
list, because both changed what got built.

**The taxonomy asked for a TypeScript AST extractor for CDK and Pulumi. That is
the wrong tool, and the alternative is not a compromise — it is more accurate.**
CDK's entire job is to turn TypeScript into CloudFormation: it expands
constructs, applies aspects, runs escape hatches, generates logical ids
deterministically and resolves cross-stack references. Pulumi's job is to turn a
program into a resource graph with resolved property values and explicit
dependencies. Both write that answer to disk — `cdk.out/*.template.json`,
`pulumi stack export`. An AST walk over the source re-derives all of it badly and
then disagrees with what actually deploys. So ArchSim reads the output. That
makes CDK and Pulumi **Mode A** paths — exact, because someone else's compiler
did the resolving — rather than the Mode B guesswork an AST walk would be.

**ArchSim is plain ESM JavaScript with zero runtime dependencies, and the studio
is a hand-written SVG canvas, not React Flow or Zustand.** The framework's
"production-grade TypeScript interfaces / Zustand hooks" therefore do not apply
literally. The state model is ArchIR 2.0, which is already the single source of
truth every projection reads; the integration point is the IR, not a store.

---

## What shipped

### Terraform breadth

| Feature | State |
|---|---|
| 1. AWS provider rules | already shipped — 88 rules |
| 2. GCP provider rules | already shipped — 29 rules |
| 3. Azure provider rules | already shipped — 33 rules |
| 4. **Oracle Cloud (OCI) provider rules** | **new — 32 rules** |
| 5. Terraform plan JSON ingest (exact) | already shipped |
| 6. `terraform show -json` state ingest | already shipped — the same reader; state and plan differ only in which key holds the root module |
| 7. Raw HCL2 CST parser and patcher | already shipped |
| 8. Kubernetes manifest and live-cluster ingest | already shipped |

The OCI table sizes a load balancer from its **bandwidth shape** rather than an
instance class — `400Mbps` becomes 50,000 requests/second at a kilobyte a
response — and an Autonomous Database from its OCPU count, because those are the
two capacity dials OCI actually exposes in Terraform.

### CloudFormation, CDK and SAM

| Feature | State |
|---|---|
| 9. **CloudFormation template parser, JSON and YAML** | **new** |
| 10. **YAML short-form intrinsics** (`!Ref`, `!GetAtt`, `!Sub`) | **new** |
| 11. **Intrinsic resolution** — `Ref`, `GetAtt`, `Sub`, `Join`, `Select`, `Split`, `FindInMap`, `If`, `ImportValue` | **new** |
| 12. **Parameter defaults and condition evaluation** | **new** |
| 13. **CloudFormation type mapping table** | **new — 46 rules** |
| 14. **`Ref`/`GetAtt`/`DependsOn` dependency graph → edges** | **new** |
| 15. **`cdk.out` manifest reader** | **new** |
| 16. **Generated-logical-id delabelling** | **new** |

`CheckoutServiceB1CE1F2A` becomes `checkout-service` on the canvas; the logical
id stays in the binding, because that is what a patch needs.

What it refuses to guess is as important as what it resolves. A `Ref` to a
parameter with no default, an `Fn::ImportValue` that crosses into a stack you did
not ingest, a condition that depends on a pseudo-parameter — each is recorded as
a warning naming the resource, not replaced with an invented value. The one
place a choice is made is `Fn::If` on an undecidable condition, which takes the
true branch and says so: conditions overwhelmingly guard optional extras, so
over-counting is the safe direction for a capacity model.

### Pulumi

| Feature | State |
|---|---|
| 17. **`pulumi stack export` ingest** | **new** |
| 18. **`pulumi preview --json` ingest** | **new** |
| 19. **URN → provider/type normalisation** | **new** |
| 20. **Dependency and property-dependency graph → edges** | **new** |

Pulumi's AWS, GCP and Azure providers are generated from the same schemas as
Terraform's, so `aws:ecs/service:Service` is `aws_ecs_service` and maps onto the
rules already in the registry. That correspondence is mechanical — camel-case
class name, snake-cased, provider-prefixed — with a short list of the resources
that were renamed on the way across. Every rule contributed for Terraform
therefore also serves Pulumi.

The report says which file it read. "This is what is deployed" and "this is what
*will* be deployed" are different claims, and a gate should not confuse them.

### Helm and Kubernetes

| Feature | State |
|---|---|
| 21. **Chart directory reader** — `Chart.yaml`, `values.yaml`, `templates/` | **new** |
| 22. **Value substitution with `-f`-style overrides** | **new** |
| 23. **Loud refusal on Go-template control flow** | **new** |

The temptation here is to implement Go templates. It should be resisted. Go's
template language has conditionals, ranges, pipelines, named sub-templates,
`include`, `tpl` and a hundred-odd Sprig functions, and a partial implementation
does not fail on what it cannot do — it silently renders something *else*. A
manifest that is quietly wrong is worse than one that was never read.

So: substitute what cannot change the document's shape (`{{ .Values.x }}`,
`{{ .Chart.Name }}`, `| default`, `| quote`), and refuse by file and line the
moment `if`, `range`, `with`, `include` or `toYaml` appears — pointing at
`helm template`, which already does this correctly. A chart that is half
renderable produces half an architecture and says which half is missing.

### Drift and pull requests

| Feature | State |
|---|---|
| 24. **Drift detection between the design and the deployed estate** | **new** |
| 25. **Pull-request payload generator** | **new** |

Drift is one command rather than one per provider, because every input becomes
IR first. `archsim drift --ir archsim.lock.json --plan live.json` compares a
committed design against `terraform show -json`; swap `--plan` for `--cfn`,
`--k8s` or `--pulumi` and nothing else changes.

Three findings, deliberately kept apart:

- **Undeployed** — in the design, not in the estate. An unmerged pull request
  looks exactly like this, which is why it is a finding rather than an error.
- **Unmanaged** — deployed, in nobody's design. The finding that costs money
  nobody has attributed.
- **Diverged** — both have it, and a field the *simulator reads* differs.

That last restriction is the whole design. Comparing every attribute produces a
report where the real finding is on page four. Only eight fields can change a
verdict — replicas, capacity per replica, median latency, availability,
concurrency, queue depth, cache hit rate, component kind — so only those are
compared, and each difference is reported with what it does to the model. A
differing tag is not drift. `archsim drift` exits `2`, not `1`: an unmerged pull
request is drift, and a pipeline that blocks on it blocks on being mid-deploy.

The pull-request generator turns canvas edits into a branch name, a commit
message, a real unified diff, a body, labels, and an `open.sh` that runs `gh`.
**It does not call GitHub.** A tool that opens pull requests needs a token, and a
token that can open a pull request can usually do a great deal more; the honest
boundary is to hand back everything needed and let a person or a CI job do the
pushing. It also means the payload is reviewable before anything irreversible
happens, which is the premise of the product.

The branch name is `archsim/<resource>-<irHash prefix>`: stable for the same
design, different for a design one replica away.

---

## Using it

```bash
# CloudFormation, straight
archsim ingest --cfn template.yaml --out archsim.lock.json

# a CDK app, from what `cdk synth` wrote — never from the TypeScript
cdk synth > /dev/null
archsim gate --cdk cdk.out/

# Pulumi
pulumi stack export > stack.json
archsim simulate --pulumi stack.json --rps 4000

# a chart you have not rendered
archsim ingest --helm charts/checkout --values values.prod.yaml

# what is deployed, against what was designed
terraform show -json > live.json
archsim drift --ir archsim.lock.json --plan live.json      # exit 2 if it differs

# canvas edits → a reviewable pull request
archsim emit --base archsim.lock.json --ir edited.json --hcl infra/ --pr
cat .archsim/pr/changes.diff && .archsim/pr/open.sh
```

The studio detects all of these from content rather than extension. A file
called `stack.json` can be a Terraform plan, a CloudFormation template, a Pulumi
export or a lockfile; asking the reader which is asking them to know something
the file already says.

---

## Data model

No new schema. Every path above produces ArchIR 2.0, which is the point of
having an IR: the gate, the discrete-event engine, the twin, the drift comparison
and the emitter all read one document, and a sixth input format costs them
nothing.

What each path adds is *bindings* — how a node traces back to the bytes it came
from:

```js
// Terraform plan JSON
{ lang: 'plan-json',       file: 'tfplan.json',   address: 'aws_ecs_service.checkout',  managed: 'observed' }
// raw HCL, with CST byte ranges behind it so the emitter can patch in place
{ lang: 'hcl',             file: 'main.tf',       address: 'aws_ecs_service.checkout',  managed: 'partial'  }
// Kubernetes
{ lang: 'k8s',             file: 'cluster.json',  address: 'apps/v1:Deployment/checkout', managed: 'observed' }
// CloudFormation and CDK
{ lang: 'cloudformation',  file: 'Stack.template.json', address: 'CheckoutServiceB1CE1F2A', managed: 'observed' }
// Pulumi
{ lang: 'pulumi',          file: 'stack.json',    address: 'aws:ecs/service:Service::checkout', managed: 'observed' }
```

`managed` is the adoption control, unchanged from the existing paths:
`observed` renders and simulates but is never written to, `partial` allows
attribute patches, `full` allows generation. The new readers default to
`observed`, so ingesting a stack can never modify it.

---

## Coverage, honestly counted

```
236 mapping rules
  aws  88 · cfn  46 · azure 33 · oci 32 · gcp 29 · k8s 8
262 structural types · 67 connectors · 62 noise
```

`archsim coverage` prints this. Unmapped resources render as `custom`,
round-trip byte-identically through passthrough, and are simulated
conservatively — never dropped, never silently absent from the diagram.

**506 checks** cover the whole compiler, 63 of them new in this batch.

---

## What still isn't good enough

- **Nested CloudFormation stacks are not followed.** An `AWS::CloudFormation::Stack`
  resource points at a template URL, which ArchSim cannot fetch. Ingest the child
  templates alongside the parent and their `Fn::ImportValue` references resolve;
  otherwise they are reported unresolved.
- **`Fn::Sub` returns a placeholder for resource references**, not a resolved
  ARN. That is correct — the ARN does not exist until deploy — but it means a
  rule that parses an ARN to find a dependency sees `${LogicalId.Arn}`. The
  dependency is still recorded, so edges are right; only string-parsing rules are
  affected.
- **The Helm renderer covers the substitution subset only.** By design, but it
  means most real charts — which use `if` for optional ingress and `range` for
  extra environments — come back as refusals. `helm template` remains the right
  answer for those, and the refusal says so.
- **The OCI table has not been run against a real Oracle Cloud repository.**
  The other four tables were hardened against 6,762 real Terraform files; this
  one has fixtures and no corpus. That is the next thing worth measuring.
- **Pulumi component resources are flattened.** A `ComponentResource` that wraps
  five real resources contributes its children, not itself, which is right for
  simulation and loses the grouping the author intended.
