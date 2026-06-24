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

- **Writer:** the recent prose window is already analyzed, so reuse
  `meta.annotations[].fragmentId` (resolved mentions) as the relevance set — no
  phase-1 needed. Inline full bodies for mentioned + sticky characters up to a
  token budget; summaries + `getFragment` for the overflow.
- **Directions:** already inlines the full cast; under the unified model it is
  simply "budget high, window = whole story."
- **Unifying concept:** *relevance = resolved mentions*, sourced from a live
  `reportMentions` (analyze) or stored window annotations (writer).

## Budget

- Reuse the existing `chars/4` token estimate and the `ContextCompactOption`
  precedent (`context-builder.ts`) rather than inventing a new primitive.
- Per-agent defaults (starting points): analyze is naturally bounded by
  mention-injection; writer ≈ 2–3k tokens of full bodies on top of sticky;
  Directions ≈ 8k (effectively "all, capped for runaway casts").

## Cleanups noted along the way

- `recentMentions` (librarian state) is push-only and never trimmed
  (`agent.ts:359`) → it grows forever and its keys drift toward "every character
  ever." Trim to a recent window, or drop it in favor of the per-fragment
  `meta.annotations`.

## Decisions still open

1. Should `reportMentions`-returns-bodies apply to the writer path too, or
   analyze-only? (Writer already has window annotations; it may not need it.)
2. Budget knob: per-agent constants baked in, or a story-level setting?
