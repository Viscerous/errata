import { createStreamingRunner } from '../agents/create-streaming-runner'
import { tool } from 'ai'
import { StorySetupAssessmentSchema, StorySetupSnapshotSchema } from './schema'
import { listStorySetupFragments, syncStorySetupSnapshot } from './sync'

export interface StorySetupChatOptions {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  mode?: 'assess' | 'continue'
}

function resolveStorySetupMode(opts: StorySetupChatOptions): 'assess' | 'continue' {
  return opts.mode ?? (opts.messages.some(message => message.role === 'user') ? 'continue' : 'assess')
}

const runStorySetupChat = createStreamingRunner<StorySetupChatOptions>({
  name: 'story-setup.chat',
  role: 'story-setup.chat',
  readOnly: true,
  extraContext: async ({ dataDir, storyId, opts }) => ({
    storySetupFragments: await listStorySetupFragments(dataDir, storyId),
    storySetupReadOnly: resolveStorySetupMode(opts) === 'assess',
  }),
  tools: ({ dataDir, storyId, opts }) => {
    const mode = resolveStorySetupMode(opts)
    if (mode === 'assess') {
      return {
        updateStorySetup: tool({
          description: 'Report the seven checklist items from the existing story material without changing the story.',
          inputSchema: StorySetupAssessmentSchema,
          execute: async ({ checklist }) => {
            try {
              const existing = await listStorySetupFragments(dataDir, storyId)
              return {
                saved: false,
                checklist,
                covered: checklist.filter(item => item.status === 'covered').length,
                story: null,
                fragments: existing.map(fragment => ({
                  id: fragment.id,
                  key: fragment.meta.storySetupKey as string,
                  type: fragment.type,
                  name: fragment.name,
                  description: fragment.description,
                  content: fragment.content,
                })),
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              throw new Error(`Errata could not assess the existing setup: ${message}. Retry updateStorySetup.`)
            }
          },
        }),
      }
    }

    return {
      updateStorySetup: tool({
        description: 'Save the working story details and complete setup-fragment snapshot, and replace the visible checklist before asking the writer the next question.',
        inputSchema: StorySetupSnapshotSchema,
        execute: async ({ story, checklist, fragments }) => {
          try {
            const saved = await syncStorySetupSnapshot(dataDir, storyId, { story: story ?? null, fragments })
            return {
              saved: true,
              checklist,
              covered: checklist.filter(item => item.status === 'covered').length,
              story: saved.story,
              fragments: saved.fragments,
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            throw new Error(`Errata rejected the story setup snapshot: ${message}. Correct it and call updateStorySetup again.`)
          }
        },
      }),
    }
  },
  toolChoice: 'auto',
  maxSteps: 3,
  messages: ({ compiled, opts }) => {
    const mode = resolveStorySetupMode(opts)
    const contextMessage = compiled.messages.find(message => message.role === 'user')
    const conversation = opts.messages.length > 0
      ? opts.messages
      : mode === 'assess' ? [{
          role: 'user' as const,
          content: 'Assess the checklist against the current story material. Make no story changes. Then ask only about the highest-value genuinely unresolved point; if there is no meaningful material yet, invite any incomplete starting point.',
        }] : [{
          role: 'user' as const,
          content: 'Begin the story setup conversation. Ask what starting point I have, and make it clear that an incomplete idea is welcome.',
        }]
    const assessment = mode === 'assess' && opts.messages.length > 0
      ? [{
          role: 'user' as const,
          content: 'Reassess the checklist against the current story material. Preserve the conversation, make no story changes, and ask only about a genuinely unresolved point.',
        }]
      : []
    return [
      ...(contextMessage ? [{ role: 'user' as const, content: contextMessage.content }] : []),
      ...conversation,
      ...assessment,
    ]
  },
})

export async function storySetupChat(
  dataDir: string,
  storyId: string,
  opts: StorySetupChatOptions,
) {
  const result = await runStorySetupChat(dataDir, storyId, opts)
  return {
    ...result,
    completion: result.completion.then((completion) => {
      if (!completion.toolCalls.some(call => call.toolName === 'updateStorySetup')) {
        throw new Error('Story setup ended without a valid updateStorySetup result')
      }
      if (!completion.text.trim()) {
        throw new Error('Story setup updated its snapshot but ended before asking the next question')
      }
      return completion
    }),
  }
}
