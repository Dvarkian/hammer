#!/usr/bin/env node
/**
 * @file hammer.js
 * @description Web dashboard and OpenAI-compatible router for coding LLM models.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs, clearContextBound, parseUsageStatKey } from '../lib/utils.js'
import { loadConfig, saveConfig, exportConfigToken, importConfigToken } from '../lib/config.js'
import { runOnboard } from '../lib/onboard.js'
import { getAutostartStatus, installAutostart, startAutostart, stopAutostart, uninstallAutostart } from '../lib/autostart.js'
import { stopExistingHammerProcesses } from '../lib/instances.js'
import { runUpdateCommand } from '../lib/update.js'
import chalk from 'chalk'

function printHelp() {
  console.log('hammer')
  console.log('')
  console.log('Usage:')
  console.log('  hammer [--port <port>] [--log] [--verbose] [--ban <model1,model2>]')
  console.log('  hammer onboard [--port <port>]')
  console.log('  hammer install --autostart')
  console.log('  hammer start --autostart')
  console.log('  hammer uninstall --autostart')
  console.log('  hammer status --autostart')
  console.log('  hammer status')
  console.log('  hammer update')
  console.log('  hammer refresh-scores')
  console.log('  hammer config export')
  console.log('  hammer config import <token>')
  console.log('  hammer config set-keys <provider> <key1,key2,...>')
  console.log('  hammer config add-key <provider> <key>')
  console.log('  hammer config remove-key <provider> <key>')
  console.log('  hammer config remove-key <provider> <index>')
  console.log('  hammer config set-maxturns <provider> <number>')
  console.log('  hammer config set-maxturns <provider> 0')
  console.log('  hammer autostart [--install|--start|--uninstall|--status]')
  console.log('  hammer context reset [--provider <key>] [--model <id>]')
  console.log('')
  console.log('Flags:')
  console.log('  --port <number>    Router HTTP port (default: 7352)')
  console.log('  --host <address>   Listen address. Loopback 127.0.0.1 by default (local only).')
  console.log('                     Use --host 0.0.0.0 to expose on the LAN (requires access token)')
  console.log('  --no-log           Disable request payload logging in terminal (legacy/override)')
  console.log('  --verbose, -v        Show detailed startup diagnostics')
  console.log('  --ban <ids>        Comma-separated model IDs to keep banned')
  console.log('  --onboard          Same as the onboard subcommand')
  console.log('  --autostart        Manage start-on-login behavior for the router')
  console.log('  --install          For autostart subcommand: enable at login')
  console.log('  --start            For autostart subcommand: trigger service start now')
  console.log('  --uninstall        For autostart subcommand: disable at login')
  console.log('  --status           For autostart subcommand: show status')
  console.log('  --help, -h         Show help')
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk)
  }
  return Buffer.concat(chunks.map(c => Buffer.isBuffer(c) ? c : Buffer.from(c))).toString('utf8')
}

function runAutostartAction(action) {
  if (action === 'install') {
    const installResult = installAutostart()
    if (!installResult.ok) return installResult

    const startResult = startAutostart()
    if (!startResult.ok) {
      return {
        ok: true,
        supported: installResult.supported,
        path: installResult.path,
        message: `${installResult.message}\nAutostart install succeeded, but start-now failed: ${startResult.message}`,
      }
    }

    return {
      ok: true,
      supported: installResult.supported,
      path: installResult.path,
      message: `${installResult.message}\n${startResult.message}`,
    }
  }
  if (action === 'start') return startAutostart()
  if (action === 'uninstall') return uninstallAutostart()
  return getAutostartStatus()
}

// Drops learned context bounds (see the context-observation rules in lib/utils.js),
// either through the running router or, when nothing is listening, in the persisted
// stats file. A bound is a conclusion drawn from one error body; the user needs a way
// to withdraw one without editing ~/.hammer-usage.json by hand.
async function runContextReset(cliArgs) {
  const providerKey = cliArgs.contextProvider || null
  const modelId = cliArgs.contextModel || null
  const scope = [providerKey ? `provider ${providerKey}` : null, modelId ? `model ${modelId}` : null]
    .filter(Boolean).join(', ')

  // The running router owns the in-memory copy of these bounds and would write it back
  // on its next save, so ask it first.
  try {
    const response = await fetch(`http://127.0.0.1:${cliArgs.portValue || 7352}/api/context-bounds/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerKey, modelId }),
    })
    if (response.ok) {
      const body = await response.json().catch(() => ({}))
      const count = Array.isArray(body.cleared) ? body.cleared.length : 0
      return { ok: true, message: `Cleared learned context bounds for ${count} row${count === 1 ? '' : 's'}${scope ? ` (${scope})` : ''}.` }
    }
    // 404 means the router is up but predates this endpoint. Editing the file behind its
    // back would look like it worked and then be overwritten by the next save, so say so.
    if (response.status === 404) {
      return {
        ok: false,
        message: `The router on port ${cliArgs.portValue || 7352} is running a build without context-bound resets. Restart it, then run this again.`,
      }
    }
    return { ok: false, message: `The router answered HTTP ${response.status} to the context reset.` }
  } catch {
    // No router on that port — fall through to the file.
  }

  const usagePath = join(homedir(), '.hammer-usage.json')
  if (!existsSync(usagePath)) {
    return { ok: true, message: 'No learned context bounds to clear (no usage stats file).' }
  }
  let stats
  try {
    stats = JSON.parse(readFileSync(usagePath, 'utf8'))
  } catch (err) {
    return { ok: false, message: `Could not read ${usagePath}: ${err?.message || err}` }
  }

  const cleared = []
  for (const [key, entry] of Object.entries(stats && typeof stats === 'object' ? stats : {})) {
    const next = clearContextBound(entry)
    if (next === entry) continue
    const row = parseUsageStatKey(key)
    if (providerKey && row.providerKey !== providerKey) continue
    if (modelId && row.modelId !== modelId) continue
    stats[key] = next
    cleared.push(key)
  }
  if (cleared.length > 0) {
    writeFileSync(usagePath, JSON.stringify(stats, null, 2), { mode: 0o600 })
  }
  return {
    ok: true,
    message: `Cleared learned context bounds for ${cleared.length} row${cleared.length === 1 ? '' : 's'}${scope ? ` (${scope})` : ''}${cleared.length > 0 ? ` in ${usagePath}` : ''}.`,
  }
}

async function main() {
  const cliArgs = parseArgs(process.argv)

  if (cliArgs.help) {
    printHelp()
    return
  }

  if (cliArgs.autostartAction) {
    const result = runAutostartAction(cliArgs.autostartAction)

    if (result.ok) {
      console.log(result.message)
      if (result.path) console.log(`Path: ${result.path}`)
        if (cliArgs.autostartAction === 'install') {
        console.log('Local access only (loopback). To expose on the LAN, set host via `--host 0.0.0.0` or HAMMER_HOST.')
      }
      return
    }

    console.error(result.message)
    process.exit(1)
  }

  if (cliArgs.command === 'update') {
    const result = await runUpdateCommand()
    if (result.ok) {
      console.log(result.message)
      return
    }

    console.error(result.message)
    process.exit(1)
  }

  // `hammer autoupdate` configured the background npm self-update path that no longer exists.
  // Failing loudly is the point: without this guard the command falls through to the end of
  // main() and silently starts the router instead, which looks like it worked.
  if (cliArgs.command === 'autoupdate') {
    console.error('The autoupdate subcommand was removed: hammer no longer updates itself. Use `hammer update` to upgrade on demand.')
    process.exit(1)
  }

  if (cliArgs.command === 'refresh-scores') {
    const config = loadConfig();
    const { getModelScoreAudit } = await import('../lib/score-fetcher.js');
    const audit = await getModelScoreAudit(config);
    console.log(chalk.green(`Scored ${audit.entries.length} configured or discovered models from OpenRouter catalog data:`));
    for (const entry of audit.entries) {
      const fallback = entry.source === 'artificial-analysis' ? '' : ' [fallback]';
      console.log(`${(entry.score * 100).toFixed(1).padStart(5)}  ${entry.modelId}  ${entry.source}${fallback} — ${entry.detail}`);
    }
    const counts = Object.groupBy
      ? Object.groupBy(audit.entries, entry => entry.source)
      : audit.entries.reduce((groups, entry) => ((groups[entry.source] ||= []).push(entry), groups), {});
    console.log('\nSources: ' + Object.entries(counts).map(([source, rows]) => `${source}=${rows.length}`).join(', '));
    console.log(`Coverage: measured=${audit.coverage.measured} estimated=${audit.coverage.estimated} family-matched=${audit.coverage.familyMatched} floored=${audit.coverage.floored} total=${audit.coverage.total}`);
    if (audit.regression) {
      console.log(chalk.dim(`Design Arena regression trained on ${audit.regression.sampleSize} catalog models.`));
    }
    for (const failure of audit.providerErrors) {
      console.log(chalk.yellow(`Warning: ${failure.providerKey} discovery failed: ${failure.error}`));
    }
    return;
  }

  if (cliArgs.command === 'context') {
    if (cliArgs.contextAction && cliArgs.contextAction !== 'reset') {
      console.error(`Unknown context action: ${cliArgs.contextAction}. Use: hammer context reset [--provider <key>] [--model <id>]`)
      process.exit(1)
    }
    const result = await runContextReset(cliArgs)
    if (result.ok) {
      console.log(result.message)
      return
    }
    console.error(result.message)
    process.exit(1)
  }

  if (cliArgs.command === 'config') {
    if (cliArgs.configAction === 'export') {
      const config = loadConfig()
      console.log(exportConfigToken(config))
      return
    }

    if (cliArgs.configAction === 'import') {
      let payload = cliArgs.configPayload
      if (!payload && !process.stdin.isTTY) {
        payload = (await readStdin()).trim()
      }
      if (!payload) {
        console.error('Missing config token. Use: hammer config import <token> (or pipe token via stdin).')
        process.exit(1)
      }

      try {
        const imported = importConfigToken(payload)
        saveConfig(imported)
        console.log('Configuration imported successfully.')
      } catch (err) {
        console.error(`Failed to import configuration: ${err?.message || 'Invalid token.'}`)
        process.exit(1)
      }
      return
    }

    if (cliArgs.configAction === 'set-keys') {
      const provider = cliArgs.configProvider
      const keysRaw = cliArgs.configKeys
      if (!provider || !keysRaw) {
        console.error('Usage: hammer config set-keys <provider> <key1,key2,...>')
        process.exit(1)
      }
      const keys = keysRaw.split(',').map(k => k.trim()).filter(Boolean)
      if (keys.length === 0) {
        console.error('No valid keys provided.')
        process.exit(1)
      }
      const config = loadConfig()
      if (!config.apiKeys) config.apiKeys = {}
      config.apiKeys[provider] = keys.length === 1 ? keys[0] : keys
      saveConfig(config)
      if (keys.length === 1) {
        console.log(chalk.green(`✔ Set key for ${provider}: ${keys[0].slice(0, 4)}...`))
      } else {
        console.log(chalk.green(`✔ Set ${keys.length} keys for ${provider}`))
        keys.forEach((k, i) => console.log(chalk.dim(`  [${i}] ${k.slice(0, 4)}...`)))
      }
      return
    }

    if (cliArgs.configAction === 'add-key') {
      const provider = cliArgs.configProvider
      const key = cliArgs.configKeys
      if (!provider || !key) {
        console.error('Usage: hammer config add-key <provider> <key>')
        process.exit(1)
      }
      const config = loadConfig()
      if (!config.apiKeys) config.apiKeys = {}
      const existing = config.apiKeys[provider]
      if (Array.isArray(existing)) {
        if (existing.includes(key)) {
          console.log(chalk.yellow(`Key already exists in pool for ${provider}.`))
        } else {
          existing.push(key)
          config.apiKeys[provider] = existing
          saveConfig(config)
          console.log(chalk.green(`✔ Added key to ${provider} (now ${existing.length} keys)`))
        }
      } else if (typeof existing === 'string' && existing) {
        config.apiKeys[provider] = [existing, key]
        saveConfig(config)
        console.log(chalk.green(`✔ Added a second key to ${provider} (the first is spent before the second is used)`))
      } else {
        config.apiKeys[provider] = key
        saveConfig(config)
        console.log(chalk.green(`✔ Set single key for ${provider}`))
      }
      return
    }

    if (cliArgs.configAction === 'remove-key') {
      const provider = cliArgs.configProvider
      const keyOrIndex = cliArgs.configKeys
      if (!provider || keyOrIndex === undefined) {
        console.error('Usage: hammer config remove-key <provider> <key|index>')
        process.exit(1)
      }
      const config = loadConfig()
      if (!config.apiKeys || !config.apiKeys[provider]) {
        console.error(`No keys configured for provider ${provider}.`)
        process.exit(1)
      }
      const existing = config.apiKeys[provider]
      if (!Array.isArray(existing)) {
        delete config.apiKeys[provider]
        saveConfig(config)
        console.log(chalk.green(`✔ Removed single key for ${provider}.`))
        return
      }
      // Prefer an exact key match over interpreting the value as an index, so an
      // all-numeric key can be removed by value instead of accidentally by position.
      const exactIdx = existing.indexOf(keyOrIndex)
      let removedIdx = exactIdx
      if (removedIdx === -1) {
        const idx = Number(keyOrIndex)
        if (!isNaN(idx) && Number.isInteger(idx) && idx >= 0 && idx < existing.length) {
          removedIdx = idx
        }
      }
      if (removedIdx === -1) {
        console.error(`Key not found in ${provider} pool: ${keyOrIndex}`)
        process.exit(1)
      }
      const removed = existing.splice(removedIdx, 1)[0]
      if (existing.length === 0) {
        delete config.apiKeys[provider]
      } else if (existing.length === 1) {
        config.apiKeys[provider] = existing[0]
      } else {
        config.apiKeys[provider] = existing
      }
      saveConfig(config)
      const removedLabel = exactIdx !== -1 ? keyOrIndex.slice(0, 4) : `[${removedIdx}] ${removed.slice(0, 4)}`
      console.log(chalk.green(`✔ Removed key ${removedLabel}... from ${provider} (${existing.length} remaining)`))
      return
    }

    if (cliArgs.configAction === 'set-maxturns') {
      const provider = cliArgs.configProvider
      const val = cliArgs.configMaxTurns
      if (!provider || val === undefined) {
        console.error('Usage: hammer config set-maxturns <provider> <number>')
        process.exit(1)
      }
      const maxTurns = Math.floor(Number(val))
      if (isNaN(maxTurns)) {
        console.error('maxTurns must be a number.')
        process.exit(1)
      }
      const config = loadConfig()
      if (!config.providers) config.providers = {}
      if (!config.providers[provider]) config.providers[provider] = {}
      if (maxTurns === 0) {
        delete config.providers[provider].maxTurns
        saveConfig(config)
        console.log(chalk.green(`✔ maxTurns disabled for ${provider} (unlimited requests per account)`))
      } else {
        config.providers[provider].maxTurns = maxTurns
        saveConfig(config)
        console.log(chalk.green(`✔ maxTurns set to ${maxTurns} for ${provider}`))
      }
      return
    }

    console.error('Usage: hammer config export | hammer config import <token>')
    console.error('       hammer config set-keys <provider> <key1,key2,...>')
    console.error('       hammer config add-key <provider> <key>')
    console.error('       hammer config remove-key <provider> <key|index>')
    console.error('       hammer config set-maxturns <provider> <number>')
    process.exit(1)
  }

  if (cliArgs.command === 'status') {
    const config = loadConfig()
    const { getAccountStatus } = await import('../lib/server.js')
    const { sources } = await import('../sources.js')
    const { getApiKeyPool, getMaxTurns } = await import('../lib/config.js')

    const liveStatus = getAccountStatus(config)

    console.log()
    console.log(chalk.bold('hammer account status'))
    console.log()

    const configuredProviders = Object.keys(config.apiKeys || {}).filter(k => getApiKeyPool(config, k).length > 0)

    if (configuredProviders.length === 0) {
      console.log(chalk.dim('No accounts configured.'))
      console.log(chalk.dim('Add keys: hammer config add-key <provider> <key>'))
      return
    }

    for (const provider of configuredProviders) {
      const info = sources[provider]
      const name = info?.name || provider
      const isEnabled = config?.providers?.[provider]?.enabled !== false
      const maxTurns = getMaxTurns(config, provider)
      const pool = getApiKeyPool(config, provider)
      const live = liveStatus.providers[provider]

      console.log(chalk.bold(`${name} (${provider})`) + chalk.dim(` ${isEnabled ? 'enabled' : 'disabled'} | ${pool.length} account${pool.length !== 1 ? 's' : ''} | maxTurns: ${maxTurns > 0 ? maxTurns : 'unlimited'}`))

      for (let i = 0; i < pool.length; i++) {
        const key = pool[i]
        const masked = key.length > 8 ? `${key.slice(0, 4)}...${key.slice(-4)}` : `${key.slice(0, 2)}***`
        const liveAcct = live?.accounts?.find(a => a.index === i)
        const requests = liveAcct?.requests ?? 0
        const isRateLimited = liveAcct?.rateLimited ?? false
        const hitMaxTurns = maxTurns > 0 && requests >= maxTurns

        let statusIcon = chalk.green('🟢')
        if (isRateLimited) statusIcon = chalk.red('🔴')
        else if (hitMaxTurns) statusIcon = chalk.yellow('🟡')

        const rotation = live?.currentIdx === i ? ' ← serving' : ''
        console.log(`  ${statusIcon} [${i}] ${masked}${rotation}  requests: ${requests}`)
      }
      console.log()
    }

    if (configuredProviders.length > 0) {
      console.log(chalk.dim('(Live request counts require the router to be running)'))
    }
    return
  }

  if (cliArgs.onboard) {
    const shouldStartRouter = await runOnboard(cliArgs.portValue || 7352)
    if (!shouldStartRouter) return
  }

  if (process.env.HAMMER_SKIP_INSTANCE_STOP !== '1') {
    const autostartStatus = getAutostartStatus()
    if (autostartStatus?.configured) {
      const supervisorStop = stopAutostart()
      if (!supervisorStop.ok) {
        console.error(`Unable to stop the Hammer autostart supervisor: ${supervisorStop.message}`)
        process.exit(1)
      }
      console.log(chalk.dim(`  ℹ ${supervisorStop.message} This instance takes over.`))
    }
    try {
      const instanceStop = await stopExistingHammerProcesses()
      if (instanceStop.stopped.length > 0) console.log(chalk.dim(`  ℹ ${instanceStop.message}`))
      else if (instanceStop.message && process.env.HAMMER_DEBUG_STARTUP === '1') console.log(chalk.dim(`  ℹ ${instanceStop.message}`))
    } catch (err) {
      console.error(`Unable to stop existing Hammer processes: ${err?.message || err}`)
      process.exit(1)
    }
  }

  const config = loadConfig()

  const { runServer } = await import('../lib/server.js')

  await runServer(config, cliArgs.portValue || 7352, cliArgs.enableLog, cliArgs.bannedModels, cliArgs.hostValue, cliArgs.verbose)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
