// @ts-check
/**
 * @file oauth-codex.js
 * @description OpenAI Codex sign-in (ChatGPT OAuth device flow).
 *
 * ChatGPT's device flow has two legs: the device authorization hands back a
 * user code the user approves on auth.openai.com/codex/device, then the
 * authorization code is exchanged (with the PKCE verifier the backend
 * generated) for the OAuth tokens. Only the long-lived refresh token is stored;
 * access tokens are exchanged on demand.
 *
 * Extracted from `runServer` with its flow store and explicit dependencies, so
 * the whole sign-in can be exercised without booting the router.
 */

import { randomUUID } from 'node:crypto'
import {
  loadConfig,
  saveConfig,
  addOrUpdateProviderAccount,
  getProviderAccounts,
} from '../../config.js'
import { extractCodexAccountIdentity } from '../../openai-codex.js'

/** In-progress device authorisations, keyed by the id handed to the browser. */
const deviceFlows = new Map()

/**
 * @param {import('express').Express} app
 * @param {{
 *   providerKey: string,
 *   deviceFlowExpiryMs: number,
 *   normalizeSecretValue: (value: unknown) => string,
 *   ensureProviderConfig: (config: any, providerKey: string) => any,
 *   clearAuthCaches: () => void,
 *   triggerImmediateProviderPing: (scopeKey: string) => void,
 *   applyProviderSignOut: (config: any, providerKey: string, identifier?: string | null) => any,
 *   startDeviceAuth: () => Promise<any>,
 *   pollDeviceToken: (deviceAuthId: string, userCode: string) => Promise<any>,
 *   exchangeAuthorizationCode: (authorizationCode: string, codeVerifier: string) => Promise<any>,
 * }} deps
 */
export function registerCodexOAuthRoutes(app, deps) {
  const {
    providerKey,
    deviceFlowExpiryMs,
    normalizeSecretValue,
    ensureProviderConfig,
    clearAuthCaches,
    triggerImmediateProviderPing,
    applyProviderSignOut,
    startDeviceAuth,
    pollDeviceToken,
    exchangeAuthorizationCode,
  } = deps

  app.get('/api/oauth/openai-codex/device-code', async (req, res) => {
    try {
      const deviceAuth = await startDeviceAuth()
      const flowId = randomUUID()
      const expiresIn = Math.max(60, Math.floor(deviceFlowExpiryMs / 1000))

      // The device code never leaves the server; the client only gets a flowId.
      deviceFlows.set(flowId, {
        deviceAuthId: deviceAuth.deviceAuthId,
        userCode: deviceAuth.userCode,
        expiresAt: Date.now() + expiresIn * 1000,
      })
      const now = Date.now()
      for (const [id, flow] of Array.from(deviceFlows)) {
        if (flow.expiresAt <= now) deviceFlows.delete(id)
      }

      return res.json({
        flowId,
        userCode: deviceAuth.userCode,
        verificationUri: deviceAuth.verificationUri,
        expiresIn,
        interval: deviceAuth.interval,
      })
    } catch (err) {
      return res
        .status(502)
        .json({ error: err?.message || 'Failed to start OpenAI Codex device authorization.' })
    }
  })

  app.post('/api/oauth/openai-codex/poll', async (req, res) => {
    try {
      const flowId = normalizeSecretValue(req.body?.flowId)
      if (!flowId) return res.status(400).json({ error: 'flowId is required.' })

      const flow = deviceFlows.get(flowId)
      if (!flow)
        return res
          .status(400)
          .json({ error: 'Unknown or expired flow. Start a new device authorization.' })
      if (flow.expiresAt <= Date.now()) {
        deviceFlows.delete(flowId)
        return res.status(400).json({ error: 'Device authorization expired. Start a new flow.' })
      }

      const pollResult = await pollDeviceToken(flow.deviceAuthId, flow.userCode)
      if (pollResult.pending) return res.json({ success: false, pending: true })
      if (!pollResult.authorizationCode) {
        deviceFlows.delete(flowId)
        return res.json({
          success: false,
          pending: false,
          error: pollResult.error || 'Device authorization failed.',
        })
      }

      const tokens = await exchangeAuthorizationCode(
        pollResult.authorizationCode,
        pollResult.codeVerifier,
      )
      const identity = extractCodexAccountIdentity(tokens.accessToken, tokens.idToken)
      const currentConfig = loadConfig()
      const providerConfig = ensureProviderConfig(currentConfig, providerKey)
      // The refresh token is the credential; the pool keeps one entry per signed-in
      // account, so re-signing in the same account refreshes it in place while a
      // different ChatGPT account is appended as an additional one to rotate across.
      addOrUpdateProviderAccount(currentConfig, providerKey, {
        secret: tokens.refreshToken,
        email: identity.email,
        accountId: identity.accountId,
        planType: identity.planType,
      })
      delete providerConfig.refreshToken
      providerConfig.authMode = 'device-flow'
      if (identity.email) providerConfig.authEmail = identity.email
      else delete providerConfig.authEmail
      // One account is the legacy shape; more than one is a pool, and the single-value
      // display fields must not claim to describe it.
      const codexAccountCount = getProviderAccounts(currentConfig, providerKey).length
      if (codexAccountCount > 1) delete providerConfig.authEmail
      saveConfig(currentConfig)
      clearAuthCaches()
      deviceFlows.delete(flowId)

      // The ping helper refreshes the Codex catalog first (which is account-scoped),
      // so one call both discovers the plan's models and probes them.
      void triggerImmediateProviderPing(providerKey)

      return res.json({
        success: true,
        email: identity.email || null,
        planType: identity.planType || null,
        accountCount: codexAccountCount,
      })
    } catch (err) {
      return res
        .status(502)
        .json({ error: err?.message || 'Failed while polling OpenAI Codex device authorization.' })
    }
  })

  // With no body this signs every account out, which is what it has always done. With
  // `account` (an email or workspace id) or `index` (the pool position the dashboard was
  // given) it signs out exactly that one, so a pool of several ChatGPT accounts can be
  // trimmed instead of only emptied. The index form is what makes an account that reported
  // no email removable at all — it has no other identifier to send.
  app.post('/api/oauth/openai-codex/disconnect', (req, res) => {
    try {
      const account = normalizeSecretValue(req.body?.account)
      const hasIndex = Number.isInteger(req.body?.index)
      const currentConfig = loadConfig()
      let target = account
      if (!target && hasIndex) {
        const accounts = getProviderAccounts(currentConfig, providerKey)
        const selected = accounts[req.body.index]
        target = selected ? selected.email || selected.accountId || selected.secret : null
      }
      // A single-account sign-out that resolved to nothing is an error, never a silent
      // fall-through into signing the whole pool out.
      if ((account || hasIndex) && !target) {
        return res
          .status(404)
          .json({ error: 'No signed-in account matches that email, account id or position.' })
      }
      const result = applyProviderSignOut(currentConfig, providerKey, target)
      if (target && result.removed === 0) {
        return res
          .status(404)
          .json({ error: 'No signed-in account matches that email, account id or position.' })
      }
      saveConfig(currentConfig)
      clearAuthCaches()
      void triggerImmediateProviderPing(providerKey)
      return res.json({ success: true, removed: result.removed, remaining: result.remaining })
    } catch (err) {
      return res.status(500).json({ error: err?.message || 'Failed to disconnect OpenAI Codex.' })
    }
  })
}
