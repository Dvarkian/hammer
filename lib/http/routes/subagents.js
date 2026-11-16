// @ts-check
/**
 * @file subagents.js
 * @description The authenticated subagent surface.
 *
 * Every route that reads a transcript, sends a message, reports status or controls a child
 * resolves the caller from its bearer token. A client-supplied sender, parent or root is
 * never read. The UI gets a scoped token from a same-origin endpoint because a browser has
 * no console process to hold one; that token can read and control but cannot spawn.
 */

import { CAPS } from '../../subagents/policy.js'

/** @param {any} res */
function unauthenticated(res) {
  return res.status(401).json({ error: 'A subagent principal token is required.' })
}

/** @param {any} res @param {Error|string} err @param {number} [status] */
function fail(res, err, status = 400) {
  return res.status(status).json({ error: /** @type {Error} */ (err)?.message || String(err) })
}

/**
 * @param {import('express').Express} app
 * @param {import('../../subagents/manager.js').SubagentManager} manager
 */
export function registerSubagentRoutes(app, manager) {
  const principal = (req, res) => {
    const who = manager.identify(req)
    if (!who) {
      unauthenticated(res)
      return null
    }
    return who
  }

  // The browser has no parent console process, so it exchanges a same-origin request for a
  // scoped UI token. This is a policy token, not an OS boundary; a child with bash can still
  // call loopback routes it knows about, as the no-sandbox note says.
  app.get('/api/subagents/ui-token', (req, res) => {
    const site = String(req.get('sec-fetch-site') || '').toLowerCase()
    const origin = String(req.get('origin') || '')
    // A browser fetch from the app sends sec-fetch-site: same-origin. A process on the
    // loopback that merely knows the URL does not, which keeps a casual child from minting
    // the broad UI token without at least impersonating the page. This is policy, not an OS
    // boundary; a child with bash can still read files and forge the header.
    let sameOrigin = site === 'same-origin' || site === 'none'
    if (origin) {
      try {
        if (new URL(origin).host !== req.get('host')) sameOrigin = false
      } catch {
        sameOrigin = false
      }
    }
    if (!sameOrigin)
      return res.status(403).json({ error: 'The UI token is only issued to this origin.' })
    res.setHeader('Cache-Control', 'no-store')
    res.json({ token: manager.uiToken() })
  })

  app.get('/api/subagents/models', (req, res) => {
    const who = principal(req, res)
    if (!who) return
    try {
      const numeric = (value) => {
        if (value == null || value === '') return undefined
        const n = Number(value)
        return Number.isFinite(n) ? n : undefined
      }
      const { payload, text } = manager.catalogue({
        query: typeof req.query.query === 'string' ? req.query.query : '',
        min_intelligence: numeric(req.query.min_intelligence),
        min_speed: numeric(req.query.min_speed),
        min_context: numeric(req.query.min_context),
        usage: typeof req.query.usage === 'string' ? req.query.usage : undefined,
        include_unrated: req.query.include_unrated === '1' || req.query.include_unrated === 'true',
        limit: numeric(req.query.limit),
        offset: numeric(req.query.offset),
      })
      res.setHeader('Cache-Control', 'no-store')
      res.json({ ...payload, text })
    } catch (err) {
      fail(res, err)
    }
  })

  app.get('/api/subagents', (req, res) => {
    const who = principal(req, res)
    if (!who) return
    try {
      res.setHeader('Cache-Control', 'no-store')
      res.json(manager.list(who))
    } catch (err) {
      fail(res, err, 403)
    }
  })

  app.post('/api/subagents', async (req, res) => {
    const who = principal(req, res)
    if (!who) return
    try {
      const receipt = await manager.spawn(who, req.body || {})
      res.status(201).json(receipt)
    } catch (err) {
      fail(res, err)
    }
  })

  app.get('/api/subagents/:id/transcript', (req, res) => {
    const who = principal(req, res)
    if (!who) return
    try {
      const limit = Number(req.query.limit) || CAPS.maxTranscriptChars
      const data = manager.transcript(who, req.params.id, limit)
      res.setHeader('Cache-Control', 'no-store')
      res.json(data)
    } catch (err) {
      fail(res, err, 403)
    }
  })

  app.get('/api/subagents/:id/wait', async (req, res) => {
    const who = principal(req, res)
    if (!who) return
    try {
      const data = await manager.wait(who, req.params.id, Number(req.query.wait_ms) || 60_000)
      res.setHeader('Cache-Control', 'no-store')
      res.json(data)
    } catch (err) {
      fail(res, err, 403)
    }
  })

  app.post('/api/subagents/:id/send', async (req, res) => {
    const who = principal(req, res)
    if (!who) return
    try {
      const data = await manager.send(
        who,
        req.params.id,
        req.body?.message,
        req.body?.mode || 'steer',
      )
      res.json(data)
    } catch (err) {
      fail(res, err, 409)
    }
  })

  app.post('/api/subagents/:id/promote', (req, res) => {
    const who = principal(req, res)
    if (!who) return
    try {
      res.json(manager.promote(who, req.params.id))
    } catch (err) {
      fail(res, err, 403)
    }
  })

  app.post('/api/subagents/:id/stop', async (req, res) => {
    const who = principal(req, res)
    if (!who) return
    try {
      const data = await manager.stop(who, req.params.id)
      res.json(data)
    } catch (err) {
      fail(res, err, 403)
    }
  })

  app.delete('/api/subagents/:id', async (req, res) => {
    const who = principal(req, res)
    if (!who) return
    try {
      const data = await manager.delete(who, req.params.id)
      res.json(data)
    } catch (err) {
      fail(res, err, 403)
    }
  })

  app.get('/api/subagents/:id', (req, res) => {
    const who = principal(req, res)
    if (!who) return
    try {
      const includeReport = req.query.report === '1' || req.query.report === 'true'
      const data = manager.status(who, req.params.id, {
        includeReport,
        ui: who.ui === true,
      })
      res.setHeader('Cache-Control', 'no-store')
      res.json(data)
    } catch (err) {
      fail(res, err, 403)
    }
  })
}
