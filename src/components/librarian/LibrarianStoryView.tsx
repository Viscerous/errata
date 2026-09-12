import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, BookOpen, ChevronDown, ChevronRight, Clock, Lightbulb, Sparkles } from 'lucide-react'
import {
  api,
  type LibrarianAnalysis,
  type LibrarianAnalysisSummary,
  type LibrarianStatusResponse,
} from '@/lib/api'
import { q, qk, useActiveBranchId } from '@/lib/query-keys'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { EmptyState } from '@/components/ui/async-view'
import { RefinementPanel } from '@/components/refinement/RefinementPanel'
import { FragmentTypeDisplayIcon } from '@/components/fragments/fragment-type-icons'
import { SettingsSelect } from '@/components/settings/primitives'
import { LibrarianAnalysisCard } from './LibrarianAnalysisCard'
import { buildMentionGroups, type MentionGroup } from './librarian-mention-groups'
import { useLiveAnalysisProgress } from './use-live-analysis-progress'
import { mentionLinkCount } from '@/components/sidebar/librarian-panel-helpers'

interface LibrarianStoryViewProps {
  storyId: string
  status?: LibrarianStatusResponse
  onOpenChat?: (message: string) => void
}

export function LibrarianStoryView({ storyId, status, onOpenChat }: LibrarianStoryViewProps) {
  const [refineTarget, setRefineTarget] = useState<{ fragmentId: string; fragmentName: string } | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [liveExpanded, setLiveExpanded] = useState(true)
  const [showAllAnalyses, setShowAllAnalyses] = useState(false)
  const branchId = useActiveBranchId(storyId)
  const liveProgress = useLiveAnalysisProgress(storyId, status?.runStatus === 'running')

  const { data: characters } = useQuery(q.fragments(storyId, branchId, 'character'))
  const { data: guidelines } = useQuery(q.fragments(storyId, branchId, 'guideline'))
  const { data: knowledge } = useQuery(q.fragments(storyId, branchId, 'knowledge'))
  const { data: allFragments } = useQuery(q.fragments(storyId, branchId))
  const { data: story } = useQuery({ queryKey: ['story', storyId], queryFn: () => api.stories.get(storyId) })
  const { data: analyses } = useQuery({
    queryKey: qk.librarianAnalyses(storyId, branchId),
    queryFn: () => api.librarian.listAnalyses(storyId),
    refetchInterval: 5000,
  })
  const { data: expandedAnalysis } = useQuery({
    queryKey: ['librarian-analysis', storyId, expandedId],
    queryFn: () => api.librarian.getAnalysis(storyId, expandedId!),
    enabled: !!expandedId,
  })

  const refinableFragments = useMemo(() => [...(characters ?? []), ...(guidelines ?? []), ...(knowledge ?? [])].filter(fragment => !fragment.archived), [characters, guidelines, knowledge])
  const fragmentById = useMemo(() => new Map((allFragments ?? []).map(fragment => [fragment.id, fragment])), [allFragments])
  const customTypeByType = useMemo(() => new Map((story?.settings.customFragmentTypes ?? []).map(definition => [definition.type, definition])), [story?.settings.customFragmentTypes])
  const fragmentName = (id: string) => characters?.find(fragment => fragment.id === id)?.name
    ?? knowledge?.find(fragment => fragment.id === id)?.name
    ?? fragmentById.get(id)?.name
    ?? id

  useEffect(() => { if (liveProgress) setLiveExpanded(true) }, [liveProgress?.fragmentId])

  const liveAnalysis = useMemo<LibrarianAnalysis | null>(() => liveProgress ? {
    id: `live-${liveProgress.fragmentId}`,
    createdAt: new Date().toISOString(),
    fragmentId: liveProgress.fragmentId,
    summaryUpdate: liveProgress.summaryUpdate,
    continuityProjection: liveProgress.continuityProjection,
    mentions: liveProgress.mentions,
    contradictions: liveProgress.contradictions,
    fragmentChangeProposals: liveProgress.fragmentChangeProposals,
    timelineEvents: liveProgress.timelineEvents,
    directions: liveProgress.directions,
  } : null, [liveProgress])
  const liveSummary = useMemo<LibrarianAnalysisSummary | null>(() => liveAnalysis ? {
    id: liveAnalysis.id,
    createdAt: liveAnalysis.createdAt,
    fragmentId: liveAnalysis.fragmentId,
    contradictionCount: liveAnalysis.contradictions.length,
    suggestionCount: liveAnalysis.fragmentChangeProposals.length,
    pendingSuggestionCount: liveAnalysis.fragmentChangeProposals.length,
    timelineEventCount: liveAnalysis.timelineEvents.length,
    directionsCount: liveAnalysis.directions?.length ?? 0,
    hasContinuityProjection: true,
  } : null, [liveAnalysis])

  const totalContradictions = (analyses?.reduce((count, item) => count + item.contradictionCount, 0) ?? 0) + (liveSummary?.contradictionCount ?? 0)
  const totalSuggestions = (analyses?.reduce((count, item) => count + item.pendingSuggestionCount, 0) ?? 0) + (liveSummary?.pendingSuggestionCount ?? 0)
  const mentionGroups = status ? buildMentionGroups(Object.entries(status.recentMentions ?? {}), fragmentById, customTypeByType) : []
  const hasTimeline = !!status?.timeline?.length

  return (
    <ScrollArea className="h-full" data-component-id="librarian-story-view">
      <div className="space-y-2 px-4 py-3">
        {(totalContradictions > 0 || totalSuggestions > 0) && (
          <section>
            <SectionLabel>Findings</SectionLabel>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {totalContradictions > 0 && <Badge variant="destructive" className="h-5 gap-1 text-ui-label"><AlertTriangle />{totalContradictions} contradiction{totalContradictions === 1 ? '' : 's'}</Badge>}
              {totalSuggestions > 0 && <Badge variant="secondary" className="h-5 gap-1 text-ui-label"><Lightbulb />{totalSuggestions} suggestion{totalSuggestions === 1 ? '' : 's'}</Badge>}
            </div>
          </section>
        )}

        {liveAnalysis && liveSummary && liveProgress && (
          <section>
            <SectionLabel>Analysis in progress</SectionLabel>
            <div className="mt-1.5"><LibrarianAnalysisCard storyId={storyId} summary={liveSummary} expanded={liveExpanded} analysis={liveAnalysis} onToggle={() => setLiveExpanded(value => !value)} charName={fragmentName} fragmentById={fragmentById} customTypeByType={customTypeByType} provisionalStage={liveProgress.stage} /></div>
          </section>
        )}

        {!!analyses?.length && (
          <section>
            <SectionLabel>Analyses</SectionLabel>
            <div className="mt-1.5 space-y-1.5">
              {(showAllAnalyses ? analyses : analyses.slice(0, 6)).map(summary => (
                <LibrarianAnalysisCard key={summary.id} storyId={storyId} summary={summary} expanded={expandedId === summary.id} analysis={expandedId === summary.id ? expandedAnalysis ?? null : null} onToggle={() => setExpandedId(expandedId === summary.id ? null : summary.id)} onOpenChat={onOpenChat} charName={fragmentName} fragmentById={fragmentById} customTypeByType={customTypeByType} />
              ))}
              {!showAllAnalyses && analyses.length > 6 && <Button type="button" size="xs" variant="ghost" className="w-full text-muted-foreground" onClick={() => setShowAllAnalyses(true)}>Show {analyses.length - 6} more</Button>}
            </div>
          </section>
        )}

        {!analyses?.length && mentionGroups.length === 0 && !hasTimeline && !liveAnalysis && (
          <EmptyState icon={<BookOpen className="size-5" />} title="Nothing tracked yet" hint="Generate some prose and the librarian will annotate your story here." variant="panel" />
        )}

        <MentionGroupList groups={mentionGroups} fragmentName={fragmentName} customTypeByType={customTypeByType} />

        {hasTimeline && status && (
          <section>
            <SectionLabel icon={<Clock />}>Timeline</SectionLabel>
            <div className="relative mt-1.5">
              <div className="absolute bottom-2 left-[5px] top-2 w-px bg-border/40" />
              {status.timeline.slice(-10).map((entry, index) => (
                <div key={`${entry.fragmentId}-${entry.event}-${index}`} className="relative flex items-start gap-2.5 py-1">
                  <span className="relative z-10 mt-[5px] size-[7px] shrink-0 rounded-full bg-muted-foreground/20 ring-2 ring-background" />
                  <span className="min-w-0"><span className="block text-ui-label leading-snug text-foreground/65">{entry.event}</span><span className="font-mono text-ui-label text-muted-foreground">{entry.fragmentId}</span></span>
                </div>
              ))}
            </div>
          </section>
        )}

        <section>
          <SectionLabel icon={<Sparkles />}>Refine</SectionLabel>
          <div className="mt-1.5">
            {refineTarget ? (
              <RefinementPanel storyId={storyId} fragmentId={refineTarget.fragmentId} fragmentName={refineTarget.fragmentName} onComplete={() => setRefineTarget(null)} onClose={() => setRefineTarget(null)} />
            ) : refinableFragments.length > 0 ? (
              <SettingsSelect aria-label="Fragment to refine" className="h-8 w-full cursor-pointer text-ui-label text-muted-foreground" value="" onChange={value => { const fragment = refinableFragments.find(item => item.id === value); if (fragment) setRefineTarget({ fragmentId: fragment.id, fragmentName: fragment.name }) }}>
                <option value="" disabled>Select a fragment to refine...</option>
                {refinableFragments.map(fragment => <option key={fragment.id} value={fragment.id}>{fragment.name} ({fragment.type})</option>)}
              </SettingsSelect>
            ) : <p className="text-ui-label italic text-muted-foreground">No fragments to refine yet.</p>}
          </div>
        </section>
      </div>
    </ScrollArea>
  )
}

function SectionLabel({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return <div className="flex items-center gap-1.5 pb-0.5 pt-2"><span className="text-muted-foreground [&_svg]:size-3">{icon}</span><h4 className="text-ui-label font-medium uppercase tracking-[0.15em] text-muted-foreground">{children}</h4></div>
}

function MentionGroupList({ groups, fragmentName, customTypeByType }: { groups: MentionGroup[]; fragmentName: (id: string) => string; customTypeByType: Parameters<typeof FragmentTypeDisplayIcon>[0]['customTypes'] }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  return <>{groups.map(group => {
    const open = !!expanded[group.type]
    const mentionCount = mentionLinkCount(group.entries)
    return (
      <section key={group.type}>
        <button type="button" onClick={() => setExpanded(current => ({ ...current, [group.type]: !open }))} aria-expanded={open} className="flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left transition-colors hover:bg-accent/25">
          {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          <FragmentTypeDisplayIcon type={group.type} customTypes={customTypeByType} className="size-3" />
          <span className="text-ui-label font-medium uppercase tracking-[0.15em] text-muted-foreground">{group.visual.label}</span>
          <span className="ml-auto font-mono text-ui-label text-muted-foreground">{mentionCount} mention{mentionCount === 1 ? '' : 's'}</span>
        </button>
        {open && <div className="mt-1 space-y-0.5">{group.entries.map(([fragmentId, sources]) => <div key={fragmentId} className="flex items-center justify-between rounded-md px-2 py-1 transition-colors hover:bg-accent/30"><span className="text-ui-label text-foreground/70">{fragmentName(fragmentId)}</span><span className="font-mono text-ui-label text-muted-foreground">{new Set(sources).size}</span></div>)}</div>}
      </section>
    )
  })}</>
}
