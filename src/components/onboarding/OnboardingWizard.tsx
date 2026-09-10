import { useEffect, useRef, useState } from 'react'
import { Wizard } from '@/components/ui/wizard'
import { GuillocheBackground } from './OnboardingBackdrop'
import { ThemeStep, TypographyStep } from './OnboardingAppearanceSteps'
import { WelcomeStep } from './OnboardingWelcomeStep'
import { ProviderSelectStep, type PresetKey } from './OnboardingProviderSteps'
import { ProviderSetupStep } from './OnboardingProviderSetupStep'

interface OnboardingWizardProps {
  onComplete: () => void
}

type Step = 'theme' | 'typography' | 'welcome' | 'provider-select' | 'provider-setup'

export function OnboardingWizard({ onComplete }: OnboardingWizardProps) {
  const [step, setStep] = useState<Step>('theme')
  const [selectedPreset, setSelectedPreset] = useState<PresetKey | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [step])

  return (
    <div className="fixed inset-0 z-50 bg-background" data-component-id="onboarding-root">
      <GuillocheBackground />
      <div ref={scrollRef} className="relative z-10 h-full overflow-auto">
        <Wizard step={step}>
          <Wizard.Step stepKey="theme" transition="fade">
            <div className="grid min-h-full place-items-center py-10">
              <ThemeStep onNext={() => setStep('typography')} />
            </div>
          </Wizard.Step>
          <Wizard.Step stepKey="typography" transition="fade">
            <div className="grid min-h-full place-items-center py-10">
              <TypographyStep onNext={() => setStep('welcome')} onBack={() => setStep('theme')} />
            </div>
          </Wizard.Step>
          <Wizard.Step stepKey="welcome" transition="fade">
            <div className="grid min-h-full place-items-center py-10">
              <WelcomeStep onNext={() => setStep('provider-select')} />
            </div>
          </Wizard.Step>
          <Wizard.Step stepKey="provider-select" transition="fade">
            <div className="grid min-h-full place-items-center py-10">
              <ProviderSelectStep onSelect={(preset) => { setSelectedPreset(preset); setStep('provider-setup') }} onBack={() => setStep('welcome')} />
            </div>
          </Wizard.Step>
          <Wizard.Step stepKey="provider-setup" transition="fade">
            {selectedPreset && (
              <div className="grid min-h-full place-items-center py-10">
                <ProviderSetupStep preset={selectedPreset} onComplete={onComplete} onBack={() => setStep('provider-select')} />
              </div>
            )}
          </Wizard.Step>
        </Wizard>
      </div>
    </div>
  )
}
