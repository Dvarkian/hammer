/**
 * ── Shared provider keys ───────────────────────────────────────────────────────────────
 *
 * The provider keys that both `lib/server.js` and `lib/providers/discovery.js` have to name.
 * They live here — the lowest module the two can import — so the spelling exists once: a
 * key that is `'kilocode'` in one file and `'kilo-code'` in the other would fail quietly, as
 * a provider whose catalog is fetched under one name and routed under another.
 *
 * Scope is deliberately narrow. These are only the providers with a bespoke *catalog* shape,
 * which is what discovery has to agree about; every other provider key hammer names is still
 * declared where it is used, next to the narrative that explains it. Nothing here is a
 * secret, an endpoint or a fact about a provider beyond its name.
 */

/** Free rows flagged by `isFree` rather than by an id suffix. */
export const KILOCODE_PROVIDER_KEY = 'kilocode'
/** A plain OpenAI `data` array on a free host. */
export const EMPERO_PROVIDER_KEY = 'empero'
/** A full catalog of which only the `:free` rows are routable. */
export const OPENROUTER_PROVIDER_KEY = 'openrouter'
/** `/api/tags` plus a per-model `/api/show`, and a local base URL that needs no key. */
export const OLLAMA_PROVIDER_KEY = 'ollama'
