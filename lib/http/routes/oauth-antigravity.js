/**
 * @file lib/http/routes/oauth-antigravity.js
 * @description Antigravity sign-in: consent on its registered loopback callback, then onboarding.
 *
 * The Antigravity OAuth client registers `127.0.0.1:51121/oauth-callback`, and Google matches a
 * desktop client's redirect exactly, so this flow cannot reuse Hammer's own callback port. A
 * listener is opened on that port for the lifetime of the sign-in attempt and closed the moment
 * the attempt finishes, fails or expires — the main server keeps running on its own port.
 */

import { randomUUID } from 'node:crypto'
import http from 'node:http'
import {
  ANTIGRAVITY_CALLBACK_HOST,
  ANTIGRAVITY_CALLBACK_PATH,
  ANTIGRAVITY_CALLBACK_PORT,
  buildAntigravityAuthUrl,
  createAntigravityPkcePair,
  exchangeAntigravityCode,
  fetchAntigravityUserInfo,
  resolveAntigravityProject,
} from '../../google-antigravity.js'
import { getProviderAccounts, removeProviderAccount } from '../../config.js'
import { requireOAuthClient } from '../../oauth-clients.js'

const FLOW_EXPIRY_MS = 10 * 60_000
const MAX_FLOWS = 8

function htmlEscape(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
  )
}

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${htmlEscape(title)}</title>
<style>body{font-family:system-ui,sans-serif;background:#111;color:#eee;max-width:40rem;margin:12vh auto;padding:0 1.5rem;line-height:1.55}
code{background:#222;padding:2px 6px;border-radius:4px}a{color:#8ab4f8}</style></head>
<body>${body}</body></html>`
}

/**
 * The callback arrives on the bare `node:http` listener, not through Express, so it gets a
 * `ServerResponse` — no `status()`, `type()` or `send()`. Answering with those helpers throws
 * `res.status is not a function` and the browser tab is left hanging with no page at all.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} title
 * @param {string} body
 */
function sendHtml(res, status, title, body) {
  if (res.headersSent) {
    res.end()
    return
  }
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(page(title, body))
}

/**
 * @param {import('express').Express} app
 * @param {{
 *   providerKey?: string,
 *   loadConfig: () => any,
 *   saveConfig: (config: any) => void,
 *   ensureProviderConfig: (config: any, key: string) => any,
 *   addOrUpdateProviderAccount: (config: any, key: string, account: any) => void,
 *   clearAuthCaches?: () => void,
 *   triggerImmediateProviderPing?: (key: string) => void,
 * }} deps
 */
export function registerAntigravityOAuthRoutes(app, deps) {
  const {
    providerKey = 'google-antigravity',
    loadConfig,
    saveConfig,
    ensureProviderConfig,
    addOrUpdateProviderAccount,
    clearAuthCaches,
    triggerImmediateProviderPing,
  } = deps

  /** @type {Map<string, any>} */
  const flows = new Map()
  /** @type {import('node:http').Server|null} */
  let listener = null

  function pruneFlows() {
    const now = Date.now()
    for (const [id, flow] of flows) {
      if (flow.expiresAt <= now || flows.size > MAX_FLOWS) flows.delete(id)
    }
    if (flows.size === 0) closeListener()
  }

  function closeListener() {
    if (!listener) return
    const active = listener
    listener = null
    active.close()
    // The browser keeps its socket alive after the page, and close() waits for it; the callback
    // has been answered by now, so let the idle connection go instead of holding the process.
    active.closeIdleConnections?.()
  }

  function finish(flow, result) {
    flow.status = result.status
    flow.error = result.error || null
    flow.email = result.email || null
    flow.projectId = result.projectId || null
    flow.tier = result.tier || null
    flow.finishedAt = Date.now()
  }

  async function persist(tokens) {
    const user = await fetchAntigravityUserInfo(tokens.accessToken).catch(() => ({
      email: null,
      id: null,
    }))
    let projectId = null
    let tier = null
    try {
      const resolved = await resolveAntigravityProject(tokens.accessToken, null)
      projectId = resolved.projectId
      tier = resolved.tier
    } catch (error) {
      // A signed-in account without a project is still worth keeping: the refresh token is the
      // hard part, and onboarding can be retried from the card.
      process.stderr.write(
        `[google-antigravity] project onboarding failed: ${error instanceof Error ? error.message : String(error)}\n`,
      )
    }
    const config = loadConfig()
    const provider = ensureProviderConfig(config, providerKey)
    provider.authMode = 'antigravity-oauth'
    provider.authProvider = 'google-antigravity'
    if (user.email) provider.authEmail = user.email
    // A second sign-in is a second pool entry, not a replacement: the account is matched by
    // email, so the same Google account signing in again refreshes its row in place.
    addOrUpdateProviderAccount(config, providerKey, {
      secret: tokens.refreshToken,
      email: user.email,
      accountId: user.id,
      projectId,
      planType: tier,
    })
    const accounts = getProviderAccounts(config, providerKey)
    // The project belongs to the account. A single provider-level project is only unambiguous
    // when there is a single account; with several, each row carries its own and the stale
    // provider value is dropped so it cannot be paired with the wrong token.
    if (projectId && accounts.length === 1) provider.googleProjectId = projectId
    else if (accounts.length > 1) delete provider.googleProjectId
    saveConfig(config)
    clearAuthCaches?.()
    void triggerImmediateProviderPing?.(providerKey)
    return { email: user.email, projectId, tier }
  }

  async function handleCallback(req, res) {
    pruneFlows()
    const state = String(req.query?.state || '')
    const flow = flows.get(state)
    if (!flow) {
      sendHtml(
        res,
        400,
        'Antigravity sign-in expired',
        '<h1>Antigravity sign-in expired</h1><p>Return to Hammer and start the sign-in again.</p>',
      )
      return
    }
    const oauthError = String(req.query?.error || '')
    if (oauthError) {
      const message = String(req.query?.error_description || oauthError)
      finish(flow, { status: 'error', error: message })
      sendHtml(
        res,
        400,
        'Antigravity sign-in failed',
        `<h1>Sign-in failed</h1><p>${htmlEscape(message)}</p>`,
      )
      closeListener()
      return
    }
    const code = String(req.query?.code || '')
    if (!code) {
      finish(flow, { status: 'error', error: 'Google did not return an authorization code.' })
      sendHtml(
        res,
        400,
        'Antigravity sign-in failed',
        '<h1>Sign-in failed</h1><p>No authorization code.</p>',
      )
      closeListener()
      return
    }
    try {
      const tokens = await exchangeAntigravityCode({
        code,
        codeVerifier: flow.verifier,
        redirectUri: flow.redirectUri,
      })
      const saved = await persist(tokens)
      finish(flow, { status: 'success', ...saved })
      sendHtml(
        res,
        200,
        'Antigravity connected',
        `<h1>Antigravity connected</h1>
           <p>${saved.email ? `${htmlEscape(saved.email)} is now the Google credential for Hammer.` : 'Antigravity is connected.'}</p>
           ${saved.projectId ? `<p>Code Assist project: <code>${htmlEscape(saved.projectId)}</code></p>` : '<p>No Code Assist project was provisioned; Hammer will retry on the next refresh.</p>'}           <p>You can close this tab and return to Hammer.</p>`,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      finish(flow, { status: 'error', error: message })
      sendHtml(
        res,
        502,
        'Antigravity sign-in failed',
        `<h1>Sign-in failed</h1><p>${htmlEscape(message)}</p>`,
      )
    } finally {
      closeListener()
    }
  }

  async function ensureListener() {
    if (listener) return
    await new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const path = (req.url || '').split('?')[0]
        if (path !== ANTIGRAVITY_CALLBACK_PATH) {
          res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found')
          return
        }
        // handleCallback reads `req.query` like an Express handler, and a URLSearchParams is not
        // one — `query.state` would be undefined and every callback would look unknown.
        const query = Object.fromEntries(new URL(req.url || '/', 'http://127.0.0.1').searchParams)
        void handleCallback({ query }, res).catch((error) => {
          process.stderr.write(
            `[google-antigravity] callback failed: ${error instanceof Error ? error.message : String(error)}\n`,
          )
          sendHtml(
            res,
            500,
            'Antigravity sign-in failed',
            '<h1>Sign-in failed</h1><p>Hammer could not finish the sign-in. Check the app log.</p>',
          )
        })
      })
      server.once('error', (error) => {
        reject(error)
      })
      server.listen(ANTIGRAVITY_CALLBACK_PORT, ANTIGRAVITY_CALLBACK_HOST, () => {
        listener = server
        resolve(undefined)
      })
    })
  }

  app.get('/api/oauth/antigravity/authorize', async (req, res) => {
    pruneFlows()
    // Checked before the callback port is opened: an unconfigured client is a setup problem,
    // and holding port 51121 for ten minutes would only make the next attempt fail as busy.
    try {
      requireOAuthClient('antigravity')
    } catch (error) {
      return res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      })
    }
    const flowId = randomUUID()
    const { verifier, challenge } = createAntigravityPkcePair()
    try {
      await ensureListener()
    } catch (error) {
      const busy = /** @type {any} */ (error)?.code === 'EADDRINUSE'
      return res.status(503).json({
        error: busy
          ? `Port ${ANTIGRAVITY_CALLBACK_PORT} is busy. Antigravity's OAuth client only accepts its own callback, so close whatever is using that port and try again.`
          : `Could not listen on ${ANTIGRAVITY_CALLBACK_HOST}:${ANTIGRAVITY_CALLBACK_PORT}: ${error?.message || 'unknown error'}`,
      })
    }
    const flow = {
      id: flowId,
      verifier,
      redirectUri: `http://${ANTIGRAVITY_CALLBACK_HOST}:${ANTIGRAVITY_CALLBACK_PORT}${ANTIGRAVITY_CALLBACK_PATH}`,
      status: 'pending',
      error: null,
      email: null,
      projectId: null,
      tier: null,
      createdAt: Date.now(),
      expiresAt: Date.now() + FLOW_EXPIRY_MS,
    }
    flows.set(flowId, flow)
    return res.json({
      flowId,
      authUrl: buildAntigravityAuthUrl({
        redirectUri: flow.redirectUri,
        state: flowId,
        codeChallenge: challenge,
      }),
      redirectUri: flow.redirectUri,
      expiresAt: flow.expiresAt,
    })
  })

  app.get('/api/oauth/antigravity/status', (req, res) => {
    pruneFlows()
    const flow = flows.get(String(req.query?.flowId || ''))
    if (!flow) {
      return res.status(404).json({
        ok: false,
        status: 'missing',
        error: 'That Antigravity sign-in attempt has expired.',
      })
    }
    res.set('Cache-Control', 'no-store')
    return res.json({
      ok: flow.status === 'success',
      status: flow.status,
      email: flow.email,
      projectId: flow.projectId,
      tier: flow.tier,
      error: flow.error,
    })
  })

  app.post('/api/oauth/antigravity/accounts/remove', (req, res) => {
    const config = loadConfig()
    const existing = getProviderAccounts(config, providerKey)
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const identifier =
      typeof body.account === 'string'
        ? body.account.trim().toLowerCase()
        : typeof body.email === 'string'
          ? body.email.trim().toLowerCase()
          : ''
    const index = Number.isInteger(body.index) ? body.index : -1
    const target = identifier
      ? existing.find(
          (account) =>
            String(account.email || '').toLowerCase() === identifier ||
            String(account.accountId || '').toLowerCase() === identifier ||
            String(account.projectId || '').toLowerCase() === identifier,
        ) || null
      : index >= 0
        ? existing[index] || null
        : null
    if (!target) {
      return res
        .status(404)
        .json({ ok: false, error: 'That Antigravity account is no longer signed in.' })
    }
    removeProviderAccount(config, providerKey, target.secret)
    const provider = config.providers?.[providerKey]
    const remaining = getProviderAccounts(config, providerKey)
    if (provider) {
      if (remaining.length === 0) {
        delete provider.authMode
        delete provider.authProvider
        delete provider.authEmail
        delete provider.googleProjectId
        delete provider.accounts
      } else if (remaining.length === 1) {
        // Back to a single account, where one project cannot be confused with a sibling's.
        if (remaining[0].email) provider.authEmail = remaining[0].email
        if (remaining[0].projectId) provider.googleProjectId = remaining[0].projectId
      } else {
        delete provider.googleProjectId
      }
    }
    saveConfig(config)
    clearAuthCaches?.()
    void triggerImmediateProviderPing?.(providerKey)
    return res.json({ ok: true, remaining: remaining.length })
  })

  app.post('/api/oauth/antigravity/disconnect', (req, res) => {
    const config = loadConfig()
    const provider = config.providers?.[providerKey]
    if (provider) {
      delete provider.accounts
      delete provider.authMode
      delete provider.authProvider
      delete provider.authEmail
      delete provider.googleProjectId
    }
    saveConfig(config)
    clearAuthCaches?.()
    void triggerImmediateProviderPing?.(providerKey)
    return res.json({ ok: true, remaining: 0 })
  })
}
