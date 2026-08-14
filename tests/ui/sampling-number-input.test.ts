// @vitest-environment jsdom
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { SamplingNumberInput } from '../../src/components/settings/SamplingNumberInput'

afterEach(cleanup)

function renderInput(overrides: Partial<React.ComponentProps<typeof SamplingNumberInput>> = {}) {
  const onCommit = vi.fn()
  const view = render(React.createElement(SamplingNumberInput, {
    value: null,
    onCommit,
    min: 1,
    max: 1000,
    step: 1,
    integer: true,
    title: 'Top K',
    ...overrides,
  }))

  return {
    ...view,
    input: view.container.querySelector('input') as HTMLInputElement,
    onCommit,
  }
}

describe('SamplingNumberInput', () => {
  it('keeps an editing draft and saves only after focus leaves the field', () => {
    const { input, onCommit } = renderInput()

    input.focus()
    fireEvent.change(input, { target: { value: '6' } })
    expect(document.activeElement).toBe(input)
    expect(onCommit).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: '64' } })
    expect(document.activeElement).toBe(input)
    expect(onCommit).not.toHaveBeenCalled()

    fireEvent.blur(input)
    expect(onCommit).toHaveBeenCalledOnce()
    expect(onCommit).toHaveBeenCalledWith(64)
  })

  it('does not persist an out-of-range value', () => {
    const { input, onCommit } = renderInput()

    fireEvent.change(input, { target: { value: '1001' } })
    fireEvent.blur(input)

    expect(onCommit).not.toHaveBeenCalled()
    expect(input.getAttribute('aria-invalid')).toBe('true')
  })

  it('restores the saved value on Escape without persisting the draft', () => {
    const { input, onCommit } = renderInput({ value: 20 })

    input.focus()
    fireEvent.change(input, { target: { value: '64' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(input.value).toBe('20')
    expect(onCommit).not.toHaveBeenCalled()
  })
})
