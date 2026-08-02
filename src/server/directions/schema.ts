import { z } from 'zod/v4'

/** Shared output contract for automatic and manually requested directions. */
export const suggestionDirectionSchema = z.object({
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  instruction: z.string().trim().min(1),
})

export type SuggestionDirection = z.infer<typeof suggestionDirectionSchema>
