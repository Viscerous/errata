import { createStreamingRunner } from '../agents/create-streaming-runner'
import { tool } from 'ai'
import { StorySetupSnapshotSchema } from './schema'

export interface StorySetupChatOptions {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
}

export const storySetupChat = createStreamingRunner<StorySetupChatOptions>({
  name: 'story-setup.chat',
  role: 'story-setup.chat',
  buildContext: false,
  readOnly: true,
  tools: () => ({
    updateStorySetup: tool({
      description: 'Replace the visible story checklist and full set of provisional fragment drafts before asking the writer the next question.',
      inputSchema: StorySetupSnapshotSchema,
      execute: async ({ checklist, fragments }) => ({
        accepted: true,
        covered: checklist.filter(item => item.status === 'covered').length,
        fragmentCount: fragments.length,
      }),
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
