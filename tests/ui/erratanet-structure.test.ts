import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parsePackRef } from '@/components/erratanet/ErratanetBrowserPanel'

function source(path: string) {
  return readFileSync(resolve(path), 'utf8')
}

describe('ErrataNet workspace structure', () => {
  it('shares publishing identity, release, account, and success surfaces', () => {
    const publish = source('src/components/erratanet/PublishPackDialog.tsx')
    const share = source('src/components/erratanet/ShareAgentConfigDialog.tsx')
    for (const component of ['ErratanetIdentityFields', 'ErratanetReleaseFields', 'ErratanetPublishSuccess']) {
      expect(publish).toContain(component)
      expect(share).toContain(component)
    }
    expect(source('src/components/erratanet/ErratanetPanel.tsx')).toContain('ErratanetAccountBlock')
    expect(source('src/components/erratanet/ErratanetPublishFields.tsx')).toContain('ERRATANET_LICENSES')
  })

  it('keeps the browser focused on search and install orchestration', () => {
    const browser = source('src/components/erratanet/ErratanetBrowserPanel.tsx')
    expect(browser).toContain('ErratanetResultRow')
    expect(browser).toContain('ErratanetPackDetailView')
    expect(browser.split('\n').length).toBeLessThan(350)
    expect(source('src/components/erratanet/ErratanetPanel.tsx').split('\n').length).toBeLessThan(250)
  })

  it('parses direct pack references without confusing the leading handle marker for a version', () => {
    expect(parsePackRef('@writer/cozy-pack')).toEqual({ id: '@writer/cozy-pack', version: undefined })
    expect(parsePackRef('@writer/cozy-pack@1.2.3')).toEqual({ id: '@writer/cozy-pack', version: '1.2.3' })
    expect(parsePackRef('https://hub.example/packs/@writer/cozy-pack?version=2.0.0')).toEqual({ id: '@writer/cozy-pack', version: '2.0.0' })
    expect(parsePackRef('not-a-pack')).toBeNull()
  })
})
