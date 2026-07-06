# Summarization and Story Memory

This document describes how Errata maintains long-term story memory, how deferred summary application works, and how summary fragments prevent unbounded prompt growth.

## Overview

Errata uses `summary` fragments as long-term memory for prose that has fallen outside the active prose context window. The legacy `story.summary` string is migrated into a summary fragment and then cleared.

The pipeline is:

1. A prose fragment is generated/saved or manually re-analyzed.
2. Librarian analyzes that fragment and produces `summaryUpdate` and optional `structuredSummary` signals.
3. Deferred summary application appends eligible `summaryUpdate` entries into chapter-scoped summary fragments.
4. Oversized chapter summaries split into an era summary fragment plus a fresh active chapter summary.

Key implementation files:

- `src/server/librarian/agent.ts` — analysis runner and deferred summary application
- `src/server/librarian/blocks.ts` — agent block definitions for librarian analyze context

## Data Model

Relevant story settings include:

```ts
disableLibrarianAutoAnalysis: boolean
disableLibrarianDirections: boolean
disableLibrarianSuggestions: boolean
enableHierarchicalSummary: boolean
summaryCompact: { // legacy compatibility only
  maxCharacters: number
  targetCharacters: number
}
```

Defaults:

- `maxCharacters: 12000` (legacy setting; no longer read by the summary-fragment path)
- `targetCharacters: 9000` (legacy setting; no longer read by the summary-fragment path)
- `disableLibrarianAutoAnalysis: false`
- `disableLibrarianDirections: false`
- `disableLibrarianSuggestions: false`
- `enableHierarchicalSummary: false`

Schema source:

- `src/server/fragments/schema.ts`

API settings PATCH support:

- `src/server/api.ts`
- `src/lib/api/settings.ts`

## Deferred Summary Application

Function:

- `applyDeferredSummaries(...)` in `src/server/librarian/agent.ts`

Inputs:

- `state.summarizedUpTo` (watermark)
- active prose chain order
- `summarizationThreshold`
- latest librarian analysis per prose fragment (`summaryUpdate`)

### Latest-analysis dedupe

Reanalysis can create multiple analysis records for the same prose fragment. Deferred application now resolves each `fragmentId` to the latest analysis first, then applies summaries using that deduped set.

Selection rules:

- prefer newest `createdAt`
- break timestamp ties by lexicographically larger analysis `id`

Implementation:

- `selectLatestAnalysesByFragment(...)` in `src/server/librarian/storage.ts`
- used by deferred summary application in `src/server/librarian/agent.ts`

### Threshold semantics

`summarizationThreshold` defines how many most-recent prose positions are *not yet folded* into summary fragments.

Given `proseIds.length = N`, the apply cutoff is:

- `cutoffIndex = max(0, N - summarizationThreshold)`

Only prose in `[startIndex, cutoffIndex)` are candidates, where:

- `startIndex = indexOf(summarizedUpTo) + 1`

### Contiguous watermark behavior

Application is contiguous. The algorithm stops at first gap:

- missing analysis for a prose ID, or
- analysis exists but `summaryUpdate` is empty/whitespace.

This guarantees `summarizedUpTo` does not leap over missing data.

Diagnostic logs emitted on stop:

- `gapFragmentId`
- `gapReason` (`missing_analysis` | `empty_summary_update`)

### State update rules

If one or more contiguous updates are applied:

- append joined updates to the active summary fragment for each chapter
- advance `state.summarizedUpTo` to last applied prose ID
- write `analysis.summaryFragmentId` on each contributing analysis

If none are applicable:

- no summary append
- watermark unchanged

## Analysis Triggers and Controls

Librarian analysis can start in three ways:

1. automatically after prose generation
2. manually from the prose block `Analyze` action
3. indirectly after material prose edits that re-trigger analysis

Automatic post-generation analysis is disabled when either of these flags is set:

- `story.settings.disableLibrarianAutoAnalysis`
- `agent-blocks/librarian.analyze.json` with `disableAutoAnalysis: true`

Analysis behavior can also be narrowed without disabling memory entirely:

- `disableLibrarianDirections` keeps summary/continuity analysis but skips direction cards
- `disableLibrarianSuggestions` keeps summary/continuity analysis but skips fragment create/update/edit suggestions

## Summary Fragment Overflow

Overflow function:

- `appendAndMaybeSplit(...)` in `src/server/librarian/agent.ts`

Strategy:

- If the active chapter summary remains under `SUMMARY_OVERFLOW_THRESHOLD`, append in place.
- If it exceeds the threshold, split near the middle on a paragraph boundary.
- The older half becomes an archived-era summary fragment after deterministic character compaction.
- The newer half becomes the fresh active chapter summary.

Behavioral implications:

- Memory stays bounded for very long stories.
- Context loading reads active summary fragments, with era summaries first and chapter summaries after them.

### Guardrails

Runtime behavior:

- Summary overflow is deterministic and does not add an LLM call to the hot path.
- Legacy `summaryCompact` settings remain in the schema only for compatibility.

## Context Builder Interaction

Summary fragments appear in prompt context as `Story Summary So Far` (unless excluded by options such as `excludeStorySummary` in specialized flows).

When building `summaryBeforeFragmentId`, context rebuild also uses the same latest-analysis dedupe to avoid stale reanalysis summaries.

Relevant file:

- `src/server/llm/context-builder.ts`

When `enableHierarchicalSummary` is on, chapter marker summaries are also included as an intermediate memory layer between long-term summary fragments and the recent prose window.

## Analysis Index

The prose view uses a lightweight fragment-to-analysis index to track which prose fragments have current librarian analysis.

- Route: `GET /stories/:storyId/librarian/analysis-index`
- Manual trigger: `POST /stories/:storyId/librarian/analyze`

This powers the analyzed-dot indicator on prose blocks and the manual `Analyze` action in the prose block menu.

## Tests

Primary tests:

- `tests/librarian/agent.test.ts`

Important coverage:

- contiguous application does not skip gaps
- summary fragments split when chapter summaries exceed the overflow threshold
- overflow handling stays deterministic and does not call an LLM
- deferred apply uses latest analysis per fragment
- librarian can derive `summaryUpdate` from structured signals when summary text is empty

Related context tests:

- `tests/llm/context-builder.test.ts`

## Operational Notes

- For short stories, defaults are usually sufficient.
- For long-running projects, monitor summary-fragment growth and lower the code-level overflow threshold only if active summary fragments become too large in practice.
- If summaries stall, check for gap logs from deferred application.

## Agent Block System Integration

The librarian analyze agent uses the **agent block system** for context assembly. The system prompt and user context (summary, characters, knowledge, new prose) are defined as blocks in `src/server/librarian/blocks.ts` and compiled via `compileAgentContext()`. This means:

- The librarian's system prompt can be customized per-story through agent block overrides (Settings > Agent Context).
- Fragments tagged `pass-to-librarian-system-prompt` are loaded into the block context and appended to the system message.
- Custom blocks can be added to inject additional instructions or context.

The same block system is used by `librarian.chat`, `librarian.refine`, and `librarian.prose-transform` agents.

## Direction Suggestions

When guided mode asks for them, Errata can produce **direction suggestions** — possible next steps for the story. The `directions.suggest` agent uses a directions-specific, tiered context profile to generate titled suggestion cards, each with a description and a ready-to-use writing instruction.

- Agent module: `src/server/directions/suggest.ts`
- Block definitions: `src/server/directions/blocks.ts`
- Runtime path: guided mode or the explicit directions endpoint invokes `directions.suggest`. Routine librarian analysis can also record direction cards in the fused analyze pass when directions are enabled.
- Directions requested for the current head passage are surfaced in the generation input's **guided mode**.

Mentions and fragment change suggestions are deduplicated across multi-turn tool calls to prevent duplicate entries when the librarian's analysis spans several steps.

## Fragment Suggestions & Updates

The librarian's analysis tools use `proposeFragmentChanges` to queue creates, localized edits, whole-field rewrites, and archive requests as reviewable `fragmentChangeProposals`. Each proposal stores the exact operation batch plus validation previews, so review and auto-apply use the same semantics as the tool call. Whole-field `set_fields` requires a `baseHash` from `readFragments`, descriptions are capped at 250 characters, and accepted or auto-applied proposals re-read the target and check locked, frozen, stale-hash, and exact-text protections before writing. When an anchor or base hash fails, validation reports the specific operation and recommends `readFragments` for the affected IDs.

## Known Limitations

- LLM compaction quality depends on the configured librarian model and prompt adherence.
- Structured summary signals are optional and quality depends on model/tool-call discipline.
- Chapter summaries must be created on marker fragments before hierarchical summary mode adds value.
