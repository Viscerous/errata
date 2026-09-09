import type { AgentBlockInfo, GlobalConfigSafe, ModelRoleInfo, StoryMeta } from '@/lib/api/types'
import { getInheritLabel, resolveInheritedSamplingValue, resolveInheritedTemperature, resolveProvider } from '@/lib/model-role-helpers'
import { ModelSelect } from '@/components/settings/ModelSelect'
import { ProviderSelect } from '@/components/settings/ProviderSelect'
import { SamplingNumberInput } from '@/components/settings/SamplingNumberInput'
import { SettingRow, SettingsCard } from '@/components/settings/primitives'

type ModelOverrides = StoryMeta['settings']['modelOverrides']

interface AgentModelControlsProps {
  agent: AgentBlockInfo
  story: StoryMeta
  globalConfig: GlobalConfigSafe | null
  roles: ModelRoleInfo[]
  pending: boolean
  onChange: (modelOverrides: ModelOverrides) => void
}

export function AgentModelControls({
  agent,
  story,
  globalConfig,
  roles,
  pending,
  onChange,
}: AgentModelControlsProps) {
  const key = agent.agentName
  const overrides = story.settings.modelOverrides ?? {}
  const direct = overrides[key] ?? {}
  const providerId = resolveProvider(key, story.settings, globalConfig, roles)
  const inheritedTemperature = direct.temperature == null
    ? resolveInheritedTemperature(key, story.settings, globalConfig, roles)
    : null
  const inheritedTopP = direct.topP == null
    ? resolveInheritedSamplingValue(key, 'topP', story.settings, roles)
    : null
  const inheritedTopK = direct.topK == null
    ? resolveInheritedSamplingValue(key, 'topK', story.settings, roles)
    : null
  const update = (values: Partial<typeof direct>) => onChange({
    ...overrides,
    [key]: { ...direct, ...values },
  })

  return (
    <SettingsCard>
      <SettingRow label="Provider">
        <div className="w-[160px]">
          <ProviderSelect
            value={direct.providerId ?? null}
            globalConfig={globalConfig}
            onChange={(next) => update({ providerId: next, modelId: null })}
            disabled={pending}
            inheritLabel={key === 'generation' ? undefined : getInheritLabel(key, roles, story.settings, globalConfig)}
          />
        </div>
      </SettingRow>
      <SettingRow label="Model">
        <div className="w-[160px]">
          <ModelSelect
            providerId={providerId}
            value={direct.modelId ?? null}
            onChange={(modelId) => update({
              providerId: modelId ? (direct.providerId ?? providerId) : direct.providerId,
              modelId,
            })}
            disabled={pending}
            defaultLabel={key === 'generation' ? 'Default' : 'Inherit'}
          />
        </div>
      </SettingRow>
      <SamplingRow
        label="Temperature"
        description={inheritedTemperature ? `${inheritedTemperature.value} via ${inheritedTemperature.source}` : undefined}
        value={direct.temperature}
        placeholder={inheritedTemperature ? `${inheritedTemperature.value}` : '—'}
        min={0}
        max={2}
        step={0.1}
        title="Temperature (0–2). Leave empty to inherit."
        pending={pending}
        onChange={(temperature) => update({ temperature })}
      />
      <SamplingRow
        label="Top P"
        description={inheritedTopP ? `${inheritedTopP.value} via ${inheritedTopP.source}` : undefined}
        value={direct.topP}
        placeholder={inheritedTopP ? `${inheritedTopP.value}` : '—'}
        min={0}
        max={1}
        step={0.05}
        title="Nucleus sampling (0–1). Leave empty to inherit or use the model default."
        pending={pending}
        onChange={(topP) => update({ topP })}
      />
      <SamplingRow
        label="Top K"
        description={inheritedTopK ? `${inheritedTopK.value} via ${inheritedTopK.source}` : undefined}
        value={direct.topK}
        placeholder={inheritedTopK ? `${inheritedTopK.value}` : '—'}
        min={1}
        max={1000}
        step={1}
        integer
        title="Top-k sampling (1–1000). Leave empty to inherit or use the model default."
        pending={pending}
        onChange={(topK) => update({ topK })}
      />
    </SettingsCard>
  )
}

function SamplingRow({
  label,
  description,
  value,
  placeholder,
  min,
  max,
  step,
  integer,
  title,
  pending,
  onChange,
}: {
  label: string
  description?: string
  value?: number | null
  placeholder: string
  min: number
  max: number
  step: number
  integer?: boolean
  title: string
  pending: boolean
  onChange: (value: number | null) => void
}) {
  return (
    <SettingRow label={label} description={description}>
      <SamplingNumberInput
        min={min}
        max={max}
        step={step}
        integer={integer}
        value={value}
        onCommit={onChange}
        disabled={pending}
        placeholder={placeholder}
        title={title}
        className="w-[72px]"
      />
    </SettingRow>
  )
}
