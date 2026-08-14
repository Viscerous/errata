# Context Strategy — Tiering & Analyze Edit-Safety

**Status: active experimental baseline.** Analyze preloads high-signal full
fragments, records branch-local observations, and returns newly resolved
records from the reporting call itself. Prose and records are presented with
numbered sentences so the model addresses text rather than reproducing it. Its online maintenance surface is
deliberately narrow and semantically split: accepted prose may support exact
corrections to existing reusable records or genuinely new reusable records.
The online contract is intentionally narrow and does not expose direct writes.

The accepted end-state for context receipts, continuity projections, chronology,
open-thread lifecycle, and character knowledge is documented in
[Context Provenance and Continuity](context-provenance-and-continuity.md). This
document covers the current Analyze-specific tiering and edit-safety slice.

## The problem this solves

A whole-field rewrite replaces the whole `content` field. If analyze has only a
fragment's one-line **catalog row** in context, the model can write a short body
from what it has, truncating the durable sheet. Kill test: killing a character
must not replace its full body with a one-liner.

## The relevance signal: context receipts

At generation time the Writer records a versioned **context receipt** on the new
prose fragment. It distinguishes full presentation, catalog-only presentation,
explicit Writer or pre-writer reads, and explicit fragment tags. It is
deliberately **type-agnostic** and persists with the passage, so re-analysis can
audit against the same full records used to draft it.

Only an explicit read or tag bridges into the immediately following generation
while asynchronous mention analysis catches up. Inherited full presentation and
catalog presence never renew relevance. Undifferentiated `writerContextIds` data
does not participate in the new path.

## Content tiering (the principle)

One rule, applied per fragment type:

| Tier | Rule |
|---|---|
| **Sticky** | full (author-pinned, always relevant) |
| **Promoted by relevance signals** | full |
| **Otherwise** | one-line catalog row with backticked ID, name, and description separated by pipes |
| **Not in context** | fetched via `readFragments` on demand |

Fragments have multiple relevance sources: prose mention annotations, context
receipt reads/tags, sticky pins, explicit lookup, and LLM-reported candidates.
Characters may still be promoted more often in practice because prose mentions
them frequently, but knowledge and custom fragments now flow through the same
semantic lanes. The depth difference is earned by signal density, not by a
character-only special case.

## How analyze applies it (shipped)

- Fragment context splits by semantic source and depth, each fragment in exactly
  one surface: `fragment-pinned`, `fragment-writer-context`,
  `fragment-recent`, or `fragment-candidates` for promoted full context, and
  everyone else as one-line rows in `fragment-catalog`. The full sheets are in
  context **before** any edit proposal. Fragments newly identified by
  `reportAnalysis` remain a small mid-loop delta, returned by that call rather
  than fetched.
- Pins are loaded from `sticky` directly, **independent of the forward**, so
  re-analysis of older prose, the context preview, and prose not written by the
  writer still get author-pinned sheets in full (matching the writer's
  pinned plus recent-context relevance model).
- Full sheets here render with the shared `` `id` | name | desc `` identity line as a
  `####` heading under their `### <Type>` section, then `content` — the same grammar
  as a catalog row, so a full sheet (heading + body) and a catalog row read
  distinctly but cohesively.
  Analyze keeps the `description` that read-only agents drop in full renders (see
  [Context Blocks](context-blocks.md#content-tiering)), because proposals can
  target all three fields and must see the current value of each.
- `reportAnalysis` records mentions as **annotation-only** data (who appears, for prose
  highlighting); it no longer returns bodies.
- `readFragments` is the **backstop** for an appearing fragment not in the
  forwarded set.

### Edit safety

- Online maintenance exposes two small semantic tools:
  `proposeRecordCorrections` for exact changes to existing assertions and
  `proposeNewRecords` for newly established reusable named records. Each call
  queues its own atomic proposal; correction and discovery no longer share a
  schema or failure surface.
- **The model cites, it does not transcribe.** Prose and the records shown to
  Analyze are rendered with numbered sentences. Evidence is a list of sentence
  numbers, and a correction names the sentence it replaces. The server resolves
  a citation to byte-identical source text, so evidence cannot be paraphrased,
  mis-quoted, or reworded — those failures are not expressible. It is also
  cheaper: an integer instead of a few hundred output characters per operation.
- A resolved citation is retained across a failed retry, so the model can
  resubmit only corrected operation fields. Rationale and title are optional.
- **Correction scope is structural.** A correction is `{fragmentId, field,
  segment, newText}`; the server derives the exact `oldText` and any
  disambiguating occurrence. A copied paragraph or an episode recap is not
  expressible, and `oldText was not found` cannot occur. Growth relative to the
  replaced sentence remains as a backstop against a single sentence being
  inflated into a scene summary. Replacing the *only* sentence in a record is
  refused: that is a whole-field rewrite, which stays barred for unattended
  application, and it goes to author review instead.
- `autoApplyLibrarianSuggestions` remains a supported unattended mode. Auto-apply
  independently re-checks exact source evidence, allowed operation kinds, and
  localized operation limits, reading the same limit constants as the tool
  contract so the two cannot drift.
- Analyze no longer exposes direct write tools. Every model-authored change goes
  through the change-proposal queue before it can be accepted or auto-applied.
- Routine events, current conditions, relationship movement, and open threads
  stay in `reportAnalysis` unless their progression makes an assertion in a
  reusable fragment inaccurate. In that case the stale assertion is eligible
  for the smallest possible correction. Events are never appended as
  character-sheet diary paragraphs.

The broader `proposeFragmentChanges` operation vocabulary remains available to
explicit editing surfaces such as Librarian Chat. This restriction applies to
automatic online prose analysis, whose outputs may be applied unattended.

### Reject on correctness, clip on preference

A schema rejection throws away the whole call. On a small model that is the most
expensive failure the loop has: the batched report has to be reasoned out and
emitted again from scratch, and any lane already completed is usually re-run
alongside it. So the input contract only refuses what it cannot interpret, and
anything merely more verbose than wanted is accepted and bounded on the way in.

- Citation counts are clipped at `MAX_CITED_SEGMENTS` when the citation is
  resolved, not capped in the schema. Over-citing costs a longer stored evidence
  string and nothing else.
- Mention and candidate lists take a verbose-but-sane ceiling and are clipped in
  `execute`; only a degenerate repeat is rejected.
- Summary and timeline prose are shortened at sentence or word boundaries, with
  an ellipsis when a partial tail is omitted, so stored diagnostics do not end
  in a misleading word fragment.
- Proposal titles and rationales are preference-sized metadata. Overlong values
  are accepted and shortened in `execute` rather than invalidating otherwise
  grounded operations.
- `finishAnalysis` accepts an abandoned lane as a bare tool name, because that is
  complete information for a lane never called — and the gate does not require
  those to be declared at all. It still demands a reason for abandoning a lane
  left in a failed state, which is the one case where the reason is load-bearing.

The inverse also holds: a bound worth enforcing belongs in the schema, where the
model cannot express the violation, rather than in a check that discards work
after the fact. Continuity operations missing a citation are the open case —
they are currently dropped with a note, which loses durable memory silently.

## Current state vs the principle

The current policy is semantic first, with no numeric context caps chosen yet:

- **Analyze online** gets the target prose, summary, strong-signal full
  fragments, compact catalogs for the rest, and read tools when suggestions are
  enabled.
- **Full analyze context** comes from sticky fragments, recent context,
  same-passage context-receipt provenance, and any externally supplied current-observation or
  router-selected candidates. Lexical word matching is not a live candidate
  source.
- **Fragment routing** remains a bounded supporting job for deeper or historical
  work. Routine online analysis does not block on a synchronous router fallback.
- **Online analysis uses one adaptive tool loop.** `reportAnalysis` is required
  before `finishAnalysis`, but reporting does not force a fresh Analyze
  invocation. Its normalized result returns newly resolved numbered records in
  the same tool history; another model step happens only when the tool workflow
  needs one. A repeated `readFragments` request for an available record returns
  its ID under `alreadyAvailable` instead of echoing the body again. Pass
  diagnostics retain usage for each model step as well as the aggregate, making
  both total work and the largest individual request visible.
- **Automatic directions** remain a required lane in the adaptive loop when
  enabled. When disabled, their tool and instructions are absent.
  `reportAnalysis` loads every referenced fragment to validate its ID and makes
  records not already in the initial prompt available to subsequent model
  steps. `finishAnalysis` still rejects falsely completed calls, and directions
  cannot be abandoned as an optional skip. The dedicated `directions.suggest`
  runner remains available for guided/on-demand suggestions even when automatic
  directions are disabled.
- **Lane completion is explicit.** Observation is required, record maintenance
  is conditional, and automatic directions are required-or-disabled. If a
  later model or tool step fails after a valid observation, that source-linked
  observation is saved with incomplete lane state before the run reports its
  failure; expensive factual work is not discarded with the tail.
- **Continuity keys are steered, not enumerated.** State, thread, and knowledge
  operations each take a single `key`. The live registry is named inside that
  field's description, and reuse is settled server-side by canonicalizing both
  sides, so a variant or drifted spelling lands on the identity it meant instead
  of being refused. A key carrying no alphanumeric content is not an identity and
  is skipped with a reason rather than admitted.
- **Finishing** distinguishes an optional lane never used from one abandoned in
  a failed state. Never calling `proposeRecordCorrections` or `proposeNewRecords`
  needs no declaration; leaving a failed call unretried and undeclared is
  refused.
- **Writer** tiers characters, knowledge, and custom context from sticky and
  recent-context signals, including recent annotations and a one-turn receipt
  bridge for explicit reads/tags.

New generations no longer write the undifferentiated `writerContextIds` field.
That field recorded both newly consulted fragments and inherited full context;
because inherited IDs were written again, they could renew themselves
indefinitely. The versioned receipt now records those surfaces separately.
In prewriter mode the fragment surfaces are presented to the planner rather than
the writer, so the receipt records the planner's presentation too; otherwise a
prewriter passage would carry no full-context provenance at all and re-analysis
could not audit against the records it was drafted from.

The shared resolver still supports future runner budgets, but no hard full-body
limits are enabled for these profiles until empirical testing shows where they
help reliability more than they hurt recall.

## Related memory surfaces

- `structuredSummary.events`, `stateChanges`, timeline events, and legacy
  `openThreads` remain Analysis and summary material; they do not re-enter Writer
  context as a parallel history channel.
- New analyses also emit an evidence-backed continuity projection: material
  source hash, temporal frame, keyed state operations, explicit thread lifecycle
  plus focus, and per-character knowledge operations. Global participant/witness
  rosters are not treated as general or reliable continuity truth.
  The deterministic fold rejects stale source hashes. Structured live threads
  can enter Writer context only when the latest focus snapshot marks them
  foreground or background; omission makes them dormant.
