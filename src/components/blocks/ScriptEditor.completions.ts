import type { Completion, CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete'

// ── Static: members of `ctx` ──────────────────────────────────
//
// These mirror `createScriptHelpers()` + `AgentBlockContext` on the server.
// Keep this list in sync with:
//   src/server/blocks/script-context.ts
//   src/server/agents/agent-block-context.ts

const CTX_MEMBERS: Completion[] = [
  // Helper methods (always present)
  {
    label: 'getFragment',
    type: 'method',
    detail: '(id) → Fragment | null',
    info: 'Fetch a fragment by its ID. Returns null if it does not exist.',
    apply: 'getFragment(',
  },
  {
    label: 'getFragments',
    type: 'method',
    detail: '(type?) → Fragment[]',
    info: 'List all fragments, optionally filtered by type (e.g. "character", "knowledge").',
    apply: 'getFragments(',
  },
  {
    label: 'getFragmentsByTag',
    type: 'method',
    detail: '(tag) → Fragment[]',
    info: 'Every fragment carrying the given tag.',
    apply: 'getFragmentsByTag(',
  },
  {
    label: 'getFragmentByTag',
    type: 'method',
    detail: '(tag) → Fragment | null',
    info: 'First fragment carrying the given tag, or null.',
    apply: 'getFragmentByTag(',
  },

  // Common fields on every agent context
  { label: 'story', type: 'property', detail: 'StoryMeta', info: 'The current story — name, description, summary, settings.' },
  { label: 'proseFragments', type: 'property', detail: 'Fragment[]', info: 'Recent prose fragments already included in the prompt.' },
  { label: 'stickyCharacters', type: 'property', detail: 'Fragment[]', info: 'Characters pinned to the prompt.' },
  { label: 'stickyGuidelines', type: 'property', detail: 'Fragment[]', info: 'Guideline fragments pinned to the prompt.' },
  { label: 'stickyKnowledge', type: 'property', detail: 'Fragment[]', info: 'Knowledge fragments pinned to the prompt.' },
  { label: 'characterCatalog', type: 'property', detail: 'Fragment[]', info: 'Non-pinned characters rendered as catalog rows.' },
  { label: 'guidelineCatalog', type: 'property', detail: 'Fragment[]', info: 'Non-pinned guidelines rendered as catalog rows.' },
  { label: 'knowledgeCatalog', type: 'property', detail: 'Fragment[]', info: 'Non-pinned knowledge rendered as catalog rows.' },
  { label: 'systemPromptFragments', type: 'property', detail: 'Fragment[]', info: 'Fragments tagged for system-prompt placement.' },
  { label: 'modelId', type: 'property', detail: 'string | undefined', info: 'Resolved model ID for this agent run.' },

  // Agent-specific fields (only present on certain agents)
  { label: 'allCharacters', type: 'property', detail: 'Fragment[]?', info: 'Librarian analyze: every character in the story.' },
  { label: 'allKnowledge', type: 'property', detail: 'Fragment[]?', info: 'Librarian analyze: every knowledge fragment in the story.' },
  { label: 'newProse', type: 'property', detail: '{ id, content }?', info: 'Librarian analyze: the prose just written.' },
  { label: 'targetFragment', type: 'property', detail: 'Fragment?', info: 'Librarian refine / prose-transform: the fragment being worked on.' },
  { label: 'instructions', type: 'property', detail: 'string?', info: 'User-provided instructions (librarian refine).' },
  { label: 'operation', type: 'property', detail: 'string?', info: 'Prose-transform: the requested operation name.' },
  { label: 'guidance', type: 'property', detail: 'string?', info: 'Prose-transform: user-supplied guidance.' },
  { label: 'selectedText', type: 'property', detail: 'string?', info: 'Prose-transform: the text the user selected.' },
  { label: 'sourceContent', type: 'property', detail: 'string?', info: 'Prose-transform: the full source of the selection.' },
  { label: 'contextBefore', type: 'property', detail: 'string?', info: 'Prose-transform: prose before the selection.' },
  { label: 'contextAfter', type: 'property', detail: 'string?', info: 'Prose-transform: prose after the selection.' },
  { label: 'character', type: 'property', detail: 'Fragment?', info: 'Character-chat: the character being conversed with.' },
  { label: 'personaDescription', type: 'property', detail: 'string?', info: 'Character-chat: the user persona.' },
]

// ── Static: members of a Fragment object ──────────────────────
//
// Most script completions chain off an awaited Fragment. We can't infer types,
// but `.<something>` after an identifier that looks like a fragment is common
// enough that a second-tier static list is useful.

const FRAGMENT_MEMBERS: Completion[] = [
  { label: 'id', type: 'property', detail: 'string' },
  { label: 'name', type: 'property', detail: 'string' },
  { label: 'type', type: 'property', detail: 'string', info: 'Fragment type (character, knowledge, prose, etc.).' },
  { label: 'description', type: 'property', detail: 'string' },
  { label: 'content', type: 'property', detail: 'string', info: 'The fragment body.' },
  { label: 'tags', type: 'property', detail: 'string[]' },
  { label: 'sticky', type: 'property', detail: 'boolean' },
  { label: 'placement', type: 'property', detail: 'string' },
  { label: 'meta', type: 'property', detail: 'Record<string, unknown>' },
  { label: 'createdAt', type: 'property', detail: 'string' },
  { label: 'updatedAt', type: 'property', detail: 'string' },
]

// ── Static: members of StoryMeta ──────────────────────────────

const STORY_MEMBERS: Completion[] = [
  { label: 'id', type: 'property', detail: 'string' },
  { label: 'name', type: 'property', detail: 'string' },
  { label: 'description', type: 'property', detail: 'string' },
  { label: 'summary', type: 'property', detail: 'string', info: 'Rolling summary maintained by the librarian.' },
  { label: 'settings', type: 'property', detail: 'StorySettings' },
  { label: 'createdAt', type: 'property', detail: 'string' },
  { label: 'updatedAt', type: 'property', detail: 'string' },
]

// ── Completion source: `ctx.<cursor>` ─────────────────────────

export const ctxCompletionSource: CompletionSource = (context: CompletionContext): CompletionResult | null => {
  const word = context.matchBefore(/ctx\.\w*/)
  if (!word) return null
  return {
    from: word.from + 4, // past "ctx."
    options: CTX_MEMBERS,
    validFor: /^\w*$/,
  }
}

// ── Completion source: `ctx.story.<cursor>` ────────────────────

export const storyCompletionSource: CompletionSource = (context: CompletionContext): CompletionResult | null => {
  const word = context.matchBefore(/ctx\.story\.\w*/)
  if (!word) return null
  return {
    from: word.from + 'ctx.story.'.length,
    options: STORY_MEMBERS,
    validFor: /^\w*$/,
  }
}

// ── Completion source: `<identifier>.<cursor>` for likely fragments ─
//
// Heuristic: if the identifier looks like a fragment (singular/plural naming
// conventions we already use — "fragment", "character", "frag", "c", "f" — or
// any name ending in "Fragment(s)"), offer fragment members. False positives
// are harmless; the completion is opt-in via Ctrl+Space.

const FRAGMENT_IDENT_RE = /\b(fragment|frag|character|char|guideline|knowledge|k\w*|doc)\w*\.\w*$/i

export const fragmentPropertyCompletionSource: CompletionSource = (context: CompletionContext): CompletionResult | null => {
  const before = context.matchBefore(/[\w$]+\.\w*$/)
  if (!before) return null
  const text = before.text
  if (text.startsWith('ctx.')) return null
  if (!FRAGMENT_IDENT_RE.test(text)) return null
  const dotIdx = text.lastIndexOf('.')
  if (dotIdx < 0) return null
  const from = before.from + dotIdx + 1
  return {
    from,
    options: FRAGMENT_MEMBERS,
    validFor: /^\w*$/,
  }
}

// ── Completion source: fragment ID inside `ctx.get...(` string arg ─

export interface FragmentHint {
  id: string
  name: string
  type: string
}

export function makeFragmentIdCompletionSource(
  getFragments: () => FragmentHint[],
): CompletionSource {
  const BY_ID_CALL = /ctx\.(?:getFragment)\(['"`]([^'"`]*)$/
  const BY_TAG_CALL = /ctx\.(?:getFragmentByTag|getFragmentsByTag)\(['"`]([^'"`]*)$/
  const BY_TYPE_CALL = /ctx\.getFragments\(['"`]([^'"`]*)$/

  return (context: CompletionContext): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos)
    const beforeCursor = line.text.slice(0, context.pos - line.from)

    const idMatch = beforeCursor.match(BY_ID_CALL)
    if (idMatch) {
      const frags = getFragments()
      if (frags.length === 0) return null
      return {
        from: context.pos - idMatch[1].length,
        options: frags.map(f => ({
          label: f.id,
          type: 'text',
          detail: f.name,
          info: `${f.type} — ${f.name}`,
        })),
        validFor: /^[\w-]*$/,
      }
    }

    const tagMatch = beforeCursor.match(BY_TAG_CALL)
    if (tagMatch) {
      const frags = getFragments()
      const tags = new Set<string>()
      // Hint: we don't have tags here without extra plumbing; fall through.
      if (tags.size === 0 && frags.length === 0) return null
      return null
    }

    const typeMatch = beforeCursor.match(BY_TYPE_CALL)
    if (typeMatch) {
      const frags = getFragments()
      const types = Array.from(new Set(frags.map(f => f.type))).sort()
      if (types.length === 0) return null
      return {
        from: context.pos - typeMatch[1].length,
        options: types.map(t => ({
          label: t,
          type: 'enum',
          detail: 'fragment type',
        })),
        validFor: /^[\w-]*$/,
      }
    }

    return null
  }
}
