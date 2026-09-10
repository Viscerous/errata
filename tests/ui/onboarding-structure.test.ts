import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function source(path: string) {
  return readFileSync(resolve(path), 'utf8')
}

describe('onboarding structure', () => {
  it('keeps the wizard focused on navigation', () => {
    const wizard = source('src/components/onboarding/OnboardingWizard.tsx')
    expect(wizard).toContain('OnboardingAppearanceSteps')
    expect(wizard).toContain('OnboardingWelcomeStep')
    expect(wizard).toContain('OnboardingProviderSteps')
    expect(wizard).toContain('OnboardingProviderSetupStep')
    expect(wizard.split('\n').length).toBeLessThan(80)
  })

  it('gives every onboarding screen a focused owner', () => {
    expect(source('src/components/onboarding/OnboardingBackdrop.tsx')).toContain('GuillocheBackground')
    expect(source('src/components/onboarding/OnboardingAppearanceSteps.tsx')).toContain('TypographyStep')
    expect(source('src/components/onboarding/OnboardingWelcomeStep.tsx')).toContain('WelcomeStep')
    expect(source('src/components/onboarding/OnboardingProviderSteps.tsx')).toContain('ProviderSelectStep')
    expect(source('src/components/onboarding/OnboardingProviderSetupStep.tsx')).toContain('ProviderSetupStep')
  })

  it('uses shared form controls rather than bespoke native provider controls', () => {
    const setup = source('src/components/onboarding/OnboardingProviderSetupStep.tsx')
    expect(setup).toContain("from '@/components/ui/input'")
    expect(setup).toContain('SettingsSelect')
    expect(setup).not.toMatch(/<input\b/)
    expect(setup).not.toMatch(/<select\b/)
    for (const file of [
      'src/components/onboarding/OnboardingAppearanceSteps.tsx',
      'src/components/onboarding/OnboardingProviderSetupStep.tsx',
      'src/components/onboarding/OnboardingProviderSteps.tsx',
      'src/components/onboarding/OnboardingWelcomeStep.tsx',
    ]) {
      expect(source(file)).not.toMatch(/text-\[[^\]]+\]/)
    }
  })
})
