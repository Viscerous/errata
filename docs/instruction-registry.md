# Instruction Registry

## Overview

The instruction registry provides centralized management of all LLM prompt instructions. Instead of hardcoding system prompts in agent modules, each instruction is registered under a dot-separated key and resolved at runtime.

The registry stores built-in defaults together with the receiving agent and the
text's role as a system instruction, narrower contract, or interpolated
template. Story-specific prompt customization lives in per-agent block
configuration through the Agent Context panel.

## API

The singleton `instructionRegistry` is exported from `src/server/instructions/index.ts`.

| Method | Signature | Description |
|---|---|---|
| `registerDefault` | `(key: string, text: string, metadata?) => void` | Register default text and its `usedBy`/`kind` inventory metadata. Called at module init. |
| `resolve` | `(key: string, modelId?: string) => string` | Return the registered default. The `modelId` parameter is accepted for call-site compatibility but ignored. Throws if key is unregistered. |
| `getDefault` | `(key: string) => string \| undefined` | Return the default text, or undefined for unknown keys. |
| `listKeys` | `() => string[]` | List all registered instruction keys. |
| `listEntries` | `() => RegisteredInstruction[]` | List text plus ownership/kind metadata for inspection. |
| `clear` | `() => void` | Reset all defaults. Used in tests. |

## Registered Instruction Keys

All registered keys grouped by module:

### Generation (4)

| Key | Registered in | Description |
|---|---|---|
| `generation.system` | `src/server/llm/agents.ts` | Main writer system prompt |
| `generation.writer-brief.system` | `src/server/llm/agents.ts` | Writer system prompt when receiving a prewriter brief |
| `generation.play-continuation` | `src/server/llm/agents.ts` | Continuation-only contract for Play input |
| `generation.prewriter.system` | `src/server/llm/agents.ts` | Prewriter agent system prompt |

### Librarian (5)

| Key | Registered in | Description |
|---|---|---|
| `librarian.analyze.system` | `src/server/librarian/agents.ts` | Background analysis system prompt |
| `librarian.chat.system` | `src/server/librarian/agents.ts` | Interactive librarian chat system prompt |
| `librarian.refine.system` | `src/server/librarian/agents.ts` | Fragment refinement system prompt |
| `librarian.optimize-character.system` | `src/server/librarian/agents.ts` | Character optimization system prompt (depth methodology) |
| `librarian.prose-transform.system` | `src/server/librarian/agents.ts` | Prose selection transform system prompt |

### Character Chat (4)

| Key | Registered in | Description |
|---|---|---|
| `character-chat.system` | `src/server/character-chat/agents.ts` | Complete character chat roleplay contract |
| `character-chat.persona.character` | `src/server/character-chat/agents.ts` | Named character persona (uses `{{personaName}}`, `{{personaDescription}}`) |
| `character-chat.persona.stranger` | `src/server/character-chat/agents.ts` | Anonymous stranger persona |
| `character-chat.persona.custom` | `src/server/character-chat/agents.ts` | Custom persona (uses `{{prompt}}`) |

### Directions (2)

| Key | Registered in | Description |
|---|---|---|
| `directions.system` | `src/server/directions/agents.ts` | Direction suggestion system prompt |
| `directions.suggest-template` | `src/server/directions/agents.ts` | Suggest prompt template |

### Story setup (1)

| Key | Registered in | Description |
|---|---|---|
| `story-setup.system` | `src/server/story-setup/agents.ts` | Conversational story discovery prompt |

### Chapters (1)

| Key | Registered in | Description |
|---|---|---|
| `chapters.summarize.system` | `src/server/chapters/agents.ts` | Chapter summarization system prompt |

## Customizing Instructions

Every agent's prompt is assembled from blocks that can be overridden, reordered,
disabled, or extended per story in the Agent Context panel. To customize an
instruction, override the block that carries it (typically the `instructions`
block) for the agent in question. See `docs/context-blocks.md` and
`docs/adding-agents.md`.

## Template Variables

Some instruction keys contain `{{placeholder}}` markers that are substituted at call sites — not by the registry itself. The registry stores the raw template text.

| Key | Variables | Substituted in |
|---|---|---|
| `character-chat.persona.character` | `{{personaName}}`, `{{personaDescription}}` | `src/server/character-chat/chat.ts` |
| `character-chat.persona.custom` | `{{prompt}}` | `src/server/character-chat/chat.ts` |
| `directions.suggest-template` | `{{count}}` | `src/server/directions/suggest.ts` |

## Integration

Instructions flow into agent contexts through `instructionRegistry.resolve(key)`:

1. Agent block definitions call `resolve()` in their `createDefaultBlocks()` function
2. The instruction text becomes the content of a context block (typically the `instructions` block)
3. Users customize that block per story via the Agent Context panel (block overrides), not via the registry

## Prompt surface audit

Run `bun run audit:prompts` to print three complementary views:

1. every registered instruction, its receiving agent, kind, approximate size,
   and template placeholders;
2. every agent's instruction keys, context-block support, advertised tool count,
   and child-agent call surface;
3. the generation Direct/Play × standard/planner/brief input contract.

`bun run audit:prompts --verbose` additionally prints the exact registered text
and generation input blocks. This is an inventory, not a runtime policy. Dynamic
story context and tool schemas remain visible in the live Agent Context preview.

## File Reference

| File | Purpose |
|---|---|
| `src/server/instructions/registry.ts` | `InstructionRegistry` class and singleton |
| `src/server/instructions/index.ts` | Re-exports |
