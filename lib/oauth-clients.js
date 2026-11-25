/**
 * @file lib/oauth-clients.js
 * @description Where Hammer's installed-application OAuth clients come from.
 *
 * Google accepts a sign-in only from a client id registered for the scopes being asked, so the
 * Gemini quota flow and the Antigravity flow each need a desktop client's id and secret. Those
 * two values cannot live in this repository: a client secret in tracked source is a leaked
 * credential to every secret scanner — GitHub's push protection refused the commit that carried
 * them — even when the vendor ships the same pair inside its own binary.
 *
 * They therefore come from the environment, or from the user's own state file:
 *
 *     ~/.hammer/oauth-clients.json
 *     {
 *       "google":      { "clientId": "...", "clientSecret": "..." },
 *       "antigravity": { "clientId": "...", "clientSecret": "..." }
 *     }
 *
 * The environment wins, so a shell or a CI run can override the file without editing it. Only
 * the entry a flow needs has to exist; a missing pair is reported when that sign-in is started,
 * not at import, so the rest of the app keeps working.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const OAUTH_CLIENTS_PATH = join(homedir(), '.hammer', 'oauth-clients.json')

/** The env names each flow has always honoured, kept so existing setups keep working. */
const ENV_NAMES = {
  google: { id: 'GOOGLE_OAUTH_CLIENT_ID', secret: 'GOOGLE_OAUTH_CLIENT_SECRET' },
  antigravity: { id: 'ANTIGRAVITY_CLIENT_ID', secret: 'ANTIGRAVITY_CLIENT_SECRET' },
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * The file's contents, or an empty object when it is absent, unreadable or not JSON.
 *
 * A broken file must not take the whole sign-in path down: a missing entry is reported as an
 * unconfigured client, which is the same message a user with no file gets.
 *
 * @param {string} [path]
 * @returns {Record<string, any>}
 */
function readClientsFile(path = OAUTH_CLIENTS_PATH) {
  try {
    if (!existsSync(path)) return {}
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * The client a flow should use, or `null` when neither source names one.
 *
 * A pair is only usable whole. Google answers `invalid_client` for a secret without its id, and
 * a half-configured client would present as a sign-in that fails after consent — a setup error
 * showing up as a Google error page — rather than as a missing configuration.
 *
 * @param {'google'|'antigravity'} name
 * @param {{path?:string, env?:Record<string,string|undefined>}} [options]
 * @returns {{clientId:string, clientSecret:string}|null}
 */
export function resolveOAuthClient(name, options = {}) {
  const names = ENV_NAMES[name]
  if (!names) return null
  const env = options.env || process.env
  const file = readClientsFile(options.path)
  const entry = file[name] && typeof file[name] === 'object' ? file[name] : {}
  const clientId = text(env[names.id]) || text(entry.clientId)
  const clientSecret = text(env[names.secret]) || text(entry.clientSecret)
  if (!clientId || !clientSecret) return null
  return { clientId, clientSecret }
}

/**
 * The client without which a flow cannot start, with the fix in the message.
 *
 * The message is what the dashboard shows under the sign-in button, so it names both sources
 * and the exact path rather than saying only that something is missing.
 *
 * @param {'google'|'antigravity'} name
 * @param {{path?:string, env?:Record<string,string|undefined>}} [options]
 * @returns {{clientId:string, clientSecret:string}}
 */
export function requireOAuthClient(name, options = {}) {
  const client = resolveOAuthClient(name, options)
  if (client) return client
  const names = ENV_NAMES[name] || { id: 'CLIENT_ID', secret: 'CLIENT_SECRET' }
  const path = options.path || OAUTH_CLIENTS_PATH
  throw new Error(
    `No ${name} OAuth client is configured. Set ${names.id} and ${names.secret}, ` +
      `or add a "${name}": {"clientId": "...", "clientSecret": "..."} entry to ${path}.`,
  )
}
