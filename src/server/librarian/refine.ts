import { getFragment } from '../fragments/storage'
import { createStreamingRunner } from '../agents/create-streaming-runner'
import type { Fragment } from '@/contracts/story'
import type { AgentStreamResult } from '../agents/stream-types'

export interface RefineOptions {
  fragmentId: string
  instructions?: string
  maxSteps?: number
}

export type RefineResult = AgentStreamResult

export const refineFragment = createStreamingRunner<RefineOptions, { fragment: Fragment }>({
  name: 'librarian.refine',
  readOnly: false,

  validate: async ({ dataDir, storyId, opts }) => {
    const fragment = await getFragment(dataDir, storyId, opts.fragmentId)
    if (!fragment) throw new Error(`Fragment ${opts.fragmentId} not found`)
    return { fragment }
  },

  contextOptions: (opts) => ({ excludeFragmentId: opts.fragmentId }),

  extraContext: async ({ validated, opts }) => ({
    targetFragment: validated.fragment,
    instructions: opts.instructions,
  }),
})
