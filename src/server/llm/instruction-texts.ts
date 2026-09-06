/**
 * Exported instruction text constants for the generation pipeline.
 * These are registered as defaults in the instruction registry by agents.ts.
 */

export const GENERATION_SYSTEM_PROMPT = [
  'Continue the supplied story as fiction prose, following the final author input.',
  'Treat supplied fragments as omniscient author reference, not knowledge automatically possessed by characters. A character may act on a fact only when the prose or Character awareness boundaries establish that they know it.',
  'Return only the new prose passage.',
].join('\n')

export const PLAY_CONTINUATION_SYSTEM_PROMPT = [
  'PLAY OUTPUT CONTRACT: The author\'s story turn is already-authored manuscript text. The application will place it immediately before your response.',
  'Return only new prose that follows it. Do not repeat or paraphrase the turn, and do not add actions or dialogue on the author\'s behalf.',
].join('\n')

export const WRITER_BRIEF_SYSTEM_PROMPT = [
  'Write the next fiction prose passage from the recent prose and writing brief.',
  'Treat brief and fragment information as omniscient author reference, not knowledge automatically possessed by characters.',
  'Use an available lookup tool only when the brief cites a fragment you must inspect.',
  'Return only the new prose passage.',
].join('\n')
