import { createStreamingRunner } from '../agents/create-streaming-runner'
import { tool } from 'ai'
import { StorySetupSnapshotSchema } from './schema'
import { listStorySetupFragments, syncStorySetupSnapshot } from './sync'

export interface StorySetupChatOptions {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
}

export const storySetupChat = createStreamingRunner<StorySetupChatOptions>({
  name: 'story-setup.chat',
  role: 'story-setup.chat',
  buildContext: false,
  readOnly: true,
  extraContext: async ({ dataDir, storyId }) => ({
    storySetupFragments: await listStorySetupFragments(dataDir, storyId),
  }),
  tools: ({ dataDir, storyId }) => ({
    updateStorySetup: tool({
      description: 'Save the working story details and fragments, and replace the visible checklist before asking the writer the next question.',
      inputSchema: StorySetupSnapshotSchema,
      execute: async ({ story, checklist, fragments }) => {
        const saved = await syncStorySetupSnapshot(dataDir, storyId, { story, fragments })
        return {
          saved: true,
          covered: checklist.filter(item => item.status === 'covered').length,
          story: saved.story,
          fragments: saved.fragments,
        }
      },
    }),
  }),
  toolChoice: 'auto',
  maxSteps: 3,
  messages: ({ opts }) => opts.messages.length > 0
    ? opts.messages
    : [{
        role: 'user',
        content: 'Begin the story setup conversation. Ask what starting point I have, and make it clear that an incomplete idea is welcome.',
      }],
})
