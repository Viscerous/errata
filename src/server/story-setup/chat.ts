import { createStreamingRunner } from '../agents/create-streaming-runner'

export interface StorySetupChatOptions {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
}

export const storySetupChat = createStreamingRunner<StorySetupChatOptions>({
  name: 'story-setup.chat',
  role: 'story-setup.chat',
  buildContext: false,
  readOnly: 'none',
  toolChoice: 'none',
  maxSteps: 1,
  messages: ({ opts }) => opts.messages.length > 0
    ? opts.messages
    : [{
        role: 'user',
        content: 'Begin the story setup conversation. Ask what starting point I have, and make it clear that an incomplete idea is welcome.',
      }],
})
