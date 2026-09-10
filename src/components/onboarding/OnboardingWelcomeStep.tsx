import { BookOpen, GitBranch, Layers, Moon, Puzzle, Sparkles, Sun } from 'lucide-react'
import { useTheme } from '@/lib/theme'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/prose-text'

export function WelcomeStep({
  onNext,
}: {
  onNext: () => void
}) {
  const { theme, toggle } = useTheme()

  return (
    <div className="max-w-xl mx-auto text-center px-6 relative">
      {/* Theme toggle */}
      <button
        type="button"
        onClick={toggle}
        className="absolute -top-12 right-0 size-8 rounded-full flex items-center justify-center text-muted-foreground hover:text-muted-foreground hover:bg-card/50 transition-all"
        title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
        aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
      >
        {theme === 'dark' ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
      </button>

      <div className="animate-onboarding-fade-up">
        <h1 className="font-display text-5xl italic tracking-tight mb-3">Errata</h1>
        <p className="font-prose text-lg text-muted-foreground">
          Model-assisted writing, built around fragments.
        </p>
      </div>

      {/* Hero features: Librarian & Timelines */}
      <div className="mt-10 grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div
          className="text-left p-5 rounded-xl border border-primary/15 bg-primary/[0.03] animate-onboarding-fade-up"
          style={{ animationDelay: '200ms' }}
        >
          <div className="size-10 rounded-xl bg-primary/10 flex items-center justify-center mb-3">
            <BookOpen className="size-5 text-primary" />
          </div>
          <p className="text-sm font-medium mb-1">The Librarian</p>
          <Hint className="leading-relaxed">
            A background AI reads every generation &mdash; tracking characters,
            contradictions, and world details into a living story reference.
          </Hint>
        </div>
        <div
          className="text-left p-5 rounded-xl border border-primary/15 bg-primary/[0.03] animate-onboarding-fade-up"
          style={{ animationDelay: '320ms' }}
        >
          <div className="size-10 rounded-xl bg-primary/10 flex items-center justify-center mb-3">
            <GitBranch className="size-5 text-primary" />
          </div>
          <p className="text-sm font-medium mb-1">Timelines</p>
          <Hint className="leading-relaxed">
            Fork at any point to explore alternate paths. Each timeline
            carries its own fragments, prose, and accumulated knowledge.
          </Hint>
        </div>
      </div>

      {/* Supporting features */}
      <div className="mt-4 space-y-3">
        {[
          { icon: Layers, title: 'Fragments', desc: 'Prose, characters, guidelines, knowledge — everything is a composable fragment.' },
          { icon: Sparkles, title: 'Generation', desc: 'Fragments compose into rich context for nuanced story continuations.' },
          { icon: Puzzle, title: 'Plugins', desc: 'Extend with custom fragment types, tools, and pipeline hooks.' },
        ].map((f, i) => (
          <div
            key={f.title}
            className="flex items-start gap-4 text-left p-4 rounded-lg border border-border/20 bg-card/30 animate-onboarding-fade-up"
            style={{ animationDelay: `${450 + i * 100}ms` }}
          >
            <div className="size-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
              <f.icon className="size-4 text-primary" />
            </div>
            <div>
              <p className="text-sm font-medium mb-0.5">{f.title}</p>
              <Hint className="leading-relaxed">{f.desc}</Hint>
            </div>
          </div>
        ))}
      </div>

      <div
        className="mt-10 animate-onboarding-fade-up"
        style={{ animationDelay: '800ms' }}
      >
        <Button onClick={onNext} className="px-8" data-component-id="onboarding-welcome-start">
          Get Started
        </Button>
      </div>
    </div>
  )
}
