/**
 * Desktop-only Updates controls. Renders nothing in the browser build. Inside the Electron
 * shell it drives electron-updater: a manual check, confirm-to-download (or skip), download
 * progress, restart-to-install, and an "install automatically" toggle. By default every
 * update asks for confirmation; stories are backed up before any update is applied. Update
 * state is pushed from the main process (see desktop/updater.ts) via the preload bridge.
 *
 * No em dashes in copy, per project convention.
 */
import { useEffect, useState } from 'react'
import { RefreshCw, Download } from 'lucide-react'
import { desktop, type DesktopUpdateState } from '@/lib/desktop'
import { SectionHeading, SettingsCard, SettingRow, Toggle } from './primitives'

const primaryBtn =
  'flex items-center gap-1.5 rounded-md bg-foreground px-2.5 py-1 text-[0.6875rem] font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-40'
const ghostBtn =
  'flex items-center gap-1.5 rounded-md px-2 py-1 text-[0.6875rem] text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground/70 disabled:opacity-40'

function statusText(state: DesktopUpdateState): string {
  switch (state.status) {
    case 'checking':
      return 'Checking for updates...'
    case 'available':
      return `Version ${state.version ?? ''} is available.`
    case 'downloading':
      return `Downloading ${state.version ?? 'update'}... ${state.percent ?? 0}%`
    case 'downloaded':
      return `Version ${state.version ?? ''} is ready to install.`
    case 'skipped':
      return `Version ${state.version ?? ''} skipped.`
    case 'not-available':
      return 'You are on the latest version.'
    case 'error':
      return `Update check failed: ${state.error ?? 'unknown error'}`
    default:
      return 'Updates are checked on launch.'
  }
}

export function DesktopUpdatesControls() {
  const [state, setState] = useState<DesktopUpdateState>({ status: 'idle' })
  const [autoInstall, setAutoInstall] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!desktop) return
    desktop.getUpdateState().then(setState).catch(() => {})
    desktop.getUpdatePrefs().then((p) => setAutoInstall(p.autoInstall)).catch(() => {})
    return desktop.onUpdateState(setState)
  }, [])

  if (!desktop) return null
  const bridge = desktop

  const check = async () => {
    setBusy(true)
    try {
      setState(await bridge.checkForUpdates())
    } finally {
      setBusy(false)
    }
  }

  const toggleAuto = async (next: boolean) => {
    setAutoInstall(next)
    try {
      const p = await bridge.setAutoInstall(next)
      setAutoInstall(p.autoInstall)
    } catch {
      setAutoInstall(!next)
    }
  }

  const checking = busy || state.status === 'checking'

  const actions = () => {
    switch (state.status) {
      case 'available':
        return (
          <div className="flex items-center gap-1.5">
            <button type="button" className={primaryBtn} onClick={() => bridge.downloadUpdate()}>
              <Download className="size-3" />
              Download and install
            </button>
            <button type="button" className={ghostBtn} onClick={() => bridge.skipUpdate(state.version ?? '')}>
              Skip
            </button>
          </div>
        )
      case 'skipped':
        return (
          <button type="button" className={ghostBtn} onClick={() => bridge.downloadUpdate()}>
            <Download className="size-3" />
            Download
          </button>
        )
      case 'downloaded':
        return (
          <button type="button" className={primaryBtn} onClick={() => bridge.installUpdate()}>
            <Download className="size-3" />
            Restart and install
          </button>
        )
      case 'downloading':
      case 'checking':
        return null
      default:
        return (
          <button type="button" className={ghostBtn} onClick={check} disabled={checking}>
            <RefreshCw className={`size-3 ${checking ? 'animate-spin' : ''}`} />
            Check for updates
          </button>
        )
    }
  }

  return (
    <div>
      <SectionHeading label="Updates" />
      <SettingsCard>
        <SettingRow
          label="Install updates automatically"
          description="Skip the confirmation and update in the background. Stories are backed up first."
        >
          <Toggle checked={autoInstall} onChange={toggleAuto} label="Install updates automatically" />
        </SettingRow>
        <SettingRow label="Status" description={statusText(state)}>
          {actions()}
        </SettingRow>
      </SettingsCard>
      <p className="mt-1.5 px-3 text-[0.625rem] leading-snug text-muted-foreground">
        Your stories are backed up before every update.
      </p>
    </div>
  )
}
