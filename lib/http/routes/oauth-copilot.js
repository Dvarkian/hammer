// @ts-check
/**
 * @file oauth-copilot.js
 * @description GitHub Copilot device-flow sign-in.
 *
 * Extracted from `runServer` unchanged except for the two things that made it
 * impossible to test there: the flow store now belongs to this feature instead
 * of being a module-level global shared by a 7,500-line function, and the
 * handful of helpers it depends on arrive as an explicit `deps` argument
 * instead of being captured from the enclosing scope.
 *
 * The GitHub token never leaves the server; the browser only ever receives an
 * opaque flow id.
 */

import { randomUUID } from 'node:crypto'
import { loadConfig, saveConfig } from '../../config.js'

/** In-progress device authorisations, keyed by the id handed to the browser. */
const deviceFlows = new Map()

/**
 * @param {import('express').Express} app
 * @param {{
 *   providerKey: string,
 *   normalizeSecretValue: (value: unknown) => string,
 *   ensureProviderConfig: (config: any, providerKey: string) => any,
 *   clearAuthCaches: () => void,
 *   triggerImmediateProviderPing: (scopeKey: string) => void,
 *   startDeviceAuth: () => Promise<any>,
 *   pollDeviceToken: (deviceCode: string) => Promise<any>,
 *   fetchLogin: (token: string, options?: any) => Promise<any>,
 * }} deps
 */
export function registerCopilotOAuthRoutes(app, deps) {
  const {
    providerKey,
    normalizeSecretValue,
    ensureProviderConfig,
    clearAuthCaches,
    triggerImmediateProviderPing,
    startDeviceAuth,
    pollDeviceToken,
    fetchLogin,
  } = deps

  app.get('/api/oauth/github-copilot/device-code', async (req, res) => {
    try {
      const deviceAuth = await startDeviceAuth()
      const flowId = randomUUID()
      const expiresAt = Date.now() + Math.max(60, Number(deviceAuth.expiresIn || 900)) * 1000

      // The device code never leaves the server; the client only gets a flowId.
      deviceFlows.set(flowId, { deviceCode: deviceAuth.deviceCode, expiresAt })
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
        .json({ error: err?.message || 'Failed to start GitHub Copilot device authorization.' })
    }
  })

  app.post('/api/oauth/github-copilot/poll', async (req, res) => {
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

      const pollResult = await pollDeviceToken(flow.deviceCode)
      if (!pollResult.success) {
        if (!pollResult.pending) deviceFlows.delete(flowId)
        return res.json({
          success: false,
          pending: pollResult.pending === true,
          error: pollResult.error,
          errorDescription: pollResult.errorDescription,
        })
      }

      const githubToken = pollResult.accessToken
      const login = await fetchLogin(githubToken, { signal: AbortSignal.timeout(10_000) })
      const currentConfig = loadConfig()
      const providerConfig = ensureProviderConfig(currentConfig, providerKey)
      currentConfig.apiKeys[providerKey] = githubToken
      providerConfig.authMode = 'device-flow'
      if (login) providerConfig.authEmail = login
      else delete providerConfig.authEmail
      // Re-probe the plan host on the next discovery pass, which also accepts the
      // account's gated model policies (both live in refreshCopilotModels).
      delete providerConfig.apiEndpoint
      saveConfig(currentConfig)
      clearAuthCaches()
      deviceFlows.delete(flowId)

      // The ping helper refreshes the Copilot catalog first (learning the plan host and
      // accepting gated policies) before probing, so one call covers both.
      void triggerImmediateProviderPing(providerKey)

      return res.json({ success: true, login: providerConfig.authEmail || null })
    } catch (err) {
      return res.status(502).json({
        error: err?.message || 'Failed while polling GitHub Copilot device authorization.',
      })
    }
  })

  app.post('/api/oauth/github-copilot/disconnect', (req, res) => {
    try {
      const currentConfig = loadConfig()
      const providerConfig = ensureProviderConfig(currentConfig, providerKey)
      delete currentConfig.apiKeys[providerKey]
      delete providerConfig.oauthToken
      delete providerConfig.authMode
      delete providerConfig.authEmail
      delete providerConfig.apiEndpoint
      saveConfig(currentConfig)
      clearAuthCaches()
      void triggerImmediateProviderPing(providerKey)
      return res.json({ success: true })
    } catch (err) {
      return res.status(500).json({ error: err?.message || 'Failed to disconnect GitHub Copilot.' })
    }
  })
}
