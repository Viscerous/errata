import { describe, expect, it } from 'vitest'
import { z } from 'zod/v4'
import { reportMaintenanceInputSchema, reportPassageInputSchema } from '@/server/librarian/analysis-tools'
import { FREEFORM_ANSWER_TOKENS, freeformOutputCap, maxSerializedChars, toolCallOutputCap } from '@/server/llm/output-budget'
import { DEFAULT_REASONING_ALLOWANCE } from '@/contracts/providers'

// Each budget is roughly an order of magnitude above a typical report, so a
// legitimate dense passage fits while a runaway report stays bounded.
const REPORT_BUDGETS = [
  ['reportPassage', reportPassageInputSchema, 44_000],
  ['reportMaintenance', reportMaintenanceInputSchema, 20_000],
] as const

describe('analyze report output budgets', () => {
  it.each(REPORT_BUDGETS)('%s admits at most its budget of serialized output', (_name, schema, budget) => {
    expect(maxSerializedChars(z.toJSONSchema(schema))).toBeLessThanOrEqual(budget)
  })
})

describe('tool-call output cap', () => {
  const schema = { type: 'object', properties: { value: { type: 'string', maxLength: 298 } } }

  it('is the largest well-formed call when the model does not reason', () => {
    // {"value":"<298>"} is 2 + 5 + 4 + 300 = 311 characters, at three per token.
    expect(toolCallOutputCap(schema, { enabled: false, allowance: 50_000 })).toBe(104)
  })

  it("adds the model's reasoning allowance, or the default when none is set", () => {
    expect(toolCallOutputCap(schema, { enabled: true, allowance: 2_000 })).toBe(2_104)
    expect(toolCallOutputCap(schema, { enabled: true })).toBe(104 + DEFAULT_REASONING_ALLOWANCE)
  })

  it('leaves an unbounded schema to the provider', () => {
    expect(toolCallOutputCap({ type: 'string' }, { enabled: false })).toBeUndefined()
  })
})

describe('free-form output cap', () => {
  it('bounds a prose or chat request by its answer plus the reasoning allowance', () => {
    expect(freeformOutputCap({ thinkingEnabled: false, reasoningAllowance: 40_000, guards: {} })).toBe(FREEFORM_ANSWER_TOKENS)
    expect(freeformOutputCap({ thinkingEnabled: true, reasoningAllowance: 40_000, guards: {} })).toBe(FREEFORM_ANSWER_TOKENS + 40_000)
    expect(freeformOutputCap({ thinkingEnabled: true, guards: {} })).toBe(FREEFORM_ANSWER_TOKENS + DEFAULT_REASONING_ALLOWANCE)
  })

  it('yields to a lower explicit story limit', () => {
    expect(freeformOutputCap({ thinkingEnabled: true, guards: { maxOutputTokens: 2_000 } })).toBe(2_000)
  })
})
