import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type StoryMeta, type GlobalConfigSafe } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useQuickSwitch, useMentionTypes, BASE_MENTION_TYPES, useTimelineBar, useProseWidth, useUiFontSize, UI_FONT_SIZE_LABELS, useProseFontSize, PROSE_FONT_SIZE_LABELS, useFontPreferences, getActiveFont, FONT_CATALOGUE, loadFullFontCatalogue, useCustomCss, useWritingTransforms, useTransformContext, TRANSFORM_CONTEXT_LABELS, type TransformContext, type FontRole, type ProseWidth, type UiFontSize, type ProseFontSize } from '@/lib/theme'
import { ChevronRight, ExternalLink, Eye, EyeOff, Puzzle, RotateCcw, CircleHelp, Code } from 'lucide-react'
import { useHelp } from '@/hooks/use-help'
import { CustomCssPanel } from '@/components/settings/CustomCssPanel'
import { TtsSettings } from '@/components/settings/TtsSettings'
import { SharingPanel } from '@/components/settings/SharingPanel'
import { ProseColorsControls } from '@/components/settings/ProseColorsPanel'
import { CustomTransformsControls } from '@/components/settings/CustomTransformsPanel'
import { DesktopUpdatesControls } from '@/components/settings/DesktopUpdatesPanel'
import { AboutSection } from '@/components/settings/AboutPanel'
import { ModelSelect } from '@/components/settings/ModelSelect'
import { SamplingNumberInput } from '@/components/settings/SamplingNumberInput'
import { ProviderSelect } from '@/components/settings/ProviderSelect'
import { getDesktopBridge, onDesktopBridgeReady } from '@/lib/desktop'
import { resolveProvider, getInheritLabel } from '@/lib/model-role-helpers'
import { GUIDED_CONTINUE_PROMPT, GUIDED_SCENE_SETTING_PROMPT, GUIDED_SUGGEST_PROMPT } from '@/lib/guided-prompts'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Eyebrow, MetaLabel, Metric } from '@/components/ui/prose-text'
import { GlobalAppearanceRows, ManageProvidersButton } from '@/components/settings/GlobalSettingsControls'
import {
  BUILTIN_FRAGMENT_TYPES,
  compareFragmentTypeVisuals,
  FragmentTypeDisplayIcon,
  getFragmentTypeVisual,
} from '@/components/fragments/fragment-type-icons'
import {
  SettingsSection,
  SectionHeading,
  SettingsCard,
  SettingsGroup,
  SettingRow,
  Toggle,
  SegmentedControl,
  NumberField,
} from '@/components/settings/primitives'

interface SettingsPanelProps {
  storyId: string
  story: StoryMeta
  onManageProviders: () => void
  onOpenPluginPanel?: (pluginName: string) => void
  onTogglePluginSidebar?: (pluginName: string, visible: boolean) => void
  pluginSidebarVisibility?: Record<string, boolean>
}

function FontPicker({ role, label, description, activeFont, onSelect }: {
  role: FontRole
  label: string
  description: string
  activeFont: string
  onSelect: (name: string) => void
}) {
  useEffect(() => { loadFullFontCatalogue() }, [])
  const options = FONT_CATALOGUE[role]
  return (
    <div className="px-3 py-2.5">
      <p className="mb-0.5 text-ui-body font-medium text-foreground/85">{label}</p>
      <MetaLabel asChild><p className="mb-2 leading-snug">{description}</p></MetaLabel>
      <div className="flex flex-wrap gap-1.5">
        {options.map((opt) => {
          const isActive = opt.name === activeFont
          return (
            <Button
              key={opt.name}
              type="button"
              variant={isActive ? 'secondary' : 'ghost'}
              size="xs"
              aria-pressed={isActive}
              onClick={() => onSelect(opt.name)}
              style={{ fontFamily: `"${opt.name}", ${opt.fallback}` }}
              className="border border-transparent text-ui-body data-[variant=secondary]:border-border/50"
            >
              {opt.name}
              {opt.tag && (
                <span className="text-ui-label font-sans font-medium uppercase tracking-wider text-primary/60 bg-primary/8 px-1.5 py-px rounded-full leading-tight">
                  {opt.tag}
                </span>
              )}
            </Button>
          )
        })}
      </div>
    </div>
  )
}

function MentionTypePicker({
  story,
  enabledTypes,
  onChange,
}: {
  story: StoryMeta
  enabledTypes: string[]
  onChange: (types: string[]) => void
}) {
  const customTypes = story.settings.customFragmentTypes ?? []
  const options = useMemo(() => {
    const visuals = [
      ...BASE_MENTION_TYPES.map((type) => getFragmentTypeVisual(type, customTypes)),
      ...customTypes
        .filter((def) => !BUILTIN_FRAGMENT_TYPES.has(def.type))
        .map((def) => getFragmentTypeVisual(def.type, customTypes)),
    ]
    return visuals.sort(compareFragmentTypeVisuals)
  }, [customTypes])
  const enabled = new Set(enabledTypes)

  const toggleType = (type: string) => {
    onChange(enabled.has(type)
      ? enabledTypes.filter((current) => current !== type)
      : [...enabledTypes, type])
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((option) => {
        const active = enabled.has(option.type)
        return (
          <Button
            key={option.type}
            type="button"
            variant={active ? 'secondary' : 'outline'}
            size="xs"
            aria-pressed={active}
            onClick={() => toggleType(option.type)}
            className={cn(
              'gap-1 px-2 text-ui-caption',
              active
                ? 'bg-foreground text-background hover:bg-foreground/90'
                : 'border-border/60 bg-transparent text-muted-foreground hover:bg-accent/40',
            )}
            title={option.label}
          >
            <FragmentTypeDisplayIcon type={option.type} customTypes={customTypes} className="size-3" />
            <span>{option.singularLabel}</span>
          </Button>
        )
      })}
    </div>
  )
}


function LLMSection({ story, globalConfig, updateMutation, onManageProviders }: {
  story: StoryMeta
  globalConfig: GlobalConfigSafe | null
  updateMutation: { mutate: (data: Parameters<typeof api.settings.update>[1]) => void; isPending: boolean }
  onManageProviders: () => void
}) {
  const settings = story.settings
  const overrides = settings.modelOverrides ?? {}

  const { data: modelRoles } = useQuery({
    queryKey: ['model-roles'],
    queryFn: () => api.agentBlocks.listModelRoles(),
  })

  const roles = modelRoles ?? []

  return (
    <div>
      <SectionHeading label="LLM" helpTopic="settings#providers" />
      <SettingsCard>
        {roles.map((role) => {
          const directProviderId = overrides[role.key]?.providerId ?? null
          const directModelId = overrides[role.key]?.modelId ?? null
          const effectiveProviderId = resolveProvider(role.key, settings, globalConfig, roles)
          const isGeneration = role.key === 'generation'

          return (
            <div key={role.key} className="px-3 py-2">
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <div className="min-w-0">
                  <p className="text-ui-body font-medium text-foreground/85">{role.label}</p>
                  <MetaLabel asChild><p className="leading-snug">{role.description}</p></MetaLabel>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <ProviderSelect
                    value={directProviderId}
                    globalConfig={globalConfig}
                    onChange={(id) => {
                      const current = overrides[role.key] ?? {}
                      updateMutation.mutate({
                        modelOverrides: { ...overrides, [role.key]: { ...current, providerId: id, modelId: null } },
                      })
                    }}
                    disabled={updateMutation.isPending}
                    inheritLabel={isGeneration ? undefined : getInheritLabel(role.key, roles, settings, globalConfig)}
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <ModelSelect
                    providerId={effectiveProviderId}
                    value={directModelId}
                    onChange={(mid) => {
                      const current = overrides[role.key] ?? {}
                      updateMutation.mutate({
                        modelOverrides: {
                          ...overrides,
                          [role.key]: {
                            ...current,
                            providerId: mid ? (current.providerId ?? effectiveProviderId) : current.providerId,
                            modelId: mid,
                          },
                        },
                      })
                    }}
                    disabled={updateMutation.isPending}
                    defaultLabel={isGeneration ? 'Default' : 'Inherit'}
                  />
                </div>
                <div className="shrink-0 w-16">
                  <SamplingNumberInput
                    min={0}
                    max={2}
                    step={0.1}
                    value={overrides[role.key]?.temperature}
                    onCommit={(temperature) => {
                      const current = overrides[role.key] ?? {}
                      updateMutation.mutate({
                        modelOverrides: { ...overrides, [role.key]: { ...current, temperature } },
                      })
                    }}
                    disabled={updateMutation.isPending}
                    placeholder="Temp"
                    title="Temperature (0–2). Leave empty to use provider default."
                    className="w-full"
                  />
                </div>
              </div>
            </div>
          )
        })}
        <ManageProvidersButton onClick={onManageProviders} />
      </SettingsCard>
    </div>
  )
}

function GuidedPromptsControls({ story, onUpdate, isPending }: {
  story: StoryMeta
  onUpdate: (data: { guidedContinuePrompt?: string; guidedSceneSettingPrompt?: string; guidedSuggestPrompt?: string }) => void
  isPending: boolean
}) {
  const [continuePrompt, setContinuePrompt] = useState(story.settings.guidedContinuePrompt ?? '')
  const [sceneSettingPrompt, setSceneSettingPrompt] = useState(story.settings.guidedSceneSettingPrompt ?? '')
  const [suggestPrompt, setSuggestPrompt] = useState(story.settings.guidedSuggestPrompt ?? '')

  useEffect(() => {
    setContinuePrompt(story.settings.guidedContinuePrompt ?? '')
    setSceneSettingPrompt(story.settings.guidedSceneSettingPrompt ?? '')
    setSuggestPrompt(story.settings.guidedSuggestPrompt ?? '')
  }, [
    story.settings.guidedContinuePrompt,
    story.settings.guidedSceneSettingPrompt,
    story.settings.guidedSuggestPrompt,
  ])

  const save = (field: 'guidedContinuePrompt' | 'guidedSceneSettingPrompt' | 'guidedSuggestPrompt', value: string) => {
    onUpdate({ [field]: value.trim() === '' ? '' : value })
  }

  return (
    <div className="space-y-4">
        <div>
          <label className="mb-1 block text-ui-body font-medium text-foreground/85">Continue prompt</label>
          <MetaLabel asChild><p className="mb-1.5 leading-snug">Used when clicking the "Continue" button</p></MetaLabel>
          <Textarea
            value={continuePrompt}
            onChange={(e) => setContinuePrompt(e.target.value)}
            onBlur={() => save('guidedContinuePrompt', continuePrompt)}
            placeholder={GUIDED_CONTINUE_PROMPT}
            rows={3}
            disabled={isPending}
            className="resize-none bg-elevated/60 text-ui-body"
          />
        </div>
        <div>
          <label className="mb-1 block text-ui-body font-medium text-foreground/85">Scene-setting prompt</label>
          <MetaLabel asChild><p className="mb-1.5 leading-snug">Used when clicking the "Scene-setting" button</p></MetaLabel>
          <Textarea
            value={sceneSettingPrompt}
            onChange={(e) => setSceneSettingPrompt(e.target.value)}
            onBlur={() => save('guidedSceneSettingPrompt', sceneSettingPrompt)}
            placeholder={GUIDED_SCENE_SETTING_PROMPT}
            rows={3}
            disabled={isPending}
            className="resize-none bg-elevated/60 text-ui-body"
          />
        </div>
        <div>
          <label className="mb-1 block text-ui-body font-medium text-foreground/85">Suggest directions prompt</label>
          <MetaLabel asChild><p className="mb-1.5 leading-snug">
            Prompt for generating direction suggestions. Use <code className="rounded bg-panel-muted px-1">{'{{count}}'}</code> for the number of suggestions.
          </p></MetaLabel>
          <Textarea
            value={suggestPrompt}
            onChange={(e) => setSuggestPrompt(e.target.value)}
            onBlur={() => save('guidedSuggestPrompt', suggestPrompt)}
            placeholder={GUIDED_SUGGEST_PROMPT}
            rows={6}
            disabled={isPending}
            className="resize-none bg-elevated/60 text-ui-body"
          />
        </div>
        <MetaLabel asChild><p className="italic">
          Leave empty to use the default prompt. Changes are saved when you leave each field.
        </p></MetaLabel>
    </div>
  )
}

const DEFAULT_HUB = 'https://errata.tealios.com'

function ErrataNetSection() {
  const queryClient = useQueryClient()
  const { data: config } = useQuery({
    queryKey: ['erratanet-config'],
    queryFn: () => api.erratanet.getConfig(),
  })
  const setConfig = useMutation({
    mutationFn: (data: { enabled?: boolean; hubUrl?: string; introSeen?: boolean }) =>
      api.erratanet.setConfig(data),
    onSuccess: (cfg) => {
      queryClient.setQueryData(['erratanet-config'], cfg)
      queryClient.invalidateQueries({ queryKey: ['erratanet-account'] })
    },
  })

  const enabled = config?.enabled ?? false

  // Local draft for the endpoint so typing does not fire a save on every key.
  const [endpoint, setEndpoint] = useState('')
  useEffect(() => {
    setEndpoint(config?.hubUrl ?? '')
  }, [config?.hubUrl])

  const saveEndpoint = () => {
    const next = endpoint.trim().replace(/\/+$/, '')
    setEndpoint(next)
    if (next === (config?.hubUrl ?? '')) return
    setConfig.mutate({ hubUrl: next })
  }

  return (
    <>
      <SectionHeading label="ErrataNet" />
      <div className="space-y-3">
        <SettingsCard>
          <SettingRow
            label="ErrataNet"
            description="Browse, install, and publish community packs from a hub."
          >
            <Toggle
              checked={enabled}
              disabled={setConfig.isPending}
              onChange={(next) => setConfig.mutate(next ? { enabled: true, introSeen: true } : { enabled: false })}
              label="Toggle ErrataNet"
            />
          </SettingRow>
        </SettingsCard>

        <div className={`rounded-lg border border-border/30 p-3 ${enabled ? '' : 'pointer-events-none opacity-40'}`}>
          <p className="text-ui-body font-medium text-foreground/85">API endpoint</p>
          <MetaLabel asChild><p className="mt-0.5 leading-snug">
            The hub Errata connects to for browsing and publishing packs.
          </p></MetaLabel>
          <Input
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            onBlur={saveEndpoint}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
            placeholder={DEFAULT_HUB}
            spellCheck={false}
            autoComplete="off"
            disabled={!enabled || setConfig.isPending}
            className="mt-2 h-8 bg-elevated font-mono text-ui-body"
          />
        </div>
      </div>
    </>
  )
}

export function SettingsPanel({
  storyId,
  story,
  onManageProviders,
  onOpenPluginPanel,
  onTogglePluginSidebar,
  pluginSidebarVisibility,
}: SettingsPanelProps) {
  const queryClient = useQueryClient()

  const { data: plugins } = useQuery({
    queryKey: ['plugins'],
    queryFn: () => api.plugins.list(),
  })

  const { data: globalConfig } = useQuery({
    queryKey: ['global-config'],
    queryFn: () => api.config.getProviders(),
  })

  const updateMutation = useMutation({
    mutationFn: (data: Parameters<typeof api.settings.update>[1]) =>
      api.settings.update(storyId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['story', storyId] })
    },
  })

  const togglePlugin = (pluginName: string) => {
    const enabled = story.settings.enabledPlugins
    const next = enabled.includes(pluginName)
      ? enabled.filter((p) => p !== pluginName)
      : [...enabled, pluginName]
    updateMutation.mutate({ enabledPlugins: next })
  }

  const [customCssPanelOpen, setCustomCssPanelOpen] = useState(false)
  const [writingTransforms] = useWritingTransforms()
  const enabledTransformCount = writingTransforms.filter(t => t.enabled).length
  const [transformContext, setTransformContext] = useTransformContext()
  const { openHelp } = useHelp()
  const [quickSwitch, setQuickSwitch] = useQuickSwitch()
  const [mentionTypes, setMentionTypes] = useMentionTypes()
  const [timelineBar, setTimelineBar] = useTimelineBar()
  const [proseWidth, setProseWidth] = useProseWidth()
  const [uiFontSize, setUiFontSize] = useUiFontSize()
  const [proseFontSize, setProseFontSize] = useProseFontSize()
  const [fontPrefs, setFont, resetFonts] = useFontPreferences()
  const hasCustomFonts = Object.keys(fontPrefs).length > 0
  const [, customCssEnabled, , setCustomCssEnabled] = useCustomCss()
  const [hasDesktopBridge, setHasDesktopBridge] = useState(() => getDesktopBridge() !== null)

  useEffect(() => {
    return onDesktopBridgeReady(() => setHasDesktopBridge(true))
  }, [])

  if (customCssPanelOpen) {
    return <CustomCssPanel onClose={() => setCustomCssPanelOpen(false)} />
  }

  return (
    <div className="space-y-10 p-5 sm:p-6" data-component-id="settings-panel-root">
      {/* Appearance */}
      <SettingsSection id="set-appearance" label="Appearance" group="Interface">
        <SectionHeading label="Appearance" />
        <SettingsCard>
          <GlobalAppearanceRows />
          <SettingRow label="UI size" description="Scale the entire interface">
            <SegmentedControl<UiFontSize>
              value={uiFontSize}
              options={[
                { value: 'xs', label: UI_FONT_SIZE_LABELS.xs },
                { value: 'sm', label: UI_FONT_SIZE_LABELS.sm },
                { value: 'md', label: UI_FONT_SIZE_LABELS.md },
                { value: 'lg', label: UI_FONT_SIZE_LABELS.lg },
                { value: 'xl', label: UI_FONT_SIZE_LABELS.xl },
              ]}
              onChange={setUiFontSize}
            />
          </SettingRow>
          <SettingRow label="Quick switch" description="Show chevrons to swap between variations">
            <Toggle checked={quickSwitch} onChange={setQuickSwitch} label="Toggle quick switch" />
          </SettingRow>
          <SettingRow label="Mentions" description="Highlight analyzed fragment references in prose" className="flex-col items-stretch gap-2">
            <MentionTypePicker story={story} enabledTypes={mentionTypes} onChange={setMentionTypes} />
          </SettingRow>
          <SettingRow label="Timeline bar" description="Show timeline switcher above prose">
            <Toggle checked={timelineBar} onChange={setTimelineBar} label="Toggle timeline bar" />
          </SettingRow>
          <SettingRow label="Prose width" description="Reading column width">
            <SegmentedControl<ProseWidth>
              value={proseWidth}
              options={[
                { value: 'narrow', label: 'Narrow' },
                { value: 'medium', label: 'Medium' },
                { value: 'wide', label: 'Wide' },
                { value: 'full', label: 'Full' },
              ]}
              onChange={setProseWidth}
            />
          </SettingRow>
          <SettingRow label="Font size" description="Prose text size">
            <SegmentedControl<ProseFontSize>
              value={proseFontSize}
              options={[
                { value: 'xs', label: PROSE_FONT_SIZE_LABELS.xs },
                { value: 'sm', label: PROSE_FONT_SIZE_LABELS.sm },
                { value: 'md', label: PROSE_FONT_SIZE_LABELS.md },
                { value: 'lg', label: PROSE_FONT_SIZE_LABELS.lg },
                { value: 'xl', label: PROSE_FONT_SIZE_LABELS.xl },
              ]}
              onChange={setProseFontSize}
            />
          </SettingRow>
          <SettingRow label="Custom CSS" description="Apply your own styles globally">
            <Toggle checked={customCssEnabled} onChange={setCustomCssEnabled} label="Toggle custom CSS" />
          </SettingRow>
          {customCssEnabled && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => setCustomCssPanelOpen(true)}
              className="h-9 w-full justify-between rounded-none px-3 text-ui-caption text-muted-foreground"
            >
              <span className="flex items-center gap-1.5">
                <Code className="size-3" />
                Edit custom CSS
              </span>
              <ChevronRight className="size-3" />
            </Button>
          )}
        </SettingsCard>
        <ProseColorsControls />
      </SettingsSection>

      {/* Typography */}
      <SettingsSection id="set-typography" label="Typography" group="Interface">
        <SectionHeading
          label="Typography"
          action={hasCustomFonts && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={resetFonts}
              className="text-ui-label text-muted-foreground"
            >
              <RotateCcw className="size-2.5" />
              Reset
            </Button>
          )}
        />
        <SettingsCard>
          <FontPicker
            role="display"
            label="Display"
            description="Titles, headings, story names"
            activeFont={getActiveFont('display', fontPrefs)}
            onSelect={(name) => setFont('display', name)}
          />
          <FontPicker
            role="prose"
            label="Prose"
            description="Reading experience, story content"
            activeFont={getActiveFont('prose', fontPrefs)}
            onSelect={(name) => setFont('prose', name)}
          />
          <FontPicker
            role="sans"
            label="Interface"
            description="UI text, buttons, labels"
            activeFont={getActiveFont('sans', fontPrefs)}
            onSelect={(name) => setFont('sans', name)}
          />
          <FontPicker
            role="mono"
            label="Code"
            description="Fragment IDs, monospace text"
            activeFont={getActiveFont('mono', fontPrefs)}
            onSelect={(name) => setFont('mono', name)}
          />
        </SettingsCard>
      </SettingsSection>

      {/* Read aloud (TTS) */}
      <SettingsSection id="set-read-aloud" label="Read aloud" group="Interface"><TtsSettings /></SettingsSection>

      {/* LLM */}
      <SettingsSection id="set-providers" label="Providers" group="Writing">
        <LLMSection
          story={story}
          globalConfig={globalConfig ?? null}
          updateMutation={updateMutation}
          onManageProviders={onManageProviders}
        />
      </SettingsSection>

      {/* Generation */}
      <SettingsSection id="set-generation" label="Generation" group="Writing">
        <SectionHeading label="Generation" helpTopic="generation#overview" />
        <div className="space-y-3">
          <SettingsGroup title="Workflow" description="How prose generation runs and what the model is allowed to do.">
            <SettingRow
              label="Writing relationship"
              description={(story.settings.authorInputMode ?? 'direct') === 'play'
                ? 'Your primary input is story prose. A successful turn is saved verbatim before the continuation and included in exports.'
                : 'Your primary input directs the assistant and is not included in the manuscript or exports.'}
            >
              <SegmentedControl
                value={(story.settings.authorInputMode ?? 'direct') as 'direct' | 'play'}
                options={[
                  { value: 'direct' as const, label: 'Assistant' },
                  { value: 'play' as const, label: 'Play' },
                ]}
                onChange={(v) => updateMutation.mutate({ authorInputMode: v })}
                disabled={updateMutation.isPending}
              />
            </SettingRow>
            <SettingRow label="Generation mode" description="How prose generation is handled">
              <SegmentedControl
                value={(story.settings.generationMode ?? 'standard') as 'standard' | 'prewriter'}
                options={[
                  { value: 'standard' as const, label: 'Standard' },
                  { value: 'prewriter' as const, label: 'Prewriter' },
                ]}
                onChange={(v) => updateMutation.mutate({ generationMode: v })}
                disabled={updateMutation.isPending}
              />
            </SettingRow>
            {(story.settings.generationMode ?? 'standard') === 'prewriter' && (
              <>
                <SettingRow label="Prewriter reasoning" description="How much the prewriter deliberates. Short favors speed; Extensive favors depth.">
                  <SegmentedControl
                    value={(story.settings.prewriterReasoning ?? 'normal') as 'short' | 'normal' | 'extensive'}
                    options={[
                      { value: 'short' as const, label: 'Short' },
                      { value: 'normal' as const, label: 'Normal' },
                      { value: 'extensive' as const, label: 'Extensive' },
                    ]}
                    onChange={(v) => updateMutation.mutate({ prewriterReasoning: v })}
                    disabled={updateMutation.isPending}
                  />
                </SettingRow>
                <SettingRow label="Clarify before writing" description="Let the prewriter ask you questions when your direction is ambiguous, before it writes.">
                  <Toggle
                    checked={story.settings.clarifyBeforeGenerate ?? false}
                    onChange={(next) => updateMutation.mutate({ clarifyBeforeGenerate: next })}
                    disabled={updateMutation.isPending}
                    label="Toggle clarify before writing"
                  />
                </SettingRow>
              </>
            )}
            <SettingRow label="Output format" helpTopic="generation#output-format">
              <SegmentedControl
                value={story.settings.outputFormat}
                options={[
                  { value: 'plaintext', label: 'Plain' },
                  { value: 'markdown', label: 'Markdown' },
                ]}
                onChange={(v) => updateMutation.mutate({ outputFormat: v })}
                disabled={updateMutation.isPending}
              />
            </SettingRow>
            <SettingRow label="Max steps" description="Tool-use rounds per generation" helpTopic="generation#max-steps">
              <NumberField
                value={story.settings.maxSteps ?? 10}
                min={1}
                max={50}
                onChange={(v) => updateMutation.mutate({ maxSteps: v })}
                disabled={updateMutation.isPending}
              />
            </SettingRow>
            <SettingRow label="Disable thinking" description="Suppress extended thinking / reasoning mode on models that support it">
              <Toggle
                checked={story.settings.disableThinking ?? false}
                onChange={(next) => updateMutation.mutate({ disableThinking: next })}
                disabled={updateMutation.isPending}
                label="Toggle disable thinking"
              />
            </SettingRow>
            <SettingRow label="Expand thinking by default" description="Show the model's thinking expanded while it generates, instead of collapsed">
              <Toggle
                checked={story.settings.expandThoughtsByDefault ?? true}
                onChange={(next) => updateMutation.mutate({ expandThoughtsByDefault: next })}
                disabled={updateMutation.isPending}
                label="Toggle expand thinking by default"
              />
            </SettingRow>
          </SettingsGroup>

          <SettingsGroup title="Context" description="How the prompt is assembled before generation starts.">
            <SettingRow label="Fragment ordering" description="Grouped bundles fragments by type. Custom unlocks the Fragment Order panel for drag-and-drop sequencing." helpTopic="settings#prompt-control">
              <SegmentedControl
                value={story.settings.contextOrderMode ?? 'simple'}
                options={[
                  { value: 'simple', label: 'Grouped' },
                  { value: 'advanced', label: 'Custom' },
                ]}
                onChange={(v) => updateMutation.mutate({ contextOrderMode: v })}
                disabled={updateMutation.isPending}
              />
            </SettingRow>
            <div className="px-3 py-2.5">
              <div className="flex items-center gap-1">
                <p className="text-ui-body font-medium text-foreground/85">Context limit</p>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={(e) => { e.stopPropagation(); openHelp('generation#context-limit') }}
                  aria-label="Learn more about context limit"
                >
                  <CircleHelp className="size-3" />
                </Button>
              </div>
              <MetaLabel asChild><p className="mt-0.5 leading-snug">How much recent prose to include</p></MetaLabel>
              <div className="flex items-center justify-between gap-2 mt-2.5">
                <SegmentedControl
                  value={(story.settings.contextCompact?.type ?? 'proseLimit') as 'proseLimit' | 'maxTokens' | 'maxCharacters'}
                  options={[
                    { value: 'proseLimit' as const, label: 'Fragments' },
                    { value: 'maxTokens' as const, label: 'Tokens' },
                    { value: 'maxCharacters' as const, label: 'Characters' },
                  ]}
                  onChange={(v) => {
                    const defaults = { proseLimit: 10, maxTokens: 40000, maxCharacters: 160000 } as const
                    updateMutation.mutate({ contextCompact: { type: v, value: defaults[v] } })
                  }}
                  disabled={updateMutation.isPending}
                />
                <NumberField
                  value={story.settings.contextCompact?.value ?? 10}
                  min={(story.settings.contextCompact?.type ?? 'proseLimit') === 'proseLimit' ? 1 : (story.settings.contextCompact?.type ?? 'proseLimit') === 'maxTokens' ? 100 : 500}
                  max={(story.settings.contextCompact?.type ?? 'proseLimit') === 'proseLimit' ? 100 : (story.settings.contextCompact?.type ?? 'proseLimit') === 'maxTokens' ? 100000 : 500000}
                  onChange={(v) => updateMutation.mutate({ contextCompact: { type: story.settings.contextCompact?.type ?? 'proseLimit', value: v } })}
                  disabled={updateMutation.isPending}
                  className={(story.settings.contextCompact?.type ?? 'proseLimit') !== 'proseLimit' ? 'w-20' : undefined}
                />
              </div>
            </div>
          </SettingsGroup>

          <SettingsGroup title="Librarian" description="What happens after prose is generated and the librarian follows up.">
            <SettingRow label="Disable auto analysis" description="Do not run the librarian automatically after prose generation">
              <Toggle
                checked={story.settings.disableLibrarianAutoAnalysis ?? false}
                onChange={(next) => updateMutation.mutate({ disableLibrarianAutoAnalysis: next })}
                disabled={updateMutation.isPending}
                label="Toggle disable auto analysis"
              />
            </SettingRow>
            <SettingRow label="Auto-apply suggestions" description="Apply evidence-backed fragment corrections and new reusable records automatically" helpTopic="librarian#auto-suggestions">
              <Toggle
                checked={story.settings.autoApplyLibrarianSuggestions ?? false}
                onChange={(next) => updateMutation.mutate({ autoApplyLibrarianSuggestions: next })}
                disabled={updateMutation.isPending}
                label="Toggle auto-apply suggestions"
              />
            </SettingRow>
            <SettingRow label="Disable automatic directions" description="Skip directions during automatic Librarian analysis; manual suggestions remain available">
              <Toggle
                checked={story.settings.disableLibrarianDirections ?? false}
                onChange={(next) => updateMutation.mutate({ disableLibrarianDirections: next })}
                disabled={updateMutation.isPending}
                label="Toggle automatic directions"
              />
            </SettingRow>
            <SettingRow label="Disable suggestions" description="Skip fragment corrections and new-record suggestions during analysis">
              <Toggle
                checked={story.settings.disableLibrarianSuggestions ?? false}
                onChange={(next) => updateMutation.mutate({ disableLibrarianSuggestions: next })}
                disabled={updateMutation.isPending}
                label="Toggle disable suggestions"
              />
            </SettingRow>
          </SettingsGroup>
        </div>
      </SettingsSection>

      {/* Authoring (transforms + guided prompts) */}
      <SettingsSection id="set-authoring" label="Authoring" group="Writing">
        <SectionHeading label="Authoring" />
        <div className="space-y-6">
          <div className="space-y-2.5">
            <div>
              <Eyebrow asChild><p>
                Selection transforms{enabledTransformCount > 0 ? ` · ${enabledTransformCount} active` : ''}
              </p></Eyebrow>
              <MetaLabel asChild><p className="mt-0.5 leading-snug">
                Quick rewrites in the floating toolbar when you select text. Drag to reorder, toggle to show or hide.
              </p></MetaLabel>
            </div>
            <SettingsCard>
              <SettingRow label="Surrounding context" description="How much of the passage around your selection a transform can read.">
                <SegmentedControl
                  value={transformContext}
                  options={(['tight', 'wide', 'passage'] as TransformContext[]).map((v) => ({ value: v, label: TRANSFORM_CONTEXT_LABELS[v] }))}
                  onChange={setTransformContext}
                />
              </SettingRow>
            </SettingsCard>
            <CustomTransformsControls />
          </div>

          <div className="space-y-2.5">
            <div>
              <Eyebrow asChild><p>Guided mode prompts</p></Eyebrow>
              <MetaLabel asChild><p className="mt-0.5 leading-snug">
                The prompts behind the guided writing buttons. Leave a field empty to use its default.
              </p></MetaLabel>
            </div>
            <GuidedPromptsControls story={story} onUpdate={(data) => updateMutation.mutate(data)} isPending={updateMutation.isPending} />
          </div>
        </div>
      </SettingsSection>

      {/* Remote access (auth + LAN + tunnel) */}
      <SettingsSection id="set-remote" label="Remote" group="System">
        <SharingPanel />
      </SettingsSection>

      {/* ErrataNet (pack hub: enable + API endpoint) */}
      <SettingsSection id="set-erratanet" label="ErrataNet" group="System">
        <ErrataNetSection />
      </SettingsSection>

      {/* Updates */}
      {hasDesktopBridge && (
        <SettingsSection id="set-updates" label="Updates" group="System">
          <DesktopUpdatesControls />
        </SettingsSection>
      )}

      {/* Plugins */}
      <SettingsSection id="set-plugins" label="Plugins" group="System">
        <SectionHeading label="Plugins" helpTopic="settings#plugins" className="mb-3" />
        {plugins && plugins.length > 0 ? (
          <div className="space-y-2">
            {plugins.map((plugin) => {
              const isEnabled = story.settings.enabledPlugins.includes(plugin.name)
              const isSidebarVisible = (pluginSidebarVisibility?.[plugin.name]) ?? (plugin.panel?.showInSidebar !== false)
              return (
                <div
                  key={plugin.name}
                  className={`rounded-lg border transition-colors ${isEnabled
                      ? 'border-border/60 bg-accent/20'
                      : 'border-border/30 bg-transparent'
                    }`}
                >
                  {/* Main row: toggle + info */}
                  <div className="flex items-start gap-3 px-3 py-2.5">
                    <Toggle
                      checked={isEnabled}
                      onChange={() => togglePlugin(plugin.name)}
                      disabled={updateMutation.isPending}
                      label={`${isEnabled ? 'Disable' : 'Enable'} ${plugin.name}`}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-ui-body font-medium leading-tight text-foreground/85">{plugin.name}</p>
                      <MetaLabel asChild><p className="mt-0.5 leading-snug">{plugin.description}</p></MetaLabel>
                    </div>
                    <Metric className={`mt-1 shrink-0 uppercase tracking-widest ${isEnabled ? 'text-foreground/50' : ''}`}>
                      v{plugin.version}
                    </Metric>
                  </div>

                  {/* Panel actions — only when enabled and has a panel */}
                  {isEnabled && plugin.panel && (
                    <div className="flex items-center gap-1 px-3 pb-2.5 pt-0">
                      {onOpenPluginPanel && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          onClick={() => onOpenPluginPanel(plugin.name)}
                          className="text-ui-caption text-muted-foreground"
                        >
                          <ExternalLink className="size-3" />
                          Open panel
                        </Button>
                      )}
                      {onTogglePluginSidebar && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          onClick={() => onTogglePluginSidebar(plugin.name, !isSidebarVisible)}
                          className="text-ui-caption text-muted-foreground"
                        >
                          {isSidebarVisible ? <Eye className="size-3" /> : <EyeOff className="size-3" />}
                          {isSidebarVisible ? 'Visible in sidebar' : 'Hidden from sidebar'}
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        ) : (
          <div className="flex flex-col items-center py-6 text-center">
            <Puzzle className="size-5 text-muted-foreground mb-2" />
            <MetaLabel>No plugins available</MetaLabel>
          </div>
        )}
      </SettingsSection>

      {/* About: version, links (docs, Discord, GitHub, releases), attribution + desktop updates */}
      <SettingsSection id="set-about" label="About" group="System">
        <AboutSection />
      </SettingsSection>
    </div>
  )
}
