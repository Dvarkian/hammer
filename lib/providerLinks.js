/**
 * 📖 Signup / credential pages, keyed by provider.
 *
 * This table used to be hand-maintained here and had drifted: nothing tied an entry to
 * the provider it described. It is now derived from the provider descriptors, so a provider's signup
 * link lives beside the rest of its definition and cannot go missing.
 *
 * The notes that used to annotate individual entries — that GitHub Copilot and OpenAI
 * Codex sign in through an OAuth device flow rather than a dashboard key, that g4f's key
 * is optional, that gptfree has no credential page at all — now sit with each provider
 * in lib/providers/catalog.js.
 */

import { signupUrlTable } from './providers/index.js'

export const API_KEY_SIGNUP_URLS = signupUrlTable()
