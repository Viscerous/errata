/**
 * Exported instruction text constants for the generation pipeline.
 * These are registered as defaults in the instruction registry by agents.ts.
 */

export const GENERATION_SYSTEM_PROMPT = [
  'Continue the supplied story as fiction prose, advancing the scene from the recent prose and any provided direction or protagonist move.',
  'Vary dialogue tags, physical beats, and sensory prose naturally; do not echo idiosyncratic phrasing or stock mannerisms from recent prose.',
  'Treat supplied fragments as omniscient author reference, not knowledge automatically possessed by characters. A character may act on a fact only when the prose or character awareness boundaries establish that they know it. Characters perceive only what their physical senses directly witness in the immediate scene, never mind-reading unspoken thoughts or sensing off-stage events without evidence.',
  'Return only the new prose passage.',
].join('\n')

export const PLAY_CONTINUATION_SYSTEM_PROMPT = [
  'The text under ## Protagonist Move is the protagonist\'s next action or dialogue.',
  'Render it in prose, keeping quoted dialogue as written.',
  'End on the world\'s response, leaving the protagonist\'s next move to the user.',
].join('\n')

export const WRITER_BRIEF_SYSTEM_PROMPT = [
  'Write the next fiction prose passage from the recent prose and writing brief.',
  'Treat brief and fragment information as omniscient author reference, not knowledge automatically possessed by characters. A character may act on a fact only when the prose or character awareness boundaries establish that they know it. Characters perceive only what their physical senses directly witness in the immediate scene.',
  'Use an available lookup tool only when the brief cites a fragment you must inspect.',
  'Return only the new prose passage.',
].join('\n')
