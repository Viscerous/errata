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
  'The input under ## Protagonist Move is the protagonist\'s intended action or dialogue.',
  'Render the protagonist performing this move, speaking any quoted dialogue as written.',
  'The protagonist acts or speaks once from this input; the remainder of the passage belongs to the world\'s response.',
  'Terminate on an external beat—another character\'s reaction, spoken reply, or a shift in the scene.',
  'Do not invent subsequent lines, decisions, or reflections for the protagonist, and never end with choices, menus, or prompt questions.',
].join('\n')

export const WRITER_BRIEF_SYSTEM_PROMPT = [
  'Write the next fiction prose passage from the recent prose and writing brief.',
  'Treat brief and fragment information as omniscient author reference, not knowledge automatically possessed by characters. A character may act on a fact only when the prose or character awareness boundaries establish that they know it. Characters perceive only what their physical senses directly witness in the immediate scene.',
  'Use an available lookup tool only when the brief cites a fragment you must inspect.',
  'Return only the new prose passage.',
].join('\n')
