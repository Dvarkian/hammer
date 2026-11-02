// @ts-check
/**
 * @file sessions.js
 * @description Reading the session store: listing, summarizing, and resolving sessions.
 *
 * Pi writes every conversation as a JSONL file whose first record is a session header and
 * whose later records are the message tree, names, compactions and the rest (see pi's
 * session-format docs). The console needs three things from those files without ever
 * loading one into the agent: a list to show in the picker, enough of a summary to tell the
 * entries apart, and a safe way to turn a user's click — a path, a UUID, or a prefix of one —
 * into exactly one file.
 *
 * Everything here is read-only and confined to the session directory: a resolved path that
 * escapes it is refused, because `switch_session` would happily load whatever it is given.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

/** Sessions larger than this are summarized from their head and tail only. */
const SCAN_CAP = 8 * 1024 * 1024
const HEAD_SCAN = 512 * 1024
const TAIL_SCAN = 512 * 1024
const PREVIEW_CHARS = 90

/** @typedef {{ file: string, fileName: string, sessionId: string, cwd: string|null, timestamp: string|null, modifiedMs: number, size: number, name: string|null, preview: string|null, userMessages: number, assistantMessages: number, toolCalls: number, truncated: boolean }} SessionSummary */

/**
 * Text of a message's content, whatever shape it arrived in.
 * @param {any} content
 * @returns {string}
 */
function messageText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (part && typeof part === 'object' && part.type === 'text' ? part.text : ''))
    .filter(Boolean)
    .join(' ')
}

/**
 * Folds one parsed record into the running summary.
 * @param {SessionSummary} summary mutated in place
 * @param {any} record
 */
function absorbRecord(summary, record) {
  if (!record || typeof record !== 'object') return
  switch (record.type) {
    case 'session':
      summary.sessionId = typeof record.id === 'string' ? record.id : summary.sessionId
      summary.cwd = typeof record.cwd === 'string' ? record.cwd : summary.cwd
      summary.timestamp = typeof record.timestamp === 'string' ? record.timestamp : summary.timestamp
      break
    case 'session_info':
      if (typeof record.name === 'string' && record.name.trim()) summary.name = record.name.trim()
      break
    case 'message': {
      const message = record.message
      if (!message || typeof message !== 'object') break
      if (message.role === 'user') {
        summary.userMessages += 1
        // The first user message is the preview when the session has no name. A `!!` bash
        // line or an attachment shell says nothing a reader can recognize, so keep looking.
        if (!summary.preview) {
          const text = messageText(message.content).replace(/\s+/g, ' ').trim()
          if (text && !text.startsWith('!')) summary.preview = text.slice(0, PREVIEW_CHARS)
        }
      } else if (message.role === 'assistant') {
        summary.assistantMessages += 1
        if (Array.isArray(message.content)) {
          summary.toolCalls += message.content.filter(
            (part) => part && typeof part === 'object' && part.type === 'toolCall',
          ).length
        }
      }
      break
    }
    default:
      break
  }
}

/** @param {SessionSummary} summary */
function finishSummary(summary) {
  if (!summary.preview && summary.name) summary.preview = summary.name
  return summary
}

/**
 * Reads one session file and summarizes it. A file that cannot be parsed still deserves a
 * row — it exists on disk — so failures degrade to an unnamed, empty entry.
 * @param {string} file
 * @returns {SessionSummary}
 */
export function summarizeSession(file) {
  const stats = statSync(file)
  /** @type {SessionSummary} */
  const summary = {
    file,
    fileName: basename(file),
    sessionId: '',
    cwd: null,
    timestamp: null,
    modifiedMs: stats.mtimeMs,
    size: stats.size,
    name: null,
    preview: null,
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    truncated: false,
  }

  /** @param {string} text */
  const absorbLines = (text) => {
    for (const line of text.split('\n')) {
      if (!line) continue
      try {
        absorbRecord(summary, JSON.parse(line))
      } catch {
        // One bad line is not a bad session.
      }
    }
  }

  try {
    if (stats.size <= SCAN_CAP) {
      absorbLines(readFileSync(file, 'utf8'))
    } else {
      // Beyond the cap, the header (first line, always) and the most recent work (tail) are
      // what a picker shows; the middle is history nobody is choosing from.
      summary.truncated = true
      const fd = readFileSync(file)
      absorbLines(fd.subarray(0, HEAD_SCAN).toString('utf8'))
      absorbLines(fd.subarray(Math.max(HEAD_SCAN, fd.length - TAIL_SCAN)).toString('utf8'))
    }
  } catch {
    // Unreadable: the empty summary stands.
  }
  return finishSummary(summary)
}

/**
 * Lists the sessions in a directory, most recently touched first.
 * @param {string} dir
 * @param {{ limit?: number }} [options]
 * @returns {SessionSummary[]}
 */
export function listSessions(dir, { limit = 200 } = {}) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const sessions = []
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue
    const file = join(dir, name)
    try {
      if (!statSync(file).isFile()) continue
    } catch {
      continue
    }
    sessions.push(summarizeSession(file))
  }
  sessions.sort((a, b) => b.modifiedMs - a.modifiedMs)
  return sessions.slice(0, limit)
}

/**
 * A path is inside the directory only if it really is: `..` tricks and sibling prefixes
 * (`/store-x` versus `/store`) both have to fail.
 * @param {string} dir
 * @param {string} candidate
 */
function isInside(dir, candidate) {
  const root = resolve(dir)
  const target = resolve(candidate)
  return target === root || target.startsWith(root + sep)
}

/**
 * Turns what a caller clicked into one session file. A path must stay inside the session
 * directory; a UUID — or a prefix of one, which is what pi's `--session` accepts — is
 * matched against the store, latest first.
 * @param {string} dir the session directory
 * @param {string} reference path, UUID, or UUID prefix
 * @returns {string} absolute path to the session file
 * @throws when nothing unambiguous matches
 */
export function resolveSessionReference(dir, reference) {
  const value = String(reference ?? '').trim()
  if (!value) throw new Error('A session path or id is required.')
  if (isAbsolute(value) || value.includes('/') || value.includes('\\')) {
    const target = resolve(value)
    if (!isInside(dir, target)) throw new Error('Sessions may only be opened from the session store.')
    if (!statSyncSafe(target)) throw new Error(`No session file at ${target}.`)
    return target
  }
  const lower = value.toLowerCase()
  const matches = listSessions(dir, { limit: Infinity }).filter(
    (session) =>
      session.sessionId.toLowerCase() === lower ||
      session.sessionId.toLowerCase().startsWith(lower) ||
      session.fileName.toLowerCase().includes(lower),
  )
  if (matches.length === 0) throw new Error(`No session matches "${value}".`)
  if (matches.length > 1) {
    const ids = new Set(matches.map((session) => session.sessionId))
    if (ids.size > 1) throw new Error(`"${value}" matches ${ids.size} sessions; be more specific.`)
    // Several files, one session id: the store was moved or duplicated; the newest wins.
  }
  return matches[0].file
}

/**
 * @param {string} file
 * @returns {boolean}
 */
function statSyncSafe(file) {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

/** The session's display label: its name, or the first thing the user said. */
/**
 * @param {SessionSummary} session
 * @returns {string}
 */
export function sessionLabel(session) {
  return session.name || session.preview || session.fileName
}

/** Directory of a session file — where a restarted agent's `--session-dir` must point. */
/**
 * @param {string} file
 * @returns {string}
 */
export function sessionDirOf(file) {
  return dirname(file)
}
