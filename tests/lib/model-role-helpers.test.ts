import { describe, expect, it } from 'vitest'
import { getModelFallbackChain, resolveProvider } from '@/lib/model-role-helpers'
import { makeTestGlobalConfig, makeTestSettings } from '../setup'
import type { ModelRoleInfo } from '@/lib/api/types'

const roles: ModelRoleInfo[] = [{
  key: 'chapters',
  label: 'Chapters',
  description: 'Chapter summaries',
  fallback: 'librarian',
}]

describe('model role helpers', () => {
  it('matches explicit namespace fallbacks supplied by the server', () => {
    expect(getModelFallbackChain('chapters.summarize', roles))
      .toEqual(['chapters.summarize', 'chapters', 'librarian', 'generation'])

    const settings = makeTestSettings({
      modelOverrides: {
        librarian: { providerId: 'librarian-provider', modelId: 'summary-model' },
      },
    })
    const globalConfig = makeTestGlobalConfig({
      providers: [],
      defaultProviderId: null,
    })
    expect(resolveProvider('chapters.summarize', settings, globalConfig, roles))
      .toBe('librarian-provider')
  })
})
