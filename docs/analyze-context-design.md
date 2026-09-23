# Context Strategy — Tiering & Analyze Edit-Safety

**Status: active experimental baseline.** Analyze preloads high-signal full
fragments, answers the passage in one report, and records branch-local
observations from it. Prose and records are presented with
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
| **Not in context** | fetched via `readFragments` on demand, by agents that have read tools |

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
  context **before** any edit proposal. Analyze has no read tools: what it
  needs is in its context, and a record the passage report cites is handed to
  record maintenance numbered rather than fetched.
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
- `reportPassage` records mentions as **annotation-only** data (who appears, for prose
  highlighting). A mention quotes the words the prose uses; the server confirms
  them as whole words that name something, or falls back to the record's name.

### Edit safety

- Online maintenance is one report, `reportMaintenance`, with two lists:
  corrections, exact changes to existing assertions, and new records, newly
  established reusable named records. Each list is queued as its own atomic
  proposal, so a bad correction does not take a sound new record with it.
- **The model cites, it does not transcribe.** Prose and the records shown to
  Analyze are rendered with numbered sentences. Evidence is a list of sentence
  numbers, and a correction names the sentence it replaces. The server resolves
  a citation to byte-identical source text, so evidence cannot be paraphrased,
  mis-quoted, or reworded — those failures are not expressible. It is also
  cheaper: an integer instead of a few hundred output characters per operation.
- **Correction scope is structural.** A correction is `{fragmentId, field,
  segment, newText}`; the server derives the exact `oldText` and any
  disambiguating occurrence. The model therefore supplies one address and one
  replacement rather than coordinating an anchor with a copied `oldText`.
- `autoApplyLibrarianSuggestions` remains a supported unattended mode. Auto-apply
  independently re-checks exact source evidence and allowed operation kinds.
- Analyze no longer exposes direct write tools. Every model-authored change goes
  through the change-proposal queue before it can be accepted or auto-applied.
- Routine events, current conditions, relationship movement, and open threads
  stay in the passage report's events, live state, and threads unless their
  progression makes an assertion in a reusable fragment inaccurate. In that case the stale assertion is eligible
  for the smallest possible correction. Events are never appended as
  character-sheet diary paragraphs.

The broader `proposeFragmentChanges` operation vocabulary remains available to
explicit editing surfaces such as Librarian Chat. This restriction applies to
automatic online prose analysis, whose outputs may be applied unattended.

### Validation boundary

The model-facing schemas require only enough structure to interpret a result.
The server does not shorten, rewrite, or infer missing model-authored content.
Proposal calls are self-contained and atomic: evidence and every requested
operation validate together, or nothing from that call is queued. Structural
state checks remain at the boundary—valid IDs, resolvable sentence addresses,
live threads for resolutions, numbered items for endings, and exact edit targets.

## Current state vs the principle

The current policy is semantic first, with no numeric context caps chosen yet:

- **Analyze online** gets the target prose, summary, strong-signal full
  fragments, compact catalogs for the rest, and the folded continuity it
  reports against.
- **Full analyze context** comes from sticky fragments, recent context,
  same-passage context-receipt provenance, and any externally supplied current-observation or
  router-selected candidates. Lexical word matching is not a live candidate
  source.
- **Fragment routing** remains a bounded supporting job for deeper or historical
  work. Routine online analysis does not block on a synchronous router fallback.
- **Online analysis answers the passage in one request.** `reportPassage`
  carries, in order, what happened (summary, events, scene, mentions, and any
  record evidence), where each character and entity now stands, which threads
  are open or resolved, and, when enabled, directions for the next passage.
  Each part builds on the one before it, and the model reasons over the
  passage once. Splitting the parts into a request each re-read the same
  context per part, more than doubled latency on slow models, and did not stop
  a small model from running away; bounding the output did. Record maintenance
  is the only second request.
- **A request is answered in its report's schema.** Where the provider constrains
  a JSON-schema response format while decoding (llama.cpp, LM Studio, and
  Ollama by default; a per-provider setting), the stage requests that format,
  so the schema bounds the whole answer and nothing can follow its closing
  brace. The server does not show the model that schema, so the task block
  carries the report's description and schema. Elsewhere the request calls the
  report as its only tool. Both paths hand the parsed report to the same tool
  code.
- **Every request has an output ceiling**: the largest report its schema
  admits plus the model's reasoning allowance when thinking is enabled. The
  provider is the only party that can stop a runaway request, so the ceiling is
  sent with the request rather than enforced by the client.
- **Record maintenance runs only on evidence**: a contradiction citing both the
  record and the prose, or a new name the prose uses verbatim and the catalog
  lacks. Naming a candidate record is a claim, not evidence. A lasting change
  that contradicts nothing belongs in live state until the author promotes it.
  Maintenance is shown the records it may edit and the cited evidence, not live
  state.
- **Automatic directions** remain a required lane when enabled. When disabled,
  the passage report has no directions field. The dedicated `directions.suggest`
  runner remains available for guided/on-demand suggestions even when automatic
  directions are disabled.
- **Lane completion is observable.** The passage report is required, record
  maintenance is conditional, and automatic directions are required-or-disabled.
  A report without usable directions keeps everything else it found and records
  the directions lane as incomplete. If record maintenance fails after a valid
  passage report, that source-linked report is saved with incomplete lane state
  before the run reports its failure; expensive factual work is not discarded
  with the tail.
- **Visibility is progressive; persistence is atomic.** Each successful report
  publishes the normalized collector as a live `analysis-progress` event.
  The Story panel replaces that provisional snapshot when maintenance refines
  it, while analysis history, annotations, and continuity state are written
  only after the run reaches its existing commit boundary.
- **Continuity is addressed as it is shown.** A thread is named by the key
  shown beside it or by its label; anything else opens a new one. A live-state
  item is ended by the number shown beside it. Neither needs the model to spell
  an identity it has not been shown.
- **Finishing** checks only required successful calls. Proposal lanes are
  optional and carry no hidden retry or abandonment state.
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

- Summary and timeline material do not re-enter Writer context as a parallel
  history channel.
- New analyses also emit a continuity projection: material source hash,
  scene frame, the thread snapshot plus focus, and live-state reports for the
  characters and entities the passage involves.
  The deterministic fold rejects stale source hashes. Structured live threads
  can enter Writer context only when the latest focus snapshot marks them
  foreground or background; omission makes them dormant.
