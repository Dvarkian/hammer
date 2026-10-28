// @ts-check
/**
 * @file oauth-kiro.js
 * @description Kiro sign-in: AWS SSO cache import, Builder ID device flow, and
 * browser (Google/GitHub) OAuth.
 *
 * Extracted from `runServer` by the same rule as the Copilot/Codex modules: the
 * device-flow store moves here because these routes are its only readers and
 * writers, and the flow engines stay in `server.js` and arrive as explicit
 * dependencies, so this module never imports the router it is mounted on.
 *
 * The client id, client secret and device code never leave the server; the
 * browser only ever receives an opaque flow id.
 */

import { randomUUID } from 'node:crypto'
import { loadConfig, saveConfig } from '../../config.js'

/** In-progress Builder ID device authorisations, keyed by the id sent to the browser. */
const deviceFlows = new Map()

/**
 * @param {import('express').Express} app
 * @param {{
 *   providerKey: string,
 *   browserAuthProviders: Set<string>,
 *   normalizeSecretValue: (value: unknown) => string,
 *   ensureProviderConfig: (config: any, providerKey: string) => any,
 *   clearAuthMetadata: (providerConfig: any) => void,
 *   clearTokenCaches: () => void,
 *   triggerImmediateProviderPing: (scopeKey: string) => void,
 *   extractRefreshTokenFromAwsCache: () => string | null,
 *   extractEmailFromAccessToken: (accessToken: string) => string | null,
 *   startDeviceAuth: () => Promise<any>,
 *   pollDeviceToken: (deviceCode: string, clientId: string, clientSecret: string) => Promise<any>,
 *   startSocialAuth: (provider: string) => any,
 *   exchangeSocialAuth: (flowId: string, code: string, state: string) => Promise<any>,
 * }} deps
 */
export function registerKiroOAuthRoutes(app, deps) {
  const {
    providerKey,
    browserAuthProviders,
    normalizeSecretValue,
    ensureProviderConfig,
    clearAuthMetadata,
    clearTokenCaches,
    triggerImmediateProviderPing,
    extractRefreshTokenFromAwsCache,
    extractEmailFromAccessToken,
    startDeviceAuth,
    pollDeviceToken,
    startSocialAuth,
    exchangeSocialAuth,
  } = deps

  app.get('/api/oauth/kiro/auto-import', (req, res) => {
    try {
      const refreshToken = extractRefreshTokenFromAwsCache()
      if (!refreshToken) {
        return res.json({
          found: false,
          error:
            'Kiro refresh token not found in ~/.aws/sso/cache. Sign in to Kiro first or paste a token manually.',
        })
      }

      // Save the token directly — never return it in the response body
      const currentConfig = loadConfig()
      const providerConfig = ensureProviderConfig(currentConfig, providerKey)
      clearAuthMetadata(providerConfig)
      providerConfig.refreshToken = refreshToken
      providerConfig.authMode = 'aws-cache'
      delete currentConfig.apiKeys[providerKey]
      saveConfig(currentConfig)
      clearTokenCaches()
      void triggerImmediateProviderPing(providerKey)

      return res.json({ found: true })
    } catch (err) {
      return res.status(500).json({
        found: false,
        error: err?.message || 'Failed to inspect the AWS SSO cache.',
      })
    }
  })

  app.get('/api/oauth/kiro/device-code', async (req, res) => {
    try {
      const deviceAuth = await startDeviceAuth()
      const flowId = randomUUID()
      const expiresAt = Date.now() + Math.max(60, Number(deviceAuth.expiresIn || 600)) * 1000

      // Store secrets server-side; the client only receives an opaque flowId
      deviceFlows.set(flowId, {
        clientId: deviceAuth.clientId,
        clientSecret: deviceAuth.clientSecret,
        deviceCode: deviceAuth.deviceCode,
        expiresAt,
      })

      // Prune stale entries to avoid unbounded growth
      const now = Date.now()
      for (const [id, flow] of Array.from(deviceFlows)) {
        if (flow.expiresAt <= now) deviceFlows.delete(id)
      }

      return res.json({
        flowId,
        userCode: deviceAuth.userCode,
        verificationUri: deviceAuth.verificationUri,
        verificationUriComplete: deviceAuth.verificationUriComplete,
        expiresIn: deviceAuth.expiresIn,
        interval: deviceAuth.interval,
      })
    } catch (err) {
      return res
        .status(502)
        .json({ error: err?.message || 'Failed to start Kiro device authorization.' })
    }
  })

  app.post('/api/oauth/kiro/poll', async (req, res) => {
    try {
      const flowId = normalizeSecretValue(req.body?.flowId)
      if (!flowId) {
        return res.status(400).json({ error: 'flowId is required.' })
      }

      const flow = deviceFlows.get(flowId)
      if (!flow) {
        return res
          .status(400)
          .json({ error: 'Unknown or expired flow. Start a new device authorization.' })
      }
      if (flow.expiresAt <= Date.now()) {
        deviceFlows.delete(flowId)
        return res.status(400).json({ error: 'Device authorization expired. Start a new flow.' })
      }

      const { deviceCode, clientId, clientSecret } = flow
      const pollResult = await pollDeviceToken(deviceCode, clientId, clientSecret)
      if (!pollResult.success) {
        return res.json({
          success: false,
          pending: pollResult.pending === true,
          error: pollResult.error,
          errorDescription: pollResult.errorDescription,
        })
      }

      const currentConfig = loadConfig()
      const providerConfig = ensureProviderConfig(currentConfig, providerKey)
      providerConfig.refreshToken = pollResult.tokens.refreshToken
      providerConfig.clientId = pollResult.tokens.clientId
      providerConfig.clientSecret = pollResult.tokens.clientSecret
      providerConfig.authMode = 'builder-id'
      providerConfig.authProvider = 'aws-builder-id'
      delete providerConfig.profileArn
      const email = extractEmailFromAccessToken(pollResult.tokens.accessToken)
      if (email) providerConfig.authEmail = email
      else delete providerConfig.authEmail
      delete currentConfig.apiKeys[providerKey]
      saveConfig(currentConfig)
      clearTokenCaches()
      deviceFlows.delete(flowId)
      void triggerImmediateProviderPing(providerKey)

      return res.json({
        success: true,
        email,
      })
    } catch (err) {
      return res
        .status(502)
        .json({ error: err?.message || 'Failed while polling Kiro device authorization.' })
    }
  })

  app.get('/api/oauth/kiro/social-authorize', (req, res) => {
    try {
      const provider = normalizeSecretValue(req.query?.provider).toLowerCase()
      if (!browserAuthProviders.has(provider)) {
        return res.status(400).json({ error: "Invalid provider. Use 'google' or 'github'." })
      }

      return res.json(startSocialAuth(provider))
    } catch (err) {
      return res
        .status(500)
        .json({ error: err?.message || 'Failed to initialize Kiro browser OAuth.' })
    }
  })

  app.post('/api/oauth/kiro/social-exchange', async (req, res) => {
    try {
      const provider = normalizeSecretValue(req.body?.provider).toLowerCase()
      const code = normalizeSecretValue(req.body?.code)
      const flowId = normalizeSecretValue(req.body?.flowId)
      const state = normalizeSecretValue(req.body?.state)

      if (!browserAuthProviders.has(provider)) {
        return res.status(400).json({ error: "Invalid provider. Use 'google' or 'github'." })
      }
      if (!code || !flowId) {
        return res.status(400).json({ error: 'code and flowId are required.' })
      }

      const tokens = await exchangeSocialAuth(flowId, code, state)
      const currentConfig = loadConfig()
      const providerConfig = ensureProviderConfig(currentConfig, providerKey)
      clearAuthMetadata(providerConfig)
      providerConfig.refreshToken = tokens.refreshToken
      providerConfig.authMode = 'browser-oauth'
      providerConfig.authProvider = provider
      if (tokens.profileArn) providerConfig.profileArn = tokens.profileArn
      else delete providerConfig.profileArn
      const email = extractEmailFromAccessToken(tokens.accessToken)
      if (email) providerConfig.authEmail = email
      else delete providerConfig.authEmail
      delete currentConfig.apiKeys[providerKey]
      saveConfig(currentConfig)
      clearTokenCaches()
      void triggerImmediateProviderPing(providerKey)

      return res.json({
        success: true,
        email,
      })
    } catch (err) {
      return res
        .status(502)
        .json({ error: err?.message || 'Failed to complete Kiro browser OAuth.' })
    }
  })
}
