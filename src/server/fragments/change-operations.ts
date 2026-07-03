import { createHash } from 'node:crypto'
import { z } from 'zod/v4'
import { generateFragmentId, PREFIXES } from '@/lib/fragment-ids'
import type { Fragment } from './schema'
import {
  archiveFragment,
  createFragment as createFragmentInStorage,
  getFragment,
  getStory,
  updateFragmentVersioned,
} from './storage'
import { registry } from './registry'
import { checkFragmentWrite, isFragmentLocked } from './protection'

export const MAX_BATCH_OPERATIONS = 25

export const FRAGMENT_NAME_DESCRIPTION = 'Plain human-readable fragment name, e.g. "Elias Thorne".'
export const FRAGMENT_DESCRIPTION_DESCRIPTION = 'Short fragment description for lists and context. Maximum 250 characters.'
export const FRAGMENT_CONTENT_DESCRIPTION = 'Complete fragment content, written in full.'
export const BASE_HASH_DESCRIPTION = '`baseHash` returned by `readFragments`; required for whole-field rewrites.'
export const SET_FIELDS_DESCRIPTION = 'Whole replacement values for editable fields. Use complete final field text.'

/**
 * Canonical description of the fragment-change operations. Every tool description
 * and agent prompt that teaches these verbs interpolates this one string so the
 * model never sees two subtly different explanations. Do not paraphrase per call
 * site — edit here.
 */
export const OPERATION_GUIDANCE =
  '`replace_text` for localized edits — to insert detail, set `oldText` to an existing sentence and `newText` to that sentence plus the addition; `append_paragraph` for a new topic at the end; `set_fields` only for whole-field rewrites (requires `baseHash`); `archive_fragment` only to retire. Group related facts in cohesive paragraphs; change only the affected span, never restate existing content.'

/** Tool description for `proposeFragmentChanges`, shared by the chat and analysis tools. */
export const PROPOSE_FRAGMENT_CHANGES_DESCRIPTION =
  `Propose fragment changes via \`operations\`. ${OPERATION_GUIDANCE} Does not apply changes.`

export type EditableField = 'name' | 'description' | 'content'
export type OperationStatus = 'valid' | 'invalid' | 'applied' | 'skipped'

export interface OperationError {
  code: string
  message: string
  nextAction?: 'readFragments' | 'listFragments' | 'proposeProseChanges'
}

export interface DiffPreview {
  field: EditableField
  before: string
  after: string
}

export interface OperationValidation {
  operationId: string
  action: FragmentChangeOperation['action']
  status: OperationStatus
  target?: { fragmentId: string; field?: EditableField }
  errors?: OperationError[]
  warnings?: string[]
  diffs?: DiffPreview[]
  createdFragmentId?: string
}

export interface ValidationOptions {
  allowProseEdits?: boolean
  allowedCreateTypes?: string[]
  createTypeScopeDescription?: string
}

export interface ApplyOperationsOptions extends ValidationOptions {
  reason?: string
  createMetaSource?: string
  onFragmentUpdated?: (before: Fragment, after: Fragment) => void | Promise<void>
}

const FRAGMENT_ID_LABEL_RE = /^([a-z][a-z0-9]{1,7})-[a-z0-9][a-z0-9-]*\s*:/i
const FRAGMENT_ID_LIKE_RE = /^([a-z][a-z0-9]{1,7})-[a-z0-9][a-z0-9-]*$/i
const BUILTIN_FRAGMENT_PREFIXES = new Set(Object.values(PREFIXES).map(prefix => prefix.toLowerCase()))

function fragmentPrefixForType(type: string): string {
  return (PREFIXES[type] ?? registry.getType(type)?.prefix ?? type.slice(0, 4)).toLowerCase()
}

function isReservedFragmentPrefix(prefix: string, expectedPrefix: string): boolean {
  const normalized = prefix.toLowerCase()
  return normalized === expectedPrefix || BUILTIN_FRAGMENT_PREFIXES.has(normalized) || registry.getTypeByPrefix(normalized) !== undefined
}

export function fragmentNameError(type: string, name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return null

  const expectedPrefix = fragmentPrefixForType(type)
  const labelMatch = trimmed.match(FRAGMENT_ID_LABEL_RE)
  const idLikeMatch = trimmed.match(FRAGMENT_ID_LIKE_RE)
  if (
    (labelMatch && isReservedFragmentPrefix(labelMatch[1] ?? '', expectedPrefix))
    || (idLikeMatch && isReservedFragmentPrefix(idLikeMatch[1] ?? '', expectedPrefix))
  ) {
    return 'Use the fragment human-readable name, for example "Elias Thorne". Fragment IDs are generated separately.'
  }

  return null
}

export const editableFieldSchema = z.enum(['name', 'description', 'content'])

const operationIdSchema = z.string().min(1).max(80).optional()
const REASONING_ARTIFACT_TAGS = ['think', 'thinking', 'reasoning']

/**
 * Remove reasoning-tag artifacts (`<think>…`) that small models sometimes leak
 * into generated text. `truncateUnclosed` is for the write path, where content
 * is being created fresh and a runaway, never-closed reasoning dump should be
 * cut off entirely. Echoes back to the model (see {@link sanitizeTextForToolEcho})
 * leave it off so a stray `<think` inside legitimate stored content can't silently
 * truncate everything after it.
 */
function stripReasoningArtifacts(val: string, { truncateUnclosed = true } = {}): string {
  let next = val
  for (const tag of REASONING_ARTIFACT_TAGS) {
    next = next.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), '')
    if (truncateUnclosed) {
      next = next
        .replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*$`, 'gi'), '')
        .replace(new RegExp(`<\\/${tag}>`, 'gi'), '')
    }
  }
  return next
}

export function sanitizeTextForToolEcho(text: string): string {
  return stripReasoningArtifacts(text, { truncateUnclosed: false })
}

function normalizeLlmEscapedText(val: string): string {
  const unescaped = val
    .replace(/(?:\\r)?\\n/g, '\n')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
  return stripReasoningArtifacts(unescaped)
}

/** Sanitizes literal escaped newline strings (like \n or \r\n) generated by LLMs into actual newlines. */
export const llmRawTextSchema = z.string().transform((val) =>
  normalizeLlmEscapedText(val)
)

/** A sanitized string schema for LLM-generated text fields that must be non-empty (1+ chars). */
export const llmInsertTextSchema = llmRawTextSchema.refine((val) => val.length >= 1, {
  message: 'String must contain at least 1 character.',
})

/** A sanitized string schema for LLM-generated paragraphs, stripping leading/trailing literal and actual newlines. */
export const llmTextSchema = z.string().transform((val) =>
  normalizeLlmEscapedText(val).trim()
).refine((val) => val.length >= 1, { message: 'String must contain at least 1 character.' })

/** A sanitized string schema for fragment names (max 100 after trimming). */
export const llmNameSchema = z.string().transform((val) =>
  stripReasoningArtifacts(val)
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .trim()
).pipe(z.string().min(1).max(100))

/** A sanitized string schema for fragment descriptions (max 250 after trimming). */
export const llmDescriptionSchema = z.string().transform((val) =>
  normalizeLlmEscapedText(val).trim()
).pipe(z.string().max(250))

const fieldUpdatesSchema = z.object({
  name: llmNameSchema.describe(FRAGMENT_NAME_DESCRIPTION).optional(),
  description: llmDescriptionSchema.describe(FRAGMENT_DESCRIPTION_DESCRIPTION).optional(),
  content: llmInsertTextSchema.describe('Complete final content when set; not a partial edit.').optional(),
}).refine(
  (value) => value.name !== undefined || value.description !== undefined || value.content !== undefined,
  { message: 'Provide at least one field to set.' },
)

const createFragmentOperationSchema = z.object({
  operationId: operationIdSchema,
  action: z.literal('create_fragment'),
  type: z.string().min(1).describe('Registered fragment type, such as character, guideline, knowledge, summary, or a story custom type.'),
  name: llmNameSchema.describe(FRAGMENT_NAME_DESCRIPTION),
  description: llmDescriptionSchema.describe(FRAGMENT_DESCRIPTION_DESCRIPTION),
  content: llmInsertTextSchema.describe(FRAGMENT_CONTENT_DESCRIPTION),
  reason: z.string().max(500).optional(),
})

const replaceTextOperationSchema = z.object({
  operationId: operationIdSchema,
  action: z.literal('replace_text'),
  fragmentId: z.string().min(1).describe('Target fragment ID.'),
  field: editableFieldSchema.describe('Editable field to change. Defaults to content.').default('content'),
  oldText: z.string().default('').describe('Required exact current text span to replace. Match the stored text literally (whitespace included); do not escape newlines or quotes — anchors are matched byte-for-byte.'),
  newText: llmRawTextSchema.describe('Required replacement text. Use an empty string only to delete oldText.'),
  occurrence: z.number().int().positive().optional().describe('1-based occurrence to replace when `oldText` appears multiple times. Omit only when unique or when `replaceAll` is true.'),
  replaceAll: z.boolean().default(false).describe('Replace every occurrence of `oldText` in the field. Defaults to false for fragment memory edits; use carefully.'),
  reason: z.string().max(500).optional(),
})

const appendParagraphOperationSchema = z.object({
  operationId: operationIdSchema,
  action: z.literal('append_paragraph'),
  fragmentId: z.string().min(1).describe('Target fragment ID.'),
  field: editableFieldSchema.describe('Editable field to change. Defaults to content.').default('content'),
  text: llmTextSchema.describe('Required paragraph text to append. The tool adds paragraph spacing.'),
  reason: z.string().max(500).optional(),
})

const setFieldsOperationSchema = z.object({
  operationId: operationIdSchema,
  action: z.literal('set_fields'),
  fragmentId: z.string().min(1).describe('Target fragment ID.'),
  baseHash: z.string().min(8).optional().describe(BASE_HASH_DESCRIPTION),
  fields: fieldUpdatesSchema.describe(SET_FIELDS_DESCRIPTION),
  reason: z.string().max(500).optional(),
})

const archiveFragmentOperationSchema = z.object({
  operationId: operationIdSchema,
  action: z.literal('archive_fragment'),
  fragmentId: z.string().min(1),
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

export const proposeFragmentChangesSchema = z.object({
  title: z.string().max(100).optional(),
  rationale: z.string().max(1200).optional(),
  operations: z.array(fragmentChangeOperationSchema).min(1).max(MAX_BATCH_OPERATIONS),
})

export const operationsInputSchema = z.object({
  proposalId: z.string().optional().describe('`proposalId` returned by a propose tool. Preferred over restating operations.'),
  operations: z.array(fragmentChangeOperationSchema).min(1).max(MAX_BATCH_OPERATIONS).optional().describe('Inline operations, used only when no proposalId exists.'),
}).refine(
  (value) => Boolean(value.proposalId) || Boolean(value.operations?.length),
  { message: 'Provide either proposalId or operations.' },
)

function editableSnapshot(fragment: Fragment) {
  return {
    id: fragment.id,
    type: fragment.type,
    name: fragment.name,
    description: fragment.description,
    content: fragment.content,
    version: fragment.version ?? 1,
  }
}

export function fragmentBaseHash(fragment: Fragment): string {
  return createHash('sha256')
    .update(JSON.stringify(editableSnapshot(fragment)))
    .digest('hex')
    .slice(0, 16)
}

export function truncateText(text: string, max = 900): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}...`
}

export function excerptAround(text: string, index: number, length: number, radius = 140): string {
  const start = Math.max(0, index - radius)
  const end = Math.min(text.length, index + length + radius)
  return `${start > 0 ? '...' : ''}${text.slice(start, end)}${end < text.length ? '...' : ''}`
}

function fieldValue(fragment: Pick<Fragment, EditableField>, field: EditableField): string {
  return fragment[field]
}

function setFieldValue<T extends Pick<Fragment, EditableField>>(fragment: T, field: EditableField, value: string): T {
  return { ...fragment, [field]: value }
}

type EditableDraft = Pick<Fragment, EditableField>

export function findOccurrences(text: string, needle: string): number[] {
  const indices: number[] = []
  let offset = 0
  while (offset <= text.length) {
    const index = text.indexOf(needle, offset)
    if (index === -1) break
    indices.push(index)
    offset = index + Math.max(needle.length, 1)
  }
  return indices
}

export function makeOperationError(
  code: string,
  message: string,
  nextAction?: OperationError['nextAction'],
): OperationError {
  return nextAction ? { code, message, nextAction } : { code, message }
}

export function countOperationErrors(results: OperationValidation[]): number {
  return results.reduce((n, result) => n + (result.errors?.length ?? 0), 0)
}

export function recommendedReadFragmentIds(results: OperationValidation[]): string[] {
  const ids = new Set<string>()
  for (const result of results) {
    if (!result.target?.fragmentId) continue
    if (result.errors?.some((error) => error.nextAction === 'readFragments')) {
      ids.add(result.target.fragmentId)
    }
  }
  return [...ids]
}

export function sanitizeOperationValidationsForTool(results: OperationValidation[]): OperationValidation[] {
  return results.map((result) => ({
    ...result,
    diffs: result.diffs?.map((diff) => ({
      ...diff,
      before: sanitizeTextForToolEcho(diff.before),
      after: sanitizeTextForToolEcho(diff.after),
    })),
  }))
}

/**
 * Common echo fields shared by every propose/validate/apply tool result so all
 * surfaces answer the model in the same shape. Callers add their own `ok` and any
 * surface-specific fields on top.
 */
export function operationEchoFields(results: OperationValidation[]): {
  valid: number
  readFragmentIds: string[]
  operations: OperationValidation[]
} {
  return {
    valid: results.filter((result) => result.status === 'valid').length,
    readFragmentIds: recommendedReadFragmentIds(results),
    operations: sanitizeOperationValidationsForTool(results),
  }
}

/** Single source for the "this fragment ID does not exist" error. */
export function unknownFragmentIdError(fragmentId: string): OperationError {
  return makeOperationError(
    'fragment_not_found',
    `Fragment ID '${fragmentId}' does not exist in the story. Use listFragments to find the correct active ID.`,
    'listFragments',
  )
}

/** Human-readable variant of {@link unknownFragmentIdError} for a batch of IDs. */
export function unknownFragmentIdsMessage(fragmentIds: string[]): string {
  const list = fragmentIds.map((id) => `'${id}'`).join(', ')
  return `Fragment ID(s) not found in the story: ${list}. Use listFragments or findFragments to find the correct active IDs (did you write a descriptive name instead of the actual random-suffix ID like 'ch-nezeze'?).`
}

function listKnownTypes(storyCustomTypes: Array<{ type: string }> = []): string[] {
  return [
    ...registry.listTypes().map((t) => t.type),
    ...storyCustomTypes.map((t) => t.type),
  ]
}

async function isKnownFragmentType(dataDir: string, storyId: string, type: string): Promise<boolean> {
  if (registry.getType(type)) return true
  const story = await getStory(dataDir, storyId)
  return story?.settings.customFragmentTypes?.some((t) => t.type === type) ?? false
}

/**
 * A localized edit larger than this is almost certainly a whole-rewrite (or a
 * looping model restating the body); those belong in `set_fields`, which is
 * `baseHash`-guarded. `set_fields.content` itself is exempt.
 */
export const MAX_LOCALIZED_EDIT_CHARS = 4000

function localizedEditSizeError(
  fragmentId: string,
  operation: Exclude<FragmentChangeOperation, { action: 'create_fragment' | 'archive_fragment' | 'set_fields' }>,
): OperationError | null {
  const text = operation.action === 'replace_text' ? operation.newText : operation.text
  if (text.length <= MAX_LOCALIZED_EDIT_CHARS) return null
  return makeOperationError(
    'localized_edit_too_large',
    `${operation.action} text for ${fragmentId} is ${text.length} characters — far beyond a localized edit. Replace only the span that changes, or use set_fields with baseHash for a complete rewrite.`,
    'readFragments',
  )
}

// Matches the context-rendering identity heading ("### `ch-abc123` | Name | desc")
// that full sheets carry in agent prompts. It is prompt chrome, never fragment text;
// a model pasting it into content is echoing its own context back into storage.
const CONTEXT_HEADING_RE = /^#{2,3}\s*`[a-z]{2,4}-[a-z0-9]{4,12}`\s*\|/m

/** Paragraphs shorter than this are ignored by the repetition check (labels, headings). */
const MIN_DUP_PARAGRAPH_CHARS = 80

function normalizedParagraphCounts(content: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const paragraph of content.split(/\n\s*\n/)) {
    const normalized = paragraph.trim().replace(/\s+/g, ' ').toLowerCase()
    if (normalized.length < MIN_DUP_PARAGRAPH_CHARS) continue
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1)
  }
  return counts
}

/**
 * Errors for looping/format artifacts an operation would INTRODUCE into content.
 * Compares against the pre-edit content so a fragment that already carries an
 * artifact (legacy damage) stays editable — only making it worse is blocked.
 */
function contentIntegrityErrors(label: string, before: string, after: string): OperationError[] {
  const errors: OperationError[] = []
  if (CONTEXT_HEADING_RE.test(after) && !CONTEXT_HEADING_RE.test(before)) {
    errors.push(makeOperationError(
      'context_heading_in_content',
      `Content for ${label} contains a context-rendering heading ("### \`id\` | name | description"). That line is prompt formatting, not fragment text — write only the fragment body.`,
    ))
  }
  const beforeCounts = normalizedParagraphCounts(before)
  const introduced: string[] = []
  for (const [paragraph, count] of normalizedParagraphCounts(after)) {
    if (count >= 2 && count > (beforeCounts.get(paragraph) ?? 0)) {
      introduced.push(paragraph.slice(0, 60))
    }
  }
  if (introduced.length > 0) {
    errors.push(makeOperationError(
      'repeated_content',
      `Content for ${label} would repeat the same paragraph more than once (e.g. "${introduced[0]}..."). State each fact once — remove the repetition and resubmit.`,
    ))
  }
  return errors
}

function validateDraftFields(fragmentId: string, type: string, draft: Pick<Fragment, EditableField>): OperationError[] {
  const errors: OperationError[] = []
  const nameError = fragmentNameError(type, draft.name)
  if (nameError) {
    errors.push(makeOperationError('fragment_name_invalid', `${nameError} Target: ${fragmentId}.`))
  }
  if (draft.name.length > 100) {
    errors.push(makeOperationError('name_too_long', `Name for ${fragmentId} exceeds 100 characters.`))
  }
  if (draft.description.length > 250) {
    errors.push(makeOperationError('description_too_long', `Description for ${fragmentId} exceeds 250 characters.`))
  }
  if (draft.content.trim().length === 0) {
    errors.push(makeOperationError('content_empty', `Content for ${fragmentId} cannot be empty.`))
  }
  return errors
}

type OccurrenceResolution =
  | { index: number; occurrence: number; errors?: undefined }
  | { errors: OperationError[]; index?: undefined; occurrence?: undefined }

function resolveOccurrence(params: {
  occurrences: number[]
  occurrence?: number
  notFound: OperationError
  ambiguous: (count: number) => OperationError
  outOfRange: (count: number, occurrence: number) => OperationError
}): OccurrenceResolution {
  if (params.occurrences.length === 0) {
    return { errors: [params.notFound] }
  }
  if (params.occurrences.length > 1 && !params.occurrence) {
    return { errors: [params.ambiguous(params.occurrences.length)] }
  }

  const occurrence = params.occurrence ?? 1
  const index = params.occurrences[occurrence - 1]
  if (index === undefined) {
    return { errors: [params.outOfRange(params.occurrences.length, occurrence)] }
  }

  return { index, occurrence }
}

function replaceExactText(params: {
  fragmentId: string
  field: EditableField
  current: string
  oldText: string
  newText: string
  occurrence?: number
  replaceAll?: boolean
}): { next?: string; diff?: DiffPreview; errors?: OperationError[] } {
  const occurrences = findOccurrences(params.current, params.oldText)
  if (occurrences.length === 0) {
    return {
      errors: [makeOperationError('old_text_not_found', `oldText was not found in ${params.fragmentId}.${params.field}. No change was applied for this operation. Read the current fragment and match the text exactly; if you are adding to the end, prefer append_paragraph.`, 'readFragments')],
    }
  }

  if (params.replaceAll) {
    const next = params.current.split(params.oldText).join(params.newText)
    const first = occurrences[0]
    return {
      next,
      diff: {
        field: params.field,
        before: excerptAround(params.current, first, params.oldText.length),
        after: excerptAround(next, Math.max(0, first), params.newText.length),
      },
    }
  }

  const resolved = resolveOccurrence({
    occurrences,
    occurrence: params.occurrence,
    notFound: makeOperationError('old_text_not_found', `oldText was not found in ${params.fragmentId}.${params.field}. No change was applied for this operation. Read the current fragment and match the text exactly; if you are adding to the end, prefer append_paragraph.`, 'readFragments'),
    ambiguous: (count) => makeOperationError('old_text_ambiguous', `oldText appears ${count} times in ${params.fragmentId}.${params.field}. Provide occurrence or set replaceAll intentionally.`, 'readFragments'),
    outOfRange: (count, occurrence) => makeOperationError('occurrence_out_of_range', `${params.fragmentId}.${params.field} has ${count} occurrence(s); requested occurrence ${occurrence}.`, 'readFragments'),
  })
  if (resolved.errors) return { errors: resolved.errors }

  const next = `${params.current.slice(0, resolved.index)}${params.newText}${params.current.slice(resolved.index + params.oldText.length)}`
  return {
    next,
    diff: {
      field: params.field,
      before: excerptAround(params.current, resolved.index, params.oldText.length),
      after: excerptAround(next, resolved.index, params.newText.length),
    },
  }
}

function applyOperationToDraft(
  fragmentId: string,
  draft: EditableDraft,
  operation: Exclude<FragmentChangeOperation, { action: 'create_fragment' | 'archive_fragment' }>,
): { draft: EditableDraft; diffs?: DiffPreview[]; errors?: OperationError[] } {
  if (operation.action === 'set_fields') {
    const before = draft
    const next = { ...draft, ...operation.fields }
    return {
      draft: next,
      diffs: (Object.keys(operation.fields) as EditableField[]).map((field) => ({
        field,
        before: truncateText(before[field]),
        after: truncateText(next[field]),
      })),
    }
  }

  if (operation.action === 'replace_text') {
    if (!operation.oldText) {
      return {
        draft,
        errors: [makeOperationError(
          'old_text_missing',
          `replace_text requires oldText — the exact current text to find and replace. To rewrite the whole field, use set_fields with baseHash instead.`,
          'readFragments',
        )],
      }
    }
    const replacement = replaceExactText({
      fragmentId,
      field: operation.field,
      current: fieldValue(draft, operation.field),
      oldText: operation.oldText,
      newText: operation.newText,
      occurrence: operation.occurrence,
      replaceAll: operation.replaceAll,
    })
    if (replacement.errors) return { draft, errors: replacement.errors }
    return {
      draft: replacement.next !== undefined
        ? setFieldValue(draft, operation.field, replacement.next)
        : draft,
      diffs: replacement.diff ? [replacement.diff] : undefined,
    }
  }

  const current = fieldValue(draft, operation.field)
  const currentTrimmed = current.trimEnd()
  const next = currentTrimmed.length > 0
    ? `${currentTrimmed}\n\n${operation.text}`
    : operation.text
  return {
    draft: setFieldValue(draft, operation.field, next),
    diffs: [{
      field: operation.field,
      before: '',
      after: truncateText(operation.text),
    }],
  }
}

export function normalizeOperations(operations: FragmentChangeOperation[]): FragmentChangeOperation[] {
  const seen = new Set<string>()
  return operations.map((operation, index) => {
    const requested = typeof operation.operationId === 'string' && operation.operationId.trim()
      ? operation.operationId.trim()
      : `op-${index + 1}`
    let operationId = requested
    let suffix = 2
    while (seen.has(operationId)) {
      operationId = `${requested}-${suffix}`
      suffix += 1
    }
    seen.add(operationId)
    return { ...operation, operationId }
  })
}

async function validateCreateOperation(
  dataDir: string,
  storyId: string,
  operation: Extract<FragmentChangeOperation, { action: 'create_fragment' }>,
  options: ValidationOptions,
): Promise<OperationValidation> {
  const errors: OperationError[] = []
  if (options.allowedCreateTypes && !options.allowedCreateTypes.includes(operation.type)) {
    const available = options.allowedCreateTypes.join(', ')
    errors.push(makeOperationError(
      'fragment_type_not_allowed',
      `Fragment type "${operation.type}" is not available${options.createTypeScopeDescription ? ` for ${options.createTypeScopeDescription}` : ''}. Use one of: ${available}.`,
    ))
  } else if (!await isKnownFragmentType(dataDir, storyId, operation.type)) {
    const story = await getStory(dataDir, storyId)
    errors.push(makeOperationError('unknown_fragment_type', `Unknown fragment type "${operation.type}". Known types: ${listKnownTypes(story?.settings.customFragmentTypes ?? []).join(', ')}.`))
  }
  if (operation.name.trim().length === 0) {
    errors.push(makeOperationError('name_empty', 'Fragment name cannot be empty.'))
  }
  const nameError = fragmentNameError(operation.type, operation.name)
  if (nameError) {
    errors.push(makeOperationError('fragment_name_invalid', nameError))
  }
  if (operation.name.length > 100) {
    errors.push(makeOperationError('name_too_long', 'Fragment name exceeds 100 characters.'))
  }
  if (operation.description.length > 250) {
    errors.push(makeOperationError('description_too_long', 'Description exceeds 250 characters.'))
  }
  if (operation.content.trim().length === 0) {
    errors.push(makeOperationError('content_empty', 'Fragment content cannot be empty.'))
  }
  errors.push(...contentIntegrityErrors(`new ${operation.type} "${operation.name}"`, '', operation.content))

  return {
    operationId: operation.operationId ?? '',
    action: operation.action,
    status: errors.length > 0 ? 'invalid' : 'valid',
    errors: errors.length > 0 ? errors : undefined,
    diffs: errors.length > 0 ? undefined : [{
      field: 'content',
      before: '',
      after: truncateText(operation.content),
    }],
  }
}

export async function validateOperations(
  dataDir: string,
  storyId: string,
  operationsInput: FragmentChangeOperation[],
  options: ValidationOptions = {},
): Promise<{ operations: FragmentChangeOperation[]; results: OperationValidation[] }> {
  const operations = normalizeOperations(operationsInput)
  const results = new Map<string, OperationValidation>()
  const createOps = operations.filter((operation): operation is Extract<FragmentChangeOperation, { action: 'create_fragment' }> => operation.action === 'create_fragment')

  for (const operation of createOps) {
    results.set(operation.operationId ?? '', await validateCreateOperation(dataDir, storyId, operation, options))
  }

  const targetIds = [...new Set(operations
    .filter((operation): operation is Exclude<FragmentChangeOperation, { action: 'create_fragment' }> => operation.action !== 'create_fragment')
    .map((operation) => operation.fragmentId))]

  for (const fragmentId of targetIds) {
    const targetOps = operations.filter((operation): operation is Exclude<FragmentChangeOperation, { action: 'create_fragment' }> =>
      operation.action !== 'create_fragment' && operation.fragmentId === fragmentId,
    )
    const target = await getFragment(dataDir, storyId, fragmentId)
    if (!target) {
      for (const operation of targetOps) {
        results.set(operation.operationId ?? '', {
          operationId: operation.operationId ?? '',
          action: operation.action,
          status: 'invalid',
          target: { fragmentId },
          errors: [unknownFragmentIdError(fragmentId)],
        })
      }
      continue
    }

    if (target.archived) {
      for (const operation of targetOps) {
        results.set(operation.operationId ?? '', {
          operationId: operation.operationId ?? '',
          action: operation.action,
          status: 'invalid',
          target: { fragmentId },
          errors: [makeOperationError('archived_fragment', `Fragment ${fragmentId} is archived. Restore it before editing.`)],
        })
      }
      continue
    }

    if (isFragmentLocked(target)) {
      for (const operation of targetOps) {
        results.set(operation.operationId ?? '', {
          operationId: operation.operationId ?? '',
          action: operation.action,
          status: 'invalid',
          target: { fragmentId },
          errors: [makeOperationError('locked_fragment', 'Fragment is locked and cannot be modified by AI tools.')],
        })
      }
      continue
    }

    const archiveOps = targetOps.filter((operation) => operation.action === 'archive_fragment')
    const editOps = targetOps.filter((operation) => operation.action !== 'archive_fragment')
    if (archiveOps.length > 0 && editOps.length > 0) {
      for (const operation of targetOps) {
        results.set(operation.operationId ?? '', {
          operationId: operation.operationId ?? '',
          action: operation.action,
          status: 'invalid',
          target: { fragmentId },
          errors: [makeOperationError('conflicting_operations', `Submit archive and edit operations for ${fragmentId} in separate proposals.`)],
        })
      }
      continue
    }

    for (const operation of archiveOps) {
      results.set(operation.operationId ?? '', {
        operationId: operation.operationId ?? '',
        action: operation.action,
        status: 'valid',
        target: { fragmentId },
        warnings: ['Archiving is reversible from storage, but it hides the fragment from normal context and lists.'],
      })
    }
    if (archiveOps.length > 0) continue

    if (target.type === 'prose' && !options.allowProseEdits) {
      for (const operation of targetOps) {
        results.set(operation.operationId ?? '', {
          operationId: operation.operationId ?? '',
          action: operation.action,
          status: 'invalid',
          target: { fragmentId },
          errors: [makeOperationError('prose_requires_prose_tool', 'Use proposeProseChanges for prose edits so scope is explicit and active-prose constrained.', 'proposeProseChanges')],
        })
      }
      continue
    }

    const hasSetFields = targetOps.some((operation) => operation.action === 'set_fields')
    if (hasSetFields && targetOps.length > 1) {
      for (const operation of targetOps) {
        results.set(operation.operationId ?? '', {
          operationId: operation.operationId ?? '',
          action: operation.action,
          status: 'invalid',
          target: { fragmentId },
          errors: [makeOperationError('conflicting_operations', `Submit set_fields and localized span edits for ${fragmentId} in separate proposals. Use either a single complete rewrite or localized edits.`)],
        })
      }
      continue
    }

    let draft: Pick<Fragment, EditableField> = {
      name: target.name,
      description: target.description,
      content: target.content,
    }
    let targetInvalid = false

    for (const operation of targetOps) {
      const targetField = operation.action === 'archive_fragment' ? undefined : operation.action === 'set_fields' ? undefined : operation.field
      const validation: OperationValidation = {
        operationId: operation.operationId ?? '',
        action: operation.action,
        status: 'valid',
        target: { fragmentId, field: targetField },
      }

      if (operation.action === 'set_fields') {
        if (!operation.baseHash) {
          validation.status = 'invalid'
          validation.errors = [makeOperationError('base_hash_required', `set_fields requires baseHash from readFragments for ${fragmentId}. Read the fragment before proposing a whole-field rewrite.`, 'readFragments')]
        } else if (operation.baseHash !== fragmentBaseHash(target)) {
          validation.status = 'invalid'
          validation.errors = [makeOperationError('base_hash_mismatch', `baseHash for ${fragmentId} is stale. Read the fragment again before rewriting fields.`, 'readFragments')]
        } else {
          const applied = applyOperationToDraft(fragmentId, draft, operation)
          draft = applied.draft
          validation.diffs = applied.diffs
        }
      } else if (operation.action !== 'archive_fragment') {
        const oversize = localizedEditSizeError(fragmentId, operation)
        if (oversize) {
          validation.status = 'invalid'
          validation.errors = [oversize]
        } else {
          const applied = applyOperationToDraft(fragmentId, draft, operation)
          if (applied.errors) {
            validation.status = 'invalid'
            validation.errors = applied.errors
          } else {
            draft = applied.draft
            validation.diffs = applied.diffs
          }
        }
      }

      if (validation.errors?.length) {
        targetInvalid = true
      }
      results.set(operation.operationId ?? '', validation)
    }

    const fieldErrors = validateDraftFields(fragmentId, target.type, draft)
    fieldErrors.push(...contentIntegrityErrors(fragmentId, target.content, draft.content))
    const protection = checkFragmentWrite(target, { content: draft.content })
    if (!protection.allowed) {
      fieldErrors.push(makeOperationError('protected_fragment', protection.reason ?? 'Fragment is protected.'))
    }
    if (fieldErrors.length > 0) {
      targetInvalid = true
    }

    if (targetInvalid || fieldErrors.length > 0) {
      for (const operation of targetOps) {
        const existing = results.get(operation.operationId ?? '')
        const errors = [
          ...(existing?.errors ?? []),
          ...(fieldErrors.length > 0 ? fieldErrors : []),
        ]
        results.set(operation.operationId ?? '', {
          ...(existing ?? {
            operationId: operation.operationId ?? '',
            action: operation.action,
            target: { fragmentId },
          }),
          status: 'invalid',
          errors: errors.length > 0 ? errors : [makeOperationError('target_batch_invalid', `Another operation against ${fragmentId} is invalid, so the target batch cannot be applied atomically.`)],
        })
      }
    }
  }

  return {
    operations,
    results: operations.map((operation) => results.get(operation.operationId ?? '') ?? {
      operationId: operation.operationId ?? '',
      action: operation.action,
      status: 'invalid',
      errors: [makeOperationError('validation_missing', 'Operation was not validated.')],
    }),
  }
}

export async function applyOperations(
  dataDir: string,
  storyId: string,
  operationsInput: FragmentChangeOperation[],
  options: ApplyOperationsOptions = {},
): Promise<OperationValidation[]> {
  const { operations, results } = await validateOperations(dataDir, storyId, operationsInput, options)
  const byId = new Map(results.map((result) => [result.operationId, result]))
  const appliedResults: OperationValidation[] = []

  const createOps = operations.filter((operation): operation is Extract<FragmentChangeOperation, { action: 'create_fragment' }> => operation.action === 'create_fragment')
  for (const operation of createOps) {
    const validation = byId.get(operation.operationId ?? '')
    if (!validation || validation.status !== 'valid') {
      appliedResults.push(validation ?? {
        operationId: operation.operationId ?? '',
        action: operation.action,
        status: 'invalid',
        errors: [makeOperationError('validation_missing', 'Operation was not validated.')],
      })
      continue
    }

    const now = new Date().toISOString()
    const id = generateFragmentId(operation.type)
    const fragment: Fragment = {
      id,
      type: operation.type,
      name: operation.name.trim(),
      description: operation.description,
      content: operation.content,
      tags: [],
      refs: [],
      sticky: registry.getType(operation.type)?.stickyByDefault ?? false,
      placement: 'user',
      createdAt: now,
      updatedAt: now,
      order: 0,
      meta: {
        source: options.createMetaSource ?? 'llm-proposed-change',
        reason: operation.reason,
      },
      archived: false,
      version: 1,
      versions: [],
    }
    await createFragmentInStorage(dataDir, storyId, fragment)
    appliedResults.push({
      ...validation,
      status: 'applied',
      createdFragmentId: id,
      target: { fragmentId: id },
    })
  }

  const targetIds = [...new Set(operations
    .filter((operation): operation is Exclude<FragmentChangeOperation, { action: 'create_fragment' }> => operation.action !== 'create_fragment')
    .map((operation) => operation.fragmentId))]

  for (const fragmentId of targetIds) {
    const targetOps = operations.filter((operation): operation is Exclude<FragmentChangeOperation, { action: 'create_fragment' }> =>
      operation.action !== 'create_fragment' && operation.fragmentId === fragmentId,
    )
    const targetResults = targetOps.map((operation) => byId.get(operation.operationId ?? ''))
    if (targetResults.some((result) => !result || result.status !== 'valid')) {
      for (const operation of targetOps) {
        const validation = byId.get(operation.operationId ?? '')
        appliedResults.push(validation ?? {
          operationId: operation.operationId ?? '',
          action: operation.action,
          status: 'invalid',
          target: { fragmentId },
          errors: [makeOperationError('validation_missing', 'Operation was not validated.')],
        })
      }
      continue
    }

    const target = await getFragment(dataDir, storyId, fragmentId)
    if (!target) {
      for (const operation of targetOps) {
        appliedResults.push({
          operationId: operation.operationId ?? '',
          action: operation.action,
          status: 'invalid',
          target: { fragmentId },
          errors: [unknownFragmentIdError(fragmentId)],
        })
      }
      continue
    }

    if (targetOps.every((operation) => operation.action === 'archive_fragment')) {
      await archiveFragment(dataDir, storyId, fragmentId)
      for (const operation of targetOps) {
        appliedResults.push({
          ...(byId.get(operation.operationId ?? '') as OperationValidation),
          status: 'applied',
        })
      }
      continue
    }

    let draft: Pick<Fragment, EditableField> = {
      name: target.name,
      description: target.description,
      content: target.content,
    }

    for (const operation of targetOps) {
      if (operation.action !== 'archive_fragment') {
        draft = applyOperationToDraft(fragmentId, draft, operation).draft
      }
    }

    const updated = await updateFragmentVersioned(
      dataDir,
      storyId,
      fragmentId,
      {
        name: draft.name,
        description: draft.description,
        content: draft.content,
      },
      { reason: options.reason ?? 'llm-applyProposedChanges' },
    )
    if (!updated) {
      for (const operation of targetOps) {
        appliedResults.push({
          operationId: operation.operationId ?? '',
          action: operation.action,
          status: 'invalid',
          target: { fragmentId },
          errors: [makeOperationError('apply_failed', `Fragment disappeared before apply: ${fragmentId}`)],
        })
      }
      continue
    }

    await options.onFragmentUpdated?.(target, updated)
    for (const operation of targetOps) {
      appliedResults.push({
        ...(byId.get(operation.operationId ?? '') as OperationValidation),
        status: 'applied',
      })
    }
  }

  return appliedResults
}
