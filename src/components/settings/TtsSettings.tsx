import { useState } from 'react'
import { Volume2, Download, Check, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { MetaLabel } from '@/components/ui/prose-text'
import {
  useTtsSettings,
  useBrowserVoices,
  isBrowserTtsSupported,
  SUPERTONIC_VOICES,
  playFragment,
  preloadNeural,
  stopTts,
  type TtsEngine,
} from '@/lib/tts'
import {
  SettingRow,
  Toggle,
  SegmentedControl,
  Slider,
  SettingsSelect,
  SectionHeading,
  SettingsCard,
} from './primitives'

const SAMPLE = 'And here he stands, the one they call the Knight of the Sorrowful Countenance, the once and future king'

function BrowserVoiceRow({ voiceURI, onChange, disabled }: { voiceURI: string | null; onChange: (uri: string | null) => void; disabled?: boolean }) {
  const voices = useBrowserVoices()
  return (
    <SettingRow label="Voice" description={isBrowserTtsSupported() ? 'System voices from your browser' : 'No speech voices available in this browser'} disabled={disabled}>
      <SettingsSelect className="max-w-[11rem]" value={voiceURI ?? ''} onChange={(v) => onChange(v || null)} disabled={disabled || !isBrowserTtsSupported()}>
        <option value="">Default</option>
        {voices.map((v) => (
          <option key={v.voiceURI} value={v.voiceURI}>{v.name}{v.lang ? ` (${v.lang})` : ''}</option>
        ))}
      </SettingsSelect>
    </SettingRow>
  )
}

export function TtsSettings() {
  const [s, set] = useTtsSettings()
  const [preload, setPreload] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')

  const handlePreload = async () => {
    setPreload('loading')
    try {
      await preloadNeural(s)
      setPreload('ready')
    } catch {
      setPreload('error')
    }
  }

  const disabled = !s.enabled

  return (
    <div>
      <SectionHeading label="Read aloud" />
      <SettingsCard>
        <SettingRow label="Enable read-aloud" description="Adds a Read aloud action to each passage and a player at the bottom of the screen.">
          <Toggle checked={s.enabled} onChange={(next) => { if (!next) stopTts(); set({ enabled: next }) }} label="Toggle read-aloud" />
        </SettingRow>

        <SettingRow label="Engine" description="Browser is instant. Supertonic is a far better neural voice (downloads ~200 MB on first use, then cached)." disabled={disabled}>
          <SegmentedControl<TtsEngine>
            value={s.engine}
            options={[{ value: 'browser', label: 'Browser' }, { value: 'supertonic', label: 'Supertonic' }]}
            onChange={(v) => { stopTts(); set({ engine: v }) }}
            disabled={disabled}
          />
        </SettingRow>

        {s.engine === 'browser' ? (
          <BrowserVoiceRow voiceURI={s.browserVoiceURI} onChange={(uri) => set({ browserVoiceURI: uri })} disabled={disabled} />
        ) : (
          <>
            <SettingRow label="Voice" description="Supertonic preset voices, generated on-device." disabled={disabled}>
              <SettingsSelect className="max-w-[11rem]" value={s.supertonicVoiceId} onChange={(v) => { stopTts(); set({ supertonicVoiceId: v }) }} disabled={disabled}>
                {SUPERTONIC_VOICES.map((v) => (
                  <option key={v.id} value={v.id}>{v.label}</option>
                ))}
              </SettingsSelect>
            </SettingRow>
            <SettingRow label="Model" description="Downloads once on first read (~200 MB), then runs offline from cache." disabled={disabled}>
              {preload === 'loading' ? (
                <MetaLabel className="inline-flex items-center gap-1.5 font-mono"><Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />Loading…</MetaLabel>
              ) : preload === 'ready' ? (
                <MetaLabel className="inline-flex items-center gap-1 text-primary"><Check className="size-3.5" />Ready</MetaLabel>
              ) : (
                <Button type="button" variant="outline" size="xs" onClick={handlePreload} disabled={disabled}>
                  <Download className="size-3.5" />Preload
                </Button>
              )}
            </SettingRow>
            <Slider label="Quality" value={s.steps} min={1} max={20} step={1} onChange={(v) => set({ steps: v })} format={(v) => `${v} steps`} disabled={disabled} />
          </>
        )}

        <Slider label="Speed" value={s.rate} min={0.5} max={2} step={0.05} onChange={(v) => set({ rate: v })} format={(v) => `${v.toFixed(2)}×`} disabled={disabled} />
        <Slider label="Pitch" value={s.pitch} min={0.5} max={2} step={0.05} onChange={(v) => set({ pitch: v })} format={(v) => `${v.toFixed(2)}×`} disabled={disabled} />
        <Slider label="Volume" value={s.volume} min={0} max={1} step={0.05} onChange={(v) => set({ volume: v })} format={(v) => `${Math.round(v * 100)}%`} disabled={disabled} />

        <div className={cn('px-3 py-2.5', disabled && 'pointer-events-none opacity-40')}>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => playFragment('__tts_test__', SAMPLE, 'Voice test', s)}
            disabled={disabled}
          >
            <Volume2 className="size-3.5" />Test voice
          </Button>
        </div>
      </SettingsCard>
    </div>
  )
}
