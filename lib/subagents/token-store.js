// @ts-check
/**
 * @file token-store.js
 * @description Random bearer tokens whose claims identify a requester.
 *
 * The token is the only sender identity a route trusts. A token is issued by the router for
 * a parent console or a child process and is persisted (mode 0600) so a restarted router
 * can still recognize a child it adopted. Tokens are not JWTs because there is no trust
 * boundary to cross: the claims live here, behind a random 256-bit value.
 */

import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export class SubagentTokenStore {
  /** @param {{ path?: string }} [options] */
  constructor({ path = '' } = {}) {
    this.path = path
    /** @type {Map<string, any>} */
    this.tokens = new Map()
    this.load()
  }

  load() {
    if (!this.path) return
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'))
      for (const entry of Array.isArray(parsed?.tokens) ? parsed.tokens : []) {
        if (typeof entry?.token === 'string' && entry.claims)
          this.tokens.set(entry.token, entry.claims)
      }
    } catch {
      // A missing or unreadable store is a fresh store.
    }
  }

  save() {
    if (!this.path) return
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.${process.pid}.tmp`
      const tokens = [...this.tokens.entries()].map(([token, claims]) => ({ token, claims }))
      writeFileSync(tmp, `${JSON.stringify({ tokens }, null, 2)}\n`, { mode: 0o600 })
      renameSync(tmp, this.path)
    } catch {
      // The in-memory tokens still work for this process.
    }
  }

  /** @param {any} claims @param {string} [existing] */
  issue(claims, existing = '') {
    if (existing && this.tokens.has(existing)) {
      this.tokens.set(existing, claims)
      this.save()
      return existing
    }
    const token = randomBytes(32).toString('hex')
    this.tokens.set(token, claims)
    this.save()
    return token
  }

  /** @param {string} token */
  verify(token) {
    if (!token || typeof token !== 'string') return null
    return this.tokens.get(token) || null
  }

  /** @param {string} type @param {string} requesterId */
  find(type, requesterId) {
    for (const [token, claims] of this.tokens) {
      if (claims?.type === type && claims.requesterId === requesterId) return token
    }
    return ''
  }

  /** @param {string} consoleKey */
  parentToken(consoleKey) {
    for (const [token, claims] of this.tokens) {
      if (claims?.type === 'parent' && claims.consoleKey === consoleKey) return token
    }
    return ''
  }

  /** @param {string} token */
  revoke(token) {
    if (!token) return
    this.tokens.delete(token)
    this.save()
  }
}

/** @param {string} root */
export function subagentTokenPath(root) {
  return join(root, 'subagent-tokens.json')
}
