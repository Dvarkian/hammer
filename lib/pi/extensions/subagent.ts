// @ts-nocheck
/**
 * Hammer's subagent tool. This file is deliberately a thin client: the router owns the
 * child process, model pool, grants, budgets and persistence. It is copied out of the
 * packaged asar into the agent directory because a plain Node running Pi cannot read a
 * module inside `app.asar`.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

const API = String(process.env.HAMMER_SUBAGENT_API || '').replace(/\/+$/, '')
const TOKEN = String(process.env.HAMMER_SUBAGENT_TOKEN || '')

type Json = Record<string, any>

function endpoint(path: string) {
  if (!API) throw new Error('Hammer subagents are unavailable: HAMMER_SUBAGENT_API is not set.')
  if (!TOKEN) throw new Error('Hammer subagents are unavailable: the console token is missing.')
  return `${API}${path}`
}

function transportDetail(error: any): string {
  const message = String(error?.message || error || 'fetch failed')
  const cause = error?.cause
  const code = String(cause?.code || error?.code || '').trim()
  const detail = String(cause?.message || cause || '').trim()
  if (!code && !detail) return message
  const extra = [code, detail].filter(Boolean).join(' ')
  return message.includes(extra) ? message : `${message} (${extra})`
}

async function call(
  path: string,
  options: { method?: string; body?: Json; retries?: number } = {},
): Promise<Json> {
  const method = options.method || 'GET'
  const attempts = Math.max(1, Number(options.retries) || (method === 'GET' ? 3 : 1))
  let lastError: any = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response: Response
    try {
      response = await fetch(endpoint(path), {
        method,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${TOKEN}`,
        },
        body: options.body == null ? undefined : JSON.stringify(options.body),
      })
    } catch (error: any) {
      lastError = error
      // A deliberate cancel is not a transport failure to retry. Everything else may be a
      // reset, a proxy hiccup or a server that was restarting its listener.
      if (error?.name === 'AbortError' || attempt >= attempts) break
      await sleep(250 * attempt)
      continue
    }
    const data = (await response.json().catch(() => ({}))) as Json
    if (!response.ok) {
      if (attempt < attempts && response.status >= 500) {
        await sleep(250 * attempt)
        continue
      }
      const message =
        data?.error?.message || data?.error || `Hammer subagents returned ${response.status}.`
      const error = new Error(String(message)) as Error & { status?: number }
      error.status = response.status
      throw error
    }
    return data
  }
  throw new Error(
    `Hammer subagents ${method} ${path} failed: ${transportDetail(lastError)}. ` +
      'The request may have been accepted; check the subagent list before spawning again.',
  )
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function terminal(state: unknown) {
  return state === 'completed' || state === 'failed' || state === 'stopped'
}

function compactStatus(status: Json) {
  const model = status?.model?.selected || status?.model?.group || '—'
  const fallback = status?.model?.fallback?.length
    ? ` · fallback ${status.model.fallback.join(' → ')}`
    : ''
  const tool = status?.currentTool ? ` · ${status.currentTool}` : ''
  return `${status?.name || status?.id} [${status?.phase || status?.status}] ${model}${fallback} · ${status?.tokens || 0} tokens${tool}`
}

function runningReceipt(status: Json, waitMs: number) {
  return [
    `<subagent id="${status.id}" name="${status.name}" state="running" model="${status?.model?.group || ''}" selected="${status?.model?.selected || ''}">`,
    `Still working after ${Math.round(waitMs / 1000)}s. This is now a background child; do not poll. The router will deliver its result when it finishes.`,
    `</subagent>`,
  ].join('\n')
}

function formatReport(report: Json) {
  const lines = [
    `<subagent id="${report.id}" name="${report.name}" state="${report.state}" model="${report.model || ''}" selected="${report.selected || ''}" fallback="${report.fallback?.length ? report.fallback.map((entry: Json) => entry.to).join(',') : 'none'}" turns="${report.turns}" tokens="${report.tokens}" elapsed="${Math.round((report.elapsedMs || 0) / 1000)}s">`,
    `<result>${report.text || report.error || '(no final report)'}</result>`,
  ]
  if (report.text && report.error) lines.push(`<error>${report.error}</error>`)
  if (report.reportPath) lines.push(`report=${report.reportPath}`)
  lines.push('</subagent>')
  return lines.join('\n')
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: 'subagent',
    label: 'Subagent',
    description:
      'Spawn and control a child agent on another model. Pick by the intelligence tag for judgement ' +
      '(Very Smart/Smart for design, review, debugging, research and any factual answer; Average for routine multi-file work; ' +
      'Dumb/Very Dumb only for mechanical, fully specified steps). Pick by the speed tag for volume ' +
      '(Very Fast/Fast when a turn must return quickly, Normal for routine work, Slow/Very Slow only for ' +
      'background or short output). Every model here is free to run: never pick a weaker model to save money, ' +
      'and the usage tag is quota headroom, not a price. Prefer ample usage for long jobs. Before a fan-out, give ' +
      'each child a group with no in_use children; separate models avoid sharing a rate limit. Do not put several ' +
      'children on one group just because it is convenient. Models are addressed by the key ' +
      'from the models action; no "inherit" exists. Tools are clamped to the parent\'s own. A child gets the ' +
      'subagent tool only when you grant a capability; include "spawn" in its tools to let it spawn one ' +
      'more level (the tree is capped at depth 2). Foreground is the ' +
      'default; background completes with a notification. spawn requires both task (the delegated work) ' +
      'and model (a catalogue key or fast/balanced/smart); the other actions require only their own ' +
      'target. Use send only for corrections or missing facts, not chatter; sending to a finished child ' +
      'restarts it on its session with only that message. Delete removes a child and its saved transcript ' +
      'once it is no longer needed. There is no OS sandbox: a child with bash can read anything the user can.',
    promptSnippet: 'Spawn a child agent on a chosen model, then wait for or steer its work.',
    promptGuidelines: [
      'Call subagent with action:"models" before choosing a model, then spawn with a catalogue key or fast/balanced/smart. Set thinking when the task needs a particular effort and the chosen model takes one.',
      'All models are free to run, including a group whose key is "free"; cost is never a reason to choose a weaker model. Use Smart/Very Smart whenever correctness matters (research, facts, review), and read usage only as quota headroom.',
      'Do not spawn for work you can finish yourself in one turn; delegation is for independent, context-heavy work.',
      'For nested delegation, include the "spawn" capability in the child\'s tools. Only a depth-1 child can spawn; its own children are terminal.',
    ],
    parameters: Type.Object({
      action: Type.String({
        description: 'models | spawn | status | list | transcript | wait | send | stop | delete',
      }),
      query: Type.Optional(Type.String()),
      min_intelligence: Type.Optional(
        Type.Number({
          description:
            'Minimum intelligence for models or spawn. 1-6 selects a tag floor: 1 Very Dumb, 2 Dumb, 3 Average, 4 Smart, 5 Very Smart, 6 Genius. Values above 6 are raw AA scores.',
        }),
      ),
      min_speed: Type.Optional(
        Type.Number({
          description:
            'Minimum speed for models or spawn. 1-5 selects a tag floor: 1 Very Slow, 2 Slow, 3 Normal, 4 Fast, 5 Very Fast. Values above 5 are raw effective tok/s.',
        }),
      ),
      min_context: Type.Optional(
        Type.Number({ description: 'Minimum context window in tokens for models or spawn.' }),
      ),
      usage: Type.Optional(
        Type.String({
          description:
            'Quota filter for models or spawn: any | usable | ample | unlimited | limited | scarce | exhausted | unknown.',
        }),
      ),
      include_unrated: Type.Optional(Type.Boolean()),
      limit: Type.Optional(Type.Number()),
      offset: Type.Optional(Type.Number()),
      name: Type.Optional(Type.String()),
      task: Type.Optional(
        Type.String({ description: 'Required for spawn: the work the child must complete.' }),
      ),
      instructions: Type.Optional(Type.String()),
      model: Type.Optional(
        Type.String({
          description: 'Required for spawn: a catalogue key, or fast | balanced | smart.',
        }),
      ),
      provider: Type.Optional(Type.String()),
      tools: Type.Optional(
        Type.Array(
          Type.String({
            description:
              'Optional allowlist. Omit it for read, grep, find and ls; include web_search and/or web_fetch to add network research. Capabilities: transcripts (read other transcripts), message (message other agents), spawn (spawn one more level; only a depth-1 child can hold it). A granted capability also adds the subagent tool.',
          }),
        ),
      ),
      background: Type.Optional(Type.Boolean()),
      notify: Type.Optional(Type.String({ description: 'auto | queue | silent' })),
      thinking: Type.Optional(
        Type.String({
          description:
            'Reasoning effort for the chosen model when its provider offers one: off | low | medium | high',
        }),
      ),
      max_turns: Type.Optional(Type.Number()),
      timeout_ms: Type.Optional(Type.Number()),
      token_budget: Type.Optional(Type.Number()),
      cwd: Type.Optional(Type.String()),
      id: Type.Optional(Type.String({ description: 'target id, or "parent" for the chooser' })),
      message: Type.Optional(Type.String()),
      mode: Type.Optional(Type.String({ description: 'steer | queue' })),
      wait_ms: Type.Optional(Type.Number()),
      transcript_limit: Type.Optional(Type.Number()),
    }),
    async execute(toolCallId, params, signal, onUpdate) {
      const action = String(params.action || 'models')
        .trim()
        .toLowerCase()
      if (action === 'models') {
        const query = new URLSearchParams()
        for (const key of [
          'query',
          'min_intelligence',
          'min_speed',
          'min_context',
          'usage',
          'limit',
          'offset',
        ] as const) {
          if (params[key] != null && params[key] !== '') query.set(key, String(params[key]))
        }
        if (params.include_unrated) query.set('include_unrated', '1')
        const data = await call(`/api/subagents/models?${query.toString()}`)
        return {
          content: [{ type: 'text', text: String(data.text || JSON.stringify(data)) }],
          details: { action, groups: data.total_active },
        }
      }

      if (action === 'spawn') {
        if (!String(params.task || '').trim())
          throw new Error(
            'The "spawn" action requires a task: pass task with the work the child must complete.',
          )
        if (!String(params.model || '').trim())
          throw new Error(
            'The "spawn" action requires a model: pass a catalogue key or fast | balanced | smart.',
          )
        const body: Json = {}
        for (const key of [
          'name',
          'task',
          'instructions',
          'model',
          'provider',
          'tools',
          'background',
          'notify',
          'thinking',
          'max_turns',
          'timeout_ms',
          'token_budget',
          'cwd',
          'min_intelligence',
          'min_speed',
          'min_context',
          'usage',
        ] as const) {
          if (params[key] !== undefined) body[key] = params[key]
        }
        // Stable across a transport retry, so a spawn that was accepted before the response
        // was lost returns the same child instead of colliding with itself.
        body.request_id =
          toolCallId || `subagent-${Date.now()}-${Math.random().toString(36).slice(2)}`
        const spawnStartedAt = Date.now()
        let receipt: Json
        try {
          receipt = await call('/api/subagents', { method: 'POST', body, retries: 3 })
        } catch (error: any) {
          // If every response was lost but the router stayed up, the child was still created.
          // Recover it by name, but only when it appeared during this call: an older child with
          // the same name must remain a collision, not be silently reused.
          const wanted = String(params.name || '').trim()
          if (!wanted || !String(error?.message || '').startsWith('Hammer subagents POST'))
            throw error
          let recovered: Json | null = null
          try {
            const listing = await call('/api/subagents', { retries: 3 })
            const found = (listing.subagents || []).find(
              (entry: Json) =>
                entry.name === wanted && Number(entry.createdAt || 0) >= spawnStartedAt - 30_000,
            )
            if (found) {
              recovered = {
                id: found.id,
                status: found,
                warning: found.warning || null,
                report: null,
              }
              if (terminal(found.status)) {
                const detail = await call(
                  `/api/subagents/${encodeURIComponent(found.id)}?report=1`,
                  { retries: 3 },
                )
                recovered.status = detail.subagent || found
                recovered.report = detail.report || null
              }
            }
          } catch {
            // The original transport error is the useful one if recovery cannot reach the router.
          }
          if (!recovered) throw error
          receipt = recovered
        }
        const status = receipt.status || {}
        if (body.background === true || terminal(status.status)) {
          return {
            content: [
              {
                type: 'text',
                text:
                  status.status === 'running'
                    ? `${runningReceipt({ ...status, id: receipt.id }, 0)}\nThis child is in the background; do not poll.`
                    : formatReport(receipt.report || status),
              },
            ],
            details: {
              id: receipt.id,
              state: status.status,
              model: status?.model?.group,
              fallback: status?.model?.fallback,
            },
          }
        }
        const waitMs = Math.max(1000, Math.min(30 * 60_000, Number(params.wait_ms) || 10 * 60_000))
        const started = Date.now()
        let last: Json = status
        let report: Json | null = null
        const promote = async () => {
          try {
            await call(`/api/subagents/${encodeURIComponent(receipt.id)}/promote`, {
              method: 'POST',
            })
          } catch {
            // The child may finish between the timeout and this call; the receipt is still true.
          }
        }
        for (;;) {
          if (signal?.aborted) {
            await promote()
            return {
              content: [
                {
                  type: 'text',
                  text: `The wait was cancelled; ${receipt.id} is now a background child.`,
                },
              ],
              details: { id: receipt.id, state: 'running' },
            }
          }
          let current: Json
          try {
            // Ask for the report on the terminal poll. A separate report request after the
            // loop was the last thing between a completed child and the parent, and a
            // transport failure there discarded a result that had already been produced.
            current = await call(`/api/subagents/${encodeURIComponent(receipt.id)}?report=1`)
          } catch (error: any) {
            if (signal?.aborted) {
              await promote()
              return {
                content: [
                  {
                    type: 'text',
                    text: `The wait was cancelled; ${receipt.id} is now a background child.`,
                  },
                ],
                details: { id: receipt.id, state: 'running' },
              }
            }
            // The spawn already succeeded. A lost status response is not a failed child, so
            // keep waiting through a router restart instead of reporting a false failure.
            if (error?.status && error.status < 500) throw error
            if (Date.now() - started >= waitMs) {
              await promote()
              return {
                content: [{ type: 'text', text: runningReceipt(last, waitMs) }],
                details: { id: receipt.id, state: 'running', model: last?.model?.group },
              }
            }
            await sleep(1_000)
            continue
          }
          last = current.subagent || current
          report = current.report || null
          onUpdate?.({
            content: [{ type: 'text', text: compactStatus(last) }],
            details: { id: receipt.id, state: last.status, model: last?.model?.group },
          })
          if (terminal(last.status)) break
          if (Date.now() - started >= waitMs) {
            await promote()
            return {
              content: [{ type: 'text', text: runningReceipt(last, waitMs) }],
              details: { id: receipt.id, state: 'running', model: last?.model?.group },
            }
          }
          await sleep(1000)
        }
        if (!report) {
          // Older routers (or a terminal frame that raced the result write) may omit the
          // report. Fetch it once with the normal retry policy, then return an explicit
          // result instead of letting a bare transport error replace the child's work.
          try {
            const detail = await call(`/api/subagents/${encodeURIComponent(receipt.id)}?report=1`, {
              retries: 5,
            })
            report = detail.report || detail
          } catch (error: any) {
            report = {
              ...last,
              state: last?.status,
              text: '',
              error: `The child finished, but its report could not be read: ${transportDetail(error)}. Use the transcript action to recover it.`,
            }
          }
        }
        return {
          content: [{ type: 'text', text: formatReport(report) }],
          details: {
            id: receipt.id,
            state: last.status,
            model: last?.model?.group,
            fallback: last?.model?.fallback,
          },
        }
      }

      const id = params.id ? String(params.id) : ''
      if (action === 'list') {
        const data = await call('/api/subagents')
        return {
          content: [{ type: 'text', text: JSON.stringify(data.subagents || data, null, 2) }],
          details: { action },
        }
      }
      if (!id && action !== 'list')
        throw new Error(`The "${action}" action requires an id (or "parent").`)
      if (action === 'status') {
        const data = await call(`/api/subagents/${encodeURIComponent(id)}`)
        return {
          content: [{ type: 'text', text: JSON.stringify(data.subagent || data, null, 2) }],
          details: { id, action },
        }
      }
      if (action === 'transcript') {
        const limit = Number(params.transcript_limit) || 8000
        const data = await call(
          `/api/subagents/${encodeURIComponent(id)}/transcript?limit=${encodeURIComponent(limit)}`,
        )
        return {
          content: [{ type: 'text', text: String(data.transcript || '') }],
          details: { id, bytes: data.bytes, truncated: data.truncated },
        }
      }
      if (action === 'wait') {
        const waitMs = Math.max(1000, Math.min(30 * 60_000, Number(params.wait_ms) || 60_000))
        const data = await call(
          `/api/subagents/${encodeURIComponent(id)}/wait?wait_ms=${encodeURIComponent(waitMs)}`,
        )
        return {
          content: [
            {
              type: 'text',
              text: data.report
                ? formatReport(data.report)
                : JSON.stringify(data.subagent, null, 2),
            },
          ],
          details: { id, state: data.subagent?.status },
        }
      }
      if (action === 'send') {
        const message = String(params.message || '').trim()
        if (!message) throw new Error('A message is required.')
        const data = await call(`/api/subagents/${encodeURIComponent(id)}/send`, {
          method: 'POST',
          body: { message, mode: params.mode || 'steer' },
        })
        return {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
          details: { id, mode: data.mode },
        }
      }
      if (action === 'stop') {
        const data = await call(`/api/subagents/${encodeURIComponent(id)}/stop`, { method: 'POST' })
        return {
          content: [{ type: 'text', text: JSON.stringify(data.subagent || data, null, 2) }],
          details: { id, state: data.subagent?.status },
        }
      }
      if (action === 'delete') {
        const data = await call(`/api/subagents/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        })
        return {
          content: [{ type: 'text', text: `Deleted subagent ${id}.` }],
          details: { id, deleted: data.deleted === true },
        }
      }
      throw new Error(`Unknown action "${action}".`)
    },
  })
}
