import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { rm, readFile, readdir } from 'node:fs/promises'
import { getStory, updateStory, getFragment, updateFragment } from './storage'
import { getProseChain, saveProseChain } from './prose-chain'
import { getAssociations, saveAssociations } from './associations'
import { remapFragment, remapAssociations } from './remap'
import { generateFragmentId, PREFIXES } from '@/lib/fragment-ids'
import { createLogger } from '../logging/logger'
import { getContentRoot } from './branches'
import { getState, saveState, getAnalysis, saveAnalysis, rebuildAnalysisIndex } from '../librarian/storage'
import { writeJsonAtomic } from '../fs-utils'
import type { Fragment } from './schema'

const log = createLogger('rename-id')

export async function renameFragmentIdAcrossStory(
  dataDir: string,
  storyId: string,
  oldId: string,
  newType: string
): Promise<string> {
  const root = await getContentRoot(dataDir, storyId)
  const fragmentsDir = join(root, 'fragments')

  const oldPrefix = oldId.split('-')[0]
  const newPrefix = PREFIXES[newType] ?? newType.slice(0, 4).toLowerCase()
  if (oldPrefix === newPrefix) {
    return oldId // No change needed
  }

  const suffix = oldId.includes('-') ? oldId.split('-').slice(1).join('-') : oldId
  let newId = `${newPrefix}-${suffix}`

  // Check collision
  let collisionCount = 0
  while (existsSync(join(fragmentsDir, `${newId}.json`))) {
    // If collision, generate entirely new ID for the new type
    newId = generateFragmentId(newType)
    collisionCount++
    if (collisionCount > 10) throw new Error('Failed to generate unique fragment ID')
  }

  log.info(`Renaming fragment ID ${oldId} -> ${newId} (type: ${newType}) in story ${storyId}`)

  // 1. Rename the file itself
  const fragment = await getFragment(dataDir, storyId, oldId)
  if (!fragment) throw new Error(`Fragment ${oldId} not found`)
  
  // Apply remap on itself (just to update its own id field and self-refs if any)
  const idMap = { [oldId]: newId }
  const updatedFragment = remapFragment(fragment, idMap)
  updatedFragment.type = newType
  
  await updateFragment(dataDir, storyId, updatedFragment)
  
  // Delete old file
  await rm(join(fragmentsDir, `${oldId}.json`), { force: true })

  // 2. Update all other fragments in parallel with fast string scan
  const files = await readdir(fragmentsDir)
  const jsonFiles = files.filter((e) => e.endsWith('.json') && !e.startsWith(newId))

  await Promise.all(
    jsonFiles.map(async (entry) => {
      const filePath = join(fragmentsDir, entry)
      const raw = await readFile(filePath, 'utf-8')
      // Fast path: skip parsing if the old ID is not mentioned anywhere in the JSON string
      if (!raw.includes(oldId)) {
        return
      }

      const f = JSON.parse(raw) as Fragment
      let mapped = remapFragment(f, idMap)
      let modified = mapped.id !== f.id || JSON.stringify(mapped.refs) !== JSON.stringify(f.refs) || JSON.stringify(mapped.meta) !== JSON.stringify(f.meta)

      // meta.annotations (needs manual update because remapMeta doesn't cover it)
      if (mapped.meta?.annotations && Array.isArray(mapped.meta.annotations)) {
        let annModified = false
        const newAnns = mapped.meta.annotations.map(ann => {
          if (typeof ann === 'object' && ann !== null && 'fragmentId' in ann && (ann as Record<string, unknown>).fragmentId === oldId) {
            annModified = true
            return { ...ann, fragmentId: newId }
          }
          return ann
        })
        if (annModified) {
          mapped.meta.annotations = newAnns
          modified = true
        }
      }

      // inline content
      if (mapped.content.includes(oldId)) {
        const regex = new RegExp(`(?<![a-zA-Z0-9-])${oldId}(?![a-zA-Z0-9-])`, 'g')
        const newContent = mapped.content.replace(regex, newId)
        if (newContent !== mapped.content) {
          mapped.content = newContent
          modified = true
        }
      }

      if (modified) {
        await updateFragment(dataDir, storyId, mapped)
      }
    })
  )

  // 3. Update Story settings
  const story = await getStory(dataDir, storyId)
  if (story) {
    let storyModified = false
    if (story.settings.fragmentOrder.includes(oldId)) {
      story.settings.fragmentOrder = story.settings.fragmentOrder.map(id => id === oldId ? newId : id)
      storyModified = true
    }
    // Also check erratanet packs
    if (story.settings.erratanet?.fragmentPacks) {
      for (const pack of story.settings.erratanet.fragmentPacks) {
        if (pack.fragmentIds.includes(oldId)) {
          pack.fragmentIds = pack.fragmentIds.map(id => id === oldId ? newId : id)
          storyModified = true
        }
      }
    }
    if (storyModified) {
      await updateStory(dataDir, story)
    }
  }

  // 4. Update Folders.json assignments
  const foldersFile = join(dataDir, 'stories', storyId, 'folders.json')
  if (existsSync(foldersFile)) {
    try {
      const raw = await readFile(foldersFile, 'utf-8')
      const parsed = JSON.parse(raw)
      if (parsed.assignments && parsed.assignments[oldId]) {
        parsed.assignments[newId] = parsed.assignments[oldId]
        delete parsed.assignments[oldId]
        await writeJsonAtomic(foldersFile, parsed)
      }
    } catch (e) {
      log.error(`Failed to update folder assignments: ${e}`)
    }
  }

  // 5. Update Prose Chain
  const chain = await getProseChain(dataDir, storyId)
  if (chain) {
    let chainModified = false
    for (const entry of chain.entries) {
      if (entry.active === oldId) {
        entry.active = newId
        chainModified = true
      }
      if (entry.proseFragments.includes(oldId)) {
        entry.proseFragments = entry.proseFragments.map(id => id === oldId ? newId : id)
        chainModified = true
      }
    }
    if (chainModified) {
      await saveProseChain(dataDir, storyId, chain)
    }
  }

  // 6. Update Associations
  const assoc = await getAssociations(dataDir, storyId)
  const newAssoc = remapAssociations(assoc, idMap)
  if (JSON.stringify(newAssoc) !== JSON.stringify(assoc)) {
    await saveAssociations(dataDir, storyId, newAssoc)
  }

  // 7. Update Librarian State & Analyses
  try {
    const libState = await getState(dataDir, storyId)
    let libStateModified = false
    if (libState.lastAnalyzedFragmentId === oldId) {
      libState.lastAnalyzedFragmentId = newId
      libStateModified = true
    }
    if (libState.summarizedUpTo === oldId) {
      libState.summarizedUpTo = newId
      libStateModified = true
    }
    // recentMentions
    if (libState.recentMentions[oldId]) {
      libState.recentMentions[newId] = libState.recentMentions[oldId]
      delete libState.recentMentions[oldId]
      libStateModified = true
    }
    for (const [key, ids] of Object.entries(libState.recentMentions)) {
      if (ids.includes(oldId)) {
        libState.recentMentions[key] = ids.map(id => id === oldId ? newId : id)
        libStateModified = true
      }
    }
    // timeline
    for (const event of libState.timeline) {
      if (event.fragmentId === oldId) {
        event.fragmentId = newId
        libStateModified = true
      }
    }
    if (libStateModified) {
      await saveState(dataDir, storyId, libState)
    }

    const analysesDir = join(root, 'librarian', 'analyses')
    if (existsSync(analysesDir)) {
      const files = await readdir(analysesDir)
      const jsonFiles = files.filter((f) => f.endsWith('.json'))
      let anyAnalysisModified = false

      await Promise.all(
        jsonFiles.map(async (file) => {
          const filePath = join(analysesDir, file)
          const raw = await readFile(filePath, 'utf-8')
          // Fast path: skip parsing if the old ID is not mentioned anywhere in the analysis JSON
          if (!raw.includes(oldId)) {
            return
          }

          const analysisId = file.replace('.json', '')
          const analysis = await getAnalysis(dataDir, storyId, analysisId)
          if (!analysis) return

          let analysisModified = false
          if (analysis.fragmentId === oldId) {
            analysis.fragmentId = newId
            analysisModified = true
          }
          if (analysis.summaryFragmentId === oldId) {
            analysis.summaryFragmentId = newId
            analysisModified = true
          }
          for (const m of analysis.mentions) {
            if (m.fragmentId === oldId) {
              m.fragmentId = newId
              analysisModified = true
            }
          }
          for (const c of analysis.contradictions) {
            if (c.fragmentIds.includes(oldId)) {
              c.fragmentIds = c.fragmentIds.map((id) => (id === oldId ? newId : id))
              analysisModified = true
            }
          }
          for (const proposal of analysis.fragmentChangeProposals) {
            if (proposal.sourceFragmentId === oldId) {
              proposal.sourceFragmentId = newId
              analysisModified = true
            }
            for (const operation of proposal.operations) {
              if (operation.action !== 'create_fragment' && operation.fragmentId === oldId) {
                operation.fragmentId = newId
                analysisModified = true
              }
            }
            for (const result of [...proposal.validation, ...(proposal.appliedResults ?? [])]) {
              if (result.target?.fragmentId === oldId) {
                result.target.fragmentId = newId
                analysisModified = true
              }
              if (result.createdFragmentId === oldId) {
                result.createdFragmentId = newId
                analysisModified = true
              }
            }
          }

          if (analysisModified) {
            await saveAnalysis(dataDir, storyId, analysis)
            anyAnalysisModified = true
          }
        })
      )

      // Always rebuild index if analyses were modified
      if (anyAnalysisModified) {
        await rebuildAnalysisIndex(dataDir, storyId)
      }
    }
  } catch (err) {
    log.error(`Failed to update Librarian data during ID refactor: ${err}`)
  }

  return newId
}
