import type { ThoughtStep } from './InlineGenerationInput'

export interface GenerationStreamSnapshot {
  text: string
  thoughts: ThoughtStep[]
  version: number
}

export interface GenerationStreamStore {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => GenerationStreamSnapshot
  reset: () => void
  setText: (text: string) => void
  setThoughts: (thoughts: ThoughtStep[]) => void
}

export const EMPTY_STREAM_SNAPSHOT: GenerationStreamSnapshot = { text: '', thoughts: [], version: 0 }

export function createGenerationStreamStore(): GenerationStreamStore {
  let snapshot = EMPTY_STREAM_SNAPSHOT
  const listeners = new Set<() => void>()
  let emitScheduled = false

  const emit = () => {
    emitScheduled = false
    for (const listener of listeners) listener()
  }
  const scheduleEmit = () => {
    if (emitScheduled) return
    emitScheduled = true
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(emit)
    else Promise.resolve().then(emit)
  }
  const replaceSnapshot = (next: Omit<GenerationStreamSnapshot, 'version'>) => {
    snapshot = { ...next, version: snapshot.version + 1 }
    scheduleEmit()
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => snapshot,
    reset() {
      if (!snapshot.text && snapshot.thoughts.length === 0) return
      replaceSnapshot({ text: '', thoughts: [] })
    },
    setText(text) {
      if (snapshot.text !== text) replaceSnapshot({ text, thoughts: snapshot.thoughts })
    },
    setThoughts(thoughts) {
      if (snapshot.thoughts !== thoughts) replaceSnapshot({ text: snapshot.text, thoughts })
    },
  }
}
