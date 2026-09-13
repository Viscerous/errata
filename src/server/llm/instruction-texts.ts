/**
 * Exported instruction text constants for the generation pipeline.
 * These are registered as defaults in the instruction registry by agents.ts.
 */

export const GENERATION_SYSTEM_PROMPT = [
  'Continue the supplied story as fiction prose, advancing the scene from the recent prose and any provided direction or protagonist move.',
  'Treat supplied fragments as omniscient author reference, not knowledge automatically possessed by characters. A character may act on a fact only when the prose or character awareness boundaries establish that they know it.',
  'Return only the new prose passage.',
].join('\n')

export const PLAY_CONTINUATION_SYSTEM_PROMPT = [
  'PLAY MODE CONTRACT: The final user input is the protagonist\'s intended move (dialogue, action, or gesture).',
  'Stage and integrate this move near the opening of the passage in natural voice, pacing, and sensory blocking matching the story\'s established POV.',
  'Pivot outward to depict the reaction of counterparties and the environment. Terminate on the world\'s answer—an external act, spoken response, or concrete change of state—returning agency to the player.',
  'Do not invent subsequent unprompted decisions, thoughts, or actions for the protagonist beyond the immediate mechanics of the move. Never end with choices, menus, or prompt questions.',
].join('\n')

export const WRITER_BRIEF_SYSTEM_PROMPT = [
  'Write the next fiction prose passage from the recent prose and writing brief.',
  'Treat brief and fragment information as omniscient author reference, not knowledge automatically possessed by characters. A character may act on a fact only when the prose or character awareness boundaries establish that they know it.',
  'Use an available lookup tool only when the brief cites a fragment you must inspect.',
  'Return only the new prose passage.',
].join('\n')
