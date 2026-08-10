import { describe, expect, it } from 'vitest'
import { proxyBlockReason } from '@/server/sharing/policy'

describe('sharing proxy policy', () => {
  it('forwards ordinary writing traffic', () => {
    expect(proxyBlockReason('GET', '/api/stories')).toBeNull()
    expect(proxyBlockReason('POST', '/api/stories/s1/fragments')).toBeNull()
    expect(proxyBlockReason('DELETE', '/api/stories/s1/fragments/fr-1')).toBeNull()
    expect(proxyBlockReason('GET', '/')).toBeNull()
  })

  it('forwards masked credential reads so the settings page still renders', () => {
    expect(proxyBlockReason('GET', '/api/config/providers')).toBeNull()
    expect(proxyBlockReason('GET', '/api/config/providers/prov-1/models')).toBeNull()
    expect(proxyBlockReason('GET', '/api/erratanet/config')).toBeNull()
  })

  it('refuses every write under /api/config', () => {
    expect(proxyBlockReason('POST', '/api/config/providers')).not.toBeNull()
    expect(proxyBlockReason('PUT', '/api/config/providers/prov-1')).not.toBeNull()
    expect(proxyBlockReason('DELETE', '/api/config/providers/prov-1')).not.toBeNull()
    expect(proxyBlockReason('PATCH', '/api/config/default-provider')).not.toBeNull()
    expect(proxyBlockReason('POST', '/api/config/test-connection')).not.toBeNull()
    expect(proxyBlockReason('POST', '/api/config/openrouter/oauth/exchange')).not.toBeNull()
  })

  it('refuses test-models, which would otherwise make the host issue arbitrary outbound requests', () => {
    expect(proxyBlockReason('POST', '/api/config/test-models')).not.toBeNull()
  })

  it('refuses sharing changes, so a remote client cannot rotate the password gating it', () => {
    expect(proxyBlockReason('POST', '/api/sharing/auth')).not.toBeNull()
    expect(proxyBlockReason('POST', '/api/sharing/lan')).not.toBeNull()
    expect(proxyBlockReason('POST', '/api/sharing/tunnel')).not.toBeNull()
    // The panel still needs to render its status.
    expect(proxyBlockReason('GET', '/api/sharing/status')).toBeNull()
  })

  it('refuses hub token writes but not pack browsing', () => {
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

  it('does not blow up on a malformed target', () => {
    expect(proxyBlockReason('GET', undefined)).toBeNull()
    expect(proxyBlockReason('GET', '%%%')).toBeNull()
  })
})
