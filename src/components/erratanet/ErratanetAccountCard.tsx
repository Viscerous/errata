import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { ErratanetConfigResponse, ErratanetAccount } from '@/lib/api/types'
import { Library, Loader2, Plug, ShieldCheck, AlertTriangle, LogOut, Search } from 'lucide-react'
import { ErratanetBrowserPanel } from './ErratanetBrowserPanel'

const inputClass =
  'h-[28px] w-full rounded-md border border-border/40 bg-background px-2 text-[0.75rem] text-foreground focus:border-foreground/20 focus:outline-none'

/**
 * ErratanetAccountCard: hub connection settings, styled like the Remote
 * SharingPanel card. Lets the user point at a hub URL, paste a token, and test
 * the connection. When connected it shows the resolved @handle with a masked
 * token and a Disconnect affordance (which clears the token server-side).
 */
export function ErratanetAccountCard({ storyId }: { storyId?: string }) {
  const qc = useQueryClient()
  const [browseOpen, setBrowseOpen] = useState(false)

  const { data: config } = useQuery({
    queryKey: ['erratanet-config'],
    queryFn: () => api.erratanet.getConfig(),
  })

  // Resolve the account whenever a token is configured, so a previously
  // connected hub shows its @handle on load.
  const { data: account } = useQuery({
    queryKey: ['erratanet-account'],
    queryFn: () => api.erratanet.getAccount(),
    enabled: !!config?.token,
  })

  const connected = !!config?.token && !!account?.connected
  const resolvedHandle = account?.handle ?? config?.handle

  const [hubUrl, setHubUrl] = useState('')
  const [token, setToken] = useState('')
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [mode, setMode] = useState<'password' | 'token'>('password')
  const [error, setError] = useState<string | null>(null)

  // The hub URL field is seeded from config but stays editable.
  const hubUrlValue = hubUrl || config?.hubUrl || ''

  const onError = (e: unknown) => setError(e instanceof Error ? e.message : 'Request failed')

  const connectMut = useMutation({
    mutationFn: async (data: { hubUrl: string; token: string }) => {
      const cfg = await api.erratanet.setConfig(data)
      const acct = await api.erratanet.getAccount()
      return { cfg, acct }
    },
    onSuccess: ({ cfg, acct }: { cfg: ErratanetConfigResponse; acct: ErratanetAccount }) => {
      qc.setQueryData(['erratanet-config'], cfg)
      qc.setQueryData(['erratanet-account'], acct)
      setToken('')
      setError(acct.connected ? null : acct.error ?? 'Could not verify the connection.')
    },
    onError,
  })

  const loginMut = useMutation({
    mutationFn: (data: { hubUrl: string; identifier: string; password: string }) =>
      api.erratanet.login(data),
    onSuccess: (acct: ErratanetAccount) => {
      qc.invalidateQueries({ queryKey: ['erratanet-config'] })
      qc.setQueryData(['erratanet-account'], acct)
      setPassword('')
      setError(acct.connected ? null : acct.error ?? 'Could not log in.')
    },
    onError,
  })

  const disconnectMut = useMutation({
    mutationFn: () => api.erratanet.setConfig({ token: '' }),
    onSuccess: (cfg: ErratanetConfigResponse) => {
      qc.setQueryData(['erratanet-config'], cfg)
      qc.setQueryData(['erratanet-account'], { connected: false } satisfies ErratanetAccount)
      setToken('')
      setError(null)
    },
    onError,
  })

  const busy = connectMut.isPending || disconnectMut.isPending || loginMut.isPending

  return (
    <>
    <div>
      <label className="mb-2 block text-[0.625rem] uppercase tracking-wider text-muted-foreground">
        Erratanet hub
      </label>
      <div className="space-y-3 rounded-lg border border-border/30 p-3">
        <div className="flex items-start gap-2">
          <Library className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="text-[0.75rem] font-medium text-foreground/80">Connect to a pack hub</p>
            <p className="text-[0.625rem] leading-snug text-muted-foreground">
              Browse, install, and publish fragment packs from an erratanet hub.
            </p>
          </div>
          {connected && (
            <button
              onClick={() => disconnectMut.mutate()}
              disabled={busy}
              className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border/40 px-2 py-1 text-[0.625rem] text-muted-foreground transition-colors hover:border-destructive/40 hover:text-destructive disabled:opacity-40"
            >
              {disconnectMut.isPending ? <Loader2 className="size-3 animate-spin" /> : <LogOut className="size-3" />}
              Disconnect
            </button>
          )}
        </div>

        {connected ? (
          <div className="space-y-1.5 pl-6">
            <div className="flex items-center gap-1.5 text-[0.6875rem] text-primary">
              <ShieldCheck className="size-3.5" />
              <span>
                Connected as{' '}
                <span className="font-mono">@{resolvedHandle ?? 'account'}</span>
              </span>
            </div>
            <p className="font-mono text-[0.625rem] text-muted-foreground">
              {config?.hubUrl}
            </p>
            <p className="text-[0.625rem] text-muted-foreground">Token saved and hidden.</p>
            <button
              onClick={() => setBrowseOpen(true)}
              className="mt-1 inline-flex items-center gap-1.5 rounded-md bg-foreground px-2.5 py-1 text-[0.6875rem] font-medium text-background transition-opacity hover:opacity-90"
            >
              <Search className="size-3" />
              Browse packs
            </button>
          </div>
        ) : (
          <div className="space-y-1.5 pl-6">
            <input
              className={inputClass}
              value={hubUrlValue}
              onChange={(e) => setHubUrl(e.target.value)}
              placeholder="Hub URL (https://errata.tealios.com)"
              autoComplete="off"
              spellCheck={false}
            />

            {mode === 'password' ? (
              <>
                <input
                  className={inputClass}
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  placeholder="Username or email"
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                />
                <input
                  className={inputClass}
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Password"
                  autoComplete="current-password"
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return
                    const url = hubUrlValue.trim()
                    if (!url || !identifier.trim() || !password) return
                    setError(null)
                    loginMut.mutate({ hubUrl: url, identifier: identifier.trim(), password })
                  }}
                />
                <button
                  onClick={() => {
                    const url = hubUrlValue.trim()
                    if (!url) { setError('Enter a hub URL.'); return }
                    if (!identifier.trim()) { setError('Enter your username or email.'); return }
                    if (!password) { setError('Enter your password.'); return }
                    setError(null)
                    loginMut.mutate({ hubUrl: url, identifier: identifier.trim(), password })
                  }}
                  disabled={busy || !hubUrlValue.trim() || !identifier.trim() || !password}
                  className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-2.5 py-1 text-[0.6875rem] font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-40"
                >
                  {loginMut.isPending ? <Loader2 className="size-3 animate-spin" /> : <Plug className="size-3" />}
                  Log in
                </button>
                <p className="text-[0.625rem] leading-snug text-muted-foreground">
                  No account?{' '}
                  <a
                    href={`${hubUrlValue.trim().replace(/\/+$/, '')}/register`}
                    target="_blank"
                    rel="noreferrer"
                    className="underline hover:text-foreground"
                  >
                    Create one
                  </a>
                  {'  ·  '}
                  <button onClick={() => { setMode('token'); setError(null) }} className="underline hover:text-foreground">
                    Use a token
                  </button>
                </p>
              </>
            ) : (
              <>
                <input
                  className={inputClass}
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="Access token (ern_…)"
                  autoComplete="new-password"
                />
                <button
                  onClick={() => {
                    const url = hubUrlValue.trim()
                    if (!url) { setError('Enter a hub URL.'); return }
                    if (!token.trim()) { setError('Enter an access token.'); return }
                    setError(null)
                    connectMut.mutate({ hubUrl: url, token: token.trim() })
                  }}
                  disabled={busy || !hubUrlValue.trim() || !token.trim()}
                  className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-2.5 py-1 text-[0.6875rem] font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-40"
                >
                  {connectMut.isPending ? <Loader2 className="size-3 animate-spin" /> : <Plug className="size-3" />}
                  Connect
                </button>
                <p className="text-[0.625rem] text-muted-foreground">
                  <button onClick={() => { setMode('password'); setError(null) }} className="underline hover:text-foreground">
                    Log in with a password instead
                  </button>
                </p>
              </>
            )}
          </div>
        )}

        {error && (
          <p className="flex items-start gap-1.5 pl-6 text-[0.625rem] leading-snug text-destructive">
            <AlertTriangle className="mt-px size-3 shrink-0" />
            {error}
          </p>
        )}
      </div>
    </div>
    {browseOpen && createPortal(
      <div className="fixed inset-0 z-[60] bg-background" data-component-id="erratanet-browser-overlay">
        <ErratanetBrowserPanel storyId={storyId} onClose={() => setBrowseOpen(false)} />
      </div>,
      document.body,
    )}
    </>
  )
}
