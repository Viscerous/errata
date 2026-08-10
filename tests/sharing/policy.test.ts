import { describe, expect, it } from 'vitest'
import { proxyBlockReason } from '@/server/sharing/policy'

describe('sharing proxy policy', () => {
  it('forwards the app shell and its assets', () => {
    expect(proxyBlockReason('GET', '/')).toBeNull()
    expect(proxyBlockReason('GET', '/assets/index-a1b2.js')).toBeNull()
    expect(proxyBlockReason('GET', '/favicon.ico')).toBeNull()
    expect(proxyBlockReason('GET', '/stories/s1')).toBeNull()
  })

  it('forwards ordinary writing traffic', () => {
    expect(proxyBlockReason('GET', '/api/health')).toBeNull()
    expect(proxyBlockReason('GET', '/api/stories')).toBeNull()
    expect(proxyBlockReason('POST', '/api/stories/s1/fragments')).toBeNull()
    expect(proxyBlockReason('DELETE', '/api/stories/s1/fragments/fr-1')).toBeNull()
    expect(proxyBlockReason('PUT', '/api/agent-blocks/writer')).toBeNull()
    expect(proxyBlockReason('PATCH', '/api/model-roles')).toBeNull()
    expect(proxyBlockReason('GET', '/api/plugins')).toBeNull()
    expect(proxyBlockReason('POST', '/api/plugins/my-plugin/do-thing')).toBeNull()
  })

  it('refuses an unlisted route rather than forwarding it', () => {
    // The point of the inversion: a route added later is closed until listed,
    // instead of being exposed the moment someone writes it.
    expect(proxyBlockReason('GET', '/api/some-future-area')).not.toBeNull()
    expect(proxyBlockReason('POST', '/api/billing/charge')).not.toBeNull()
    expect(proxyBlockReason('GET', '/api')).not.toBeNull()
  })

  it('forwards masked credential reads so the settings page still renders', () => {
    expect(proxyBlockReason('GET', '/api/config/providers')).toBeNull()
    expect(proxyBlockReason('GET', '/api/config/providers/prov-1/models')).toBeNull()
    expect(proxyBlockReason('GET', '/api/sharing/status')).toBeNull()
    expect(proxyBlockReason('GET', '/api/erratanet/config')).toBeNull()
  })

  it('refuses every write under /api/config', () => {
    expect(proxyBlockReason('POST', '/api/config/providers')).not.toBeNull()
    expect(proxyBlockReason('PUT', '/api/config/providers/prov-1')).not.toBeNull()
    expect(proxyBlockReason('DELETE', '/api/config/providers/prov-1')).not.toBeNull()
    expect(proxyBlockReason('PATCH', '/api/config/default-provider')).not.toBeNull()
    expect(proxyBlockReason('POST', '/api/config/providers/prov-1/test-connection')).not.toBeNull()
    expect(proxyBlockReason('POST', '/api/config/test-connection')).not.toBeNull()
    expect(proxyBlockReason('POST', '/api/config/test-models')).not.toBeNull()
    expect(proxyBlockReason('POST', '/api/config/openrouter/oauth/exchange')).not.toBeNull()
  })

  it('refuses sharing changes, so a remote client cannot rotate the password gating it', () => {
    expect(proxyBlockReason('POST', '/api/sharing/auth')).not.toBeNull()
    expect(proxyBlockReason('POST', '/api/sharing/lan')).not.toBeNull()
    expect(proxyBlockReason('POST', '/api/sharing/tunnel')).not.toBeNull()
  })

  it('refuses hub credential paths but not pack browsing', () => {
    expect(proxyBlockReason('POST', '/api/erratanet/config')).not.toBeNull()
    expect(proxyBlockReason('POST', '/api/erratanet/login')).not.toBeNull()
    expect(proxyBlockReason('GET', '/api/erratanet/login')).not.toBeNull()
    expect(proxyBlockReason('GET', '/api/erratanet/packs')).toBeNull()
    expect(proxyBlockReason('POST', '/api/erratanet/packs/p1/install')).toBeNull()
  })

  it('matches on the path the upstream router will see, not the raw one', () => {
    expect(proxyBlockReason('POST', '/api/config/test-connection?x=1')).not.toBeNull()
    expect(proxyBlockReason('POST', '/api/config/providers/')).not.toBeNull()
    // Dot segments, plain and percent-encoded, must not walk back into /api/config.
    expect(proxyBlockReason('POST', '/api/stories/../config/test-connection')).not.toBeNull()
    expect(proxyBlockReason('POST', '/api/stories/%2e%2e/config/test-connection')).not.toBeNull()
  })

  it('does not treat a lookalike prefix as the area it resembles', () => {
    expect(proxyBlockReason('GET', '/api/storiesX')).not.toBeNull()
    expect(proxyBlockReason('POST', '/api/config-export')).not.toBeNull()
  })

  it('does not blow up on a malformed target', () => {
    // Neither resolves to anything under /api, so both fall through to the app
    // shell and the upstream answers them. Nothing credential-bearing is reachable.
    expect(proxyBlockReason('GET', undefined)).toBeNull()
    expect(proxyBlockReason('GET', '%%%')).toBeNull()
  })
})
