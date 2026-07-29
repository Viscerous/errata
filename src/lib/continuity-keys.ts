/**
 * Continuity keys are the only thing making a state, thread, or knowledge
 * observation an *identity* rather than a note, so two spellings of one intent
 * must collapse to one key.
 *
 * Timeline 9 produced seven knowledge operations under seven distinct keys with
 * no reuse at all. Five embedded a fabricated fragment-id prefix
 * (`ch-zinozi|mpamba_view_of_her`, `kn-zinozi|high-priestess-role`) and the
 * prefix alternated between `ch-` and `kn-` for the same character, so the
 * rendered registry could never be matched. The character is already a separate
 * field, so that prefix is redundant by construction. Separator style also
 * drifted within one run (`victoria_trial-of-two-grounds` beside
 * `victoria_trial_status`).
 *
 * Normalizing on both write and fold means older raw keys unify with new ones
 * instead of silently forking the registry.
 *
 * This lives in `lib` rather than under the server because a key's spelling and
 * its reading are one vocabulary: the engine derives a thread's label from the
 * key and the panel renders it, and two copies of that transform would drift
 * into two different names for the same thread.
 */

const ID_PREFIX_RE = /^[a-z]{2,5}-[a-z0-9]{4,12}\s*[|:>/]\s*/i

/**
 * A key carrying no alphanumeric content is not an identity, and admitting one
 * is worse than dropping it. Timeline 11 accepted a literal `_` as a thread key
 * — the 12B had put the real key in `label` — and because the live registry
 * becomes a closed enum in the tool schema, `_` then became the *only* thread
 * key the model was allowed to reuse for the rest of the timeline. Returning
 * empty routes it into the existing skip path, which names the lane and asks for
 * a real identity.
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
 * A key is already a readable phrase by construction — snake_case words naming
 * the thing itself — so it reads as prose once the underscores go, and a thread
 * never needs a separate label to be presentable.
 *
 * Both sides depend on that. The engine used to drop an `open` that arrived
 * without a label, which cost the whole operation over wording it could derive;
 * the panel uses it wherever an operation carried no label of its own, since an
 * advance or a focus entry usually has none and showing the bare key put
 * `the_trial_of_two_grounds` in front of the author.
 */
export function continuityKeyLabel(key: string): string {
  const words = key.replace(/_+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}
