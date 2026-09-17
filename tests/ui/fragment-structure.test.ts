import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { segmentFrozenContent } from '@/components/fragments/FragmentContentFields'

function source(path: string) {
  return readFileSync(resolve(path), 'utf8')
}

describe('fragment workspace structure', () => {
  it('keeps the editor focused on orchestration', () => {
    const editor = source('src/components/fragments/FragmentEditor.tsx')
    expect(editor).toContain('FragmentMediaField')
    expect(editor).toContain('FragmentTextField')
    expect(editor).toContain('FragmentVersionHistory')
    expect(editor).toContain('FragmentMetadataPanel')
    expect(editor).toContain('CharacterLiveStatePanel')
    expect(editor.split('\n').length).toBeLessThan(800)
  })

  it('keeps the browser focused on query, filtering, and drag orchestration', () => {
    const list = source('src/components/fragments/FragmentList.tsx')
    expect(list).toContain('FragmentListToolbar')
    expect(list).toContain('FragmentListItem')
    expect(list).toContain('FragmentFolderHeader')
    expect(list.split('\n').length).toBeLessThan(750)
  })

  it('shares fragment identity between browser rows and the editor header', () => {
    expect(source('src/components/fragments/FragmentListItem.tsx')).toContain('FragmentArtwork')
    expect(source('src/components/fragments/FragmentListItem.tsx')).toContain('FragmentMetadata')
    expect(source('src/components/fragments/FragmentEditor.tsx')).toContain('FragmentArtwork')
    expect(source('src/components/fragments/FragmentEditor.tsx')).toContain('FragmentMetadata')
  })

  it('splits editable and frozen text without duplicating overlapping sections', () => {
    expect(segmentFrozenContent('Alpha beta gamma.', [
      { id: 'outer', text: 'Alpha beta' },
      { id: 'nested', text: 'beta' },
      { id: 'tail', text: 'gamma' },
    ])).toEqual([
      { type: 'editable', text: '' },
      { type: 'frozen', id: 'outer', text: 'Alpha beta' },
      { type: 'editable', text: ' ' },
      { type: 'frozen', id: 'tail', text: 'gamma' },
      { type: 'editable', text: '.' },
    ])
    expect(segmentFrozenContent('Nothing frozen', [])).toBeNull()
  })
})
