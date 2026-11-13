// @ts-check
/**
 * The queued-message store: what the agent was holding, written down for the next router.
 *
 * The file is the whole point — a queue that only lives in memory cannot survive the restart it
 * exists for — so these tests read it back rather than trusting the in-process map.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  configureQueueStore,
  forgetQueue,
  queueStorePath,
  rememberedQueue,
  rememberQueue,
} from '../lib/pi/queue-store.js'

/** A scratch store, configured and ready. */
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'hammer-queue-store-'))
  const path = queueStorePath(dir)
  configureQueueStore(path)
  return { dir, path }
}

test('a queue is remembered per session and read back by a new process', () => {
  const { path } = scratch()
  assert.equal(path, join(join(path, '..'), 'queued-messages.json'))

  rememberQueue('/sessions/a.jsonl', { steering: ['steer it'], followUp: ['then this'] })
  const file = JSON.parse(readFileSync(path, 'utf8'))
  assert.deepEqual(file.queues['/sessions/a.jsonl'], {
    steering: ['steer it'],
    followUp: ['then this'],
  })

  // A restart means a new process: configuring again forgets the map, so this reads the file.
  configureQueueStore(path)
  assert.deepEqual(rememberedQueue('/sessions/a.jsonl'), {
    steering: ['steer it'],
    followUp: ['then this'],
  })
  assert.equal(rememberedQueue('/sessions/b.jsonl'), null, 'a session with no queue has no record')
})

test('an empty queue forgets the session rather than remembering nothing waiting', () => {
  const { path } = scratch()
  rememberQueue('/sessions/a.jsonl', { followUp: ['delivered now'] })
  assert.ok(JSON.parse(readFileSync(path, 'utf8')).queues['/sessions/a.jsonl'])

  rememberQueue('/sessions/a.jsonl', { steering: [], followUp: [] })
  assert.equal(rememberedQueue('/sessions/a.jsonl'), null)
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).queues['/sessions/a.jsonl'], undefined)

  // Forgetting explicitly is the same outcome, and is safe when nothing was recorded.
  rememberQueue('/sessions/a.jsonl', { steering: ['x'] })
  assert.equal(forgetQueue('/sessions/a.jsonl'), true)
  assert.equal(forgetQueue('/sessions/a.jsonl'), false)
  assert.equal(rememberedQueue('/sessions/a.jsonl'), null)
})

test('a file this version cannot read is nothing remembered, not a failure', () => {
  const { path } = scratch()
  writeFileSync(path, 'not json at all')
  configureQueueStore(path)
  assert.equal(rememberedQueue('/sessions/a.jsonl'), null)

  // Writing still works: a corrupt record must not stop the queue from being kept again.
  rememberQueue('/sessions/a.jsonl', { steering: ['after the corruption'] })
  assert.deepEqual(rememberedQueue('/sessions/a.jsonl'), {
    steering: ['after the corruption'],
    followUp: [],
  })
  assert.ok(existsSync(path))
})

test('the store keeps the most recent sessions and drops the oldest', () => {
  const { path } = scratch()
  for (let index = 0; index < 40; index += 1) {
    rememberQueue(`/sessions/${index}.jsonl`, { steering: [`message ${index}`] })
  }
  const file = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(Object.keys(file.queues).length, 32, 'the file is bounded')
  assert.equal(file.queues['/sessions/0.jsonl'], undefined, 'the oldest session is the one dropped')
  assert.deepEqual(file.queues['/sessions/39.jsonl'], { steering: ['message 39'], followUp: [] })
})
