// @ts-check
/**
 * ── What conversation a console is on ───────────────────────────────────────────────────────
 *
 * A console names its session file, pi owns the transcript on disk. Remembering that name is
 * what lets a restarted router reopen the same conversation instead of starting an empty one
 * beside it — the "history lost after a restart" a transcript on disk never actually lost.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  configureConsoleSessionStore,
  consoleSessionFile,
  consoleSessionStorePath,
  forgetConsoleSession,
  rememberConsoleSession,
  resetConsoleSessionsForTests,
} from '../lib/pi/console-session.js'

test('the store sits beside the prepared Pi configuration', () => {
  assert.equal(
    consoleSessionStorePath('/home/u/.hammer/pi/agent'),
    '/home/u/.hammer/pi/agent/console-sessions.json',
  )
  // No directory means no file: a mounted test console remembers nothing on disk.
  assert.equal(consoleSessionStorePath(''), '')
})

test("a console's conversation survives a restart", () => {
  resetConsoleSessionsForTests()
  const dir = mkdtempSync(join(tmpdir(), 'hammer-sessions-'))
  const path = consoleSessionStorePath(dir)
  configureConsoleSessionStore(path)

  assert.equal(consoleSessionFile('7352'), null, 'nothing is remembered yet')
  assert.equal(rememberConsoleSession('7352', '/store/a.jsonl'), true)
  assert.equal(consoleSessionFile('7352'), '/store/a.jsonl')
  // A switch or a resume moves the console on; the newest file is the one it is on.
  assert.equal(rememberConsoleSession('7352', '/store/b.jsonl'), true)
  assert.equal(consoleSessionFile('7352'), '/store/b.jsonl')
  // A detached console reports no file, which must not erase the one it just left.
  assert.equal(rememberConsoleSession('7352', ''), false)
  assert.equal(consoleSessionFile('7352'), '/store/b.jsonl')
  // Each conversation owns its own name: a parallel console is a different key.
  assert.equal(consoleSessionFile('7352-abc123'), null)
  assert.equal(rememberConsoleSession('7352-abc123', '/store/a.jsonl'), true)

  // A restart is this module's memory going away while the file it wrote stays behind.
  resetConsoleSessionsForTests()
  configureConsoleSessionStore(path)
  assert.equal(consoleSessionFile('7352'), '/store/b.jsonl')
  assert.equal(consoleSessionFile('7352-abc123'), '/store/a.jsonl')

  // A deleted conversation is forgotten rather than remembered for the next run.
  forgetConsoleSession('7352')
  resetConsoleSessionsForTests()
  configureConsoleSessionStore(path)
  assert.equal(consoleSessionFile('7352'), null)
  assert.equal(consoleSessionFile('7352-abc123'), '/store/a.jsonl')

  // Unusable content is ignored rather than crashing a console: an empty name is not a file,
  // and a value that is not a string is not a path.
  writeFileSync(
    path,
    JSON.stringify({ consoleSessions: { 7352: 42, '7352-b': '', ok: '/store/c.jsonl' } }),
  )
  resetConsoleSessionsForTests()
  configureConsoleSessionStore(path)
  assert.equal(consoleSessionFile('7352'), null)
  assert.equal(consoleSessionFile('ok'), '/store/c.jsonl')

  // The file is bounded, because a parallel console gets a fresh key each time. What is kept is
  // the most recent conversations — read back through the store, as the next process would.
  resetConsoleSessionsForTests()
  configureConsoleSessionStore(path)
  for (let i = 0; i < 70; i += 1) rememberConsoleSession(`k${i}`, `/store/${i}.jsonl`)
  resetConsoleSessionsForTests()
  configureConsoleSessionStore(path)
  assert.equal(consoleSessionFile('k0'), null, 'the oldest entries fall off')
  assert.equal(consoleSessionFile('k69'), '/store/69.jsonl')
  assert.ok(JSON.parse(readFileSync(path, 'utf8')).consoleSessions)

  rmSync(dir, { recursive: true, force: true })
  resetConsoleSessionsForTests()
})
