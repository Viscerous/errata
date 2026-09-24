# Context Provenance and Continuity

Errata keeps prose generation to one foreground Writer call. After prose is
accepted, asynchronous Analyze work derives source-linked summaries and
continuity state. Authored fragments and accepted prose remain authoritative;
derived projections are disposable and rebuildable.

The shared analysis envelope and status shapes live in
`src/contracts/librarian.ts`; continuity projection types live in
`src/contracts/continuity.ts`. Server modules import these shared contracts
directly rather than defining client-facing mirrors.

## Authority boundaries

| Surface | Authority | Writer use |
|---|---|---|
| Authored fragments | Reusable canon and author intent | Included according to context policy |
| Accepted prose | What occurred on the active branch | Recent prose is included directly |
| Analysis projection | Derived observations about accepted prose | Included through bounded summary and continuity views |
| Applied record correction | Source-backed update to authored canon | Included as the updated fragment |
| Pending proposal, contradiction, or direction | Review and planning material | Excluded unless the author explicitly invokes it |

Every derived observation retains its source prose ID and source revision.
Edits, variation switches, reordering, deletion, and branch changes therefore
invalidate derived material without mutating the underlying source.

## Generation flow

```text
Authored fragments ─┐
Recent prose ───────┼─> context manifest ─> Writer ─> accepted prose
Memory projection ─┘          │                           │
                              └─> context receipt          v
                                                   asynchronous Analyze
                                                            │
                                      proposals ─────────────┤
                                      summary contribution ──┤
                                      continuity operations ─┘
```

The context manifest is assembled without another model call. The Writer can
read additional fragments during its existing tool loop. A versioned context
receipt records which fragments were presented in full, shown only as catalog
rows, or explicitly read.

## Context receipts

A receipt distinguishes:

- full fragments presented by the manifest;
- catalog-only rows;
- fragments explicitly read by Writer or Prewriter;
- the reason a fragment was promoted, such as author pinning, a recent analyzed
  mention, or the one-generation explicit-read bridge.

Presentation does not renew relevance. Catalog presence never promotes a
fragment, inherited context does not promote itself again, and an explicit read
bridges only the immediately following generation while Analyze catches up.
Only versioned receipts participate in this provenance path.

## Analysis projection

An analysis can contain:

- source prose identity and revision hash;
- narrative position and temporal frame;
- exact fragment mentions;
- a retrospective level-0 summary contribution;
- live-state reports for the characters and entities the passage involves;
- the thread snapshot and what the passage resolved;
- contradictions and record-maintenance proposals.

The passage report is required. Record maintenance is conditional. Automatic
directions are required only when enabled and are entirely absent when disabled;
manual direction requests remain independent. A valid passage report is durable
even if record maintenance or its directions do not complete.

Legacy free-text observation fields can remain visible on stored analyses, but
they do not become a second Writer-facing memory authority.

## Continuity fold

The continuity view is a deterministic fold over source-current projections on
the active branch. It contains each subject's live state, relevant unresolved
continuity, and the active temporal frame.

The fold is a cache, not canon. It never incorporates pending suggestions,
contradictions, or speculative directions. Recent raw prose is not repeated as
prose-like event history; the summary projection owns historical narrative
coverage.

## Open-thread semantics

An open thread is unresolved continuity, not an instruction to resolve it.
Lifecycle and presentation are separate:

| State | Meaning | Writer treatment |
|---|---|---|
| `foreground` | Directly engaged by the present scene or author direction | Include without requiring resolution |
| `background` | Relevant to current people, places, objects, or conflicts | Include compactly when budget permits |
| `dormant` | Still unresolved but not currently relevant | Retain in the projection and omit from the prompt |

Omission does not resolve a thread. Resolution and abandonment require an
explicit source-backed lifecycle operation.

## Chronology

Narrative order follows the active prose chain. Story time is a separate
relation and can be forward, flashback, flash-forward, concurrent, or uncertain.
A flashback updates its own temporal frame and does not silently replace
present-line state. Summary records retain coverage boundaries so older history
is not presented as though it happened immediately before the current scene.

Live state encodes time structurally, never as a value on an entry. Each
narrative line is a frame: entering a flashback or flash-forward pushes an
overlay that starts from lasting entries only, and returning pops it. Lasting
entries added or ended inside a flashback carry back to the present, because the
past it shows precedes the present; a flash-forward's do not. Cuts, time skips,
and line changes are scene boundaries: they end the moment and age last-known
values. Items are never given story-time ranges, and the fold runs in reading
order rather than reordering by chronology.

## Live state

Live state is where each character and entity stands after the passages on the
active branch: what they are doing, where they were last seen, what they know,
and what they hide. It is derived and branch-local; the character fragment
remains who they are.

Field names are vocabulary, not schema. A default set is suggested to the model
(`Currently`, `Where`, `Appearance`, `Condition`, `Wants`, `Knows`, `Secrets`;
entities get `Currently`, `Condition`, `Notes`) and any other field may be used.
The engine acts only on four structural properties of a field:

| Property | Values | Effect |
|---|---|---|
| Owner | character or entity key | Whose state it is |
| Visibility | `outward`, `inner` | Whether others present could notice it; an unknown field is `inner` |
| Holds | `moment`, `lastKnown`, `lasting` | `moment` ends with the scene; `lastKnown` stays and is shown with its age in scenes; `lasting` stays until something ends it |
| Ending | `revealed`, `changed`, `resolved` | How a lasting entry stops holding |

The model reports story events; the author corrects the record. Each passage's
report sets field values, adds entries to lasting lists, and ends numbered
entries with what happened to them (revealed to whom, changed into what, or
resolved). Entries already shown stay recorded without being repeated, and an
entry's identity comes from its field and normalized text, so a restatement is
the same entry. Ended entries leave the current state but remain as history.

Rewording or removing an entry without a story reason is an author correction.
Corrections are kept in a branch-local log and apply after the passage they were
made at, so analysis reruns never erase them and analyses are never edited.

The subjects a passage reports are the scene's roster: everyone else is absent,
which also ends their moment. Readers are shown present subjects and in-scope
characters who are elsewhere, with their last-known state. The roster places
known subjects; it cannot introduce one, and a subject with nothing to show is
left out of prompts.

A subject's identity is its catalog record. A passage may name someone before
their record exists, or report a person as an entity; the fold resolves every
report against the current catalog, by ID or by name, and the record decides
whether it is a character or an entity. A record created later therefore
gathers everything reported about that name from the first passage. A name
without a record is one subject whichever list reported it.

## Character knowledge

Character knowledge is the `inner` part of live state: what a character knows,
believes, and hides. A global presence or witness roster is not continuity
truth. Context shown to Writer grants knowledge to the model, not automatically
to every character in a scene; character chat reads only its own character's
state.

Any future character-specific agent must consume this projection rather than
creating another memory authority.

## Retrieval

The default path combines authored pins, analyzed mentions, context receipts,
catalogs, fragment tags, and explicit fragment reads. It does not add a blocking
retrieval call before Writer.

Candidate providers may later suggest cached, embedding-based, or model-selected
records. A candidate can prompt retrieval; it cannot establish occurrence truth,
character knowledge, or canon.

## Contract principles

- Ask models to identify server-owned material rather than reproduce it. Use
  segment references and the numbers shown beside items where possible.
- Keep stable keys structural. Free-form near-synonyms must not silently fork
  a thread or a live-state item.
- Scope record corrections to the assertion being corrected. Structural shape
  limits complement size limits.
- Interpret tool outcomes from their payload. A returned refusal is not a
  successful mutation merely because transport completed.
- Require declarations only where silence is ambiguous. Optional work should
  not consume extra model steps to report that nothing was proposed.
- Keep every derivation off the generation hot path and degrade to finer-grained
  current records when a cache is absent.

## Known limits

- A valid citation proves where evidence came from, not that the model's claim
  is a sound interpretation of that evidence.
- Mention surfaces remain transcription-sensitive because highlighting needs
  the exact term used in prose.
- First-use retrieval can still expose only a catalog row when a concept depends
  on an unpromoted companion record.
- Which field a statement belongs to, and whether a thread is new, remains
  model-semantic work.
- Continuity and summary budgeting reduce context growth but cannot guarantee
  that every relevant authored record was retrieved.

Summary currency, roll-ups, and target-relative rendering are specified in
[Summarization and story memory](summarization-and-memory.md) and
[Summary projection](summary-projection-design.md). Analyze-specific context and
tool-lane behavior are documented in [Analyze context](analyze-context-design.md).
