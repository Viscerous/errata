/**
 * Desktop-only Updates controls. Renders nothing in the browser build. Inside the Electron
 * shell it drives electron-updater: a manual check, confirm-to-download (or skip), download
 * progress, and restart-to-install. Updates are never checked, downloaded, or installed until
 * the user asks. Stories are backed up before any update is applied. Update state is pushed
 * from the main process (see desktop/updater.ts) via the preload bridge.
 *
 * No em dashes in copy, per project convention.
 */
import { useEffect, useState } from 'react'
import { RefreshCw, Download } from 'lucide-react'
import { getDesktopBridge, onDesktopBridgeReady, type DesktopUpdateState, type ErrataDesktop } from '@/lib/desktop'
import { SectionHeading, SettingsCard, SettingRow } from './primitives'
import { Button } from '@/components/ui/button'
import { MetaLabel, Metric } from '@/components/ui/prose-text'

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
      return 'Check manually when you want to look for a new release.'
  }
}

function nextVersionText(state: DesktopUpdateState): string {
  if (state.version) return `v${state.version}`
  if (state.status === 'checking') return 'Checking...'
  if (state.status === 'not-available') return 'None available'
  return 'Check to load'
}

function changelogText(state: DesktopUpdateState): string {
  if (state.releaseNotes) return state.releaseNotes
  if (state.status === 'available' || state.status === 'downloaded' || state.status === 'skipped') {
    return 'No changelog was included with this update.'
  }
  if (state.status === 'checking') return 'Checking release metadata...'
  return 'Run a manual update check to load the latest release notes.'
}

function releaseMetaText(state: DesktopUpdateState): string | undefined {
  const parts = [
    state.releaseName,
    state.releaseDate ? new Date(state.releaseDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : undefined,
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(' / ') : undefined
}

export function DesktopUpdatesControls() {
  const [bridge, setBridge] = useState<ErrataDesktop | null>(() => getDesktopBridge())
  const [currentVersion, setCurrentVersion] = useState(__APP_VERSION__)
  const [state, setState] = useState<DesktopUpdateState>({ status: 'idle' })
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let unsubscribeUpdates: (() => void) | undefined
    const stopWaiting = onDesktopBridgeReady((currentBridge) => {
      setBridge(currentBridge)
      currentBridge.getVersion().then(setCurrentVersion).catch(() => {})
      currentBridge.getUpdateState().then(setState).catch(() => {})
      unsubscribeUpdates = currentBridge.onUpdateState(setState)
    })
    return () => {
      stopWaiting()
      unsubscribeUpdates?.()
    }
  }, [])

  if (!bridge) return null

  const check = async () => {
    setBusy(true)
    try {
      setState(await bridge.checkForUpdates())
    } finally {
      setBusy(false)
    }
  }

  const checking = busy || state.status === 'checking'
  const checkButton = (
    <Button type="button" variant="ghost" size="xs" onClick={check} disabled={checking}>
      <RefreshCw className={`size-3 ${checking ? 'animate-spin' : ''}`} />
      Check for updates
    </Button>
  )

  const actions = () => {
    switch (state.status) {
      case 'available':
        return (
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <Button type="button" size="xs" onClick={() => bridge.downloadUpdate()}>
              <Download className="size-3" />
              Download and install
            </Button>
            <Button type="button" variant="ghost" size="xs" onClick={() => bridge.skipUpdate(state.version ?? '')}>
              Skip
            </Button>
            {checkButton}
          </div>
        )
      case 'skipped':
        return (
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <Button type="button" variant="ghost" size="xs" onClick={() => bridge.downloadUpdate()}>
              <Download className="size-3" />
              Download
            </Button>
            {checkButton}
          </div>
        )
      case 'downloaded':
        return (
          <Button type="button" size="xs" onClick={() => bridge.installUpdate()}>
            <Download className="size-3" />
            Restart and install
          </Button>
        )
      case 'downloading':
      case 'checking':
        return null
      default:
        return checkButton
    }
  }

  return (
    <div>
      <SectionHeading label="Updates" />
      <SettingsCard>
        <SettingRow label="Installed version">
          <Metric>v{currentVersion}</Metric>
        </SettingRow>
        <SettingRow label="Next version" description={releaseMetaText(state)}>
          <Metric>{nextVersionText(state)}</Metric>
        </SettingRow>
        <SettingRow label="Desktop updates" description={statusText(state)}>
          {actions()}
        </SettingRow>
        <div className="px-3 py-2.5">
          <p className="text-ui-body font-medium text-foreground/85">Changelog</p>
          <pre className="mt-1.5 max-h-44 overflow-y-auto whitespace-pre-wrap rounded-md bg-panel-muted/60 px-2.5 py-2 font-sans text-ui-caption leading-relaxed text-muted-foreground">
            {changelogText(state)}
          </pre>
        </div>
      </SettingsCard>
      <MetaLabel asChild><p className="mt-1.5 px-3 leading-snug">
        Errata only checks for updates when you click the button. Your stories are backed up before every install.
      </p></MetaLabel>
    </div>
  )
}
