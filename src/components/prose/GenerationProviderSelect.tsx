import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { SettingsSelect } from '@/components/settings/primitives'

export function GenerationProviderSelect({
  storyId,
  disabled,
  className,
  componentId = 'generation-provider-select',
}: {
  storyId: string
  disabled?: boolean
  className?: string
  componentId?: string
}) {
  const queryClient = useQueryClient()
  const { data: story } = useQuery({
    queryKey: ['story', storyId],
    queryFn: () => api.stories.get(storyId),
  })
  const { data: config } = useQuery({
    queryKey: ['global-config'],
    queryFn: () => api.config.getProviders(),
  })
  const updateProvider = useMutation({
    mutationFn: (providerId: string | null) => {
      const overrides = story?.settings.modelOverrides ?? {}
      return api.settings.update(storyId, {
        modelOverrides: { ...overrides, generation: { providerId, modelId: null } },
      })
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['story', storyId] }),
  })

  if (!config) return null

  const providers = config.providers.filter(provider => provider.enabled)
  const defaultProvider = config.defaultProviderId
    ? providers.find(provider => provider.id === config.defaultProviderId)
    : null
  const selectedProviderId = story?.settings.modelOverrides?.generation?.providerId ?? ''
  const selectedProvider = selectedProviderId
    ? providers.find(provider => provider.id === selectedProviderId)
    : defaultProvider

  return (
    <SettingsSelect
      data-component-id={componentId}
      name="generation-provider"
      aria-label="Generation model"
      value={selectedProviderId}
      onChange={(value) => updateProvider.mutate(value || null)}
      disabled={disabled || updateProvider.isPending}
      title={selectedProvider?.defaultModel}
      className={cn(
        'max-w-[180px] cursor-pointer appearance-none truncate py-1 pl-2 pr-5 font-sans text-ui-caption text-foreground/70',
        'hover:border-border/60 disabled:cursor-default disabled:opacity-30',
        className,
      )}
      style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='8' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2.5' stroke-linecap='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 6px center' }}
    >
      <option value="">{defaultProvider?.defaultModel ?? 'No provider'}</option>
      {providers
        .filter(provider => provider.id !== config.defaultProviderId)
        .map(provider => <option key={provider.id} value={provider.id}>{provider.defaultModel}</option>)}
    </SettingsSelect>
  )
}
