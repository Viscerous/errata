import { describe, expect, it } from 'vitest'
import {
  fragmentChangeOperationSchema,
} from '@/contracts/fragment-changes'

describe('shared fragment-change contracts', () => {
  it('preserves operation defaults and model-authored text', () => {
    const operation = fragmentChangeOperationSchema.parse({
      action: 'replace_text',
      fragmentId: 'ch-a1b2',
      oldText: 'Existing text',
      newText: 'Revised\\ntext',
    })

    expect(operation).toMatchObject({
      action: 'replace_text',
      field: 'content',
      newText: 'Revised\\ntext',
      replaceAll: false,
    })
  })
})
