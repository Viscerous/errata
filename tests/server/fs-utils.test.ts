import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTempDir } from '../setup'

const { renameMock } = vi.hoisted(() => ({ renameMock: vi.fn() }))

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return { ...actual, rename: renameMock }
})

import { writeJsonAtomic } from '@/server/fs-utils'

function held(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: operation not permitted, rename`), { code })
}

describe('writeJsonAtomic', () => {
  let dir: string
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    renameMock.mockReset().mockImplementation(actual.rename)
    const temp = await createTempDir()
    dir = temp.path
    cleanup = temp.cleanup
  })

  afterEach(async () => {
    await cleanup()
  })

  // Windows refuses to replace a file another process briefly holds open.
  it('waits out a target that is briefly held open', async () => {
    const path = join(dir, 'state.json')
    renameMock.mockRejectedValueOnce(held('EPERM')).mockRejectedValueOnce(held('EBUSY'))

    await writeJsonAtomic(path, { saved: true })

    expect(JSON.parse(await readFile(path, 'utf-8'))).toEqual({ saved: true })
    expect(await readdir(dir)).toEqual(['state.json'])
  })

  it('reports a failure that does not clear, leaving no temp file behind', async () => {
    const path = join(dir, 'state.json')
    renameMock.mockRejectedValueOnce(held('ENOSPC'))

    await expect(writeJsonAtomic(path, { saved: true })).rejects.toMatchObject({ code: 'ENOSPC' })
    expect(await readdir(dir)).toEqual([])
  })
})
