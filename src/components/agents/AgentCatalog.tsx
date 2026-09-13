import { Bot, ChevronRight } from 'lucide-react'
import type { AgentBlockInfo } from '@/lib/api/types'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Eyebrow, Hint } from '@/components/ui/prose-text'

const GROUPS: Array<{ label: string; prefix: string }> = [
  { label: 'Generation', prefix: 'generation.' },
  { label: 'Chapters', prefix: 'chapters.' },
  { label: 'Directions', prefix: 'directions.' },
  { label: 'Librarian', prefix: 'librarian.' },
  { label: 'Character', prefix: 'character-chat.' },
]

const ORDER = [
  'generation.writer',
  'generation.prewriter',
  'chapters.summarize',
  'directions.suggest',
  'librarian.analyze',
  'librarian.chat',
  'librarian.refine',
  'librarian.optimize-character',
  'librarian.prose-transform',
  'character-chat.chat',
]

export function groupAgents(agents: AgentBlockInfo[]) {
  const byName = new Map(agents.map((agent) => [agent.agentName, agent]))
  const placed = new Set<string>()
  const groups = GROUPS.flatMap((group) => {
    const ordered = ORDER
      .filter((name) => name.startsWith(group.prefix) && byName.has(name))
      .map((name) => byName.get(name)!)
    const remainder = agents.filter((agent) => agent.agentName.startsWith(group.prefix) && !ORDER.includes(agent.agentName))
    const members = [...ordered, ...remainder]
    members.forEach((agent) => placed.add(agent.agentName))
    return members.length ? [{ label: group.label, agents: members }] : []
  })
  const other = agents.filter((agent) => !placed.has(agent.agentName))
  if (other.length) groups.push({ label: 'Other', agents: other })
  return groups
}

export function AgentCatalog({ agents, onSelect }: { agents: AgentBlockInfo[]; onSelect: (name: string) => void }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border/30 px-4 py-3">
        <Hint className="leading-snug">Customize the context, tools, and model used by each agent.</Hint>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 px-2 py-3">
          {groupAgents(agents).map((group) => (
            <section key={group.label}>
              <div className="mb-1.5 flex items-center gap-2 px-1">
                <div className="size-1 rounded-full bg-muted-foreground/50" />
                <Eyebrow>{group.label}</Eyebrow>
                <div className="h-px flex-1 bg-border/20" />
              </div>
              <div className="space-y-1">
                {group.agents.map((agent) => (
                  <button
                    key={agent.agentName}
                    type="button"
                    className="group w-full rounded-lg border border-border/30 px-3 py-2.5 text-left transition-all duration-150 hover:border-border/50 hover:bg-accent/10"
                    onClick={() => onSelect(agent.agentName)}
                  >
                    <div className="flex items-center gap-2.5">
                      <Bot className="size-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium leading-tight">{agent.displayName}</p>
                        <Hint className="mt-0.5 leading-snug">{agent.description}</Hint>
                      </div>
                      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                    </div>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}
