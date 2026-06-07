/**
 * Renderer-side access to the Electron desktop bridge (window.errataDesktop, exposed by
 * desktop/preload.ts). Everything degrades to null/no-op in a plain browser, so the same
 * build runs both as the web app and inside the Electron shell.
 */

export type DesktopUpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'skipped'
  | 'not-available'
  | 'error'

export interface DesktopUpdateState {
  status: DesktopUpdateStatus
  version?: string
  percent?: number
  error?: string
}

export interface DesktopUpdatePrefs {
  /** When true, updates download + install automatically without a prompt. */
  autoInstall: boolean
  /** The version the user chose to skip, if any. */
  skippedVersion: string | null
}

export interface ErrataDesktop {
  isDesktop: true
  getVersion(): Promise<string>
  getUpdateState(): Promise<DesktopUpdateState>
  getUpdatePrefs(): Promise<DesktopUpdatePrefs>
  /** Toggle silent auto-update. Returns the updated prefs. */
  setAutoInstall(enabled: boolean): Promise<DesktopUpdatePrefs>
  checkForUpdates(): Promise<DesktopUpdateState>
  /** Start downloading the available update (also used to download a skipped version). */
  downloadUpdate(): Promise<void>
  /** Skip a specific version; it can still be downloaded later. Returns updated prefs. */
  skipUpdate(version: string): Promise<DesktopUpdatePrefs>
  /** Back up stories, then quit and install the downloaded update. */
  installUpdate(): Promise<void>
  /** Subscribe to update-state pushes. Returns an unsubscribe function. */
  onUpdateState(cb: (state: DesktopUpdateState) => void): () => void
}

export const desktop: ErrataDesktop | null =
  typeof window !== 'undefined' && window.errataDesktop ? window.errataDesktop : null

export const isDesktop = desktop !== null
