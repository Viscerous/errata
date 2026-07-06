# Context Strategy — Tiering & Analyze Edit-Safety

**Status: implemented.** Analyze preloads high-signal full fragments and
proposes changes against them; accepted or auto-applied suggestions land on the
durable sheet with the body preserved across first-analysis and re-analysis. This
**supersedes** the original mid-loop body-delivery plan — see
*History* at the end.

## The problem this solves

A whole-field rewrite replaces the whole `content` field. If analyze has only a
fragment's one-line **catalog row** in context, the model can write a short body
from what it has, truncating the durable sheet. Kill test: killing a character
must not replace its full body with a one-liner.

## The relevance signal: `writerContextIds`

The piece everything else hangs on. At generation time the writer records
**`writerContextIds`** on the new prose fragment's `meta` — the fragments it
actually worked from: sticky fragments, recent-context fragments, and anything
it looked up via `readFragments`. It is deliberately **type-agnostic**
(characters *and* knowledge) and persists with the fragment, so re-analysis sees
the same set.

This is what lets context tier on *relevance* instead of inlining everything.

## Content tiering (the principle)

One rule, applied per fragment type:

| Tier | Rule |
|---|---|
| **Sticky** | full (author-pinned, always relevant) |
| **Promoted by relevance signals** | full |
| **Otherwise** | one-line catalog row with backticked ID, name, and description separated by pipes |
| **Not in context** | fetched via `readFragments` on demand |

Fragments have multiple relevance sources: prose mention annotations,
`writerContextIds`, sticky pins, explicit lookup, and LLM-reported candidates.
Characters may still be promoted more often in practice because prose mentions
them frequently, but knowledge and custom fragments now flow through the same
semantic lanes. The depth difference is earned by signal density, not by a
character-only special case.

## How analyze applies it (shipped)

- Fragment context splits by semantic source and depth, each fragment in exactly
  one surface: `fragment-pinned`, `fragment-writer-context`,
  `fragment-recent`, or `fragment-candidates` for promoted full context, and
  everyone else as one-line rows in `fragment-catalog`. The full sheets are in
  context **before** any edit proposal — no mid-loop delivery, no ordering
  constraint, no gate.
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

- `proposeFragmentChanges` records the exact operation batch (`replace_text`,
  `append_paragraph`, `set_fields`, `create_fragment`,
  `archive_fragment`) as one reviewable `fragmentChangeProposal`, together with its
  validation preview. Accept and auto-apply replay that same batch, so what the
  author accepts is exactly what the model proposed.
- `proposeFragmentChanges` with `set_fields` can replace whole fields on an
  existing fragment, but it requires a `baseHash` from `readFragments` and complete
  field text.
- Analyze no longer exposes direct write tools. Every model-authored change goes
  through the change-proposal queue before it can be accepted or auto-applied.
- The blind-overwrite catastrophe is prevented **structurally**: the full sheet is
  in context before any whole-field proposal, so the model proposes against the real
  body, never the summary.

## Current state vs the principle

The current policy is semantic first, with no numeric context caps chosen yet:

- **Analyze online** gets the target prose, summary, strong-signal full
  fragments, compact catalogs for the rest, and read tools when suggestions are
  enabled.
- **Full analyze context** comes from sticky fragments, recent context,
  `writerContextIds`, and any externally supplied current-observation or
  router-selected candidates. Lexical word matching is not a live candidate
  source.
- **Fragment routing** remains a bounded supporting job for deeper or historical
  work. Routine online analysis does not block on a synchronous router fallback.
- **Directions** can be produced in the fused analyze loop when enabled, and the
  dedicated `directions.suggest` runner remains available for guided/on-demand
  suggestions.
- **Writer** tiers characters, knowledge, and custom context from sticky and
  recent-context signals, including recent annotations and `writerContextIds`.

The shared resolver still supports future runner budgets, but no hard full-body
limits are enabled for these profiles until empirical testing shows where they
help reliability more than they hurt recall.

## History (superseded plan)

The original design delivered character bodies by having the mention-reporting
step return the mentioned sheets mid-loop, with a gate forcing that step to run
before any edit proposal. That shipped briefly, then was replaced once
`writerContextIds` gave both characters and knowledge a shared relevance signal:
bodies are now **preloaded** from the forwarded set rather than returned by a
tool, and the ordering gate is gone.

## Cleanups noted

- `recentMentions` (librarian state) is push-only and never trimmed → it grows
  forever and its keys drift toward "every character ever." Trim to a recent
  window, or drop it in favor of the per-fragment `meta.annotations`.
