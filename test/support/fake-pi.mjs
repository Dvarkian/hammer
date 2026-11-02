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
 */

import { appendFileSync } from 'node:fs'
import { argv } from 'node:process'

const logPath = process.env.FAKE_PI_LOG || ''
let streaming = false
let buffer = ''

const write = (record) => process.stdout.write(`${JSON.stringify(record)}\n`)
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

function handle(command) {
  note(command.streamingBehavior ? `${command.type}:${command.streamingBehavior}` : command.type)

  if (process.env.FAKE_PI_EXIT_ON === command.type) process.exit(4)

  switch (command.type) {
    case 'get_state':
      respond(command, {
        model: { id: 'fake-model', name: 'Fake Model', provider: 'fake' },
        thinkingLevel: 'off',
        isStreaming: streaming,
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
      note(`body:${command.message}`)
      if (steered) return
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
      process.stdout.write(tail.slice(0, 20))
      setTimeout(() => {
        process.stdout.write(tail.slice(20))
        write({
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Hello\u2028wörld' }],
            stopReason: 'stop',
          },
        })
        const settleAfter = Number(process.env.FAKE_PI_SETTLE_DELAY_MS || 0)
        setTimeout(
          () => {
            write({ type: 'agent_end', messages: [] })
            streaming = false
            write({ type: 'agent_settled' })
          },
          Number.isFinite(settleAfter) && settleAfter > 0 ? settleAfter : 0,
        )
      }, 5)
      return
    }

    case 'abort':
      streaming = false
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
      respond(command, null)
      return

    case 'get_session_stats':
      respond(command, { tokens: { total: 42 }, cost: 0 })
      return

    case 'new_session':
      respond(command, { cancelled: process.env.FAKE_PI_CANCEL_RESET === '1' })
      return

    case 'clear_queue':
      respond(command, { steering: [], followUp: [] })
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
