import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '@/lib/api'
import { modelOptionLabel } from '@/lib/model-capabilities'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SettingsSelect } from './primitives'

interface ModelSelectProps {
  providerId: string | null
  value: string | null
  onChange: (modelId: string | null) => void
  disabled?: boolean
  defaultLabel?: string
}

export function ModelSelect({ providerId, value, onChange, disabled, defaultLabel = 'Default' }: ModelSelectProps) {
  const [manualEntry, setManualEntry] = useState(false)

  const { data, isLoading } = useQuery({
    queryKey: ['provider-models', providerId],
    queryFn: () => api.config.listModels(providerId!),
    enabled: !!providerId,
    staleTime: 5 * 60 * 1000,
    retry: 1,
  })

  const models = data?.models ?? []
  const hasModels = models.length > 0
  const fetchFailed = !!data?.error && !hasModels

  // If no provider, show disabled placeholder
  if (!providerId) {
    return (
      <SettingsSelect
        value=""
        onChange={() => {}}
        disabled
        className="w-full max-w-[140px] text-muted-foreground"
      >
        <option>No provider</option>
      </SettingsSelect>
    )
  }

  // Manual text input mode (for when model list can't be fetched)
  if (manualEntry || (fetchFailed && !isLoading)) {
    return (
      <div className="flex items-center gap-1">
        <Input
          type="text"
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value || null)}
          placeholder="model-id"
          className="h-7 w-full max-w-[120px] bg-elevated px-2 font-mono text-ui-caption md:text-ui-caption"
          disabled={disabled}
        />
        {hasModels && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => setManualEntry(false)}
            className="px-1.5 text-ui-label text-muted-foreground"
            title="Switch to dropdown"
          >
            list
          </Button>
        )}
      </div>
    )
  }

  return (
    <div className="flex items-center gap-1">
      <SettingsSelect
        value={value ?? ''}
        onChange={(next) => onChange(next || null)}
        className="w-full max-w-[140px] truncate"
        disabled={disabled || isLoading}
      >
        <option value="">{isLoading ? 'Loading\u2026' : defaultLabel}</option>
        {models.map((m) => (
          <option key={m.id} value={m.id}>{modelOptionLabel(m)}</option>
        ))}
      </SettingsSelect>
      {hasModels && (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => setManualEntry(true)}
          className="px-1.5 text-ui-label text-muted-foreground"
          title="Type model ID manually"
        >
          edit
        </Button>
      )}
    </div>
  )
}
