import { createContext, useContext, useMemo } from 'react'
import type { Fragment } from '@/lib/api'

interface MentionContextValue {
  storyId: string
  getFragment: (id: string) => Fragment | undefined
  mediaById: Map<string, Fragment>
}

const MentionContext = createContext<MentionContextValue | null>(null)

export function MentionProvider({
  storyId,
  fragments,
  mediaById,
  children,
}: {
  storyId: string
  fragments: Fragment[]
  mediaById: Map<string, Fragment>
  children: React.ReactNode
}) {
  const value = useMemo(() => {
    const fragmentMap = new Map<string, Fragment>()
    for (const fragment of fragments) fragmentMap.set(fragment.id, fragment)
    return {
      storyId,
      getFragment: (id: string) => fragmentMap.get(id),
      mediaById,
    }
  }, [storyId, fragments, mediaById])

  return (
    <MentionContext.Provider value={value}>
      {children}
    </MentionContext.Provider>
  )
}

export function useMentionContext() {
  return useContext(MentionContext)
}
