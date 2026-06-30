# Context Strategy — Tiering & Analyze Edit-Safety

**Status: implemented.** Analyze preloads the writer's character working set in
full and proposes changes against it; accepted or auto-applied suggestions land on
the durable sheet with the body preserved across first-analysis and re-analysis. This
**supersedes** the original mid-loop body-delivery plan — see
*History* at the end.

## The problem this solves

A whole-field rewrite replaces the whole `content` field. If analyze has only a
character's one-line **summary** in context, the model writes a short body from
what it has → the sheet is **truncated** (blind overwrite). Kill test: killing a
character replaces its full body with a one-liner.

## The relevance signal: `writerContextIds`

The piece everything else hangs on. At generation time the writer records
**`writerContextIds`** on the new prose fragment's `meta` — the fragments it
actually worked from: sticky characters + the recent cast + sticky knowledge +
anything it looked up via `readFragments`. It is deliberately **type-agnostic**
(characters *and* knowledge) and persists with the fragment, so re-analysis sees
the same set.

This is what lets context tier on *relevance* instead of inlining everything.

## Content tiering (the principle)

One rule, applied per fragment type:

| Tier | Rule |
|---|---|
| **Sticky** | full (author-pinned, always relevant) |
| **In the relevance set** (`writerContextIds`) | full |
| **Otherwise** | one-line summary with backticked ID, name, and description separated by pipes |
| **Not in context** | fetched via `readFragments` on demand |

Characters have a *richer* relevance source than knowledge — prose mention
annotations feed the recent cast, whereas knowledge only enters the set via sticky
or explicit lookup — so in practice more characters are full than knowledge. But
both flow through the **same** signal, so the depth difference is earned by signal
density, not an unexplained lopsidedness. This is what retired the earlier
*asymmetry* blocker (below): knowledge now has a relevance signal; it didn't when
the original plan was written.

## How analyze applies it (shipped)

- Characters split into three blocks, each character in exactly one: **pinned**
  (`character-sticky`, full — always, even when the pin is also in the scene), the
  rest of the **recent cast** from `writerContextIds` (`character-recent`, full),
  and everyone else (`character-shortlist`, one-line summaries). The full sheets
  are in context **before** any edit proposal — no mid-loop delivery, no ordering constraint,
  no gate.
- Pins are loaded from `sticky` directly, **independent of the forward**, so
  re-analysis of older prose, the context preview, and prose not written by the
  writer still get author-pinned sheets in full (matching the writer's
  `full = pinned ∪ recent cast` relevance model).
- Full sheets here render with the shared `` `id` | name | desc `` identity line as a
  `###` heading, then `content` — the same grammar as a shortlist row, so a full
  sheet (heading + body) and a summary (bare row) read distinctly but cohesively.
  Analyze keeps the `description` that read-only agents drop in full renders (see
  [Context Blocks](context-blocks.md#content-tiering)), because proposals can
  target all three fields and must see the current value of each.
- `reportAnalysis` records mentions as **annotation-only** data (who appears, for prose
  highlighting); it no longer returns bodies.
- `readFragments` is the **backstop** for an appearing character not in the
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

## Current state vs the principle (open questions, not decisions)

Two agents predate the relevance signal and still inline full bodies. Whether to
tier them is **undecided** — recorded here so the choice is explicit:

- **Analyze inlines *all* knowledge in full** every run. Good for contradiction
  detection (it checks the prose against established facts), but it scales poorly
  for lore-heavy stories. `writerContextIds` already carries knowledge, so analyze
  *could* tier it (forwarded-full + summary + `readFragments`) — trading some
  contradiction recall for tokens. Not done.
- **Directions inlines the entire cast in full** (sticky *and* shortlist bodies).
  Could tier to sticky/relevant-full + summary. Not done.
- **Writer** already tiers characters (recent cast full + shortlist summary).
  Knowledge stays sticky-full + shortlist, since knowledge has no
  recent-appearance signal of its own.

## Budget — deferred

No cap on full bodies yet. When lore-heavy knowledge or a huge-cast scene bites,
the specced fallback is to reuse the `chars/4` estimate + the `ContextCompactOption`
precedent to cap full bodies and spill the overflow to summaries + `readFragments`.
Build the knob only when a real story needs it.

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
