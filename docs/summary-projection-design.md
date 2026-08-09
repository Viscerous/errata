# Summary Projection — Tiered Story Memory

This document defines the implemented source-reversible, chronologically
labelled story-memory projection and its bounded context presentation.

The runtime now folds source-current level-0 contributions with explicit gaps,
bounded reader-specific rendering, and target-relative authored records.
Content-addressed background roll-ups are maintained proactively after Analyze;
a budget-truncated projection can also request them. Generation never waits for
them.

## Principle

The summary is a **fold over source-linked contributions**, with LLM roll-up as
a cached derivation step — the same shape as the continuity view
([continuity-view.ts](../src/server/librarian/continuity-view.ts)), which already
proves the pattern for state, threads, and knowledge.

Precisely: the *fold* is deterministic — given a set of cached nodes and a
boundary it always selects and renders the same thing. The *derivation* of a
node is an LLM call and is not deterministic; it is cached, versioned, and
replaced wholesale rather than accumulated. Those are different guarantees and
the design depends on not confusing them.

A node is a **pure function of its ordered children**. Nothing else is an input.
Every dependency is in the cache key, or it is not a dependency.

## Node model

One record type at every level, not a fixed L0/L1/L2 vocabulary:

| Field | Source |
|---|---|
| `level` | 0 = contribution, 1 = episode, 2+ = era, recursive |
| `children` | ordered child node IDs (level 0: the analysis itself) |
| `coverageStart` / `coverageEnd` | server-derived from children |
| `title`, `text` | model-returned (roll-up only) |
| `contractVersion`, `modelConfig` | recorded at derivation |
| `tokenCount` | server-measured |

Level 0 is `analysis.summaryUpdate` with its `sourceRevision`; it requires no
separate derived artifact.

**`level` is generic and the tree is recursive.** A terminal top tier only moves
the unbounded-growth problem up one storey: eras would accumulate without limit
and the renderer would have to discard the oldest, which is the character-slice
truncation this design removes. A 6× tree over N passages is log₆N deep — 36
passages is one era, 1,296 is one level-3 node.

Fan-out defaults:

| Setting | Default |
|---|---|
| Level-0 retained unrolled | 6 passages beyond the prose window |
| Fan-out, every level | 6 children |
| Rendered budget | per level, in tokens |
| Max output per node | hard cap; overflow is a roll-up failure |

Roll-up runs on the librarian's async path. **No LLM call enters the Writer's hot
path** — that guardrail is preserved exactly.

## Source currency — no stale rendering

**Only source-current material renders.** A level-0 contribution is eligible when
its `sourceRevision.contentHash` matches the current prose. Summary and
continuity projections apply the same source-currency principle.

A `summaryUpdate` generated from superseded prose is *itself* stale. It is not a
safe fallback for an invalidated node — it describes the same replaced text at
lower fidelity. So invalidation never degrades to raw level-0.

**A derived node exists only when every expected child is current, contiguous,
and eligible.** There is no partial node. One stale child invalidates the node;
the frontier descends to its children, and the gap renders at its exact position.
When reanalysis fills it, the node rebuilds.

Markers are structural dividers, not children. They are skipped without counting
as a gap and bound windows, so no node spans a chapter break.

**Contributions without `sourceRevision` cannot be verified.**
The summary lane rejects unverifiable level-0 contributions: they are never
folded or rolled up. Missing provenance renders as a **gap**, not as material
silently absorbed into another record.

## Projection frontier

Context construction slices the active chain before a regeneration target and
then compacts it to the prose window. Cached nodes are built against the full
chain and can straddle both boundaries. If a node covers passages 1–6 and the
target is passage 5, rendering it leaks future material into a regeneration.

Selection is a **frontier walk**, not a filter:

```text
boundary = min(first passage in prose window, regeneration target index)

select(node):
  if node.coverageEnd  < boundary   -> emit node
  if node.coverageStart >= boundary -> skip
  otherwise (node crosses)          -> recurse into ordered children
```

The result is a non-overlapping, chronologically ordered set of the
highest-available level per span, terminating at level 0. Every span before the
boundary is covered exactly once, or is an explicit gap.

**The frontier governs every summary surface, not only derived nodes.** Authored
records can contain post-target events just as easily:

- an **authored summary** carries an explicit `validThrough`. Without one it is
  excluded from target-relative prompts — regeneration, editing,
  target-relative context builds — and rendered only at the live head. First-class
  does not mean always safe to inject.

Unscoped authored summaries remain available at the live head but are excluded
from target-relative prompts. There are no active-user records to migrate.

## Roll-up contract

The call receives **only its ordered children**. No ancestor prefix, sibling
context, or other undeclared input participates. Delta suppression therefore
operates within one node; repetition across nodes collapses when those nodes
become children of the next level.

The call returns exactly:

```ts
{ title: string; text: string }
```

Coverage IDs, child links, level, gaps, and token count are all already known to
the server and are attached by it. Asking the model to reproduce server-owned
data adds cost and creates avoidable disagreement; the model should address
known inputs, not transcribe them.

`text` must be in **retrospective register**: perfect aspect and summary-of-record
voice — "by the time she reached the Trial, she had already…" rather than "she
reached the Trial." Retrospective text cannot be misread as current action,
whereas present-tense text under a warning heading can. Make the bad output
inexpressible rather than detectable.

`text` exceeding the per-node cap is a **roll-up failure**: nothing is cached,
the span renders at the level below, and the failure is recorded. Once token
budgeting is a correctness constraint, an oversized node is not a harmless
verbose one.

**Register applies at every level.** Analyze writes level-0 `summaryUpdate` in
the same retrospective register used by roll-ups. Level-0 records carry a
`contractVersion`: **source-current and register-compliant are orthogonal**. An
outdated-contract contribution remains ineligible even when its source is
current.

## Cache key and scheduling

A node's identity is the **ordered** list of its inputs — chronology is
load-bearing and a set cannot express it.

| Level | Key |
|---|---|
| 1 | ordered `[{proseId, analysisId, sourceHash, summaryHash, contractVersion}]` + roll-up contract version + model config |
| 2+ | ordered `[{childNodeId, childArtifactHash}]` + roll-up contract version + model config |

`summaryHash` is required because `summaryUpdate` can change independently of
prose. `analysisId` is required because reanalysis of unchanged prose can
produce different output. Contract version and model config are required
because a prompt, schema, or fan-out change makes cached nodes incomparable.

Keying level 2+ on child artifact hashes is what makes the cascade work:
re-rolling a node changes its artifact hash, invalidating its parent, without any
level above needing to know about passages.

**Nodes are content-addressed intervals, not positional batches.** Repartitioning
the chain into fixed groups of six would mean inserting a passage early
reshuffles every downstream group and invalidates the whole future. Instead:

- a node stays eligible while its exact ordered child sequence remains
  contiguous in the active chain;
- an insertion leaves existing downstream nodes reusable and creates an
  uncovered window;
- the scheduler fills uncovered contiguous windows opportunistically, bounded by
  markers;
- an interval that is no longer contiguous is dropped, not repaired.

**Roll-up queuing** uses a separate coalescing maintenance lane keyed by story
and branch. A projection that still has a budget omission marks demand and
immediately returns its lower-level frontier; the librarian scheduler releases
at most one node derivation only after the foreground Analyze queue is idle, and
later reads pick up the cached node. It respects `disableLibrarianAutoAnalysis`: with
automatic librarian work off, nothing is queued. Reanalysis itself continues to
use the existing librarian scheduler.

## Presentation

The renderer varies guidance by reader while preserving a single deterministic
projection.

Two failure modes need separate defenses:

1. **temporal collapse** — reading a summarized event as recent;
2. **resolution laundering** — lifting a compressed detail back into the live
   scene as a live sensory fact.

Register defends both at the text level. The renderer adds:

**Spans, not adjectives.** `Passages 1–14`. Story-time duration renders **only
from a structured range**. `temporalFrame.anchor` is free-text natural language
attached to a single passage — for example, "three winters earlier" — and
cannot be summed across a span. Rendering "roughly three weeks" from a bag of
anchors fabricates provenance; where no structured range exists, story time is
omitted.

**A visible resolution gradient.** Era → episode → recent level 0, each labelled
with its span, so the sequence reads as zooming in.

**Explicit gaps** at their exact position, never a silent omission.

**A closing fence and a stated seam.** The prose window already closes with
`## End of Recent Prose`; the summary renderer likewise closes its block and
states whether its newest coverage is contiguous with the first passage in the
prose window.

**Per-agent guidance:**

| Reader | Presentation |
|---|---|
| `generation.writer` | compressed record of what already happened; not a scene to continue from, not a source of present-moment detail |
| `directions.suggest` | narrative shape and distance, so a quiet thread can be deliberately reintroduced |
| `librarian.analyze` | coverage boundaries, so already-folded material is not re-reported |
| editing readers | evidence while editing; do not copy narrative history into the target fragment |
| `character-chat.chat` (`self`) | does not receive omniscient global story memory |

## Ownership

**Ownership.** Derived nodes are cache, not documents:

| Record | Editable | Archivable | Re-rolled |
|---|---|---|---|
| Authored summary fragment | yes | yes | never |
| Level-0 contribution | yes, via the analysis PATCH route | n/a — it is an input | n/a |
| Derived node (level 1+) | no | no | yes |

Derived nodes are internal and immutable. Authors act on the level-0
contribution, an authored summary record, or the source passage. Editing and
archiving remain properties of authored records, never cache nodes.

## Verification invariants

Coverage should preserve the following behaviors:

| Case | Guards |
|---|---|
| Regeneration target inside a derived span | frontier descent; no future leakage |
| Regeneration target before authored `validThrough` | boundary governs authored surfaces too |
| Passage deleted | contribution leaves the fold |
| Passage edited | contribution omitted, gap at exact position, reanalysis queued — never stale level 0 |
| Variation switched | same, via source hash |
| Branch fork; reorder within a branch | interval eligibility across chains |
| Insertion early in the chain | downstream nodes stay cached; only the uncovered window re-rolls |
| Level 0 with no `sourceRevision` | not folded; explicit gap |
| Manual `summaryUpdate` edit | `summaryHash` invalidates the containing node |
| Reanalysis with identical prose | `analysisId` invalidates the containing node |
| Level 0 with an outdated contract | `contractVersion` marks it non-compliant regardless of currency |
| Marker mid-window | no node spans a chapter break; marker is not a gap |
| Node re-roll | cascades upward via child artifact hash |
| Roll-up fails, or exceeds the size cap | nothing cached, span renders one level down, failure recorded |
| Auto-analysis disabled | gap renders with manual affordance; nothing queued |
| Any generation path | roll-up is never awaited or executed inline |

## Limits

**Framing will not carry this alone.** Models can under-weight metadata against
the semantic pull of narrative text. Retrospective register is the primary
defense and headings are backup.

**Cross-node repetition is unhandled below the era level** because each roll-up
sees only its declared children.

**Roll-up quality is model-dependent.** Delta-only within a node is a contract,
not a guarantee — but a model that restates its children now fails the size cap
rather than quietly inflating the budget.

**This is not retrieval.** Summaries are a chronological spine delivered
without a retrieval decision. First-use dependencies between authored records
belong to the fragment-retrieval lane, where a candidate provider may help.
Retrieved chunks do not replace chronological or resolution-aware memory: a
candidate can prompt retrieval, but cannot establish occurrence truth.
