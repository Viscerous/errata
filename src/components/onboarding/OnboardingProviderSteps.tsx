import { useQuery } from '@tanstack/react-query'
import { Server } from 'lucide-react'
import { api } from '@/lib/api'
import { Caption, Hint, MetaLabel } from '@/components/ui/prose-text'
import { Wizard } from '@/components/ui/wizard'
import { providerPresetEntries, type PresetId } from '@/contracts/providers'

export type PresetKey = PresetId

export const ACCENT_COLORS: Record<string, { border: string; bg: string; text: string }> = {
  blue: { border: 'border-blue-500/30', bg: 'bg-blue-500/10', text: 'text-blue-400' },
  emerald: { border: 'border-emerald-500/30', bg: 'bg-emerald-500/10', text: 'text-emerald-400' },
  amber: { border: 'border-amber-500/30', bg: 'bg-amber-500/10', text: 'text-amber-400' },
  cyan: { border: 'border-cyan-500/30', bg: 'bg-cyan-500/10', text: 'text-cyan-400' },
  rose: { border: 'border-rose-500/30', bg: 'bg-rose-500/10', text: 'text-rose-400' },
  purple: { border: 'border-purple-500/30', bg: 'bg-purple-500/10', text: 'text-purple-400' },
  indigo: { border: 'border-indigo-500/30', bg: 'bg-indigo-500/10', text: 'text-indigo-400' },
  neutral: { border: 'border-border/50', bg: 'bg-muted/30', text: 'text-muted-foreground' },
}

export function ProviderSelectStep({
  onSelect,
  onBack,
}: {
  onSelect: (preset: PresetKey) => void
  onBack: () => void
}) {
  const discovery = useQuery({
    queryKey: ['provider-discovery'],
    queryFn: () => api.config.discoverLocal(),
    staleTime: 10_000,
  })
  const found = new Map(
    (discovery.data?.providers ?? [])
      .filter(provider => provider.status === 'available')
      .map(provider => [provider.preset, provider]),
  )
  const cards = providerPresetEntries()
    .filter(([id, card]) => card.kind !== 'local' || found.has(id))
    .sort(([leftId], [rightId]) => Number(found.has(rightId)) - Number(found.has(leftId)))

  return (
    <div className="max-w-2xl mx-auto px-6">
      <div className="text-center mb-8 animate-onboarding-fade-up">
        <h2 className="font-display text-3xl italic mb-2">Choose your provider</h2>
        <Caption size="sm">
          Pick an LLM provider to power your writing. You can always add more later.
        </Caption>
        {discovery.isFetching && (
          <Hint className="mt-2">Checking for local model servers…</Hint>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {cards.map(([key, card], i) => {
          const accent = ACCENT_COLORS[card.accent]
          return (
            <button
              key={key}
              type="button"
              onClick={() => onSelect(key)}
              className={`relative text-left p-5 rounded-xl border border-border/30 bg-card/30 hover:border-border/60 hover:bg-card/80 hover:shadow-md hover:-translate-y-0.5 transition-all duration-200 cursor-pointer animate-onboarding-fade-up group`}
              style={{ animationDelay: `${100 + i * 80}ms` }}
            >
              {/* Accent strip */}
              <div className={`absolute top-0 left-4 right-4 h-0.5 rounded-b ${accent.bg}`} />

              <div className="flex items-start gap-3">
                <div
                  className={`size-9 rounded-lg ${accent.bg} flex items-center justify-center shrink-0`}
                >
                  <Server className={`size-4 ${accent.text}`} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium">{card.name}</span>
                    {found.has(key) && (
                      <MetaLabel className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-emerald-500">
                        found locally
                      </MetaLabel>
                    )}
                    {card.defaultModel && (
                      <MetaLabel className="rounded-full bg-muted/50 px-1.5 py-0.5">
                        {card.defaultModel}
                      </MetaLabel>
                    )}
                  </div>
                  <Hint className="leading-relaxed">
                    {found.get(key)?.models.length
                      ? `${found.get(key)!.models.length} model${found.get(key)!.models.length === 1 ? '' : 's'} available. ${card.description}`
                      : card.description}
                  </Hint>
                </div>
              </div>
            </button>
          )
        })}
      </div>

      <div
        className="flex items-center justify-center mt-8 animate-onboarding-fade-up"
        style={{ animationDelay: '500ms' }}
      >
        <Wizard.BackButton tone="link" onBack={onBack} />
      </div>
    </div>
  )
}
