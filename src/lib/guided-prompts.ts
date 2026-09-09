/** Default instructions behind the promptless guided-writing actions. */
export const GUIDED_CONTINUE_PROMPT =
  'Continue the story naturally. Write the next scene, advancing the plot and developing characters.'

export const GUIDED_SCENE_SETTING_PROMPT =
  "Continue the story without advancing the plot. Focus on atmosphere, internal thoughts, sensory details, or character moments. Don't introduce new events or move the story forward."

export const GUIDED_SUGGEST_PROMPT =
  'Return exactly {{count}} meaningfully different directions as a raw JSON array. Each item must contain "title" (3-6 evocative words), "description" (1-2 sentences), and "instruction" (a concrete 2-3 sentence prompt for the prose writer). Vary the narrative purpose across plot, relationship, tension, quiet development, or surprise where the story supports it. Return no text outside the JSON array.'
