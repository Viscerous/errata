import type { Fragment, StoryMeta } from '../fragments/schema'
import type { ContextBuildState } from '../llm/context-builder'

/**
 * Shared context type that all agent block builders receive.
 * Superset of data — each agent uses the fields it needs.
 */
export interface AgentBlockContext {
  /** Fetch any fragment by ID (async). Available in script blocks as ctx.getFragment(id). */
  getFragment?: (id: string) => Promise<Fragment | null>

  /** Resolved model ID, used for model-aware instruction resolution. */
  modelId?: string

  // Common (from ContextBuildState)
  story: StoryMeta
  proseFragments: Fragment[]
  stickyGuidelines: Fragment[]
  stickyKnowledge: Fragment[]
  stickyCharacters: Fragment[]
  /** Non-sticky characters appearing in the recent prose, carried full. */
  recentCharacters?: Fragment[]
  guidelineShortlist: Fragment[]
  knowledgeShortlist: Fragment[]
  characterShortlist: Fragment[]

  // System prompt fragments (tagged pass-to-librarian-system-prompt)
  systemPromptFragments: Fragment[]

  // Librarian analyze
  allCharacters?: Fragment[]
  allKnowledge?: Fragment[]
  newProse?: { id: string; content: string }

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
   * The writer's full build state, carried by its preview so the block builder
   * renders it directly instead of reconstructing a ContextBuildState from the
   * flat fields above (which would silently drop any field not copied across).
   */
  generationState?: ContextBuildState
}
