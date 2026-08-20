// @vitest-environment jsdom
import { createElement } from 'react'
import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { NumberField } from '@/components/settings/primitives'

function renderField(props: Partial<Parameters<typeof NumberField>[0]> = {}) {
  const onChange = vi.fn()
  const utils = render(
    createElement(NumberField, {
      value: 40000,
      min: 100,
      max: 2000000,
      onChange,
      ...props,
    }),
  )
  const input = utils.container.querySelector('input') as HTMLInputElement
  return { ...utils, input, onChange }
}

describe('NumberField draft-commit', () => {
  it('allows intermediate keystrokes below min without snapping back or committing', () => {
    const { input, onChange } = renderField()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '2' } })
    expect(input.value).toBe('2')
    fireEvent.change(input, { target: { value: '25' } })
    expect(input.value).toBe('25')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('commits the parsed value on blur', () => {
    const { input, onChange } = renderField()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '250000' } })
    fireEvent.blur(input)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(250000)
    expect(input.value).toBe('250000')
  })

  it('commits on Enter without requiring blur', () => {
    const { input, onChange } = renderField()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '120000' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith(120000)
  })

  it('clamps out-of-range input to min/max on commit', () => {
    const { input, onChange } = renderField()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '5' } })
    fireEvent.blur(input)
    expect(onChange).toHaveBeenCalledWith(100)
    expect(input.value).toBe('100')

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '9000000' } })
    fireEvent.blur(input)
    expect(onChange).toHaveBeenLastCalledWith(2000000)
  })

  it('reverts an emptied field to the committed value on blur without calling onChange', () => {
    const { input, onChange } = renderField()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '' } })
    expect(input.value).toBe('')
    fireEvent.blur(input)
    expect(input.value).toBe('40000')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('does not call onChange when the committed value is unchanged', () => {
    const { input, onChange } = renderField()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '40000' } })
    fireEvent.blur(input)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('resyncs the draft when the external value changes while unfocused', () => {
    const onChange = vi.fn()
    const { container, rerender } = render(
      createElement(NumberField, { value: 40000, min: 100, max: 2000000, onChange }),
    )
    const input = container.querySelector('input') as HTMLInputElement
    rerender(createElement(NumberField, { value: 160000, min: 100, max: 2000000, onChange }))
    expect(input.value).toBe('160000')
  })

  it('passes the step through to the input for spinner increments', () => {
    const { input } = renderField({ step: 1000 })
    expect(input.step).toBe('1000')
  })
})
