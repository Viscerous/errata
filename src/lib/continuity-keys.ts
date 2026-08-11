/**
 * A continuity key is what makes a state, thread, or knowledge observation an
 * *identity* rather than a note, so two spellings of one intent must collapse to
 * one key. Left free, models prefix keys with a fabricated fragment id and drift
 * between separators, opening a new identity per observation; the character is
 * already a separate field, so that prefix is redundant by construction.
 *
 * Normalize on both write and fold, or old keys fork the registry instead of
 * unifying with new ones. This lives in `lib` because spelling a key and reading
 * one are one vocabulary: the engine derives a thread's label from the key and
 * the panel renders it.
 */

const ID_PREFIX_RE = /^[a-z]{2,5}-[a-z0-9]{4,12}\s*[|:>/]\s*/i

/**
 * A key with no alphanumeric content is not an identity, and admitting one is
 * worse than dropping it: the live registry becomes a closed enum in the tool
 * schema, so a bare placeholder would become the only key the model may reuse
 * thereafter. Returning empty routes it into the skip path, which asks for a
 * real identity instead.
 */
export function normalizeContinuityKey(key: string): string {
  return key
    .trim()
    .replace(ID_PREFIX_RE, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/**
 * A key is a readable phrase by construction — snake_case words naming the thing
 * itself — so it presents as prose without a separate label. Both sides rely on
 * that: the engine need not reject an operation for wording it can derive, and
 * the panel has something to show for an advance or focus entry, which usually
 * carries no label of its own.
 */
export function continuityKeyLabel(key: string): string {
  const words = key.replace(/_+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * A continuity identity, scoped where the lane has an owner: knowledge belongs
 * to one character, state and threads to the story.
 *
 * One home for the pairing so the merge, the live membership set, and the fold
 * cannot drift: normalizing here means no caller has to remember to, and a
 * separator changed in one place cannot silently split the other two.
 *
 * `::` rather than an escaped NUL: a normalized key is `[a-z0-9_]` only, so it
 * cannot collide, and it stays readable in a log and a diff.
 */
export function scopedContinuityIdentity(key: string, scope?: string): string {
  const normalized = normalizeContinuityKey(key)
  return scope ? `${scope}::${normalized}` : normalized
}
