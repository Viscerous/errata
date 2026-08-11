import { z } from 'zod/v4'

/**
 * Shared output contract for automatic and manually requested directions.
 *
 * The descriptions live here rather than at each call site: two tools named
 * `proposeDirections` — the librarian's and the prewriter's — had drifted into
 * two shapes for one idea, the librarian re-declaring these exact three fields
 * just to attach wording and the prewriter not reusing them at all. A caller
 * that needs more, like the prewriter's pacing, extends this.
 */
export const suggestionDirectionSchema = z.object({
  title: z.string().trim().min(1).describe('Short evocative title (3-6 words)'),
  description: z.string().trim().min(1).describe('One or two sentences previewing what happens'),
  instruction: z.string().trim().min(1).describe('Concrete writing prompt for the writer to follow this direction'),
})

export type SuggestionDirection = z.infer<typeof suggestionDirectionSchema>
