import type { GlobalConfigSafe } from '@/lib/api/types'
import { SettingsSelect } from './primitives'

interface ProviderSelectProps {
  value: string | null
  globalConfig: GlobalConfigSafe | null
  onChange: (providerId: string | null) => void
  disabled?: boolean
  inheritLabel?: string
}

export function ProviderSelect({ value, globalConfig, onChange, disabled, inheritLabel }: ProviderSelectProps) {
  const defaultProvider = globalConfig?.defaultProviderId
    ? globalConfig.providers.find(p => p.id === globalConfig.defaultProviderId)
    : null

  const emptyLabel = inheritLabel
    ? inheritLabel
    : defaultProvider
      ? defaultProvider.name
      : 'DeepSeek (env)'

  return (
    <SettingsSelect
      className="w-full truncate"
      value={value ?? ''}
      onChange={(next) => onChange(next || null)}
      disabled={disabled}
    >
      <option value="">
        {emptyLabel}
      </option>
      {(globalConfig?.providers ?? []).map((p) => (
        <option key={p.id} value={p.id}>{p.name}</option>
      ))}
    </SettingsSelect>
  )
}
