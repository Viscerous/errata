/**
 * Inline fragment references: `<@ch-bafego>` or `<@ch-bafego:short>`.
 *
 * Generated IDs are a 2-4 character type prefix plus six lowercase letters, but
 * imported bundles carry hand-authored IDs with longer, sometimes alphanumeric
 * suffixes (`prot-crownbelow`, `orga-victisbank`), so the suffix range is wider
 * than the generator's own output.
 *
 * Returned fresh per call: the pattern is global, and a shared instance would
 * leak `lastIndex` between the context builder and the receipt writer.
 */
export function fragmentTagPattern(): RegExp {
  return /<@([a-z]{2,4}-[a-z0-9]{4,12})(?::(short))?>/g
}
