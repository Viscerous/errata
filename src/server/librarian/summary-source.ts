import type { Fragment } from '@/contracts/story'
import { proseContentHash } from './continuity-source'
import { getAnalysisSummarySource } from './storage'
import { SUMMARY_CONTRACT_VERSION } from './summary-contract'

export type SummaryGapReason = 'missing-analysis' | 'empty-summary' | 'unverified-source' | 'stale-source' | 'old-contract'

/** A passage contributes to story memory only when its latest summary still matches its source. */
export async function inspectSummarySource(
  dataDir: string,
  storyId: string,
  fragment: Fragment,
  analysisId: string | undefined,
): Promise<{ gapReason: SummaryGapReason } | { analysisId: string; text: string; sourceHash: string; contractVersion: number }> {
  if (!analysisId) return { gapReason: 'missing-analysis' }
  const source = await getAnalysisSummarySource(dataDir, storyId, analysisId)
  if (!source?.text) return { gapReason: 'empty-summary' }
  if (!source.sourceHash) return { gapReason: 'unverified-source' }
  if (source.sourceHash !== proseContentHash(fragment)) return { gapReason: 'stale-source' }
  if (source.contractVersion !== SUMMARY_CONTRACT_VERSION) return { gapReason: 'old-contract' }
  return {
    analysisId,
    text: source.text,
    sourceHash: source.sourceHash,
    contractVersion: source.contractVersion,
  }
}
