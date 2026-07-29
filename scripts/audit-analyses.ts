/**
 * Tally what the librarian analysis pipeline dropped, across every stored run.
 *
 * A contract change is only as good as its behaviour on real passages, and the
 * evidence for that is already on disk: every analysis keeps the trace of its
 * tool calls, and every tool reports refusals and partial losses in its return
 * value. This walks all of it and groups the losses by reason, so a redesign
 * can be judged by how much work stopped being thrown away.
 *
 *   bun run audit:analyses                 # every story, every branch
 *   bun run audit:analyses story-mrs5ho9b  # one story
 *
 * Outcomes are read through the same `toolResultOutcome` the trace panel uses,
 * so the audit and the UI cannot disagree about whether a run was clean.
 */
import { readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getBranchesIndex, getContentRootForBranch } from '../src/server/fragments/branches'
import { toolResultOutcome } from '../src/lib/librarian-outcome'
import type { LibrarianAnalysis } from '../src/server/librarian/storage'

const dataDir = process.env.DATA_DIR ?? './data'
const onlyStory = process.argv[2]

/**
 * Evidence used to be retyped quotes and is now sentence citations. Runs are
 * split on which contract they were produced under, since comparing the two is
 * the whole point of the tally.
 */
function isSegmentEra(analysis: LibrarianAnalysis): boolean {
  return JSON.stringify(analysis.continuityProjection ?? {}).includes('evidenceSegments')
}

interface BranchTally {
  story: string
  branch: string
  branchName: string
  runs: number
  segmentRuns: number
  losses: number
  lossyRuns: number
}

const branchTallies: BranchTally[] = []
/** Reason text with ids and numbers masked, so near-identical losses group. */
const byReason = new Map<string, { count: number; sample: string; where: string }>()
/** finishAnalysis.skipped is the model declaring intent, not the engine refusing. */
const declaredSkips = new Map<string, number>()

function record(where: string, toolName: string, result: unknown): number {
  const outcome = toolResultOutcome(result)
  // A lane the analyst chose to leave alone is a decision, not a loss — but
  // only if the call declaring it was accepted. A refused finishAnalysis
  // declared nothing, so its entries fall through and count as lost.
  if (toolName === 'finishAnalysis' && outcome.ok) {
    for (const reason of outcome.reasons) {
      declaredSkips.set(reason, (declaredSkips.get(reason) ?? 0) + 1)
    }
    return 0
  }
  const note = (key: string, sample: string) => {
    const entry = byReason.get(key)
    if (entry) entry.count++
    else byReason.set(key, { count: 1, sample, where: `${where} ${toolName}` })
  }

  for (const reason of outcome.reasons) {
    note(reason.replace(/'[^']*'/g, "'…'").replace(/\d+/g, 'N').slice(0, 120), reason)
  }
  // Work dropped without saying why is the loss that hides best, so it is
  // counted and named rather than passed over for having nothing to quote.
  const unexplained = outcome.dropped - outcome.reasons.length
  for (let i = 0; i < unexplained; i++) {
    note(`${toolName}: dropped without a reason`, `${toolName}: dropped without a reason`)
  }
  if (!outcome.ok && outcome.dropped === 0) {
    note(`${toolName}: refused without a reason`, `${toolName}: refused without a reason`)
    return 1
  }
  return outcome.dropped
}

async function auditStory(storyId: string): Promise<void> {
  const index = await getBranchesIndex(dataDir, storyId)
  for (const branch of index.branches) {
    const root = await getContentRootForBranch(dataDir, storyId, branch.id)
    const dir = join(root, 'librarian', 'analyses')
    if (!existsSync(dir)) continue

    const tally: BranchTally = {
      story: storyId,
      branch: branch.id,
      branchName: branch.name,
      runs: 0,
      segmentRuns: 0,
      losses: 0,
      lossyRuns: 0,
    }

    for (const file of await readdir(dir)) {
      if (!file.endsWith('.json')) continue
      let analysis: LibrarianAnalysis
      try {
        analysis = JSON.parse(await readFile(join(dir, file), 'utf-8')) as LibrarianAnalysis
      } catch {
        console.warn(`  ! unreadable: ${branch.id}/${file}`)
        continue
      }
      if (!Array.isArray(analysis.trace)) continue

      tally.runs++
      if (isSegmentEra(analysis)) tally.segmentRuns++
      let lost = 0
      for (const event of analysis.trace) {
        if (event.type !== 'tool-result') continue
        const { toolName, result } = event as { toolName?: string; result?: unknown }
        lost += record(`${branch.id}/${analysis.id}`, toolName ?? '?', result)
      }
      tally.losses += lost
      if (lost > 0) tally.lossyRuns++
    }

    if (tally.runs > 0) branchTallies.push(tally)
  }
}

const storiesDir = join(dataDir, 'stories')
if (!existsSync(storiesDir)) {
  console.error(`No stories under ${storiesDir}. Set DATA_DIR if your data lives elsewhere.`)
  process.exit(1)
}

const stories = onlyStory
  ? [onlyStory]
  : (await readdir(storiesDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)

for (const storyId of stories) {
  try {
    await auditStory(storyId)
  } catch (error) {
    console.warn(`Skipped ${storyId}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

if (branchTallies.length === 0) {
  console.info('No stored analyses with traces were found.')
  process.exit(0)
}

const pad = (value: string | number, width: number) => String(value).padStart(width)

console.info('\nPer branch — a "loss" is work the engine refused or could not ground.\n')
console.info('  branch       runs  segment-era  lossy runs  losses   name')
for (const t of branchTallies.sort((a, b) => a.branch.localeCompare(b.branch))) {
  console.info(
    `  ${t.branch.padEnd(11)} ${pad(t.runs, 4)}  ${pad(t.segmentRuns, 11)}  ${pad(t.lossyRuns, 10)}  ${pad(t.losses, 6)}   ${t.branchName}`,
  )
}

const era = (pick: (t: BranchTally) => boolean) => {
  const rows = branchTallies.filter(pick)
  const runs = rows.reduce((n, t) => n + t.runs, 0)
  const losses = rows.reduce((n, t) => n + t.losses, 0)
  return { runs, losses, per: runs ? (losses / runs).toFixed(2) : '—' }
}
// A branch is segment-era when its runs cite sentences rather than retyped quotes.
const segment = era((t) => t.segmentRuns > t.runs / 2)
const quote = era((t) => t.segmentRuns <= t.runs / 2)

console.info('\n  evidence contract      runs  losses  per run')
console.info(`  retyped quotes    ${pad(quote.runs, 10)}  ${pad(quote.losses, 6)}  ${pad(quote.per, 7)}`)
console.info(`  cited sentences   ${pad(segment.runs, 10)}  ${pad(segment.losses, 6)}  ${pad(segment.per, 7)}`)

console.info('\nLosses by reason:\n')
for (const [, entry] of [...byReason].sort((a, b) => b[1].count - a[1].count)) {
  console.info(`  ${pad(entry.count, 4)}  ${entry.sample.slice(0, 100)}`)
  console.info(`        first seen in ${entry.where}`)
}

if (declaredSkips.size > 0) {
  const total = [...declaredSkips.values()].reduce((a, b) => a + b, 0)
  console.info(`\nDeclared skips (the analyst's own choice, not a loss): ${total}\n`)
  for (const [reason, count] of [...declaredSkips].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    console.info(`  ${pad(count, 4)}  ${reason.slice(0, 100)}`)
  }
}
