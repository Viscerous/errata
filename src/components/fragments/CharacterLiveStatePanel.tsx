import { useState, useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Activity,
  BookOpen,
  EyeOff,
  Layers,
  Pencil,
  Plus,
  Trash2,
  Check,
  Loader2,
} from 'lucide-react'
import { api, type Fragment } from '@/lib/api'
import { q, qk, useActiveBranchId } from '@/lib/query-keys'
import { normalizeContinuityKey } from '@/lib/continuity-keys'
import { Eyebrow, EmptyHint, Hint } from '@/components/ui/prose-text'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface CharacterLiveStatePanelProps {
  storyId: string
  fragment: Fragment
}

interface StateRow {
  key: string
  value: string
}

export function CharacterLiveStatePanel({ storyId, fragment }: CharacterLiveStatePanelProps) {
  const queryClient = useQueryClient()
  const branchId = useActiveBranchId(storyId)

  const { data: continuityData, isLoading } = useQuery({
    ...q.librarianContinuity(storyId, branchId),
    enabled: !!storyId,
  })

  // Match live character state from the folded view or fallback to authored meta.liveState
  const foldedState = useMemo(() => {
    const characters = continuityData?.view?.characterStates ?? continuityData?.ledger?.characterStates ?? []
    const found = characters.find(
      (c) =>
        c.characterId === fragment.id ||
        (c.name && fragment.name && normalizeContinuityKey(c.name) === normalizeContinuityKey(fragment.name)),
    )
    if (found) return found

    const authored = (fragment.meta?.liveState as {
      immediate?: string
      state?: Record<string, string>
      knowledge?: string[]
      secrets?: string[]
    } | undefined)

    if (authored) {
      return {
        characterId: fragment.id,
        name: fragment.name,
        immediate: authored.immediate,
        state: authored.state ?? {},
        knowledge: authored.knowledge ?? [],
        secrets: authored.secrets ?? [],
        sourceFragmentId: fragment.id,
        analysisId: 'authored',
        narrativePosition: 0,
      }
    }

    return null
  }, [continuityData, fragment.id, fragment.name, fragment.meta?.liveState])

  const [isEditing, setIsEditing] = useState(false)
  const [immediate, setImmediate] = useState('')
  const [stateRows, setStateRows] = useState<StateRow[]>([])
  const [knowledgeList, setKnowledgeList] = useState<string[]>([])
  const [secretsList, setSecretsList] = useState<string[]>([])

  // Synchronize form values when entering edit mode or when foldedState changes
  const resetForm = () => {
    setImmediate(foldedState?.immediate ?? '')
    setStateRows(
      foldedState?.state
        ? Object.entries(foldedState.state).map(([key, value]) => ({ key, value }))
        : [],
    )
    setKnowledgeList(foldedState?.knowledge ?? [])
    setSecretsList(foldedState?.secrets ?? [])
  }

  const startEditing = () => {
    resetForm()
    setIsEditing(true)
  }

  const cancelEditing = () => {
    setIsEditing(false)
    resetForm()
  }

  const updateMutation = useMutation({
    mutationFn: async () => {
      const stateObj: Record<string, string> = {}
      for (const row of stateRows) {
        const k = row.key.trim()
        const v = row.value.trim()
        if (k && v) stateObj[k] = v
      }
      const cleanKnowledge = knowledgeList.map((k) => k.trim()).filter(Boolean)
      const cleanSecrets = secretsList.map((s) => s.trim()).filter(Boolean)

      return api.librarian.updateCharacterLiveState(storyId, fragment.id, {
        immediate: immediate.trim() || undefined,
        state: stateObj,
        knowledge: cleanKnowledge,
        secrets: cleanSecrets,
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: qk.librarianContinuity(storyId, branchId) })
      queryClient.invalidateQueries({ queryKey: qk.librarianAnalyses(storyId, branchId) })
      queryClient.invalidateQueries({ queryKey: qk.fragment(storyId, branchId, fragment.id) })
      setIsEditing(false)
    },
  })

  const hasContent = Boolean(
    foldedState &&
      (foldedState.immediate ||
        (foldedState.state && Object.keys(foldedState.state).length > 0) ||
        (foldedState.knowledge && foldedState.knowledge.length > 0) ||
        (foldedState.secrets && foldedState.secrets.length > 0)),
  )

  return (
    <section className="space-y-4 px-6 py-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Eyebrow>Live Character State</Eyebrow>
          {foldedState && (
            <Badge variant="outline" className="text-[10px] text-muted-foreground font-normal py-0">
              {foldedState.analysisId === 'authored' ? 'Authored Seed' : 'Folded Memory'}
            </Badge>
          )}
        </div>
        {!isEditing && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 text-xs gap-1.5"
            onClick={startEditing}
          >
            <Pencil className="size-3" />
            {hasContent ? 'Edit State' : 'Initialize State'}
          </Button>
        )}
      </div>

      {isLoading && !foldedState && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
          <Loader2 className="size-3.5 animate-spin" />
          Loading continuity projection...
        </div>
      )}

      {isEditing ? (
        <div className="space-y-5 rounded-md border border-border/60 bg-muted/20 p-4">
          {/* Immediate Kinetic Posture */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium flex items-center gap-1.5 text-foreground">
              <Activity className="size-3.5 text-amber-500" />
              Immediate Scene Posture
            </label>
            <Hint className="text-[11px]">
              Tactile or kinetic beat for the current scene (e.g. &quot;tense posture; catching breath after sprint&quot;).
            </Hint>
            <Input
              value={immediate}
              onChange={(e) => setImmediate(e.target.value)}
              placeholder="Immediate posture or action beat..."
              className="text-xs h-8"
            />
          </div>

          {/* Dynamic Physical State Keys */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium flex items-center gap-1.5 text-foreground">
                <Layers className="size-3.5 text-blue-500" />
                Dynamic State (Attire, Gear, Injuries, Status)
              </label>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-6 text-[11px] gap-1 px-2"
                onClick={() => setStateRows((prev) => [...prev, { key: '', value: '' }])}
              >
                <Plus className="size-3" /> Add Key
              </Button>
            </div>
            {stateRows.length === 0 ? (
              <EmptyHint asChild>
                <span className="text-xs">No dynamic state keys. Click &quot;Add Key&quot; to define attire, gear, or conditions.</span>
              </EmptyHint>
            ) : (
              <div className="space-y-1.5">
                {stateRows.map((row, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <Input
                      value={row.key}
                      onChange={(e) => {
                        const val = e.target.value
                        setStateRows((prev) => prev.map((r, i) => (i === idx ? { ...r, key: val } : r)))
                      }}
                      placeholder="Key (e.g. attire, gear, injuries)"
                      className="text-xs h-7 w-1/3"
                    />
                    <Input
                      value={row.value}
                      onChange={(e) => {
                        const val = e.target.value
                        setStateRows((prev) => prev.map((r, i) => (i === idx ? { ...r, value: val } : r)))
                      }}
                      placeholder="Value (e.g. grey coat, brass compass)"
                      className="text-xs h-7 flex-1"
                    />
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="size-7 text-muted-foreground hover:text-destructive"
                      onClick={() => setStateRows((prev) => prev.filter((_, i) => i !== idx))}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Active Knowledge */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium flex items-center gap-1.5 text-foreground">
                <BookOpen className="size-3.5 text-emerald-500" />
                Knowledge (Active scene facts &amp; discoveries)
              </label>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-6 text-[11px] gap-1 px-2"
                onClick={() => setKnowledgeList((prev) => [...prev, ''])}
              >
                <Plus className="size-3" /> Add Fact
              </Button>
            </div>
            {knowledgeList.length === 0 ? (
              <EmptyHint asChild>
                <span className="text-xs">No active scene knowledge entries.</span>
              </EmptyHint>
            ) : (
              <div className="space-y-1.5">
                {knowledgeList.map((item, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <Input
                      value={item}
                      onChange={(e) => {
                        const val = e.target.value
                        setKnowledgeList((prev) => prev.map((it, i) => (i === idx ? val : it)))
                      }}
                      placeholder="Known fact or witnessed event..."
                      className="text-xs h-7 flex-1"
                    />
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="size-7 text-muted-foreground hover:text-destructive"
                      onClick={() => setKnowledgeList((prev) => prev.filter((_, i) => i !== idx))}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Secrets & Deceptions */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium flex items-center gap-1.5 text-foreground">
                <EyeOff className="size-3.5 text-rose-500" />
                Secrets (Private motives, withheld facts)
              </label>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-6 text-[11px] gap-1 px-2"
                onClick={() => setSecretsList((prev) => [...prev, ''])}
              >
                <Plus className="size-3" /> Add Secret
              </Button>
            </div>
            {secretsList.length === 0 ? (
              <EmptyHint asChild>
                <span className="text-xs">No active secret entries.</span>
              </EmptyHint>
            ) : (
              <div className="space-y-1.5">
                {secretsList.map((item, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <Input
                      value={item}
                      onChange={(e) => {
                        const val = e.target.value
                        setSecretsList((prev) => prev.map((it, i) => (i === idx ? val : it)))
                      }}
                      placeholder="Withheld secret or hidden goal..."
                      className="text-xs h-7 flex-1"
                    />
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="size-7 text-muted-foreground hover:text-destructive"
                      onClick={() => setSecretsList((prev) => prev.filter((_, i) => i !== idx))}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Form Actions */}
          <div className="flex items-center justify-end gap-2 pt-2 border-t border-border/50">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={cancelEditing}
              disabled={updateMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-7 text-xs gap-1.5"
              onClick={() => updateMutation.mutate()}
              disabled={updateMutation.isPending}
            >
              {updateMutation.isPending ? (
                <>
                  <Loader2 className="size-3 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Check className="size-3" />
                  Save State
                </>
              )}
            </Button>
          </div>
        </div>
      ) : !hasContent ? (
        <EmptyHint asChild>
          <div className="py-2 text-xs">
            No working memory recorded for this character yet. It updates automatically when passages are analyzed, or you can initialize it manually.
          </div>
        </EmptyHint>
      ) : (
        <div className="space-y-3.5 rounded-lg border border-border/50 bg-card/40 p-4 text-xs">
          {/* Immediate Posture */}
          {foldedState?.immediate && (
            <div className="flex items-start gap-2.5 rounded-md bg-amber-500/10 border border-amber-500/20 px-3 py-2 text-foreground">
              <Activity className="size-3.5 text-amber-500 shrink-0 mt-0.5" />
              <div>
                <span className="font-medium text-amber-600 dark:text-amber-400 mr-1.5">Immediate:</span>
                <span>{foldedState.immediate}</span>
              </div>
            </div>
          )}

          {/* Dynamic State Badges */}
          {foldedState?.state && Object.keys(foldedState.state).length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 text-muted-foreground mb-1.5">
                <Layers className="size-3 text-blue-400" />
                <span className="font-medium text-[11px] uppercase tracking-wider">Dynamic State</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(foldedState.state).map(([key, value]) => (
                  <Badge
                    key={key}
                    variant="secondary"
                    className="text-xs px-2 py-0.5 border border-border/40 font-normal"
                  >
                    <span className="text-muted-foreground font-medium mr-1.5">{key}:</span>
                    <span>{value}</span>
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Knowledge */}
          {foldedState?.knowledge && foldedState.knowledge.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 text-muted-foreground mb-1.5">
                <BookOpen className="size-3 text-emerald-400" />
                <span className="font-medium text-[11px] uppercase tracking-wider">Knowledge</span>
              </div>
              <ul className="space-y-1 list-disc list-inside text-muted-foreground pl-1">
                {foldedState.knowledge.map((item, idx) => (
                  <li key={idx} className="text-foreground/90 leading-relaxed">
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Secrets */}
          {foldedState?.secrets && foldedState.secrets.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 text-muted-foreground mb-1.5">
                <EyeOff className="size-3 text-rose-400" />
                <span className="font-medium text-[11px] uppercase tracking-wider">Secrets</span>
              </div>
              <ul className="space-y-1 list-disc list-inside text-muted-foreground pl-1">
                {foldedState.secrets.map((item, idx) => (
                  <li key={idx} className="text-foreground/90 leading-relaxed italic">
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
