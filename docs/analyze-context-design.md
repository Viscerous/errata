# Librarian Analyze — Context & Edit-Safety Design

**Status: proposed, not yet implemented.** Captures the agreed architecture so we
can pin it before touching the renderer / `runLibrarian`.

## Problem

- Analyze sees character **summaries only** (`id: name — description`), not bodies.
- `updateFragment` overwrites the whole `content` field. With only a description
  in context, the model writes a short body from what it has → the sheet is
  **truncated** (blind overwrite). Kill-test: killing a character replaces its
  body with a one-liner.
- The read tools (`getFragment`, `getCharacter`) we added were rarely called.

## Root cause: the prompt enumeration drives tool use *and* order

- The numbered tool list in `buildAnalyzeSystemPrompt` (`1. updateSummary … 5.
  updateFragment …`) is what makes the model call tools in that order —
  `reportMentions` (#2) reliably precedes `updateFragment` (#5). It is the prose
  numbering doing this, not the SDK schema order.
- Tools **not** in the numbered list (e.g. `getFragment`, which sat in an
  un-numbered "lookup tools" paragraph) get ignored. That is the whole reason
  fetching was inconsistent.
- The reconcile branch removes this enumeration (policy-only prompt, already in
  `main`). So the ordering is incidental today and disappears once reconcile
  lands. We must make the ordering **intentional** (a policy line) and stop
  depending on a tool catalog.

## Mechanic: deliver bodies through `reportMentions`

- Change `reportMentions.execute` to **return the full sheets** of the characters
  it just resolved (today it returns `{ ok: true }`).
- The tool result is fed back into the loop, so the bodies arrive **just before**
  the edit step — single pass, no extra round-trip, and self-budgeting (only
  mentioned characters, only when mentions are reported).

This replaces the earlier (discarded) idea of a separate gated phase-1 mention
call — unnecessary, since `reportMentions` already runs before edits.

## Content strategy (per type)

- **Knowledge:** full in context (bounded, read-mostly; analyze checks
  contradictions against it). Add a budget only if a story gets lore-heavy.
- **Characters:** summaries in context; full sheet delivered on demand via the
  `reportMentions` return. **Sticky** characters are always full.
- `getFragment` = overflow / backstop, not the primary path.

## Edit safety

- **Ordering policy (keep one line):** *"Report a character's mention before
  editing it — you'll receive its full sheet to edit against."* This is behavioral
  policy, not a tool listing, so it coexists with reconcile's policy-only prompt.
  It keeps the cheap common path happening.
- **`updateFragment` read-gate (backstop):** if asked to overwrite a character's
  `content` whose sheet was neither returned by `reportMentions` nor read via
  `getFragment` this run, return an error telling it to read first. The common
  path never hits it; it only catches out-of-order or unmentioned edits, so
  correctness no longer *depends* on the ordering.
- **Prefer `editFragment`:** usable now that the full sheet is present (it needs
  an exact `oldText`). Non-destructive — replaces only the named span and keeps
  the rest of the sheet, the right primitive for "record a death." Reserve
  `updateFragment` for wholesale rewrites.

## Cross-agent reuse

- **Writer:** it already loads the recent prose window (last *N*, default
  `proseLimit: 10`), and each of those fragments carries `meta.annotations`
  (resolved mentions) from prior analysis. Reuse those as the relevance set — no
  phase-1, no extra fetch. Render the mentioned + sticky characters **full**; the
  rest stay summaries (with `getFragment` available). The mention-bodies mechanic
  is therefore **analyze-only**; the writer gets fullness straight from the
  window annotations.
- **Directions:** already inlines the full cast; under the unified model it is
  simply "budget high, window = whole story."
- **Unifying concept:** *relevance = resolved mentions*, sourced from a live
  `reportMentions` (analyze) or stored window annotations (writer).

## Budget — none for now (decided)

We adopt the **Directions precedent: no budget on full bodies.** Directions
already inlines the entire cast in full (only prose is capped), and it works in
practice. So for now, analyze and the writer also inline the relevant full
sheets unbounded — analyze is naturally limited by what gets mentioned, and the
writer by the mention set in its prose window.

This is knowingly not sensible at large scale (a huge cast all mentioned in a
window, or lore-heavy full knowledge, will bloat context). When that bites, the
fallback is already specced: reuse the existing `chars/4` estimate and the
`ContextCompactOption` precedent to cap full bodies and spill the overflow to
summaries + `getFragment`. We build that knob only when a real story needs it.

## Cleanups noted along the way

- `recentMentions` (librarian state) is push-only and never trimmed
  (`agent.ts:359`) → it grows forever and its keys drift toward "every character
  ever." Trim to a recent window, or drop it in favor of the per-fragment
  `meta.annotations`.

## Decisions (settled)

1. **Mention-bodies mechanic is analyze-only.** The writer gets fullness from the
   resolved mentions already stored on its recent prose window, so it doesn't
   need `reportMentions`-returns-bodies.
2. **No budget for now** — adopt the Directions precedent (unbounded full bodies).
   Add a `chars/4` + `ContextCompact` cap later, only when a real story needs it.
