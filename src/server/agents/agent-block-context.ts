import type { Fragment, StoryMeta } from '../fragments/schema'
import type { ContextBuildState, CustomFragmentGroup } from '../llm/context-builder'
import type { FragmentSignal } from '../llm/context-selection'

/**
 * Context every agent's block builder receives. It is the writer's
 * ContextBuildState (story context) plus the agent-specific fields below, so a
 * built ContextBuildState is directly usable as an AgentBlockContext - there's
 * one context shape, not two that must be mapped onto each other.
 */
export interface AgentBlockContext extends ContextBuildState {
  /** Fetch any fragment by ID (async). Available in script blocks as ctx.getFragment(id). */
  getFragment?: (id: string) => Promise<Fragment | null>

  // System prompt fragments (tagged pass-to-librarian-system-prompt)
  systemPromptFragments: Fragment[]

  // Librarian analyze
  allCharacters?: Fragment[]
  allKnowledge?: Fragment[]
  allCustomFragments?: CustomFragmentGroup[]
  newProse?: { id: string; content: string }
  attentionCandidateIds?: string[]
  attentionCandidateSignals?: FragmentSignal[]

  // Librarian refine
  targetFragment?: Fragment
  instructions?: string

  // Prose transform
  operation?: string
  guidance?: string
  selectedText?: string
  sourceContent?: string
  contextBefore?: string
  contextAfter?: string

  // Character chat
  character?: Fragment
  personaDescription?: string

  // Plugin tools
  pluginToolDescriptions?: Array<{ name: string; description: string }>

  /**
   * Tools disabled by this agent's per-story block config. Default block
   * builders can use this to keep generated instructions aligned with the
   * actual toolset that compileAgentContext sends to the model.
   */
  disabledTools?: string[]

  /**
   * Tool names that remain after the runtime-provided toolset and disabledTools
   * config are combined. Prefer this for prompt generation when tool wording
   * must exactly match what the model can call.
   */
  enabledTools?: string[]
}

/**
 * The story-context an agent's block context builds on: the built ContextBuildState,
 * or empties when none was built. Spread into an AgentBlockContext by the runners and
 * previews - a spread of the whole state can't drop a field, so they can't drift.
 */
export function baseBlockContext(ctxState: ContextBuildState | null | undefined, story: StoryMeta): ContextBuildState {
  return ctxState ?? {
    story,
    proseFragments: [],
    stickyGuidelines: [],
    stickyKnowledge: [],
    stickyCharacters: [],
    stickyCustomFragments: [],
    guidelineCatalog: [],
    knowledgeCatalog: [],
    characterCatalog: [],
    customFragmentCatalogs: [],
    recentCustomFragments: [],
  }
}
