import { randomUUID } from 'node:crypto'
import { withKeyLock } from '../async-lock'
import { getStory, getFragment } from '../fragments/storage'
import { getActiveProseIds } from '../fragments/prose-chain'
import { runLibrarian } from './agent'
import {
  getBackfillJob,
  saveBackfillJob,
  type LibrarianBackfillJob,
} from './storage'

export interface CreateBackfillJobOptions {
  fragmentIds?: string[]
  source?: 'import' | 'historical' | 'manual'
}

export interface RunBackfillJobOptions {
  maxFragments?: number
  continueOnError?: boolean
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids)]
}

async function resolveBackfillFragmentIds(
  dataDir: string,
  storyId: string,
  options: CreateBackfillJobOptions,
): Promise<string[]> {
  const ids = options.fragmentIds ?? await getActiveProseIds(dataDir, storyId)
  const unique = uniqueIds(ids)
  for (const fragmentId of unique) {
    const fragment = await getFragment(dataDir, storyId, fragmentId)
    if (!fragment) throw new Error(`Fragment ${fragmentId} not found`)
    if (fragment.type !== 'prose') {
      throw new Error(`Backfill jobs can only analyze prose fragments; ${fragmentId} is ${fragment.type}`)
    }
  }
  return unique
}

export async function createBackfillJob(
  dataDir: string,
  storyId: string,
  options: CreateBackfillJobOptions = {},
): Promise<LibrarianBackfillJob> {
  const story = await getStory(dataDir, storyId)
  if (!story) throw new Error(`Story ${storyId} not found`)
  const now = new Date().toISOString()
  const fragmentIds = await resolveBackfillFragmentIds(dataDir, storyId, options)
  const job: LibrarianBackfillJob = {
    id: `lbj-${randomUUID()}`,
    storyId,
    createdAt: now,
    updatedAt: now,
    status: 'queued',
    fragmentIds,
    cursor: 0,
    completedFragmentIds: [],
    failedFragments: [],
    options: {
      source: options.source ?? 'manual',
    },
  }
  await saveBackfillJob(dataDir, storyId, job)
  return job
}

function advanceJobAfterSuccess(
  job: LibrarianBackfillJob,
  fragmentId: string,
  analysisId: string,
): LibrarianBackfillJob {
  return {
    ...job,
    cursor: job.cursor + 1,
    completedFragmentIds: uniqueIds([...job.completedFragmentIds, fragmentId]),
    lastAnalysisId: analysisId,
    error: undefined,
  }
}

function advanceJobAfterFailure(
  job: LibrarianBackfillJob,
  fragmentId: string,
  error: string,
  continueOnError: boolean,
): LibrarianBackfillJob {
  return {
    ...job,
    cursor: continueOnError ? job.cursor + 1 : job.cursor,
    status: continueOnError ? job.status : 'failed',
    error,
    failedFragments: [
      ...job.failedFragments,
      { fragmentId, error, at: new Date().toISOString() },
    ],
  }
}

export async function runBackfillJob(
  dataDir: string,
  storyId: string,
  jobId: string,
  options: RunBackfillJobOptions = {},
): Promise<LibrarianBackfillJob> {
  return withKeyLock(`librarian-backfill:${storyId}:${jobId}`, async () => {
    let job = await getBackfillJob(dataDir, storyId, jobId)
    if (!job) throw new Error(`Backfill job ${jobId} not found`)
    if (job.status === 'complete' || job.status === 'cancelled') return job

    job = { ...job, status: 'running', error: undefined }
    await saveBackfillJob(dataDir, storyId, job)

    let processed = 0
    while (job.cursor < job.fragmentIds.length) {
      if (options.maxFragments !== undefined && processed >= options.maxFragments) {
        job = { ...job, status: 'paused' }
        await saveBackfillJob(dataDir, storyId, job)
        return job
      }

      const fragmentId = job.fragmentIds[job.cursor]
      try {
        const analysis = await runLibrarian(dataDir, storyId, fragmentId)
        job = advanceJobAfterSuccess(job, fragmentId, analysis.id)
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        job = advanceJobAfterFailure(job, fragmentId, errorMsg, options.continueOnError === true)
        await saveBackfillJob(dataDir, storyId, job)
        if (job.status === 'failed') return job
      }

      processed += 1
      await saveBackfillJob(dataDir, storyId, job)
    }

    job = { ...job, status: 'complete' }
    await saveBackfillJob(dataDir, storyId, job)
    return job
  })
}
