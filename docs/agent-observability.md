# Agent Observability

How to answer "what is running right now, what just ran, and what did it do" for any agent. Five pieces of state work together; this doc maps each to the question it answers so a future change doesn't have to re-derive the architecture from scratch (as this doc's own investigation had to).

## The five pieces

| System | File | Question it answers | Lifetime |
|---|---|---|---|
| Active registry | `agents/active-registry.ts` | "Is agent X running right now, for story Y?" | In-memory; entry lives exactly as long as the run (10-min TTL safety net) |
| Activity stream | `agents/activity-stream.ts` | "What is this running agent doing, live?" | In-memory; one buffer per `(storyId, agentName)`, born/retired with the active-registry entry |
| Traces | `agents/traces.ts` | "What ran recently, and how did it finish?" | In-memory; capped at 100 runs per story, lost on server restart |
| Librarian analyses | `librarian/storage.ts` | "What has the librarian analyzed/changed, ever?" | Disk, per story/branch — permanent until deleted |
| Generation logs | `llm/generation-logs.ts` | "What has the writer generated, ever?" | Disk, per story — permanent until deleted |

The first three are ephemeral run telemetry, shared across every agent. The last two are domain-specific permanent records, each owned by the one subsystem that writes it (analyze; the writer). They are not part of the same trace history — a generation's step-by-step tool calls live in its `GenerationLog`, not in `traces.ts`.

## Who wires the ephemeral trio — two paths, both automatic

Every agent execution goes through exactly one of two dispatchers, and **both already provide full active-registry + activity-stream + traces coverage**. Nothing else needs to touch this machinery:

- **`agents/agent-instance.ts`'s `createAgentInstance(name, ctx).execute(input)`** — used by every HTTP route for a registered `AgentDefinition` (`routes/librarian.ts`, `routes/character-chat.ts`). Calls `beginAgentRun` before running, **tees the agent's `eventStream`** and replays each NDJSON line onto the run's activity trace, and calls `finish()` on completion or error.
- **`agents/runner.ts`'s `invokeAgent(...)`** — used for nested agent-to-agent calls (`ctx.invokeAgent()`) and the librarian scheduler's auto-trigger (`triggerLibrarian` → `invokeAgent({ agentName: 'librarian.analyze', ... })`). Registers active, records into `traces.ts`, and additionally enforces `maxDepth`/`maxCalls`/cycle detection across the whole call tree.

This means **`createStreamingRunner`-based agents (`librarian.refine`, `librarian.optimize-character`, `librarian.prose-transform`, `character-chat.chat`) register no active-marker or trace history of their own** — and that's correct, not a gap. Their only production caller is `createAgentInstance`, which already wraps the whole call. (`agents/create-streaming-runner.ts` has a comment to this effect at the point where it would be tempting to add it — don't; it would double-register every run.) Same for `librarian.chat`, whose only caller is `createAgentInstance('librarian.chat', ...)`.

## The one path outside this net — and why

**`generation.writer` and `generation.prewriter`** call `agents/agent-run.ts`'s `beginAgentRun()` directly, inside `generation/run-generation.ts`. They are not registered `AgentDefinition`s at all — no entry in `agentRegistry`, no `AgentInputMap` entry — because the generation pipeline's two-phase (prewriter → writer) flow, clarify-round short-circuit, and post-stream save/librarian-trigger logic don't fit the generic `AgentDefinition.run()` shape. `beginAgentRun` is the same primitive `createAgentInstance` uses internally, wired by hand for exactly this one bespoke pipeline.

## Run-id format

Both dispatchers (and `agent-run.ts`) share one generator: `agents/traces.ts`'s `makeAgentRunId()` (`ar-<time36>-<counter36>`). This used to be two separate implementations with different uniqueness strategies (a `Math.random()` version in `runner.ts`, a counter version in `agent-run.ts`) — now one.

## Practical guide

- **Debugging "is X actually running"**: check `listActiveAgents(storyId)` (active-registry) or the Activity panel, which reads the same source.
- **Debugging "what did that last run do"**: check `listAgentRuns(storyId)` (traces) for the summary + status; if it was a `createAgentInstance`-dispatched run, its `trace[]` array holds the full mirrored event stream, not just the summary.
- **Debugging "what did the writer generate three days ago"**: that's not in traces (100-run cap, in-memory) — check `llm/generation-logs.ts`'s persisted `GenerationLog`s.
- **Debugging "what did the librarian change in this fragment's history"**: check `librarian/storage.ts`'s analyses, not traces — `versions[]` on the fragment itself also shows the `reason` stamp (`'auto-apply'`, `'manual-accept'`, `'librarian-analysis'` legacy, etc.).
- **Adding a new agent**: if it's a registered `AgentDefinition` (the normal case — see `docs/adding-agents.md`), you get all of this for free through whichever dispatcher calls it. Don't add your own `beginAgentRun` call inside the runtime logic itself.
