import { z } from 'zod/v4'

export const MAX_BATCH_OPERATIONS = 25

export const FRAGMENT_NAME_DESCRIPTION = 'Plain human-readable fragment name, e.g. "Elias Thorne".'
export const FRAGMENT_DESCRIPTION_DESCRIPTION = 'Short fragment description for lists and context. Maximum 250 characters.'
export const FRAGMENT_CONTENT_DESCRIPTION = 'Complete fragment content, written in full.'
export const BASE_HASH_DESCRIPTION = '`baseHash` returned by `readFragments`; required for whole-field rewrites.'
export const SET_FIELDS_DESCRIPTION = 'Whole replacement values for editable fields. Use complete final field text.'

/** One canonical explanation for every model-facing fragment-change surface. */
export const OPERATION_GUIDANCE =
  'Use `set_fields` only for whole-field rewrites (requires `baseHash`); use `append_paragraph` for a new topic at the end; use `replace_text` for localized edits to existing text; use `archive_fragment` only to retire. For `replace_text`, `oldText` is the exact existing text to find and replace, and `newText` is the complete replacement for that text. The tool preserves the text before and after `oldText`, so include only the text that should replace `oldText`. To insert detail inside a sentence or paragraph, use that sentence or paragraph as `oldText` and the revised version as `newText`. Group related facts in cohesive paragraphs.'

export const PROPOSE_FRAGMENT_CHANGES_DESCRIPTION =
  `Propose fragment changes via \`operations\`. ${OPERATION_GUIDANCE} Does not apply changes.`

export const editableFieldSchema = z.enum(['name', 'description', 'content'])
export type EditableField = z.infer<typeof editableFieldSchema>

const operationIdSchema = z.string().min(1).max(80).optional()

/**
 * Model-authored content is stored as supplied, less any sentence numbering
 * the model echoed from its view of a record (see normalizeOperations). The
 * maxLength keeps the local-grammar (GBNF) form bounded: an unbounded string
 * is an infinite repetition in the grammar, which weak models degenerate into.
 */
export const llmRawTextSchema = z.string().max(2000)

export const llmInsertTextSchema = llmRawTextSchema.refine((value) => value.length >= 1, {
  message: 'String must contain at least 1 character.',
})

const exactAnchorTextSchema = z.string().max(1000).refine((value) => value.trim().length >= 1, {
  message: 'oldText must contain the exact existing text to find and replace.',
})

export const llmTextSchema = z.string().trim().min(1).max(1000)

export const llmNameSchema = z.string().trim().min(1).max(100)

export const llmDescriptionSchema = z.string().trim().max(250)

const fieldUpdatesSchema = z.object({
  name: llmNameSchema.describe(FRAGMENT_NAME_DESCRIPTION).optional(),
  description: llmDescriptionSchema.describe(FRAGMENT_DESCRIPTION_DESCRIPTION).optional(),
  content: llmInsertTextSchema.describe('Complete final content when set; not a partial edit.').optional(),
}).refine(
  (value) => value.name !== undefined || value.description !== undefined || value.content !== undefined,
  { message: 'Provide at least one field to set.' },
)

export const createFragmentOperationSchema = z.object({
  operationId: operationIdSchema,
  action: z.literal('create_fragment'),
  type: z.string().min(1).max(64).describe('Registered fragment type, such as character, guideline, knowledge, summary, or a story custom type.'),
  name: llmNameSchema.describe(FRAGMENT_NAME_DESCRIPTION),
  description: llmDescriptionSchema.describe(FRAGMENT_DESCRIPTION_DESCRIPTION),
  content: llmInsertTextSchema.describe(FRAGMENT_CONTENT_DESCRIPTION),
  reason: z.string().max(500).optional(),
})

export const replaceTextOperationSchema = z.object({
  operationId: operationIdSchema,
  action: z.literal('replace_text'),
  fragmentId: z.string().min(1).max(64).describe('Target fragment ID.'),
  field: editableFieldSchema.describe('Editable field to change. Defaults to content.').default('content'),
  oldText: exactAnchorTextSchema.describe('Required exact existing text to find and replace. Copy it from the stored fragment text literally (whitespace included); do not escape newlines or quotes — anchors are matched byte-for-byte.'),
  newText: llmRawTextSchema.describe('Required complete replacement for oldText. The tool preserves surrounding text, so include only the text that should replace oldText. To insert detail inside a sentence or paragraph, use the revised sentence or paragraph. Use an empty string only to delete oldText.'),
  occurrence: z.number().int().positive().optional().describe('1-based occurrence to replace when `oldText` appears multiple times. Omit only when unique or when `replaceAll` is true.'),
  replaceAll: z.boolean().default(false).describe('Replace every occurrence of `oldText` in the field. Defaults to false for fragment memory edits; use carefully.'),
  reason: z.string().max(500).optional(),
})

export const appendParagraphOperationSchema = z.object({
  operationId: operationIdSchema,
  action: z.literal('append_paragraph'),
  fragmentId: z.string().min(1).max(64).describe('Target fragment ID.'),
  field: editableFieldSchema.describe('Editable field to change. Defaults to content.').default('content'),
  text: llmTextSchema.describe('Required paragraph text to append. The tool adds paragraph spacing.'),
  reason: z.string().max(500).optional(),
})

export const setFieldsOperationSchema = z.object({
  operationId: operationIdSchema,
  action: z.literal('set_fields'),
  fragmentId: z.string().min(1).max(64).describe('Target fragment ID.'),
  baseHash: z.string().min(8).max(128).optional().describe(BASE_HASH_DESCRIPTION),
  fields: fieldUpdatesSchema.describe(SET_FIELDS_DESCRIPTION),
  reason: z.string().max(500).optional(),
})

export const archiveFragmentOperationSchema = z.object({
  operationId: operationIdSchema,
  action: z.literal('archive_fragment'),
  fragmentId: z.string().min(1).max(64),
  reason: z.string().max(500).optional(),
})

export const fragmentChangeOperationSchema = z.discriminatedUnion('action', [
  createFragmentOperationSchema,
  replaceTextOperationSchema,
  appendParagraphOperationSchema,
  setFieldsOperationSchema,
  archiveFragmentOperationSchema,
])

export type FragmentChangeOperation = z.infer<typeof fragmentChangeOperationSchema>
export type FragmentChangeAction = FragmentChangeOperation['action']

export const proposeFragmentChangesSchema = z.object({
  title: z.string().max(100).optional(),
  rationale: z.string().max(1200).optional(),
  operations: z.array(fragmentChangeOperationSchema).min(1).max(MAX_BATCH_OPERATIONS),
})

export const operationsInputSchema = z.object({
  proposalId: z.string().max(64).optional().describe('`proposalId` returned by a propose tool. Preferred over restating operations.'),
  operations: z.array(fragmentChangeOperationSchema).min(1).max(MAX_BATCH_OPERATIONS).optional().describe('Inline operations, used only when no proposalId exists.'),
}).refine(
  (value) => Boolean(value.proposalId) || Boolean(value.operations?.length),
  { message: 'Provide either proposalId or operations.' },
)

export type OperationStatus = 'valid' | 'invalid' | 'applied' | 'skipped'

export interface OperationError {
  code: string
  message: string
  nextAction?: 'readFragments' | 'listFragments' | 'editProse'
}

export interface DiffPreview {
  field: EditableField
  before: string
  after: string
}

export interface OperationValidation {
  operationId: string
  action: FragmentChangeAction
  status: OperationStatus
  target?: { fragmentId: string; field?: EditableField }
  errors?: OperationError[]
  warnings?: string[]
  diffs?: DiffPreview[]
  createdFragmentId?: string
}

export interface AppliedFieldChange {
  before: string
  after: string
}

export type AppliedChange =
  | {
      kind: 'create'
      fragmentId: string
      afterHash: string
      fields: Partial<Record<EditableField, AppliedFieldChange>>
    }
  | {
      kind: 'update'
      fragmentId: string
      beforeHash: string
      afterHash: string
      fields: Partial<Record<EditableField, AppliedFieldChange>>
      addedRefs?: string[]
      /** Opaque caller metadata restored by the apply/revert hook. */
      previousLastLibrarianChangeProposal?: unknown
    }
  | {
      kind: 'archive'
      fragmentId: string
      beforeHash: string
      afterHash: string
    }

export interface RevertResult {
  kind: AppliedChange['kind']
  fragmentId: string
  status: 'reverted' | 'skipped'
  message?: string
}

export interface RevertBatchResult {
  revertResults: RevertResult[]
  updatedFragmentIds: string[]
  archivedFragmentIds: string[]
  restoredFragmentIds: string[]
}
