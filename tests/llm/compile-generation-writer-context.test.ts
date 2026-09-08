import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { tool } from 'ai'
import { z } from 'zod/v4'
import { createTempDir, makeTestSettings } from '../setup'
import { createFragment, createStory } from '@/server/fragments/storage'
import type { Fragment, StoryMeta } from '@/contracts/story'
import type { WritingPlugin } from '@/server/plugins/types'
import { compileGenerationWriterContext } from '@/server/llm/compile-generation-writer-context'
import { ensureCoreAgentsRegistered } from '@/server/agents/register-core'

function makeStory(): StoryMeta {
  const now = new Date().toISOString()
  return {
    id: 'story-test',
    name: 'Test Story',
    description: 'A test story.',
    coverImage: null,
    createdAt: now,
    updatedAt: now,
    settings: makeTestSettings(),
  }
}

function makeFragment(overrides: Partial<Fragment>): Fragment {
  const now = new Date().toISOString()
  return {
    id: 'kn-0001',
    type: 'knowledge',
    name: 'Hidden rule',
    description: 'A rule used through a plugin reference.',
    content: 'Only silver opens the sealed door.',
    tags: [],
    refs: [],
    sticky: false,
    placement: 'user',
    createdAt: now,
    updatedAt: now,
    order: 0,
    meta: {},
    ...overrides,
  }
}

describe('compiled generation writer context', () => {
  let dataDir: string
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    const temp = await createTempDir()
    dataDir = temp.path
    cleanup = temp.cleanup
    await createStory(dataDir, makeStory())
  })

  afterEach(async () => {
    await cleanup()
  })

  it('expands fragment references added by beforeGeneration hooks', async () => {
    await createFragment(dataDir, 'story-test', makeFragment({}))
    const plugin: WritingPlugin = {
      manifest: { name: 'reference-hook', version: '1.0.0', description: 'test' },
      hooks: {
        beforeGeneration: (messages) => [
          ...messages,
          { role: 'user', content: 'Plugin evidence:\n<@kn-0001>' },
        ],
      },
    }

    const compiled = await compileGenerationWriterContext({
      dataDir,
      storyId: 'story-test',
      authorInput: 'Continue.',
      enabledPlugins: [plugin],
    })

    const pluginMessage = compiled.messages.at(-1)?.content ?? ''
    expect(pluginMessage).toContain('Only silver opens the sealed door.')
    expect(pluginMessage).not.toContain('<@kn-0001>')
  })

  it('keeps core tools when a plugin declares the same name', async () => {
    const shadowRead = tool({
      description: 'Shadow core reads.',
      inputSchema: z.object({}),
      execute: async () => ({ shadowed: true }),
    })
    const customLookup = tool({
      description: 'A distinct plugin lookup.',
      inputSchema: z.object({}),
      execute: async () => ({ ok: true }),
    })
    const plugin: WritingPlugin = {
      manifest: { name: 'collision-test', version: '1.0.0', description: 'test' },
      tools: () => ({ readFragments: shadowRead, customLookup }),
    }

    const compiled = await compileGenerationWriterContext({
      dataDir,
      storyId: 'story-test',
      authorInput: 'Continue.',
      enabledPlugins: [plugin],
    })

    expect(compiled.allTools.readFragments).not.toBe(shadowRead)
    expect(compiled.allTools.customLookup).toBe(customLookup)
    expect(compiled.ignoredPluginTools).toEqual([
      { name: 'readFragments', pluginName: 'collision-test' },
    ])
    expect(compiled.pluginToolDescriptions.map((entry) => entry.name)).toEqual(['customLookup'])
  })
})
  beforeAll(() => {
    ensureCoreAgentsRegistered()
  })
