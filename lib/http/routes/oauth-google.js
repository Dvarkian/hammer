/**
 * @file lib/http/routes/oauth-google.js
 * @description Google Gemini OAuth sign-in routes for the local Hammer dashboard.
 *
 * This is the installed-application flow: the dashboard asks for an authorization URL, the
 * browser opens Google, and Google redirects back to this same loopback server. The resulting
 * refresh token goes into the provider's normal OAuth account pool, so quotas and requests use
 * the same credential and the dashboard can show the account email and project id.
 */

import { randomUUID } from 'node:crypto'
import {
  addOrUpdateProviderAccount,
  getProviderAccounts,
  loadConfig,
  saveConfig,
  setProviderAccounts,
} from '../../config.js'
import {
  buildGoogleOAuthUrl,
  clearGoogleOAuthCaches,
  createGooglePkcePair,
  discoverGoogleProject,
  exchangeGoogleOAuthCode,
  fetchGoogleUserInfo,
  googleProjectFromEnvironment,
} from '../../google-oauth.js'

const FLOW_EXPIRY_MS = 10 * 60_000
const MAX_FLOWS = 12

function htmlEscape(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${htmlEscape(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
  main { max-width: 34rem; padding: 2rem; }
  h1 { font-size: 1.35rem; margin: 0 0 .75rem; }
  p { margin: .5rem 0; }
  code { background: color-mix(in srgb, CanvasText 8%, Canvas); padding: .1rem .3rem; border-radius: .25rem; }
  a { color: LinkText; }
</style></head>
<body><main>${body}</main></body></html>`
}

function localRedirectUri(req) {
  const localPort = Number(req.socket?.localPort) || 0
  if (localPort > 0) return `http://127.0.0.1:${localPort}/oauth2callback`
  // A reverse proxy can hide localPort, but an installed Hammer normally listens directly.
  const host = String(req.headers?.host || '')
  const match = host.match(/^(?:127\.0\.0\.1|localhost)(?::(\d+))?$/)
  const port = match?.[1] ? Number(match[1]) : 7352
  return `http://127.0.0.1:${port}/oauth2callback`
}

export function registerGoogleOAuthRoutes(app, deps = {}) {
  const providerKey = deps.providerKey || 'googleai'
  /** @type {Map<string, any>} */
  const flows = new Map()

  function pruneFlows() {
    const now = Date.now()
    for (const [id, flow] of flows) {
      if (flow.expiresAt <= now || flows.size > MAX_FLOWS) flows.delete(id)
    }
  }

  function finish(flow, result) {
    flow.status = result.status
    flow.error = result.error || null
    flow.email = result.email || null
    flow.projectId = result.projectId || null
    flow.planType = result.planType || null
    flow.finishedAt = Date.now()
  }

  app.get('/api/oauth/google/authorize', (req, res) => {
    pruneFlows()
    const flowId = randomUUID()
    const { verifier, challenge } = createGooglePkcePair()
    const redirectUri = localRedirectUri(req)
    const flow = {
      id: flowId,
      verifier,
      redirectUri,
      status: 'pending',
      error: null,
      email: null,
      projectId: null,
      planType: null,
      createdAt: Date.now(),
      expiresAt: Date.now() + FLOW_EXPIRY_MS,
    }
    flows.set(flowId, flow)
    const authUrl = buildGoogleOAuthUrl({ redirectUri, state: flowId, codeChallenge: challenge })
    res.json({
      flowId,
      authUrl,
      redirectUri,
      expiresAt: flow.expiresAt,
    })
  })

  app.get('/api/oauth/google/status', (req, res) => {
    pruneFlows()
    const flowId = String(req.query?.flowId || '')
    const flow = flows.get(flowId)
    if (!flow) {
      res
        .status(404)
        .json({ ok: false, status: 'missing', error: 'That Google sign-in attempt has expired.' })
      return
    }
    res.set('Cache-Control', 'no-store')
    res.json({
      ok: flow.status === 'success',
      status: flow.status,
      email: flow.email,
      projectId: flow.projectId,
      planType: flow.planType,
      error: flow.error,
    })
  })

  app.get('/oauth2callback', async (req, res) => {
    pruneFlows()
    const state = String(req.query?.state || '')
    const flow = flows.get(state)
    if (!flow) {
      res
        .status(400)
        .type('html')
        .send(
          page(
            'Google sign-in expired',
            '<h1>Google sign-in expired</h1><p>Return to Hammer and start the Google sign-in again.</p>',
          ),
        )
      return
    }
    if (flow.status !== 'pending') {
      res
        .status(409)
        .type('html')
        .send(
          page(
            'Google sign-in already completed',
            '<h1>Google sign-in already completed</h1><p>Return to Hammer.</p>',
          ),
        )
      return
    }
    if (flow.expiresAt <= Date.now()) {
      finish(flow, {
        status: 'error',
        error: 'The Google sign-in attempt expired before it completed.',
      })
      res
        .status(400)
        .type('html')
        .send(
          page(
            'Google sign-in expired',
            '<h1>Google sign-in expired</h1><p>Return to Hammer and try again.</p>',
          ),
        )
      return
    }

    const oauthError = String(req.query?.error || '')
    if (oauthError) {
      const error = String(req.query?.error_description || oauthError)
      finish(flow, { status: 'error', error })
      res
        .status(400)
        .type('html')
        .send(
          page(
            'Google sign-in failed',
            `<h1>Google sign-in failed</h1><p>${htmlEscape(error)}</p><p>Return to Hammer to retry.</p>`,
          ),
        )
      return
    }

    const code = String(req.query?.code || '')
    if (!code) {
      const error = 'Google did not return an authorization code.'
      finish(flow, { status: 'error', error })
      res
        .status(400)
        .type('html')
        .send(
          page(
            'Google sign-in failed',
            `<h1>Google sign-in failed</h1><p>${htmlEscape(error)}</p>`,
          ),
        )
      return
    }

    try {
      const tokens = await exchangeGoogleOAuthCode({
        code,
        codeVerifier: flow.verifier,
        redirectUri: flow.redirectUri,
      })
      const user = await fetchGoogleUserInfo(tokens.accessToken).catch(() => ({
        id: null,
        email: null,
        name: null,
      }))
      let projectId = googleProjectFromEnvironment()
      let planType = null
      try {
        const discovered = await discoverGoogleProject(tokens.accessToken, projectId)
        projectId = discovered.projectId || projectId
        planType = discovered.planType
      } catch (error) {
        // An inference-only account can still be signed in; quota will explain the missing
        // project later. Do not lose the refresh token over a quota lookup.
        if (!projectId) {
          process.stderr.write(
            `[google-oauth] project discovery failed: ${error instanceof Error ? error.message : String(error)}\n`,
          )
        }
      }

      const config = loadConfig()
      const provider = deps.ensureProviderConfig
        ? deps.ensureProviderConfig(config, providerKey)
        : (config.providers[providerKey] ||= {})
      provider.authMode = 'google-oauth'
      provider.authProvider = 'google'
      if (user.email) provider.authEmail = user.email
      if (projectId) provider.googleProjectId = projectId
      addOrUpdateProviderAccount(config, providerKey, {
        secret: tokens.refreshToken,
        email: user.email,
        accountId: user.id,
        projectId,
        planType,
      })
      saveConfig(config)
      clearGoogleOAuthCaches()
      deps.clearAuthCaches?.()
      void deps.triggerImmediateProviderPing?.(providerKey)
      void deps.refreshQuota?.()

      finish(flow, {
        status: 'success',
        email: user.email,
        projectId,
        planType,
      })
      res.type('html').send(
        page(
          'Google connected',
          `<h1>Google connected</h1>
         <p>${user.email ? `${htmlEscape(user.email)} is now the Google credential for Hammer.` : 'Google is now connected to Hammer.'}</p>
         ${projectId ? `<p>Quota project: <code>${htmlEscape(projectId)}</code></p>` : ''}
         <p>This sign-in covers quota. Google serves Gemini models only to a Gemini API key, so the
         provider stays at 0 models until one is added in its settings.</p>
         <p>You can close this tab and return to Hammer.</p>`,
        ),
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      finish(flow, { status: 'error', error: message })
      res
        .status(502)
        .type('html')
        .send(
          page(
            'Google sign-in failed',
            `<h1>Google sign-in failed</h1><p>${htmlEscape(message)}</p><p>Return to Hammer to retry.</p>`,
          ),
        )
    }
  })

  app.post('/api/oauth/google/disconnect', (req, res) => {
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
    // An empty body is the Disconnect button: sign every Google account out. A body with a
    // matching identifier or index removes exactly one.
    const removeAll = !identifier && index < 0
    let remaining = removeAll ? [] : existing
    if (identifier) {
      remaining = existing.filter(
        (account) =>
          String(account.email || '').toLowerCase() !== identifier &&
          String(account.accountId || '').toLowerCase() !== identifier &&
          String(account.projectId || '').toLowerCase() !== identifier,
      )
    } else if (index >= 0) {
      remaining = existing.filter((_, idx) => idx !== index)
    }

    if ((identifier || index >= 0) && remaining.length === existing.length) {
      res.status(404).json({ ok: false, error: 'That Google account is no longer signed in.' })
      return
    }

    setProviderAccounts(config, providerKey, remaining)
    const provider = config.providers?.[providerKey]
    if (provider) {
      if (remaining.length === 0) {
        delete provider.authMode
        delete provider.authProvider
        delete provider.authEmail
        delete provider.googleProjectId
        delete provider.accounts
      } else {
        const first = remaining[0]
        if (first?.email) provider.authEmail = first.email
        if (first?.projectId) provider.googleProjectId = first.projectId
      }
    }
    saveConfig(config)
    clearGoogleOAuthCaches()
    deps.clearAuthCaches?.()
    void deps.triggerImmediateProviderPing?.(providerKey)
    void deps.refreshQuota?.()
    res.json({ ok: true, remaining: remaining.length })
  })
}
