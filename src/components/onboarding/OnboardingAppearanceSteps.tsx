import { useEffect } from 'react'
import { Check, Moon, Sun } from 'lucide-react'
import { useTheme, useFontPreferences, getActiveFont, FONT_CATALOGUE, loadFullFontCatalogue } from '@/lib/theme'
import { Button } from '@/components/ui/button'
import { Caption, Eyebrow, MetaLabel } from '@/components/ui/prose-text'
import { Wizard } from '@/components/ui/wizard'

export function ThemeStep({
  onNext,
}: {
  onNext: () => void
}) {
  const { theme, setTheme } = useTheme()

  return (
    <div className="max-w-md mx-auto text-center px-6">
      <div className="animate-onboarding-fade-up">
        <h1 className="font-display text-5xl italic tracking-tight mb-3">Errata</h1>
        <p className="font-prose text-lg text-muted-foreground mb-12">
          How do you like to read?
        </p>
      </div>

      <div
        className="grid grid-cols-2 gap-4 mb-10 animate-onboarding-fade-up"
        style={{ animationDelay: '150ms' }}
      >
        <button
          type="button"
          onClick={() => setTheme('light')}
          aria-pressed={theme === 'light'}
          className={`group relative flex flex-col items-center gap-3 p-6 rounded-xl border transition-all duration-200 cursor-pointer ${
            theme === 'light'
              ? 'border-primary/40 bg-primary/5 shadow-sm'
              : 'border-border/30 hover:border-border/60 hover:bg-card/50'
          }`}
          data-component-id="onboarding-theme-light"
        >
          <div
            className={`size-12 rounded-full flex items-center justify-center transition-colors ${
              theme === 'light'
                ? 'bg-amber-100 text-amber-600 dark:bg-amber-500/20 dark:text-amber-400'
                : 'bg-muted text-muted-foreground'
            }`}
          >
            <Sun className="size-5" />
          </div>
          <span className="text-sm font-medium">Light</span>
          {theme === 'light' && (
            <div className="absolute top-2.5 right-2.5 size-5 rounded-full bg-primary flex items-center justify-center">
              <Check className="size-3 text-primary-foreground" />
            </div>
          )}
        </button>

        <button
          type="button"
          onClick={() => setTheme('dark')}
          aria-pressed={theme === 'dark'}
          className={`group relative flex flex-col items-center gap-3 p-6 rounded-xl border transition-all duration-200 cursor-pointer ${
            theme === 'dark'
              ? 'border-primary/40 bg-primary/5 shadow-sm'
              : 'border-border/30 hover:border-border/60 hover:bg-card/50'
          }`}
          data-component-id="onboarding-theme-dark"
        >
          <div
            className={`size-12 rounded-full flex items-center justify-center transition-colors ${
              theme === 'dark'
                ? 'bg-indigo-500/20 text-indigo-400'
                : 'bg-muted text-muted-foreground'
            }`}
          >
            <Moon className="size-5" />
          </div>
          <span className="text-sm font-medium">Dark</span>
          {theme === 'dark' && (
            <div className="absolute top-2.5 right-2.5 size-5 rounded-full bg-primary flex items-center justify-center">
              <Check className="size-3 text-primary-foreground" />
            </div>
          )}
        </button>
      </div>

      <div
        className="animate-onboarding-fade-up"
        style={{ animationDelay: '300ms' }}
      >
        <Button onClick={onNext} className="px-8" data-component-id="onboarding-theme-continue">
          Continue
        </Button>
      </div>
    </div>
  )
}

// ── Step 0.5: Typography Selection ────────────────────

const PROSE_SAMPLE = 'The morning light fell across the desk, illuminating pages scattered in careless heaps. She picked up her pen.'

export function TypographyStep({
  onNext,
  onBack,
}: {
  onNext: () => void
  onBack: () => void
}) {
  useEffect(() => { loadFullFontCatalogue() }, [])
  const [fontPrefs, setFont] = useFontPreferences()
  const activeProse = getActiveFont('prose', fontPrefs)
  const activeDisplay = getActiveFont('display', fontPrefs)

  return (
    <div className="max-w-xl mx-auto px-6">
      <div className="text-center mb-10 animate-onboarding-fade-up">
        <h2 className="font-display text-3xl italic mb-2">Choose your typeface</h2>
        <Caption size="sm">
          The reading font shapes your entire writing experience.
        </Caption>
      </div>

      {/* Prose fonts — the main event */}
      <div className="mb-8">
        <Eyebrow asChild><p
          className="mb-3 animate-onboarding-fade-up"
          style={{ animationDelay: '100ms' }}
        >
          Prose
        </p></Eyebrow>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {FONT_CATALOGUE.prose.map((opt, i) => {
            const isActive = opt.name === activeProse
            return (
              <button
                key={opt.name}
                type="button"
                onClick={() => setFont('prose', opt.name)}
                aria-pressed={isActive}
                className={`group relative text-left p-4 rounded-xl border transition-all duration-200 cursor-pointer animate-onboarding-fade-up ${
                  isActive
                    ? 'border-primary/40 bg-primary/5 shadow-sm'
                    : 'border-border/30 hover:border-border/60 hover:bg-card/50'
                }`}
                style={{ animationDelay: `${150 + i * 80}ms` }}
              >
                <MetaLabel asChild><p className="mb-2 flex items-center gap-1.5 font-medium">
                  {opt.name}
                  {opt.tag && (
                    <span className="rounded-full bg-primary/8 px-1.5 py-px text-ui-label font-medium uppercase leading-tight tracking-wider text-primary/60">
                      {opt.tag}
                    </span>
                  )}
                </p></MetaLabel>
                <p
                  className="text-base leading-relaxed text-foreground/80"
                  style={{ fontFamily: `"${opt.name}", ${opt.fallback}` }}
                >
                  {PROSE_SAMPLE}
                </p>
                {isActive && (
                  <div className="absolute top-2.5 right-2.5 size-5 rounded-full bg-primary flex items-center justify-center animate-onboarding-scale-in">
                    <Check className="size-3 text-primary-foreground" />
                  </div>
                )}
              </button>
            )
          })}
        </div>
      </div>

      {/* Display fonts — secondary */}
      <div className="mb-10">
        <Eyebrow asChild><p
          className="mb-3 animate-onboarding-fade-up"
          style={{ animationDelay: '500ms' }}
        >
          Headings
        </p></Eyebrow>
        <div
          className="grid grid-cols-2 sm:grid-cols-3 gap-3 animate-onboarding-fade-up"
          style={{ animationDelay: '550ms' }}
        >
          {FONT_CATALOGUE.display.map((opt) => {
            const isActive = opt.name === activeDisplay
            return (
              <button
                key={opt.name}
                type="button"
                onClick={() => setFont('display', opt.name)}
                aria-pressed={isActive}
                className={`relative text-center p-4 rounded-xl border transition-all duration-200 cursor-pointer ${
                  isActive
                    ? 'border-primary/40 bg-primary/5 shadow-sm'
                    : 'border-border/30 hover:border-border/60 hover:bg-card/50'
                }`}
              >
                <p
                  className="text-xl italic mb-1 text-foreground/85"
                  style={{ fontFamily: `"${opt.name}", ${opt.fallback}` }}
                >
                  Chapter One
                </p>
                <MetaLabel asChild><p className="flex items-center justify-center gap-1">
                  {opt.name}
                  {opt.tag && (
                    <span className="rounded-full bg-primary/8 px-1 py-px text-ui-label font-medium uppercase leading-tight tracking-wider text-primary/60">
                      {opt.tag}
                    </span>
                  )}
                </p></MetaLabel>
                {isActive && (
                  <div className="absolute top-2 right-2 size-4 rounded-full bg-primary flex items-center justify-center animate-onboarding-scale-in">
                    <Check className="size-2.5 text-primary-foreground" />
                  </div>
                )}
              </button>
            )
          })}
        </div>
      </div>

      <div
        className="text-center animate-onboarding-fade-up"
        style={{ animationDelay: '650ms' }}
      >
        <Button onClick={onNext} className="px-8">
          Continue
        </Button>
        <div className="mt-4">
          <Wizard.BackButton tone="link" onBack={onBack} />
        </div>
      </div>
    </div>
  )
}
