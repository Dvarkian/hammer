// @ts-check
/**
 * @file registry.js
 * @description The durable record of subagents, their roots and their notifications.
 *
 * Records are bounded and written atomically, like the queue store. Transcript text is not
 * part of a record: the child's own session file is the transcript, and `result.text` is
 * the capped final report. Audit entries deliberately never store transcript contents.
 */

import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const RECORD_LIMIT = 200

/** @param {string} root */
export function subagentRegistryPath(root) {
  return join(root, 'subagents.json')
}

/** @param {string} root @param {string} id */
export function subagentReportPath(root, id) {
  return join(root, 'subagents', id, 'report.md')
}

export class SubagentRegistry {
  /** @param {{ path?: string, limit?: number }} [options] */
  constructor({ path = '', limit = RECORD_LIMIT } = {}) {
    this.path = path
    this.limit = limit
    /** @type {Map<string, any>} */
    this.records = new Map()
    /** @type {{ id: string, rootId: string, sessionFile?: string|null, text: string, createdAt: number }[]} */
    this.notices = []
    this.load()
  }

  load() {
    if (!this.path) return
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'))
      for (const record of Array.isArray(parsed?.records) ? parsed.records : []) {
        if (record?.id) this.records.set(record.id, record)
      }
      for (const notice of Array.isArray(parsed?.notices) ? parsed.notices : []) {
        if (notice?.id && notice.text) this.notices.push(notice)
      }
    } catch {
      // A missing file is a new registry.
    }
  }

  save() {
    if (!this.path) return
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.${process.pid}.tmp`
      writeFileSync(
        tmp,
        `${JSON.stringify({ records: [...this.records.values()], notices: this.notices }, null, 2)}\n`,
        { mode: 0o600 },
      )
      renameSync(tmp, this.path)
    } catch {
      // The in-memory record still serves this process.
    }
  }

  prune() {
    if (this.records.size <= this.limit) return
    const terminal = [...this.records.values()]
      .filter((record) => record.status !== 'running')
      .sort((a, b) => (a.endedAt || a.createdAt) - (b.endedAt || b.createdAt))
    while (this.records.size > this.limit && terminal.length > 0) {
      const record = terminal.shift()
      this.records.delete(record.id)
    }
  }

  /** @param {any} record */
  insert(record) {
    this.records.set(record.id, record)
    this.prune()
    this.save()
    return record
  }

  /** @param {string} id @param {any} patch */
  update(id, patch) {
    const current = this.records.get(id)
    if (!current) return null
    const next = typeof patch === 'function' ? patch(current) : { ...current, ...patch }
    this.records.set(id, next)
    this.save()
    return next
  }

  /** @param {string} id */
  get(id) {
    return this.records.get(id) || null
  }

  /**
   * @param {string} name
   * @param {string} rootId
   * @param {string|null} [sessionFile] when given, only a child of that conversation matches
   */
  findByName(name, rootId, sessionFile) {
    for (const record of this.records.values()) {
      if (record.rootId !== rootId || record.name !== name) continue
      if (sessionFile !== undefined && record.parent?.sessionFile !== sessionFile) continue
      return record
    }
    return null
  }

  all() {
    return [...this.records.values()]
  }

  /** @param {string} rootId */
  forRoot(rootId) {
    return this.all().filter((record) => record.rootId === rootId)
  }

  /** @param {string} id */
  remove(id) {
    this.records.delete(id)
    this.save()
  }

  /** @param {any} record @param {string} event @param {any} detail */
  audit(record, event, detail = {}) {
    if (!record) return
    const entry = { at: Date.now(), event, ...detail }
    record.audit = [...(Array.isArray(record.audit) ? record.audit : []), entry].slice(-100)
    this.save()
  }

  /** @param {string} rootId @param {string} text @param {string|null} [sessionFile] */
  addNotice(rootId, text, sessionFile = null) {
    const notice = {
      id: randomBytes(8).toString('hex'),
      rootId,
      sessionFile,
      text,
      createdAt: Date.now(),
    }
    this.notices = [...this.notices, notice].slice(-50)
    this.save()
    return notice
  }

  /** @param {string} rootId @param {string|null} sessionFile */
  takeNotices(rootId, sessionFile) {
    const taken = this.notices.filter(
      (notice) => notice.rootId === rootId && notice.sessionFile === sessionFile,
    )
    this.notices = this.notices.filter(
      (notice) => !(notice.rootId === rootId && notice.sessionFile === sessionFile),
    )
    this.save()
    return taken
  }
}

export function generateSubagentId() {
  return `sa_${randomBytes(4).toString('hex')}`
}

/**
 * A record's root: the parent chooser is a console, not a record. The id is stable across
 * a parent's session switch so the UI can show a conversation's historical branch. The
 * model-facing routes narrow that root to the record's `parent.sessionFile`; those are not
 * visible from a later conversation on the same console.
 * @param {string} consoleKey
 */
export function rootIdForConsole(consoleKey) {
  return `root:${String(consoleKey || 'default').replace(/[^a-zA-Z0-9_-]/g, '-')}`
}
