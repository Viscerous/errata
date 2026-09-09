import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { SharingStatusResponse } from '@/lib/api/types'
import { cn } from '@/lib/utils'
import { copyText } from '@/lib/clipboard'
import { Lock, Wifi, Globe, Loader2, Copy, Check, AlertTriangle, ShieldCheck } from 'lucide-react'
import { SectionHeading, SettingsCard, Toggle } from './primitives'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { MetaLabel } from '@/components/ui/prose-text'

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      onClick={async () => {
        if (!await copyText(value)) return
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      }}
      aria-label="Copy link"
    >
      {copied ? <Check className="size-3.5 text-primary" /> : <Copy className="size-3.5" />}
    </Button>
  )
}

function ConnectionCard({ icon, label, url, qr }: { icon: React.ReactNode; label: string; url: string; qr: string | null }) {
  return (
    <div className="space-y-2 rounded-md border border-border/30 bg-elevated/60 p-3">
      <div className="flex items-center gap-2">
        <span className="text-primary/70">{icon}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-ui-caption text-foreground/80">{url}</span>
        <CopyButton value={url} />
      </div>
      {qr && (
        <div className="flex justify-center pt-1">
          <img src={qr} alt={`${label} QR code`} className="size-40 rounded-md bg-white p-1.5" />
        </div>
      )}
    </div>
  )
}

export function SharingPanel() {
  const qc = useQueryClient()
  const { data: status } = useQuery({
    queryKey: ['sharing-status'],
    queryFn: () => api.sharing.getStatus(),
    refetchInterval: (q) => {
      const s = q.state.data as SharingStatusResponse | undefined
      return s && (s.tunnel.status === 'downloading' || s.tunnel.status === 'starting') ? 1500 : false
    },
  })

  const [username, setUsername] = useState('errata')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)

  const onSettled = (next: SharingStatusResponse) => { qc.setQueryData(['sharing-status'], next); setError(null) }
  const onError = (e: unknown) => setError(e instanceof Error ? e.message : 'Request failed')

  const authMut = useMutation({
    mutationFn: (data: { enabled: boolean; username?: string; password?: string }) => api.sharing.setAuth(data),
    onSuccess: (d) => { onSettled(d); setPassword('') },
    onError,
  })
  const lanMut = useMutation({ mutationFn: (en: boolean) => api.sharing.setLan(en), onSuccess: onSettled, onError })
  const tunnelMut = useMutation({ mutationFn: (en: boolean) => api.sharing.setTunnel(en), onSuccess: onSettled, onError })

  const authOn = status?.authEnabled ?? false
  const canExpose = authOn && (status?.hasPassword ?? false)
  const busy = authMut.isPending || lanMut.isPending || tunnelMut.isPending

  const tunnelStatusLabel = (() => {
    switch (status?.tunnel.status) {
      case 'downloading': return 'Downloading cloudflared…'
      case 'starting': return 'Starting tunnel…'
      case 'running': return null
      case 'error': return status.tunnel.error || 'Tunnel error'
      default: return null
    }
  })()

  return (
    <div>
      <SectionHeading label="Remote" />
      <SettingsCard className="space-y-3 divide-y-0 p-3">
        {/* Authentication */}
        <div className="space-y-2">
          <div className="flex items-start gap-2">
            <Lock className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="text-ui-body font-medium text-foreground/85">Require a password</p>
              <MetaLabel asChild><p className="leading-snug">
                Protects the app with Basic Auth. Required before exposing it to the network.
              </p></MetaLabel>
            </div>
            {authOn && (
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => authMut.mutate({ enabled: false })}
                disabled={busy}
                className="text-destructive"
              >
                Disable
              </Button>
            )}
          </div>

          {authOn ? (
            <div className="flex items-center gap-1.5 pl-6 text-ui-caption text-primary">
              <ShieldCheck className="size-3.5" />
              <span>On, user <span className="font-mono">{status?.username}</span></span>
            </div>
          ) : (
            <div className="space-y-1.5 pl-6">
              <Input className="h-8 bg-elevated text-ui-body" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username" autoComplete="off" />
              <Input className="h-8 bg-elevated text-ui-body" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" autoComplete="new-password" />
              <Button
                type="button"
                size="xs"
                onClick={() => { if (!password.trim()) { setError('Enter a password.'); return } authMut.mutate({ enabled: true, username: username.trim() || 'errata', password }) }}
                disabled={busy || !password.trim()}
              >
                {authMut.isPending ? <Loader2 className="size-3 animate-spin" /> : <Lock className="size-3" />}
                Enable
              </Button>
            </div>
          )}
        </div>

        <div className="h-px bg-border/20" />

        {/* Local network */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Wifi className="size-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="text-ui-body font-medium text-foreground/85">Local network</p>
              <MetaLabel asChild><p className="leading-snug">Reach Errata from other devices on your Wi-Fi.</p></MetaLabel>
            </div>
            <Toggle checked={status?.lan.enabled ?? false} disabled={!canExpose || busy} onChange={(next) => lanMut.mutate(next)} label="Toggle local network" />
          </div>
          {status?.lan.enabled && status.lan.url && (
            <ConnectionCard icon={<Wifi className="size-3.5" />} label="LAN" url={status.lan.url} qr={status.lanQr} />
          )}
        </div>

        <div className="h-px bg-border/20" />

        {/* Internet tunnel */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Globe className="size-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="text-ui-body font-medium text-foreground/85">Internet (Cloudflare Tunnel)</p>
              <MetaLabel asChild><p className="leading-snug">A temporary public HTTPS link. cloudflared downloads automatically.</p></MetaLabel>
            </div>
            <Toggle checked={status?.tunnel.enabled ?? false} disabled={!canExpose || busy} onChange={(next) => tunnelMut.mutate(next)} label="Toggle tunnel" />
          </div>
          {status?.tunnel.enabled && tunnelStatusLabel && (
            <div className={cn('flex items-center gap-1.5 pl-6 text-ui-caption', status.tunnel.status === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
              {status.tunnel.status === 'error' ? <AlertTriangle className="size-3.5" /> : <Loader2 className="size-3.5 animate-spin" />}
              {tunnelStatusLabel}
            </div>
          )}
          {status?.tunnel.status === 'running' && status.tunnel.url && (
            <ConnectionCard icon={<Globe className="size-3.5" />} label="Tunnel" url={status.tunnel.url} qr={status.tunnelQr} />
          )}
        </div>

        {!canExpose && (
          <MetaLabel asChild><p className="leading-snug">Set a password above to enable network sharing.</p></MetaLabel>
        )}
        {canExpose && (status?.lan.enabled) && (
          <MetaLabel asChild><p className="flex items-start gap-1.5 leading-snug">
            <AlertTriangle className="mt-px size-3 shrink-0 text-amber-500/70" />
            Local-network access is plain HTTP. The password is sent unencrypted on your LAN; the tunnel is HTTPS.
          </p></MetaLabel>
        )}
        {error && <MetaLabel asChild><p className="text-destructive">{error}</p></MetaLabel>}
      </SettingsCard>
    </div>
  )
}
