import { describe, expect, it } from 'vitest'
import { liveStateItemId } from '@/contracts/live-state'
import type { Fragment } from '@/contracts/story'
import { normalizeLiveStateReports } from '@/server/librarian/live-state-report'

describe('live-state report boundary', () => {
  it('gives a copied entry the identity of the entry it copied, number and all', () => {
    const shown = 'The sovereign body is a public utility'
    const { reports } = normalizeLiveStateReports({
      characters: [{
        character: 'Victoria',
        add: [
          { field: 'Knows', text: `[1] ${shown}` },
          { field: 'Knows', text: '[2] [1] A second copy of the same entry' },
          { field: 'Knows', text: '6] A new entry numbered like the list' },
        ],
        set: [{ field: 'Currently', value: '[3] smiling' }],
      }],
    }, [])

    expect(reports[0].add).toEqual([
      { id: liveStateItemId('Knows', shown), field: 'Knows', text: shown },
      { id: liveStateItemId('Knows', 'A second copy of the same entry'), field: 'Knows', text: 'A second copy of the same entry' },
      { id: liveStateItemId('Knows', 'A new entry numbered like the list'), field: 'Knows', text: 'A new entry numbered like the list' },
    ])
    expect(reports[0].set).toEqual([{ field: 'Currently', value: 'smiling' }])
  })

  it('files a value written to a list as an entry, and an entry written to a value as its value', () => {
    const { reports } = normalizeLiveStateReports({
      characters: [{
        character: 'Victoria',
        set: [{ field: 'Secrets', value: 'craves ruin' }],
        add: [{ field: 'Where', text: 'the dais' }],
      }],
    }, [])

    expect(reports[0].set).toEqual([{ field: 'Where', value: 'the dais' }])
    expect(reports[0].add).toEqual([{ id: liveStateItemId('Secrets', 'craves ruin'), field: 'Secrets', text: 'craves ruin' }])
  })

  it('places the roster in the scene apart from the changes, and reads past commentary on a name', () => {
    const catalog = new Map<string, Fragment>([
      ['ch-0001', { id: 'ch-0001', type: 'character', name: 'Victoria' } as Fragment],
      ['ch-0002', { id: 'ch-0002', type: 'character', name: 'Secunda' } as Fragment],
    ])
    const { reports } = normalizeLiveStateReports({
      present: ['ch-0002', 'an onlooker'],
      characters: [{ character: 'Victoria (implied narrator)', set: [{ field: 'Currently', value: 'at the lectern' }] }],
    }, [], catalog)

    expect(reports.map((report) => [report.key, report.present, report.set.length])).toEqual([
      ['ch-0001', true, 1],
      ['ch-0002', true, 0],
      ['an_onlooker', true, 0],
    ])
  })

  it('keeps citations out of entries and a reveal with no one to reveal it to out of the reveals', () => {
    const shown = { index: 1, kind: 'character' as const, subjectKey: 'ch-0001', subjectName: 'Victoria', id: 'k1', field: 'Knows', text: 'x' }
    const { reports } = normalizeLiveStateReports({
      characters: [{ character: 'Victoria', add: [
        { field: 'Knows', text: 'Her body is a perfected machine [36, 39, 46,' },
        { field: 'Knows', text: 'The seal holds [12] as designed' },
      ] }],
      update: [{ item: 1, happened: 'revealed' }],
    }, [shown])

    expect(reports[0].add.map((entry) => entry.text)).toEqual(['Her body is a perfected machine', 'The seal holds as designed'])
    expect(reports[0].update).toEqual([{ id: 'k1', happened: 'resolved' }])
  })
})
