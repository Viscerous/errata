import { useState, useRef, useCallback, useMemo } from 'react'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { BlockOverride, CustomBlockDefinition, AgentBlockInfo, StoryMeta } from '@/lib/api/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner, EmptyState } from '@/components/ui/async-view'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  ChevronLeft,
  Eye,
  Download,
  Upload,
} from 'lucide-react'
import { AgentBlockConfigSchema, type AgentBlockConfig } from '@/contracts/block-config'
import { BlockContentView } from '@/components/blocks/BlockContentView'
import { AgentCatalog } from './AgentCatalog'
import { AgentModelControls } from './AgentModelControls'
import { AgentToolControls, AutoAnalysisControl } from './AgentToolControls'
import { AgentPromptBlocks, type AgentPromptBlock } from './AgentPromptBlocks'

interface AgentConfigurePanelProps {
  storyId: string
}

function generateCustomBlockId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let id = 'cb-'
  for (let i = 0; i < 6; i++) {
    id += chars[Math.floor(Math.random() * chars.length)]
  }
  return id
}

export function AgentConfigurePanel({ storyId }: AgentConfigurePanelProps) {
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null)

  const { data: agents, isLoading } = useQuery({
    queryKey: ['agent-blocks'],
    queryFn: () => api.agentBlocks.list(),
  })

  const { data: story } = useQuery({
    queryKey: ['story', storyId],
    queryFn: () => api.stories.get(storyId),
  })

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Spinner />
      </div>
    )
  }

  if (!agents || agents.length === 0) {
    return (
      <div className="flex items-center justify-center py-24">
        <EmptyState title="No agents registered" />
      </div>
    )
  }

  if (selectedAgent) {
    return (
      <AgentBlockEditor
        storyId={storyId}
        agentName={selectedAgent}
        agents={agents}
        onBack={() => setSelectedAgent(null)}
      />
    )
  }

  const generationMode = story?.settings.generationMode ?? 'standard'
  const visibleAgents = generationMode === 'prewriter'
    ? agents
    : agents.filter((a) => a.agentName !== 'generation.prewriter')
  return <AgentCatalog agents={visibleAgents} onSelect={setSelectedAgent} />
}

// --- Agent Block Editor (for a specific agent) ---

interface AgentBlockEditorProps {
  storyId: string
  agentName: string
  agents: AgentBlockInfo[]
  onBack: () => void
}

function AgentBlockEditor({ storyId, agentName, agents, onBack }: AgentBlockEditorProps) {
  const queryClient = useQueryClient()
  const [showPreview, setShowPreview] = useState(false)
  const [pendingImportConfig, setPendingImportConfig] = useState<AgentBlockConfig | null>(null)
  const [transferError, setTransferError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const agent = agents.find(a => a.agentName === agentName)

  const { data, isLoading } = useQuery({
    queryKey: ['agent-blocks', storyId, agentName],
    queryFn: () => api.agentBlocks.get(storyId, agentName),
  })

  const { data: previewData, isLoading: previewLoading } = useQuery({
    queryKey: ['agent-block-preview', storyId, agentName],
    queryFn: () => api.agentBlocks.preview(storyId, agentName),
    enabled: showPreview,
  })

  // Model selection queries
  const { data: story } = useQuery({
    queryKey: ['story', storyId],
    queryFn: () => api.stories.get(storyId),
  })

  const { data: globalConfig } = useQuery({
    queryKey: ['global-config'],
    queryFn: () => api.config.getProviders(),
  })

  const { data: modelRoles } = useQuery({
    queryKey: ['model-roles'],
    queryFn: () => api.agentBlocks.listModelRoles(),
  })

  const modelOverrideMutation = useMutation({
    mutationFn: (data: { modelOverrides: StoryMeta['settings']['modelOverrides'] }) =>
      api.settings.update(storyId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['story', storyId] })
    },
  })

  const configMutation = useMutation({
    mutationFn: (params: { overrides?: Record<string, BlockOverride>; blockOrder?: string[]; disabledTools?: string[]; disableAutoAnalysis?: boolean }) =>
      api.agentBlocks.updateConfig(storyId, agentName, params),
    onSuccess: (_config, variables) => {
      queryClient.invalidateQueries({ queryKey: ['agent-blocks', storyId, agentName] })
      if (variables.disableAutoAnalysis !== undefined) {
        queryClient.invalidateQueries({ queryKey: ['librarian-analysis-index', storyId] })
      }
    },
  })

  const createMutation = useMutation({
    mutationFn: (block: CustomBlockDefinition) =>
      api.agentBlocks.createCustom(storyId, agentName, block),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agent-blocks', storyId, agentName] })
    },
  })

  const updateCustomMutation = useMutation({
    mutationFn: ({ blockId, updates }: { blockId: string; updates: Partial<Omit<CustomBlockDefinition, 'id'>> }) =>
      api.agentBlocks.updateCustom(storyId, agentName, blockId, updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agent-blocks', storyId, agentName] })
    },
  })

  const deleteCustomMutation = useMutation({
    mutationFn: (blockId: string) =>
      api.agentBlocks.deleteCustom(storyId, agentName, blockId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agent-blocks', storyId, agentName] })
    },
  })

  const mergedBlocks = useMemo((): AgentPromptBlock[] => {
    if (!data) return []

    const { config, builtinBlocks } = data
    const blockOrder = config.blockOrder
    const orderMap = new Map(blockOrder.map((id, i) => [id, i]))

    const blocks: AgentPromptBlock[] = []

    for (const b of builtinBlocks) {
      const override = config.overrides[b.id]
      blocks.push({
        id: b.id,
        name: b.name ?? b.id,
        role: b.role,
        order: orderMap.get(b.id) ?? b.order,
        source: 'builtin',
        enabled: override?.enabled !== false,
        content: b.content,
        contentPreview: b.contentPreview,
        override,
      })
    }

    for (const cb of config.customBlocks) {
      const override = config.overrides[cb.id]
      blocks.push({
        id: cb.id,
        name: cb.name,
        role: cb.role,
        order: orderMap.get(cb.id) ?? cb.order,
        source: 'custom',
        enabled: (override?.enabled !== false) && cb.enabled,
        content: cb.content,
        contentPreview: cb.content.slice(0, 200),
        customDef: cb,
        override,
      })
    }

    blocks.sort((a, b) => {
      if (a.role !== b.role) return a.role === 'system' ? -1 : 1
      return a.order - b.order
    })

    return blocks
  }, [data])

  const disabledTools = useMemo(() => new Set(data?.config.disabledTools ?? []), [data])

  const handleContentModeChange = useCallback((blockId: string, mode: 'override' | 'prepend' | 'append' | null) => {
    const block = mergedBlocks.find((item) => item.id === blockId)
    const existingOverride = block?.override
    const shouldSeedDefault =
      mode === 'override'
      && block?.source === 'builtin'
      && !existingOverride?.customContent
    const shouldClearSeededDefault =
      (mode === 'prepend' || mode === 'append')
      && block?.source === 'builtin'
      && existingOverride?.customContent === block.content

    configMutation.mutate({
      overrides: {
        [blockId]: {
          contentMode: mode,
          ...(shouldSeedDefault ? { customContent: block.content } : {}),
          ...(shouldClearSeededDefault ? { customContent: '' } : {}),
        },
      },
    })
  }, [configMutation, mergedBlocks])

  const handleCustomContentChange = useCallback((blockId: string, content: string) => {
    configMutation.mutate({
      overrides: { [blockId]: { customContent: content } },
    })
  }, [configMutation])

  const handleCreateBlock = useCallback((blockData: {
    name: string
    role: 'system' | 'user'
    type: 'simple' | 'script'
    content: string
  }) => {
    const maxOrder = mergedBlocks.reduce((max, b) => Math.max(max, b.order), 0)
    createMutation.mutate({
      id: generateCustomBlockId(),
      name: blockData.name,
      role: blockData.role,
      order: maxOrder + 100,
      enabled: true,
      type: blockData.type,
      content: blockData.content,
    })
  }, [createMutation, mergedBlocks])


  const handleExport = useCallback(async () => {
    setTransferError(null)
    try {
      const exported = await api.agentBlocks.exportConfig(storyId, agentName)
      const blob = new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${agentName}-context.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch (error) {
      setTransferError(error instanceof Error ? error.message : 'Could not export agent configuration')
    }
  }, [storyId, agentName])

  const importFile = useCallback(async (file: File) => {
    setTransferError(null)
    try {
      const text = await file.text()
      const json: unknown = JSON.parse(text)
      const candidate = typeof json === 'object' && json !== null && 'config' in json
        ? (json as { config: unknown }).config
        : json
      const parsed = AgentBlockConfigSchema.safeParse(candidate)
      if (!parsed.success) throw new Error('This file is not a valid agent configuration')
      setPendingImportConfig(parsed.data)
    } catch (error) {
      setTransferError(error instanceof Error ? error.message : 'Could not read agent configuration')
    }
  }, [])

  const confirmImport = useCallback(async () => {
    if (!pendingImportConfig) return
    setTransferError(null)
    try {
      await api.agentBlocks.importConfig(storyId, agentName, pendingImportConfig)
      queryClient.invalidateQueries({ queryKey: ['agent-blocks', storyId, agentName] })
      setPendingImportConfig(null)
    } catch (error) {
      setTransferError(error instanceof Error ? error.message : 'Could not import agent configuration')
    }
  }, [pendingImportConfig, storyId, agentName, queryClient])

  const handleImport = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) await importFile(file)
    e.target.value = ''
  }, [importFile])


  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Spinner />
      </div>
    )
  }

  if (!data) {
    return (
      <div className="flex items-center justify-center py-24">
        <EmptyState title="Could not load agent blocks" />
      </div>
    )
  }

  const availableTools = data.availableTools ?? []

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header with back button */}
      <div className="border-b border-border/30 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="shrink-0 size-7 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent/30 transition-all"
            onClick={onBack}
            aria-label="Back to agents"
          >
            <ChevronLeft className="size-4" />
          </button>
          <p className="min-w-0 flex-1 truncate text-ui-caption font-medium">{agent?.displayName ?? agentName}</p>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              className="size-7 p-0"
              onClick={handleExport}
              title="Export config"
              aria-label="Export agent configuration"
            >
              <Download className="size-3.5" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="size-7 p-0"
              onClick={() => fileInputRef.current?.click()}
              title="Import config"
              aria-label="Import agent configuration"
            >
              <Upload className="size-3.5" />
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json"
              className="hidden"
              onChange={handleImport}
            />
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs gap-1.5"
              onClick={() => setShowPreview(true)}
            >
              <Eye className="size-3" />
              Preview
            </Button>
          </div>
        </div>
        {agent?.description && (
          <p className="mt-1 pl-9 text-ui-label leading-snug text-muted-foreground">
            {agent.description}
          </p>
        )}
      </div>

      {transferError && (
        <p className="px-3 py-2 border-b border-destructive/20 bg-destructive/5 text-ui-label text-destructive">
          {transferError}
        </p>
      )}

      <ScrollArea className="flex-1 min-h-0 [&>[data-slot=scroll-area-viewport]>div]:!block">
        <div className="px-3 py-3 space-y-3">
          {agent && story && (
            <AgentModelControls
              agent={agent}
              story={story}
              globalConfig={globalConfig ?? null}
              roles={modelRoles ?? []}
              pending={modelOverrideMutation.isPending}
              onChange={(modelOverrides) => modelOverrideMutation.mutate({ modelOverrides })}
            />
          )}

          {agentName === 'librarian.analyze' && (
            <AutoAnalysisControl
              disabled={data.config.disableAutoAnalysis ?? false}
              pending={configMutation.isPending}
              onChange={(disableAutoAnalysis) => configMutation.mutate({ disableAutoAnalysis })}
            />
          )}

          <AgentToolControls
            tools={availableTools}
            disabledTools={disabledTools}
            pending={configMutation.isPending}
            onChange={(next) => configMutation.mutate({ disabledTools: next })}
          />

          <AgentPromptBlocks
            storyId={storyId}
            agentName={agentName}
            blocks={mergedBlocks}
            pending={configMutation.isPending}
            onOrderChange={(blockOrder) => configMutation.mutate({ blockOrder })}
            onToggle={(blockId, enabled) => configMutation.mutate({ overrides: { [blockId]: { enabled } } })}
            onModeChange={handleContentModeChange}
            onContentChange={handleCustomContentChange}
            onUpdateCustom={(blockId, updates) => updateCustomMutation.mutate({ blockId, updates })}
            onDeleteCustom={(blockId) => deleteCustomMutation.mutate(blockId)}
            onCreate={handleCreateBlock}
          />
        </div>
      </ScrollArea>

      <Dialog open={showPreview} onOpenChange={setShowPreview}>
        <DialogContent className="sm:max-w-[900px] max-h-[80vh] flex flex-col p-0 gap-0">
          <DialogHeader className="px-5 pt-5 pb-3">
            <DialogTitle className="font-display text-lg flex items-center gap-2.5">
              {agent?.displayName ?? agentName} — Context Preview
              {previewData && (
                <Badge variant="outline" className="text-ui-label font-normal text-muted-foreground">
                  {previewData.blockCount} {previewData.blockCount === 1 ? 'block' : 'blocks'}
                </Badge>
              )}
            </DialogTitle>
          </DialogHeader>

          {previewLoading ? (
            <div className="flex items-center justify-center py-20">
              <Spinner label="Compiling context" />
            </div>
          ) : previewData && previewData.messages.length === 0 && previewData.tools.length === 0 ? (
            <div className="flex items-center justify-center py-20">
              <EmptyState title="No messages in context" />
            </div>
          ) : previewData ? (
            <BlockContentView
              messages={previewData.messages}
              blocks={previewData.blocks}
              tools={previewData.tools}
              toolStages={previewData.toolStages}
              contextWindowTokens={previewData.contextWindowTokens}
              className="border-t border-border/30"
            />
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={!!pendingImportConfig} onOpenChange={(open) => { if (!open) setPendingImportConfig(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Import Agent Config</DialogTitle>
            <DialogDescription>
              Replace the <span className="font-medium text-foreground">{agent?.displayName ?? agentName}</span> context configuration? This will overwrite custom blocks, overrides, and tool settings.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingImportConfig(null)}>Cancel</Button>
            <Button onClick={confirmImport}>Import</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
