import { createStreamingRunner, type StreamingRunOptions } from '../agents/create-streaming-runner'
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

export function createStorySetupTools(dataDir: string, storyId: string, mode: 'assess' | 'continue') {
  if (mode === 'assess') {
    return {
      updateStorySetup: tool({
        description: 'Report the seven checklist items from the existing story material without changing the story, and provide 2 to 4 interactive options in the options argument for any directions or next steps you propose to the writer.',
        inputSchema: StorySetupAssessmentSchema,
        execute: async ({ checklist, options }) => {
          try {
            const setupFragments = await listStorySetupFragments(dataDir, storyId)
            return {
              saved: false,
              checklist,
              covered: checklist.filter(item => item.status === 'covered').length,
              story: null,
              fragments: setupFragments.map(fragment => ({
                id: fragment.id,
                key: fragment.meta.storySetupKey as string,
                type: fragment.type,
                name: fragment.name,
                description: fragment.description,
                content: fragment.content,
              })),
              options: options ?? [],
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
      description: 'Save the working story details and complete setup-fragment snapshot, and replace the visible checklist before asking the writer the next question. Propose 2 to 4 distinct elaborated directions in your conversational message and match them with concise, human-readable option labels in options. Author specific, informative descriptions (<250 chars) without placeholders, and actively update existing fragments as new details are revealed.',
      inputSchema: StorySetupSnapshotSchema,
      execute: async ({ story, checklist, fragments, options }) => {
        try {
          const saved = await syncStorySetupSnapshot(dataDir, storyId, { story: story ?? null, fragments })
          return {
            saved: true,
            checklist,
            covered: checklist.filter(item => item.status === 'covered').length,
            story: saved.story,
            fragments: saved.fragments,
            options: options ?? [],
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          throw new Error(`Errata rejected the story setup snapshot: ${message}. Correct it and call updateStorySetup again.`)
        }
      },
    }),
  }
}

const runStorySetupChat = createStreamingRunner<StorySetupChatOptions>({
  name: 'story-setup.chat',
  role: 'story-setup.chat',
  readOnly: true,
  extraContext: async ({ dataDir, storyId, opts, ctxState }) => {
    const setupFragments = await listStorySetupFragments(dataDir, storyId, ctxState?.allFragments)
    return {
      storySetupFragments: setupFragments,
      storySetupReadOnly: resolveStorySetupMode(opts) === 'assess',
    }
  },
  tools: ({ dataDir, storyId, opts }) => createStorySetupTools(dataDir, storyId, resolveStorySetupMode(opts)),
  toolChoice: 'auto',
  maxSteps: 3,
  messages: ({ compiled, opts, story }) => {
    const mode = resolveStorySetupMode(opts)
    const contextMessage = compiled.messages.find(message => message.role === 'user')
    const hasWorkingStory = Boolean(
      (story?.name && story.name !== 'New Story') ||
      story?.description?.trim()
    )
    const conversation = opts.messages.length > 0
      ? opts.messages
      : mode === 'assess' ? [{
          role: 'user' as const,
          content: 'Assess the checklist against the current story material. Make no story changes. Then ask only about the highest-value genuinely unresolved point; if there is no meaningful material yet, invite any incomplete starting point.',
        }] : [{
          role: 'user' as const,
          content: hasWorkingStory
            ? `Begin the story setup conversation by actively extrapolating from the working title "${story.name}"${story.description ? ` and description "${story.description}"` : ''}. Propose 2 to 3 vivid narrative directions or character concepts implied by this premise in rich conversational prose, and offer concrete choices in options for how to develop the foundation.`
            : 'Begin the story setup conversation. Propose a few compelling starting sparks across different genres or styles with concrete choices in options, and invite the writer to pick one or share their own idea.',
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
  execution?: StreamingRunOptions,
) {
  const result = await runStorySetupChat(dataDir, storyId, opts, execution)
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
