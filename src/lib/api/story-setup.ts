import { fetchEventStream } from './client'

export interface StorySetupMessage {
  role: 'user' | 'assistant'
  content: string
}

export type StorySetupChatMode = 'assess' | 'continue'

export type StorySetupChecklistKey =
  | 'starting-point'
  | 'premise'
  | 'characters'
  | 'goal'
  | 'setting'
  | 'voice'
  | 'opening'

export interface StorySetupChecklistItem {
  key: StorySetupChecklistKey
  status: 'missing' | 'partial' | 'covered'
  note: string
}

export interface StorySetupDraftFragment {
  id?: string
  key: string
  type: 'guideline' | 'knowledge' | 'character' | 'prose'
  name: string
  description: string
  content: string
}

export const storySetup = {
  chat: (
    storyId: string,
    messages: StorySetupMessage[],
    mode: StorySetupChatMode,
    signal?: AbortSignal,
    runId?: string,
  ) => fetchEventStream(`/stories/${storyId}/setup/chat`, { messages, mode, runId }, signal),
}
