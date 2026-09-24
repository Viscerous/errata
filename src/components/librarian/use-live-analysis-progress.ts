import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api, type ChatEvent, type LibrarianAnalysisProgress } from '@/lib/api'

/** Follow the semantic Analyze snapshots carried beside the ordinary tool trace. */
export function useLiveAnalysisProgress(storyId: string, active: boolean) {
  const queryClient = useQueryClient()
  const [progress, setProgress] = useState<LibrarianAnalysisProgress | null>(null)

  useEffect(() => {
    if (!active) {
      // When analysis transitions from active to idle, flush query invalidations
      // and keep the final progress snapshot until the query cache has refreshed,
      // avoiding the highlight flicker where mentions drop before fragments load.
      let unmounted = false
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ['librarian-analyses', storyId] }),
        queryClient.invalidateQueries({ queryKey: ['librarian-analysis-index', storyId] }),
        queryClient.invalidateQueries({ queryKey: ['librarian-status', storyId] }),
        queryClient.invalidateQueries({ queryKey: ['librarian-continuity', storyId] }),
        queryClient.invalidateQueries({ queryKey: ['fragments', storyId] }),
      ]).then(() => {
        if (!unmounted) setProgress(null)
      })
      return () => {
        unmounted = true
      }
    }

    let cancelled = false
    let reader: ReadableStreamDefaultReader<ChatEvent> | null = null

    async function follow() {
      let stream: ReadableStream<ChatEvent> | null = null
      while (!cancelled && !stream) {
        try {
          stream = await api.agents.streamActivity(storyId, 'librarian.analyze')
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 300))
        }
      }
      if (cancelled || !stream) return

      reader = stream.getReader()
      try {
        while (!cancelled) {
          const event = await reader.read()
          if (event.done) break
          if (event.value.type === 'analysis-progress') setProgress(event.value.progress)
        }
      } catch {
        // The status poll and the next run reconnect independently.
      }

      if (!cancelled) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['librarian-analyses', storyId] }),
          queryClient.invalidateQueries({ queryKey: ['librarian-analysis-index', storyId] }),
          queryClient.invalidateQueries({ queryKey: ['librarian-status', storyId] }),
          queryClient.invalidateQueries({ queryKey: ['librarian-continuity', storyId] }),
          queryClient.invalidateQueries({ queryKey: ['fragments', storyId] }),
        ])
        if (!cancelled) setProgress(null)
      }
    }

    void follow()
    return () => {
      cancelled = true
      void reader?.cancel()
    }
  }, [active, queryClient, storyId])

  return progress
}
