// @ts-check
/**
 * @file oauth-devin.js
 * @description Devin browser OAuth: start a flow, report its status, exchange
 * the returned code, and cancel it.
 *
 * The flow engines and their store stay in `server.js` (they are also used by
 * the startup path); what moves here is the HTTP surface plus the one callback
 * that writes a freshly minted session token into the local config — it existed
 * only because these routes needed it, so it now lives with them rather than as
 * a closure inside `runServer`.
 */

import { loadConfig, saveConfig } from '../../config.js'

/**
 * @param {import('express').Express} app
 * @param {{
 *   providerKey: string,
 *   normalizeSecretValue: (value: unknown) => string,
 *   normalizeToken: (token: string) => string,
 *   clearAuthCaches: () => void,
 *   triggerImmediateProviderPing: (scopeKey: string) => void,
 *   startFlow: (options: { onToken: (token: string) => void }) => Promise<any>,
 *   getFlowStatus: (flowId: string) => any,
 *   exchangeFlow: (
 *     flowId: string,
 *     code: string,
 *     state: string,
 *     options: { onToken: (token: string) => void },
 *   ) => Promise<any>,
 *   cancelFlow: (flowId: string) => boolean,
 * }} deps
 */
export function registerDevinOAuthRoutes(app, deps) {
  const {
    providerKey,
    normalizeSecretValue,
    normalizeToken,
    clearAuthCaches,
    triggerImmediateProviderPing,
    startFlow,
    getFlowStatus,
    exchangeFlow,
    cancelFlow,
  } = deps

  // Save a freshly minted Devin session token into the local config so the
  // Connect wire client picks it up, then nudge the provider ping loop.
  const persistSessionToken = (token) => {
    const currentConfig = loadConfig()
    const stored = normalizeToken(token)
    currentConfig.apiKeys[providerKey] = stored
    // A legacy per-provider session token is cleared once the account-level
    // credential holds it. The config type does not describe that legacy field,
    // hence the explicit cast rather than a widening of the shared type.
    const legacyProviderConfig = /** @type {any} */ (currentConfig.providers?.[providerKey])
    if (legacyProviderConfig?.sessionToken) delete legacyProviderConfig.sessionToken
    saveConfig(currentConfig)
    clearAuthCaches()
    void triggerImmediateProviderPing(providerKey)
  }

  app.get('/api/oauth/devin/authorize', async (req, res) => {
    try {
      const started = await startFlow({ onToken: persistSessionToken })
      return res.json(started)
    } catch (err) {
      return res.status(500).json({ error: err?.message || 'Failed to start Devin OAuth.' })
    }
  })

  app.get('/api/oauth/devin/status', (req, res) => {
    try {
      const flowId = normalizeSecretValue(req.query?.flowId)
      if (!flowId) {
        return res.status(400).json({ error: 'flowId is required.' })
      }
      return res.json(getFlowStatus(flowId))
    } catch (err) {
      return res.status(500).json({ error: err?.message || 'Failed to read Devin OAuth status.' })
    }
  })

  app.post('/api/oauth/devin/exchange', async (req, res) => {
    try {
      const flowId = normalizeSecretValue(req.body?.flowId)
      const code = normalizeSecretValue(req.body?.code)
      const state = normalizeSecretValue(req.body?.state)
      if (!flowId || !code) {
        return res.status(400).json({ error: 'flowId and code are required.' })
      }
      await exchangeFlow(flowId, code, state, { onToken: persistSessionToken })
      return res.json({ success: true })
    } catch (err) {
      return res.status(502).json({ error: err?.message || 'Failed to complete Devin OAuth.' })
    }
  })

  app.post('/api/oauth/devin/cancel', (req, res) => {
    try {
      const flowId = normalizeSecretValue(req.body?.flowId)
      if (!flowId) {
        return res.status(400).json({ error: 'flowId is required.' })
      }
      const cancelled = cancelFlow(flowId)
      return res.json({ success: cancelled })
    } catch (err) {
      return res.status(500).json({ error: err?.message || 'Failed to cancel Devin OAuth.' })
    }
  })
}
