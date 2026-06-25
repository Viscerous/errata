import { BookOpen, MessageSquare, Sparkles, Compass, Wand2, Bot } from 'lucide-react'

// Shared display metadata for agents, used by both the floating activity wisp and
// the activity panel's status strip so they describe agents the same way.

export interface AgentMeta {
  label: string
  /** A single present-continuous verb for compact status (e.g. the panel strip). */
  status: string
  /** Rotating list of verbs the wisp cycles through while active. */
  actions: string[]
  color: string
  glow: string
  icon: typeof Bot
}

export const AGENT_META: Record<string, AgentMeta> = {
  'librarian.analyze': {
    label: 'Librarian',
    status: 'Analyzing',
    actions: ['Reading', 'Annotating', 'Cross-referencing', 'Noting details'],
    color: 'oklch(0.78 0.15 70)',
    glow: 'oklch(0.78 0.15 70 / 35%)',
    icon: BookOpen,
  },
  'librarian.refine': {
    label: 'Librarian',
    status: 'Refining',
    actions: ['Refining', 'Polishing', 'Tightening a line', 'Re-phrasing'],
    color: 'oklch(0.72 0.13 50)',
    glow: 'oklch(0.72 0.13 50 / 35%)',
    icon: Wand2,
  },
  'librarian.chat': {
    label: 'Librarian',
    status: 'Replying',
    actions: ['Listening', 'Considering', 'Composing a reply'],
    color: 'oklch(0.70 0.10 80)',
    glow: 'oklch(0.70 0.10 80 / 35%)',
    icon: MessageSquare,
  },
  'librarian.optimize-character': {
    label: 'Librarian',
    status: 'Optimizing',
    actions: ['Sharpening', 'Consolidating', 'Clarifying'],
    color: 'oklch(0.75 0.13 60)',
    glow: 'oklch(0.75 0.13 60 / 35%)',
    icon: Sparkles,
  },
  'librarian.prose-transform': {
    label: 'Librarian',
    status: 'Transforming',
    actions: ['Transforming', 'Rewriting', 'Re-voicing'],
    color: 'oklch(0.70 0.12 135)',
    glow: 'oklch(0.70 0.12 135 / 35%)',
    icon: Wand2,
  },
  'character-chat.chat': {
    label: 'Character',
    status: 'Replying',
    actions: ['Listening', 'Considering', 'Reaching for words'],
    color: 'oklch(0.68 0.14 175)',
    glow: 'oklch(0.68 0.14 175 / 35%)',
    icon: MessageSquare,
  },
  'directions.suggest': {
    label: 'Directions',
    status: 'Suggesting',
    actions: ['Plotting a path', 'Weighing options', 'Peering ahead'],
    color: 'oklch(0.72 0.11 290)',
    glow: 'oklch(0.72 0.11 290 / 35%)',
    icon: Compass,
  },
  'generation.writer': {
    label: 'Writer',
    status: 'Writing',
    actions: ['Writing', 'Finding the next line', 'Listening to the page', 'Setting the scene'],
    color: 'oklch(0.74 0.12 25)',
    glow: 'oklch(0.74 0.12 25 / 35%)',
    icon: Sparkles,
  },
  'generation.prewriter': {
    label: 'Prewriter',
    status: 'Planning',
    actions: ['Planning', 'Outlining the scene', 'Shaping the brief'],
    color: 'oklch(0.72 0.11 320)',
    glow: 'oklch(0.72 0.11 320 / 35%)',
    icon: Compass,
  },
}

export const DEFAULT_META: AgentMeta = {
  label: 'Agent',
  status: 'Working',
  actions: ['Working'],
  color: 'oklch(0.65 0.08 240)',
  glow: 'oklch(0.65 0.08 240 / 35%)',
  icon: Bot,
}

function titleCase(s: string): string {
  return s.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

export function getAgentMeta(agentName: string): AgentMeta {
  if (AGENT_META[agentName]) return AGENT_META[agentName]

  // Derive a readable label/status from the agent name (e.g. "librarian.summarize").
  const parts = agentName.split('.')
  const label = titleCase(parts[0])
  const status = parts[1] ? titleCase(parts[1]) : 'Working'
  return { ...DEFAULT_META, label, status, actions: [status] }
}
