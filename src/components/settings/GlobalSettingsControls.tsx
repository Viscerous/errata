import { ChevronRight, Settings2 } from 'lucide-react'
import { useTheme } from '@/lib/theme'
import { useInteractionSounds } from '@/lib/interaction-sounds'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { SegmentedControl, SettingRow, Toggle } from './primitives'

export function GlobalAppearanceRows() {
  const { theme, setTheme } = useTheme()
  const [interactionSounds, setInteractionSounds] = useInteractionSounds()

  return (
    <>
      <SettingRow label="Theme">
        <SegmentedControl
          value={theme}
          options={[
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
            { value: 'high-contrast', label: 'High' },
          ]}
          onChange={setTheme}
        />
      </SettingRow>
      <SettingRow label="Interaction sounds" description="Play subtle feedback for controls">
        <Toggle checked={interactionSounds} onChange={setInteractionSounds} label="Toggle interaction sounds" />
      </SettingRow>
    </>
  )
}

export function ManageProvidersButton({ onClick, className }: { onClick: () => void; className?: string }) {
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={onClick}
      className={cn('h-9 w-full justify-between rounded-none px-3 text-ui-caption text-muted-foreground', className)}
      data-component-id="settings-manage-providers"
    >
      <span className="flex items-center gap-1.5">
        <Settings2 className="size-3" />
        Manage providers
      </span>
      <ChevronRight className="size-3" />
    </Button>
  )
}
