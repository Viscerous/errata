import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, Library, Loader2, LogOut, Plug } from 'lucide-react'
import { api } from '@/lib/api'
import type { ErratanetAccount, ErratanetConfigResponse } from '@/lib/api/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Eyebrow, Hint, MetaLabel } from '@/components/ui/prose-text'

const DEFAULT_HUB = 'https://errata.tealios.com'

export function ErratanetAccountBlock({
  config,
  connected,
  handle,
}: {
  config: ErratanetConfigResponse | undefined
  connected: boolean
  handle: string | undefined
}) {
  const queryClient = useQueryClient()
  const [hubUrl, setHubUrl] = useState('')
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [token, setToken] = useState('')
  const [mode, setMode] = useState<'password' | 'token'>('password')
  const [error, setError] = useState<string | null>(null)
  const hubUrlValue = hubUrl || config?.hubUrl || DEFAULT_HUB
  const registerUrl = `${hubUrlValue.trim().replace(/\/+$/, '')}/register`
  const onError = (cause: unknown) => setError(cause instanceof Error ? cause.message : 'Request failed.')

  const login = useMutation({
    mutationFn: (data: { hubUrl: string; identifier: string; password: string }) => api.erratanet.login(data),
    onSuccess: (account: ErratanetAccount) => {
      queryClient.invalidateQueries({ queryKey: ['erratanet-config'] })
      queryClient.setQueryData(['erratanet-account'], account)
      setPassword('')
      setError(account.connected ? null : account.error ?? 'Could not log in.')
    },
    onError,
  })
  const connect = useMutation({
    mutationFn: async (data: { hubUrl: string; token: string }) => ({
      config: await api.erratanet.setConfig(data),
      account: await api.erratanet.getAccount(),
    }),
    onSuccess: ({ config: nextConfig, account }: { config: ErratanetConfigResponse; account: ErratanetAccount }) => {
      queryClient.setQueryData(['erratanet-config'], nextConfig)
      queryClient.setQueryData(['erratanet-account'], account)
      setToken('')
      setError(account.connected ? null : account.error ?? 'Could not verify the token.')
    },
    onError,
  })
  const disconnect = useMutation({
    mutationFn: () => api.erratanet.setConfig({ token: '' }),
    onSuccess: (nextConfig: ErratanetConfigResponse) => {
      queryClient.setQueryData(['erratanet-config'], nextConfig)
      queryClient.setQueryData(['erratanet-account'], { connected: false } satisfies ErratanetAccount)
      setToken('')
      setPassword('')
      setError(null)
    },
    onError,
  })
  const busy = login.isPending || connect.isPending || disconnect.isPending

  if (connected) {
    return (
      <section>
        <Eyebrow asChild><h3 className="mb-2.5">Account</h3></Eyebrow>
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary"><Library className="size-3.5" /></span>
          <div className="min-w-0 flex-1">
            <p className="font-mono text-ui-body text-foreground">@{handle ?? 'account'}</p>
            <MetaLabel asChild><p className="truncate font-mono">{config?.hubUrl}</p></MetaLabel>
          </div>
          <Button variant="ghost" size="sm" className="h-7 shrink-0 gap-1.5 px-2 text-ui-caption text-muted-foreground hover:text-destructive" disabled={busy} onClick={() => disconnect.mutate()}>
            {disconnect.isPending ? <Loader2 className="size-3 animate-spin" /> : <LogOut className="size-3" />}
            Sign out
          </Button>
        </div>
      </section>
    )
  }

  const submitLogin = () => {
    const url = hubUrlValue.trim()
    if (!url) return setError('Enter a hub URL.')
    if (!identifier.trim()) return setError('Enter your username or email.')
    if (!password) return setError('Enter your password.')
    setError(null)
    login.mutate({ hubUrl: url, identifier: identifier.trim(), password })
  }
  const submitToken = () => {
    const url = hubUrlValue.trim()
    if (!url) return setError('Enter a hub URL.')
    if (!token.trim()) return setError('Enter an access token.')
    setError(null)
    connect.mutate({ hubUrl: url, token: token.trim() })
  }

  return (
    <section>
      <Eyebrow asChild><h3 className="mb-2.5">Account</h3></Eyebrow>
      <Hint className="mb-3 leading-snug">Sign in to publish your stories and packs to the hub.</Hint>
      <div className="space-y-2">
        <Input value={hubUrlValue} onChange={(event) => setHubUrl(event.target.value)} placeholder="Hub URL" aria-label="ErrataNet hub URL" autoComplete="off" spellCheck={false} className="h-9 font-mono text-ui-body" />
        {mode === 'password' ? (
          <>
            <Input value={identifier} onChange={(event) => setIdentifier(event.target.value)} placeholder="Username or email" aria-label="ErrataNet username or email" autoComplete="username" autoCapitalize="none" spellCheck={false} className="h-9" />
            <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') submitLogin() }} placeholder="Password" aria-label="ErrataNet password" autoComplete="current-password" className="h-9" />
            <Button className="w-full gap-2" disabled={busy || !hubUrlValue.trim() || !identifier.trim() || !password} onClick={submitLogin}>{login.isPending ? <Loader2 className="size-4 animate-spin" /> : <Plug className="size-4" />}Log in</Button>
            <ModeLinks registerUrl={registerUrl} onChange={() => { setMode('token'); setError(null) }} />
          </>
        ) : (
          <>
            <Input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="Access token (ern_…)" aria-label="ErrataNet access token" autoComplete="new-password" className="h-9 font-mono text-ui-body" />
            <Button className="w-full gap-2" disabled={busy || !hubUrlValue.trim() || !token.trim()} onClick={submitToken}>{connect.isPending ? <Loader2 className="size-4 animate-spin" /> : <Plug className="size-4" />}Connect</Button>
            <Hint className="pt-0.5"><button type="button" className="underline-offset-2 hover:text-foreground hover:underline" onClick={() => { setMode('password'); setError(null) }}>Log in with a password instead</button></Hint>
          </>
        )}
        {error && <Hint className="pt-0.5 leading-snug text-destructive">{error}</Hint>}
      </div>
    </section>
  )
}

function ModeLinks({ registerUrl, onChange }: { registerUrl: string; onChange: () => void }) {
  return (
    <Hint className="pt-0.5">
      <a href={registerUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline-offset-2 hover:text-foreground hover:underline">Create an account<ExternalLink className="size-3" /></a>
      <span className="px-1.5 text-border">·</span>
      <button type="button" className="underline-offset-2 hover:text-foreground hover:underline" onClick={onChange}>Use a token</button>
    </Hint>
  )
}
