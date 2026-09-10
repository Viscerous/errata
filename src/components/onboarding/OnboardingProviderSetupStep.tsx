import { useEffect, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Check, Loader2, RefreshCw, Server, Zap } from 'lucide-react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SettingsSelect } from '@/components/settings/primitives'
import { Caption, Eyebrow, Hint } from '@/components/ui/prose-text'
import { Wizard } from '@/components/ui/wizard'
import { PROVIDER_PRESETS, type ProviderModelInfo } from '@/contracts/providers'
import { modelOptionLabel } from '@/lib/model-capabilities'
import { ACCENT_COLORS, type PresetKey } from './OnboardingProviderSteps'

export function ProviderSetupStep({
  preset,
  onComplete,
  onBack,
}: {
  preset: PresetKey
  onComplete: () => void
  onBack: () => void
}) {
  const card = PROVIDER_PRESETS[preset]
  const accent = ACCENT_COLORS[card.accent]

  const [apiKey, setApiKey] = useState('')
  const [baseURL, setBaseURL] = useState<string>(card.baseURL)
  const [defaultModel, setDefaultModel] = useState<string>(card.defaultModel)
  const [name, setName] = useState<string>(card.name || '')

  const [fetchedModels, setFetchedModels] = useState<ProviderModelInfo[]>([])
  const [fetchingModels, setFetchingModels] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [useCustomModel, setUseCustomModel] = useState(preset === 'custom')

  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{
    ok: boolean
    reply?: string
    error?: string
  } | null>(null)

  const [success, setSuccess] = useState(false)

  const discovery = useQuery({
    queryKey: ['provider-discovery'],
    queryFn: () => api.config.discoverLocal(),
    staleTime: 10_000,
    enabled: card.kind === 'local',
  })
  const detectedProvider = discovery.data?.providers.find(provider => provider.preset === preset && provider.status === 'available')

  useEffect(() => {
    if (!detectedProvider) return
    setBaseURL(detectedProvider.baseURL)
    setFetchedModels(detectedProvider.models)
    if (detectedProvider.models.length > 0) {
      setDefaultModel(current => current || detectedProvider.models[0].id)
      setUseCustomModel(false)
    }
  }, [detectedProvider])

  const addMutation = useMutation({
    mutationFn: (data: {
      name: string
      preset?: string
      baseURL: string
      apiKey: string
      defaultModel: string
      customHeaders?: Record<string, string>
    }) => api.config.addProvider(data),
    onSuccess: () => {
      // Don't invalidate yet — let the celebration screen show first.
      // The parent will invalidate when onComplete is called.
      setSuccess(true)
    },
  })

  const handleFetchModels = async () => {
    setFetchingModels(true)
    setFetchError(null)
    try {
      const result = await api.config.testModels({ baseURL, apiKey, preset, customHeaders: cardHeaders })
      if (result.error) {
        setFetchError(result.error)
      } else {
        setFetchedModels(result.models)
        setUseCustomModel(false)
        // Auto-select first model if current selection is empty or not in the list
        if (result.models.length > 0 && (!defaultModel || !result.models.some(m => m.id === defaultModel))) {
          setDefaultModel(result.models[0].id)
        }
      }
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : 'Failed to fetch models')
    } finally {
      setFetchingModels(false)
    }
  }

  const handleTestConnection = async () => {
    if (!defaultModel) {
      setTestResult({ ok: false, error: 'Model is required to test' })
      return
    }
    if (!baseURL || (card.requiresApiKey && !apiKey)) {
      setTestResult({ ok: false, error: card.requiresApiKey ? 'Base URL and API Key are required' : 'Base URL is required' })
      return
    }
    setTesting(true)
    setTestResult(null)
    try {
      const result = await api.config.testConnection({
        baseURL,
        apiKey,
        model: defaultModel,
        preset,
        customHeaders: cardHeaders,
      })
      setTestResult(result)
    } catch (err) {
      setTestResult({ ok: false, error: err instanceof Error ? err.message : 'Test failed' })
    } finally {
      setTesting(false)
    }
  }

  const cardHeaders = card.customHeaders as Record<string, string>

  const handleSave = () => {
    const providerName = name || card.name || preset
    addMutation.mutate({
      name: providerName,
      preset,
      baseURL,
      apiKey,
      defaultModel,
      ...(Object.keys(cardHeaders).length > 0 ? { customHeaders: cardHeaders } : {}),
    })
  }

  const canSave = (preset === 'custom' ? name.trim() : true)
    && baseURL
    && (!card.requiresApiKey || apiKey)
    && defaultModel

  // ── Success celebration ──
  if (success) {
    return (
      <div className="max-w-md mx-auto text-center px-6">
        <div className="animate-onboarding-check mb-6">
          <div className="size-16 rounded-full bg-emerald-500/10 flex items-center justify-center mx-auto">
            <Check className="size-8 text-emerald-500" />
          </div>
        </div>
        <h2
          className="font-display text-3xl italic mb-2 animate-onboarding-fade-up"
          style={{ animationDelay: '200ms' }}
        >
          You're all set!
        </h2>
        <Caption
          size="sm"
          className="mb-8 animate-onboarding-fade-up"
          style={{ animationDelay: '350ms' }}
        >
          {card.name || name} is configured and ready to go. You can manage providers anytime in
          settings.
        </Caption>
        <div className="animate-onboarding-fade-up" style={{ animationDelay: '500ms' }}>
          <Button onClick={onComplete} className="px-8">
            Start Writing
          </Button>
        </div>
      </div>
    )
  }

  // ── Form ──
  return (
    <div className="max-w-md mx-auto px-6 w-full">
      <div className="text-center mb-8 animate-onboarding-fade-up">
        <div className="flex items-center justify-center gap-2 mb-2">
          <div className={`size-7 rounded-lg ${accent.bg} flex items-center justify-center`}>
            <Server className={`size-3.5 ${accent.text}`} />
          </div>
          <h2 className="font-display text-3xl italic">
            {preset === 'custom' ? 'Custom Provider' : card.name}
          </h2>
        </div>
        <Caption size="sm">
          Enter your credentials to get started.
        </Caption>
      </div>

      <div
        className="space-y-4 animate-onboarding-fade-up"
        style={{ animationDelay: '100ms' }}
      >
        {/* Name (only for custom) */}
        {preset === 'custom' && (
          <div>
            <label htmlFor="onboarding-provider-name" className="mb-1.5 block text-xs font-medium text-muted-foreground">Provider Name</label>
            <Input
              id="onboarding-provider-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-9"
              placeholder="My Provider"
            />
          </div>
        )}

        {/* API Key */}
        <div>
          <label htmlFor="onboarding-provider-api-key" className="mb-1.5 block text-xs font-medium text-muted-foreground">API Key{card.requiresApiKey ? '' : ' (optional)'}</label>
          <Input
            id="onboarding-provider-api-key"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            className="h-9"
            placeholder={card.requiresApiKey ? 'Enter your API key' : 'Leave blank for a keyless local server'}
            autoFocus
          />
        </div>

        {/* Base URL */}
        <div>
          <label htmlFor="onboarding-provider-base-url" className="mb-1.5 block text-xs font-medium text-muted-foreground">Base URL</label>
          <Input
            id="onboarding-provider-base-url"
            value={baseURL}
            onChange={(e) => setBaseURL(e.target.value)}
            className="h-9"
            placeholder="https://api.example.com/v1"
          />
        </div>

        {/* Default Model */}
        <div>
          <label htmlFor="onboarding-provider-model" className="mb-1.5 block text-xs font-medium text-muted-foreground">Default Model</label>
          <div className="flex gap-2">
            {fetchedModels.length > 0 && !useCustomModel ? (
              <SettingsSelect
                id="onboarding-provider-model"
                value={defaultModel}
                onChange={setDefaultModel}
                className="h-9 flex-1 text-sm"
              >
                {!fetchedModels.some((m) => m.id === defaultModel) && defaultModel && (
                  <option value={defaultModel}>{defaultModel} (current)</option>
                )}
                {fetchedModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {modelOptionLabel(m)}
                  </option>
                ))}
              </SettingsSelect>
            ) : (
              <Input
                id="onboarding-provider-model"
                value={defaultModel}
                onChange={(e) => setDefaultModel(e.target.value)}
                className="h-9 flex-1"
                placeholder="e.g. deepseek-v4-flash"
              />
            )}
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-9 text-xs gap-1.5 shrink-0"
              onClick={handleFetchModels}
              disabled={fetchingModels || !baseURL || (card.requiresApiKey && !apiKey)}
            >
              {fetchingModels ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <RefreshCw className="size-3" />
              )}
              Fetch
            </Button>
          </div>
          {(() => {
            const suggested = (card as { models?: readonly string[] }).models ?? []
            return suggested.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                <Eyebrow className="mr-0.5">Suggested</Eyebrow>
                {suggested.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setDefaultModel(m)}
                    className={`rounded-full border px-2 py-0.5 text-ui-caption transition-colors ${defaultModel === m ? 'border-primary/40 bg-primary/10 text-foreground' : 'border-border/50 text-muted-foreground hover:bg-accent/40 hover:text-foreground/80'}`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            ) : null
          })()}
          {fetchedModels.length > 0 && (
            <button
              type="button"
              className="mt-1 text-ui-caption text-muted-foreground underline hover:text-foreground"
              onClick={() => setUseCustomModel(!useCustomModel)}
            >
              {useCustomModel ? 'Use fetched models' : 'Enter model ID manually'}
            </button>
          )}
          {fetchError && <Hint className="mt-1 text-destructive">{fetchError}</Hint>}
          {fetchedModels.length > 0 && !fetchError && (
            <Hint className="mt-1">
              {fetchedModels.length} models available
            </Hint>
          )}
        </div>

        {/* Test result */}
        {testResult && (
          <div
            className={`text-sm rounded-md p-3 ${testResult.ok ? 'bg-emerald-500/10 text-emerald-400' : 'bg-destructive/10 text-destructive'}`}
          >
            {testResult.ok ? (
              <p>
                <span className="font-medium">Success:</span> {testResult.reply}
              </p>
            ) : (
              <p>
                <span className="font-medium">Error:</span> {testResult.error}
              </p>
            )}
          </div>
        )}

        {/* Mutation error */}
        {addMutation.isError && (
          <div className="text-sm rounded-md p-3 bg-destructive/10 text-destructive">
            <p>
              <span className="font-medium">Error:</span>{' '}
              {addMutation.error instanceof Error ? addMutation.error.message : 'Failed to save'}
            </p>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-2 pt-2">
          <Button onClick={handleSave} disabled={!canSave || addMutation.isPending} className="flex-1">
            {addMutation.isPending ? 'Saving...' : 'Save & Continue'}
          </Button>
          <Button
            variant="outline"
            onClick={handleTestConnection}
            disabled={testing || !defaultModel || !baseURL || (card.requiresApiKey && !apiKey)}
            className="gap-1.5"
          >
            {testing ? <Loader2 className="size-3 animate-spin" /> : <Zap className="size-3" />}
            Test
          </Button>
        </div>
      </div>

      <div
        className="flex items-center justify-center mt-8 animate-onboarding-fade-up"
        style={{ animationDelay: '250ms' }}
      >
        <Wizard.BackButton tone="link" onBack={onBack} />
      </div>
    </div>
  )
}
