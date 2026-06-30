# Summary Fragments — Implementation Plan

## Goal

Move librarian-maintained summaries from loose fields (`story.summary`, `analysis.summaryUpdate`, `fragment.meta._librarian.summary`) into first-class fragments of a new `summary` type. Gain: editable, taggable, versionable, reorderable, referenceable via `ctx.getFragment`, sidebar-visible when desired. Keep: the librarian's current compaction algorithm, adapted to fragment boundaries.

## Non-goals

- No change to the summary-fragment storage goal. The analysis tool output still writes a `summaryUpdate` string on the analysis; we just additionally materialize it as a fragment.
- No user-facing tagging convention change. Existing `sticky` and `placement` semantics apply.
- No rewrite of the chapter marker system.

## Data model

### New fragment type

Register in `src/server/fragments/registry.ts` and add to the built-in types list in `schema.ts`:
- `type: 'summary'`
- `prefix: 'sm'` in `src/lib/fragment-ids.ts`
- `llmTools: false` (summaries are read by the context builder directly; no per-type LLM query tools)
- Visual: warm parchment-ish color via `src/lib/fragment-visuals.ts` — distinct from character/knowledge/guideline; a bookmark glyph
- New `meta` fields for this type:
  - `meta.chapterId?: string` — the chapter marker this summary belongs to (null for era summaries)
  - `meta.coverageStart?: string` — ID of the first prose fragment covered
  - `meta.coverageEnd?: string` — ID of the last prose fragment covered
  - `meta.isEraSummary?: boolean` — true for compacted overflow from older ranges
  - `meta.analysisIds?: string[]` — librarian analyses that contributed to this summary

### Schema changes

- `src/server/fragments/schema.ts`: add `'summary'` to the built-in types union. Bump schema version.
- `src/lib/api/types.ts` (`StoryMeta`): **remove** `summary: string`. **Remove** `summaryCompact: { maxCharacters, targetCharacters }` from story settings — replaced by per-summary-fragment character threshold (see below).
- Analysis record (`src/server/librarian/storage.ts`): keep `summaryUpdate: string` (intent), add `summaryFragmentId?: string` (artifact reference).
- New story setting: `summaryOverflowThreshold: number` (default 2000). Controls when a chapter summary splits.

### Hidden-in-list convention

Add a `hiddenFromList?: boolean` flag to the fragment type registry entry. `FragmentList` and sidebar queries filter by this. Summary fragments set `hiddenFromList: true`. Plugins can opt in later.

## Migration

**One-shot hard cut**, run on story load:

1. `src/server/fragments/storage.ts` — add `migrateStoryToSummaryFragments(dataDir, storyId)`:
   - If `story.summary` is non-empty AND no fragments of type `summary` exist, create one summary fragment with `content = story.summary`, `name = 'Story summary'`, `meta.isEraSummary = true`, `meta.chapterId = null`.
   - Clear `story.summary` to `''` (or delete the field entirely after schema bump).
   - Log migration outcome.
2. Call this inside `getStory()` or as a one-shot at story open in the route layer — idempotent.
3. Existing analyses keep their `summaryUpdate` strings; no backfill needed for old analyses (they reference stale per-fragment caches, which we also drop — see next).
4. Drop `fragment.meta._librarian.summary` cache (redundant once summaries are fragments). Migration: on first librarian run after upgrade, walk existing prose fragments and clean up the key. Not critical; stale cache harmless.

## Librarian changes

### New flow inside `src/server/librarian/agent.ts`

Replace the deferred-summary application at `applyDeferredSummaries` (~lines 480–607):

1. For each analyzed prose fragment, determine its **chapter** by walking the prose chain backward to the nearest chapter marker. Helper: `findChapterForProse(proseId)` in `src/server/chapters/`.
2. For each chapter, find or create the **active chapter summary fragment**:
   - Query fragments of type `summary` where `meta.chapterId === chapterId` AND NOT archived.
   - If none exists, create one. `name = chapter.name + ' summary'`.
3. Append the analysis's `summaryUpdate` to the chapter summary fragment's `content`, separated by `\n\n`.
4. After append, check `content.length > summaryOverflowThreshold`:
   - If yes: run the existing `compactSummary()` (the one at agent.ts:80) on the **oldest 50%** of the fragment's content. Create a new "era summary" fragment with that compacted output, `meta.isEraSummary = true`, `meta.coverageEnd = <fragmentId at the 50% boundary>`. **Archive** the original chapter summary fragment. Create a fresh chapter summary fragment with the remaining (newer) 50%.
5. Set `analysis.summaryFragmentId = <the chapter summary fragment ID>` and save the analysis.

### Archive behavior

Archiving uses the existing `Fragment.archived: boolean` flag. The context builder already respects it (or should — verify). Archived summary fragments don't appear in context but stay recoverable from the archive panel.

### Remove

- `compactSummary()` call that operates on `story.summary` string (agent.ts:576–583) — replaced by the per-fragment compaction above.
- `_librarian.summary` meta write at agent.ts:437–439 — no longer needed.
- The summary-compaction tool that truncates `story.summary` — removed.

## Context builder changes

`src/server/llm/context-builder.ts`:

1. Drop the "## Story Summary So Far" block assembled from `story.summary`.
2. In `buildSummaryBeforeFragment()` (the call at context-builder.ts:131–154): query summary fragments where `NOT archived`, ordered by `meta.coverageStart` (stable). Include all era summaries + the current active chapter summary. Each renders as a separate `[@block=sm-…]` entry with the fragment's `name` and `content`.
3. **Automatic placement**: by default, summary fragments render as system blocks positioned before the prose block. A summary fragment's `placement` and `sticky` fields, if explicitly set by the user, override the default. This lives in `createDefaultBlocks()` — summary fragments get synthesized into the block list the same way guidelines do, with override points.
4. Respect `sticky`: if the user marks a summary fragment sticky, it stays in context regardless of which prose section is current.

## UI changes

### Fragment list

- `src/components/fragments/FragmentList.tsx`: filter out `type === 'summary'` fragments by default. A toggle or explicit filter exposes them.
- The type registry's new `hiddenFromList` flag drives this, so future hidden types work automatically.

### Librarian panel

- `src/components/sidebar/LibrarianPanel.tsx`: add a "Summaries" section (collapsible, open by default when viewing a story's state).
- Each summary fragment renders as a card: name, char count, chapter chip, "(era summary)" tag where applicable, quick-actions (edit, archive, unarchive, jump-to-covered-prose).
- Clicking a summary opens it in the `FragmentEditor` — all the existing fragment editing surface just works.

### Archive panel

- `src/components/sidebar/ArchivePanel.tsx`: archived summary fragments already show here because the filter is generic. Group them under their chapter in a "Summaries" sub-section so the archive doesn't become noisy.

### Analysis detail

- Wherever the analysis PATCH route edits a summary (the one we added for inline summary editing): redirect the "Save" action to update the referenced summary fragment's content if `summaryFragmentId` is set. The `summaryUpdate` string in the analysis record becomes read-only from the UI (it's now intent, not truth).

## Test plan

New tests in `tests/librarian/summary-fragments.test.ts`:

- Creating a new prose fragment creates/updates the chapter summary fragment.
- Second prose in the same chapter appends to the same summary fragment.
- Crossing the overflow threshold triggers: old chapter summary archived, era summary created with compacted content, new chapter summary created with the newer half.
- User edits to a summary fragment are preserved across subsequent librarian runs (librarian appends to user-edited content).
- Archived summaries don't appear in context but are recoverable.
- Migration: story with non-empty `story.summary` produces one summary fragment and clears the field.
- `ctx.getFragment(summaryId)` works inside a script block.

Update existing `tests/librarian/agent.test.ts`:
- Delete assertions about `story.summary` string mutations.
- Replace with assertions about summary fragment creation.

Update `tests/llm/context-builder.test.ts`:
- Replace the old story-summary block assertion with summary-fragment block assertions.

## Execution order

Four phases. Each phase ends at a green `bun run test`.

**Phase 1 — foundations:**
- Register `summary` fragment type (registry + prefix + schema).
- Add `hiddenFromList` flag to the type registry.
- Write the migration function (standalone, idempotent).
- Drop `story.summary` from `StoryMeta`, remove its writers. Break tests are OK here — we'll fix in phase 2.

**Phase 2 — librarian rewrite (depends on phase 1):**
- Rewrite `applyDeferredSummaries` to produce summary fragments.
- Add `summaryFragmentId` to analysis records.
- Adapt `compactSummary` to operate on a fragment's oldest half.
- Remove `_librarian.summary` writes.

**Phase 3 — context builder + UI filter (depends on phase 2):**
- Update `buildSummaryBeforeFragment` + `createDefaultBlocks`.
- Hide summaries from `FragmentList`.
- Fix broken tests from phase 1's field removal.

**Phase 4 — librarian panel UI + analysis-edit redirect (depends on phase 3):**
- Add "Summaries" section in `LibrarianPanel`.
- Redirect inline summary edits through the fragment, not the analysis.

## Open questions flagged for build

1. **Chapter detection API**: is there a `getChapterForProse(proseId)` helper, or does the librarian currently walk the chain itself? If missing, factor it out in phase 1.
2. **Archive filtering in context**: verify `buildContextState` currently filters archived fragments. If not, add that filter — it's a correctness fix either way.
3. **Overflow threshold as story setting vs. hardcoded**: start hardcoded at 2000, promote to a story setting only if users ask.
4. **Summary `placement` default**: plan says "system" position before prose. Worth prototyping with "user" (inside the user message) to see which reads better at generation time.
