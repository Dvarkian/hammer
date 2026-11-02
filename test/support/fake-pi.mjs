#!/usr/bin/env node
/**
 * @file fake-pi.mjs
 * @description A stand-in for `pi --mode rpc`, for tests that must not need a model.
 *
 * It speaks the record shapes of pi 0.85.1: one JSON object per LF-terminated line on
 * stdin/stdout, `response` records correlated by `id`, and the session-event vocabulary the
 * console renders. Behaviour a test needs to force is selected through the environment,
 * because the child's environment is fixed when the bridge spawns it:
 *
 *   FAKE_PI_LOG=<path>            append each received command type (and steer markers) to a file
 *   FAKE_PI_EXIT_ON=<type>        exit with code 4 on that command, leaving its caller waiting
 *   FAKE_PI_CANCEL_RESET=1        refuse `new_session`, as an extension handler may
 *   FAKE_PI_SETTLE_DELAY_MS=<ms>  hold the run open this long, so a UI can be seen mid-run
 *   FAKE_PI_SESSION_STATS=<json>  the `get_session_stats` payload (default: 42 total tokens)
 *   FAKE_PI_MESSAGE_USAGE=<json>  usage object attached to the assistant `message_end`
 *   FAKE_PI_NO_FOLLOW_UP=1        leave follow-ups queued on settle instead of starting them
 *   FAKE_PI_FOLLOW_UP_DELAY_MS=<ms> gap between a settled turn and its queued follow-up
 */

import { appendFileSync } from 'node:fs'
import { argv } from 'node:process'

const logPath = process.env.FAKE_PI_LOG || ''
let streaming = false
let buffer = ''
/** What the bridge queued while a run was open; drained on settle, like the real agent's. */
const steeringQueue = []
const followUpQueue = []

const write = (record) => {
  // While the deliberately split record is in flight, nothing else may write: a response
  // landing between its halves would corrupt the stream for any reader. Later records wait.
  if (tailPending) {
    outbox.push(record)
    return
  }
  process.stdout.write(`${JSON.stringify(record)}\n`)
}
let tailPending = false
/** @type {any[]} */
const outbox = []
const note = (line) => {
  if (!logPath) return
  // Diagnostics must never take the agent down: a test that cannot write its log still has to
  // see the protocol behaviour it is asserting on.
  try {
    appendFileSync(logPath, `${line}\n`)
  } catch {}
}

// What the launcher decided to run us with, once: `--session` and friends only exist here.
note(`argv:${JSON.stringify(argv.slice(2))}`)

function respond(command, data, success = true, error) {
  write({
    id: command.id,
    type: 'response',
    command: command.type,
    success,
    ...(data ? { data } : {}),
    ...(error ? { error } : {}),
  })
}

function envJson(name) {
  const raw = process.env[name]
  if (!raw) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/** Pi's queue accounting: both lists, every time anything about them moves. */
function emitQueueUpdate() {
  write({ type: 'queue_update', steering: [...steeringQueue], followUp: [...followUpQueue] })
}

function handle(command) {
  note(command.streamingBehavior ? `${command.type}:${command.streamingBehavior}` : command.type)

  if (process.env.FAKE_PI_EXIT_ON === command.type) process.exit(4)

  switch (command.type) {
    case 'get_state':
      respond(command, {
        model: { id: 'fake-model', name: 'Fake Model', provider: 'fake' },
        thinkingLevel: 'off',
        isStreaming: streaming,
        pendingMessageCount: steeringQueue.length + followUpQueue.length,
        sessionId: process.env.FAKE_PI_SESSION_ID || 'session-1',
        sessionFile: process.env.FAKE_PI_SESSION_FILE || null,
        // Echoed so a test can prove which configuration directory the child inherited.
        agentDir: process.env.PI_CODING_AGENT_DIR || null,
      })
      return

    case 'prompt': {
      if (streaming && !command.streamingBehavior) {
        respond(command, null, false, 'The agent is already streaming; specify streamingBehavior.')
        return
      }
      const steered = Boolean(command.streamingBehavior)
      respond(command, { disposition: steered ? 'queued' : 'started' })
      // An attachment count is logged so a test can see the images travelled; the fake does
      // not inspect pixels.
      if (Array.isArray(command.images) && command.images.length > 0) {
        note(`images:${command.images.length}`)
      }
      note(`body:${command.message}`)
      if (steered) {
        // The same split the real agent makes: a steer joins the run in progress, a follow-up
        // waits for it to end. Both announce themselves, and both drain when the turn ends.
        if (command.streamingBehavior === 'followUp') followUpQueue.push(command.message)
        else steeringQueue.push(command.message)
        emitQueueUpdate()
        return
      }
      streaming = true
      write({ type: 'agent_start' })
      write({
        type: 'message_start',
        message: { role: 'user', content: [{ type: 'text', text: command.message }] },
      })
      write({
        type: 'message_end',
        message: { role: 'user', content: [{ type: 'text', text: command.message }] },
      })
      write({ type: 'message_start', message: { role: 'assistant', content: [] } })
      write({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'Hello' },
      })

      // One record written in two pieces, carrying U+2028 inside a JSON string. Node's
      // readline splits on that character and any reader that assumes a data event is a
      // record will fail here; the bridge's LF-only buffer must not.
      const tail = `${JSON.stringify({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: '\u2028wörld' },
      })}\n`
      tailPending = true
      process.stdout.write(tail.slice(0, 20))
      setTimeout(() => {
        process.stdout.write(tail.slice(20))
        tailPending = false
        for (const held of outbox.splice(0)) write(held)
        const usage = envJson('FAKE_PI_MESSAGE_USAGE')
        write({
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Hello\u2028wörld' }],
            stopReason: 'stop',
            ...(usage ? { usage } : {}),
          },
        })
        const settleAfter = Number(process.env.FAKE_PI_SETTLE_DELAY_MS || 0)
        setTimeout(
          () => {
            write({ type: 'agent_end', messages: [] })
            streaming = false
            steeringQueue.length = 0
            // A finished turn consumes its follow-up queue and starts the next turn — the
            // shape the real agent's queue gives. The delay is the gap between turns.
            if (followUpQueue.length && process.env.FAKE_PI_NO_FOLLOW_UP !== '1') {
              const next = followUpQueue.shift()
              emitQueueUpdate()
              const gap = Number(process.env.FAKE_PI_FOLLOW_UP_DELAY_MS || 5)
              setTimeout(() => handle({ id: 'followup', type: 'prompt', message: next }), gap)
              return
            }
            emitQueueUpdate()
            write({ type: 'agent_settled' })
          },
          Number.isFinite(settleAfter) && settleAfter > 0 ? settleAfter : 0,
        )
      }, 5)
      return
    }

    case 'abort':
      streaming = false
      steeringQueue.length = 0
      followUpQueue.length = 0
      emitQueueUpdate()
      respond(command, null)
      write({ type: 'agent_settled' })
      return

    case 'switch_session': {
      const cancelled = process.env.FAKE_PI_CANCEL_SWITCH === '1'
      respond(command, { cancelled })
      if (cancelled) return
      // What a rebind produces: a fresh session identity and a session event naming it.
      write({ type: 'session', sessionFile: command.sessionPath, sessionId: 'session-switched' })
      return
    }

    case 'get_messages':
      respond(command, {
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'resumed question' }] },
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'resumed answer' }],
            stopReason: 'stop',
          },
        ],
      })
      return

    case 'set_session_name':
      if (!String(command.name || '').trim()) {
        respond(command, null, false, 'Session name cannot be empty')
        return
      }
      respond(command, null)
      return

    case 'get_session_stats':
      respond(command, envJson('FAKE_PI_SESSION_STATS') || { tokens: { total: 42 }, cost: 0 })
      return

    case 'new_session':
      respond(command, { cancelled: process.env.FAKE_PI_CANCEL_RESET === '1' })
      return

    case 'clear_queue': {
      const cleared = { steering: [...steeringQueue], followUp: [...followUpQueue] }
      steeringQueue.length = 0
      followUpQueue.length = 0
      emitQueueUpdate()
      respond(command, cleared)
      return
    }

    case 'follow_up':
    case 'steer':
      if (command.type === 'follow_up') followUpQueue.push(command.message)
      else steeringQueue.push(command.message)
      emitQueueUpdate()
      respond(command, null)
      return

    case 'abort_retry':
    case 'set_model':
      respond(command, null)
      return

    default:
      respond(command, null, false, `unknown command: ${command.type}`)
  }
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (!line.trim()) continue
    handle(JSON.parse(line))
  }
})
// The bridge shuts the agent down by closing stdin; a stand-in should behave like the real one.
process.stdin.on('end', () => process.exit(0))
