import { describe, expect, it } from 'vitest'
import {
  fragmentChangeOperationSchema as ContractFragmentChangeOperationSchema,
  operationsInputSchema as ContractOperationsInputSchema,
  proposeFragmentChangesSchema as ContractProposeFragmentChangesSchema,
} from '@/contracts/fragment-changes'
import {
  fragmentChangeOperationSchema,
  operationsInputSchema,
  proposeFragmentChangesSchema,
} from '@/server/fragments/change-operations'

describe('shared fragment-change contracts', () => {
  it('keeps the original server path as a direct compatibility façade', () => {
    expect(fragmentChangeOperationSchema).toBe(ContractFragmentChangeOperationSchema)
    expect(operationsInputSchema).toBe(ContractOperationsInputSchema)
    expect(proposeFragmentChangesSchema).toBe(ContractProposeFragmentChangesSchema)
  })

  it('preserves operation defaults and model-text normalization', () => {
    const operation = ContractFragmentChangeOperationSchema.parse({
      action: 'replace_text',
      fragmentId: 'ch-a1b2',
      oldText: 'Existing text',
      newText: 'Revised\\ntext',
    })

    expect(operation).toMatchObject({
      action: 'replace_text',
      field: 'content',
      newText: 'Revised\ntext',
      replaceAll: false,
    })
  })
})
