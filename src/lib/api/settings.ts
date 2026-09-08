import { apiFetch } from './client'
import type { CustomFragmentType, StoryMeta } from './types'
import type { AuthorInputMode } from '@/contracts/generation'

export const settings = {
  update: (storyId: string, data: {
    enabledPlugins?: string[]
    outputFormat?: 'plaintext' | 'markdown'
    maxSteps?: number
    modelOverrides?: StoryMeta['settings']['modelOverrides']
    authorInputMode?: AuthorInputMode
    generationMode?: 'standard' | 'prewriter'
    clarifyBeforeGenerate?: boolean
    prewriterReasoning?: 'short' | 'normal' | 'extensive'
    disableLibrarianAutoAnalysis?: boolean
    autoApplyLibrarianSuggestions?: boolean
    disableLibrarianDirections?: boolean
    disableLibrarianSuggestions?: boolean
    contextOrderMode?: 'simple' | 'advanced'
    fragmentOrder?: string[]
    customFragmentTypes?: CustomFragmentType[]
    contextCompact?: { type: 'proseLimit' | 'maxTokens' | 'maxCharacters'; value: number }
    guidedContinuePrompt?: string
    guidedSceneSettingPrompt?: string
    guidedSuggestPrompt?: string
    disableThinking?: boolean
    expandThoughtsByDefault?: boolean
  }) =>
    apiFetch<StoryMeta>(`/stories/${storyId}/settings`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
}
