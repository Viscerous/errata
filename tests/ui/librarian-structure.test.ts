import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { collapseLibrarianTrace } from '@/components/librarian/LibrarianTraceViewer'
import type { LibrarianAnalysis } from '@/lib/api'

describe('librarian UI structure', () => {
  it('keeps the sidebar as a tab controller instead of a feature monolith', () => {
    const panel = readFileSync(resolve('src/components/sidebar/LibrarianPanel.tsx'), 'utf8')
    expect(panel).toContain('LibrarianConversationList')
    expect(panel).toContain('LibrarianStoryView')
    expect(panel).toContain('LibrarianMemoryView')
    expect(panel.split('\n').length).toBeLessThan(250)
  })

  it('keeps analysis findings, suggestions, and traces independently owned', () => {
    const card = readFileSync(resolve('src/components/librarian/LibrarianAnalysisCard.tsx'), 'utf8')
    expect(card).toContain('LibrarianSuggestionList')
    expect(card).toContain('LibrarianTraceViewer')
    expect(readFileSync(resolve('src/components/librarian/LibrarianSuggestionList.tsx'), 'utf8')).toContain('acceptChangeProposal')
  })

  it('collapses adjacent trace deltas without losing event boundaries', () => {
    const trace = [
      { type: 'reasoning', text: 'First ' },
      { type: 'reasoning', text: 'thought' },
      { type: 'tool-call', toolName: 'inspect', args: { id: 'scene-1' } },
      { type: 'tool-result', toolName: 'inspect', result: { ok: true } },
      { type: 'text', text: 'Done' },
    ] as LibrarianAnalysis['trace']

    expect(collapseLibrarianTrace(trace)).toEqual([
      { kind: 'reasoning', text: 'First thought' },
      { kind: 'tool-call', toolName: 'inspect', args: { id: 'scene-1' } },
      { kind: 'tool-result', toolName: 'inspect', result: { ok: true } },
      { kind: 'text', text: 'Done' },
    ])
  })
})
