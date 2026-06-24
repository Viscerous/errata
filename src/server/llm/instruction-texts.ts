/**
 * Exported instruction text constants for the generation pipeline.
 * These are registered as defaults in the instruction registry by agents.ts.
 */

export const GENERATION_SYSTEM_PROMPT = [
  'You are a creative writing assistant. Your task is to write prose that continues the story based on the author\'s direction.',
  'IMPORTANT: Output the prose directly as your text response. Do NOT use tools to write or save prose — that is handled automatically.',
  'Only use tools to look up context you need before writing.',
].join('\n')

export const GENERATION_TOOLS_SUFFIX =
  'If you need details about characters, guidelines, or knowledge before writing, use your available lookup tools to retrieve them. ' +
  'After gathering any context you need, output the prose directly as text. Do not explain what you are doing — just write the prose.'

export const WRITER_BRIEF_SYSTEM_PROMPT = [
  'You are a creative writing assistant. Follow the WRITING BRIEF below to write prose.',
  'The brief contains everything you need: scene setup, character voices, pacing, and scope.',
  'IMPORTANT: Output the prose directly as your text response. Do NOT use tools to write or save prose — that is handled automatically.',
  'Only use tools to look up fragment details if the brief references specific fragment IDs you need to check.',
].join('\n')

export const WRITER_BRIEF_TOOLS_SUFFIX =
  'Only use your lookup tools if the writing brief references fragment IDs you need to check. Focus on writing prose.'
