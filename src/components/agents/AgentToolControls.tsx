import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { SettingRow, SettingsCard, Toggle } from '@/components/settings/primitives'
import { Eyebrow, MetaLabel } from '@/components/ui/prose-text'

export function AutoAnalysisControl({
  disabled,
  pending,
  onChange,
}: {
  disabled: boolean
  pending: boolean
  onChange: (disabled: boolean) => void
}) {
  return (
    <SettingsCard>
      <SettingRow
        label="Post-generation analysis"
        description="Run the librarian automatically after prose is generated."
      >
        <Toggle checked={!disabled} onChange={(enabled) => onChange(!enabled)} disabled={pending} label="Run post-generation analysis" />
      </SettingRow>
    </SettingsCard>
  )
}

export function AgentToolControls({
  tools,
  disabledTools,
  pending,
  onChange,
}: {
  tools: string[]
  disabledTools: Set<string>
  pending: boolean
  onChange: (disabled: string[]) => void
}) {
  const [expanded, setExpanded] = useState(false)
  if (tools.length === 0) return null

  const toggle = (tool: string) => onChange(
    disabledTools.has(tool)
      ? [...disabledTools].filter((candidate) => candidate !== tool)
      : [...disabledTools, tool],
  )

  return (
    <section>
      <button type="button" className="mb-1.5 flex w-full items-center gap-2 px-0.5" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
        <Eyebrow>Tools</Eyebrow>
        <MetaLabel>{tools.length - disabledTools.size}/{tools.length}</MetaLabel>
        <div className="h-px flex-1 bg-border/20" />
        <ChevronDown className={cn('size-3 text-muted-foreground transition-transform duration-150', expanded && 'rotate-180')} />
      </button>
      {expanded && (
        <SettingsCard>
          {tools.map((tool) => (
            <SettingRow key={tool} label={tool} className={cn(!disabledTools.has(tool) ? '' : '[&_p]:line-through')}>
              <Toggle checked={!disabledTools.has(tool)} onChange={() => toggle(tool)} disabled={pending} label={`${disabledTools.has(tool) ? 'Enable' : 'Disable'} ${tool}`} />
            </SettingRow>
          ))}
        </SettingsCard>
      )}
    </section>
  )
}
