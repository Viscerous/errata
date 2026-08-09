# Summarization and Story Memory

Errata represents long-term story history as a projection over source-linked
librarian analyses. It does not append analyses into a mutable rolling-summary
document.

The recursive roll-up architecture and its rationale are specified in
[Summary Projection](summary-projection-design.md). The current implementation
ships the source-current level-0 fold, reader-specific renderer, and recursive
background level-1+ roll-ups. No generation request waits for a roll-up or adds
a second model call.

## Runtime flow

1. Accepted prose is saved.
2. Librarian analysis records a retrospective `summaryUpdate`, the exact
   `sourceRevision`, and `summaryContractVersion`.
3. A reader builds its ordinary context.
4. Prose inside the recent context window remains verbatim.
5. For prose before that window, the summary projection selects the latest
   analysis for each active prose fragment and verifies its source hash and
   contract version.
6. The projection is rendered with reader-specific guidance, exact passage
   positions, explicit gaps, a recent-prose seam statement, and a closing fence.
7. After Analyze becomes idle, a separate Memory activity recursively maintains
   any newly eligible roll-up levels without blocking the reader.

This makes deletion, variation switching, branching, and source edits affect
memory by selection rather than by mutating another document.

Key files:

- `src/server/librarian/summary-projection.ts` — source selection, validation,
  budgeting, caching, and presentation
- `src/server/librarian/agent.ts` — writes level-0 analysis contributions
- `src/server/librarian/summary-rollups.ts` — plans and caches recursive memory
  nodes
- `src/server/librarian/summary-rollup-maintenance.ts` — schedules background
  memory maintenance
- `src/server/llm/context-builder.ts` — constructs the projection once per
  context and shares the analysis index with continuity
- `src/server/librarian/blocks.ts`, `src/server/directions/blocks.ts`, and
  `src/server/agents/block-helpers.ts` — reader-specific routing

## Data contract

Each eligible level-0 contribution is an immutable analysis artifact with:

- `fragmentId` — the source prose fragment
- `sourceRevision.contentHash` — the exact prose revision analyzed
- `summaryUpdate` — retrospective historical record
- `summaryContractVersion` — prompt/output contract used to write it

The active analysis index resolves a prose fragment to its latest analysis ID.
The projection does not accept a contribution when the analysis is missing,
empty, source-unverified, source-stale, or written under an older contract.
Those cases render as coverage gaps at the source passage's position.

The current contract version is `SUMMARY_CONTRACT_VERSION` in
`src/server/librarian/summary-projection.ts`.

## Context budget and seam

`SUMMARY_TOKEN_BUDGET` bounds the derived memory block. Selection proceeds
newest-first because history nearest the recent-prose seam has the highest
continuity value. The six nearest level-0 entries are always retained even when
they exceed the nominal budget.

When older entries do not fit, the renderer reports their omitted position
range. It never silently presents the remaining projection as complete. Future
content-addressed roll-up nodes can replace those omitted level-0 spans without
changing the rendering contract.

The renderer also states whether the newest memory entry is contiguous with the
first recent prose passage, then terminates with `## End of Story Summary`.

## Reader-specific presentation

All readers consume the same structured projection, but not identical prose:

- Writer receives historical-record guidance and is warned not to continue the
  compressed text as a live scene.
- Directions uses the record for narrative shape and deliberate thread return.
- Librarian Analyze uses coverage labels to avoid re-reporting old material.
- Editing flows use it as evidence, not replacement prose.
- Character Chat does not receive omniscient global story memory.

Rendering is deterministic and does not invoke a model.

## Authored memory

`summary` fragments remain as optional author-owned memory records. The
librarian does not create, append, compact, or splice them.

At the live story head, active authored records are included with the derived
projection. In target-relative regeneration or editing, a record is included
only when `meta.validThrough` identifies an active prose fragment before the
target boundary. Unscoped records are excluded so future editorial knowledge
cannot leak backward.

## Continuity is separate

Summary answers "what happened." The continuity projection separately folds
source-linked keyed state, live threads, temporal framing, and character
knowledge boundaries. Both views share one analysis-index read during context
construction, and analysis-file reads are promise-cached so their cold paths do
not race to open the same files.

## Controls

The relevant settings control whether automatic librarian analysis, automatic
directions, or suggestions run. Disabling automatic directions removes that
lane from Analyze but does not prevent a manual direction request. Disabling
librarian auto-analysis prevents new memory contributions but does not change
projection behavior for existing ones.

Story-memory maintenance is proactive after Analyze reaches idle, rather than
waiting for the first budget omission. It is a separate `librarian.rollup`
activity (shown as **Memory** in the UI), not an extension of Analyze's model
contract. An idle Context Preview can also release demand if it discovers an
omitted prefix. The maintenance pass repeatedly folds every currently eligible
six-child interval, including newly eligible parent levels, before yielding.

Each request receives only six exact ordered children, returns only a title and
retrospective text, and writes an immutable content-addressed cache node.
Analyze, Writer, and Context Preview never await this maintenance. If foreground
work begins, maintenance yields and resumes later; until it finishes or while it
is failing, the lower-level frontier or explicit budget omission still renders.

## Editing and reanalysis

Editing an analysis summary changes only `analysis.summaryUpdate`. It does not
rewrite an authored summary fragment. Editing source prose makes the old
contribution stale until the passage is reanalyzed.

Manual analysis is available through:

- `POST /stories/:storyId/librarian/analyze`
- the prose block's Analyze action

The analysis-index endpoint continues to power the prose view's analyzed state:

- `GET /stories/:storyId/librarian/analysis-index`

## Performance properties

- No foreground roll-up model call.
- Recursive levels drain in one low-priority Memory activity.
- No foreground summary writes.
- One shared analysis-index read for summary and continuity.
- In-flight and warm analysis reads are cached by branch-specific file path.
- Projection views are bounded and cloned before exposure.
- Missing roll-up cache degrades to finer-grained records or an
  explicit omitted span; generation must never wait for cache production.
