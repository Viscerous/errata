# Librarian Analyze — Context & Edit-Safety Design

**Status: implemented** (branch `fix/analyze-mention-bodies`). Verified against the
kill test: a character's death lands on the durable sheet (body preserved) across
runs, with the model free to vary how (name/description update, surgical edit, or
clean full rewrite).

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

## Content strategy (per type)

- **Knowledge:** full in context (bounded, read-mostly; analyze checks
  contradictions against it). Add a budget only if a story gets lore-heavy.
- **Characters:** summaries in context; full sheet delivered on demand via the
  `reportMentions` return. **Sticky** characters are always full.
- `getFragment` = overflow / backstop, not the primary path.

## Edit safety

- **Ordering — `reportMentions` is step 1 (shipped).** The procedure leads with
  it, so the sheets are in hand before any later step. Testing showed the soft
  ordering matters: when the model batched `reportMentions` and an edit in one
  step, the edit ran before the sheet returned and overwrote the body from the
  summary. Leading with `reportMentions` made that the model's opening move and
  the truncation stopped recurring.
- **Deterministic shrink-guard — deferred (in reserve).** A guard on
  `updateFragment` that refuses a content overwrite far shorter than the current
  body (the truncation-to-summary signature) was prototyped and reverted in
  favour of the step-1 reorder. It makes the catastrophe impossible rather than
  unlikely; build it only if the reorder ever proves insufficient.
- **`editFragment` (shipped):** edits an exact span in any field (name,
  description, content) and leaves the rest intact — the precise tool for a
  status change. `updateFragment` is per-field; only its `content` field is a
  whole-body replace.

## Scope: analyze-only (decided)

The mention-delivers-bodies mechanic is **analyze-only**. We deliberately do
**not** give the writer full character bodies via mention-relevance for now,
because it would be **asymmetric**: characters have a relevance signal (resolved
mentions) but knowledge does not, so characters would silently gain depth while
knowledge stayed shallow, with nothing explaining the difference. Uniform context
beats lopsided context.

- **Writer:** keep summaries + `getFragment` for **both** characters and
  knowledge, off the shortlist — symmetric, even though it leans on the
  discretionary-fetch path. Sticky fragments remain full as today. Revisit only
  once knowledge has a relevance signal to match characters.
- **Analyze:** symmetric by construction — knowledge sits in context in full;
  character bodies arrive via `reportMentions`. This is where the mechanic earns
  its keep (the editor, where blind overwrite happens).
- **Directions:** already inlines the full cast; unchanged.

## Budget — none for now (decided)

We adopt the **Directions precedent: no budget on full bodies.** Directions
already inlines the entire cast in full (only prose is capped), and it works in
practice. So for now, analyze inlines knowledge in full and delivers mentioned
character sheets unbounded — naturally limited by what the prose actually
mentions.

This is knowingly not sensible at large scale (lore-heavy full knowledge, or a
scene that mentions a huge cast, will bloat context). When that bites, the
fallback is already specced: reuse the existing `chars/4` estimate and the
`ContextCompactOption` precedent to cap full bodies and spill the overflow to
summaries + `getFragment`. We build that knob only when a real story needs it.

## Cleanups noted along the way

- `recentMentions` (librarian state) is push-only and never trimmed
  (`agent.ts:359`) → it grows forever and its keys drift toward "every character
  ever." Trim to a recent window, or drop it in favor of the per-fragment
  `meta.annotations`.

## Decisions (settled)

1. **Mention-bodies mechanic is analyze-only.** The writer keeps summaries +
   `getFragment` for both characters and knowledge — symmetric. Giving the writer
   mention-relevant character bodies is deferred until knowledge has a matching
   relevance signal (otherwise characters gain depth and knowledge doesn't).
2. **No budget for now** — adopt the Directions precedent (unbounded full bodies).
   Add a `chars/4` + `ContextCompact` cap later, only when a real story needs it.
