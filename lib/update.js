import { spawn } from 'node:child_process'
import { accessSync, existsSync, constants } from 'node:fs'
import { join, dirname, basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getAutostartStatus, startAutostart, stopAutostart } from './autostart.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, '..')

function parseVersionParts(version) {
  if (typeof version !== 'string' || !version.trim()) return null
  // Resiliently extract only numeric parts (x.y.z)
  const match = version.match(/(\d+)\.(\d+)\.(\d+)/)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

export function isRunningFromSource() {
  if (getLocalUpdateTarballPath()) return false
  return existsSync(join(PROJECT_ROOT, '.git'))
}

function canWriteToProjectRoot() {
  try {
    accessSync(PROJECT_ROOT, constants.W_OK)
    return true
  } catch {
    return false
  }
}

export function shouldStopAutostartBeforeUpdate(skipRestart = false, platform = process.platform) {
  // In-process Web UI updates on Unix-like platforms should not stop the service first,
  // because that can terminate the process before npm finishes the install.
  return !skipRestart || platform === 'win32'
}

export function getLocalUpdateTarballPath() {
  const value = process.env.HAMMER_UPDATE_TARBALL
  if (typeof value !== 'string' || !value.trim()) return null

  const candidate = resolve(value.trim())
  if (!existsSync(candidate)) return null
  return candidate
}

export function getLocalUpdateVersion() {
  const envVersion = process.env.HAMMER_UPDATE_VERSION
  if (typeof envVersion === 'string' && parseVersionParts(envVersion)) {
    return envVersion.trim()
  }

  const tarballPath = getLocalUpdateTarballPath()
  if (!tarballPath) return null

  const match = basename(tarballPath).match(/hammer-(\d+\.\d+\.\d+)\.tgz$/i)
  return match ? match[1] : null
}

export function buildNpmInstallInvocation(target = 'latest', platform = process.platform) {
  const localTarball = getLocalUpdateTarballPath()
  const packageRef = localTarball || `hammer@${target}`

  if (platform === 'win32') {
    return {
      command: 'npm',
      args: ['install', '-g', packageRef],
      shell: true,
      updateType: localTarball ? 'local package' : 'global',
      localTarball,
    }
  }

  return {
    command: 'npm',
    args: ['install', '-g', packageRef],
    shell: false,
    updateType: localTarball ? 'local package' : 'global',
    localTarball,
  }
}

async function runNpmUpdate(target = 'latest') {
  if (isRunningFromSource()) {
    return {
      ok: false,
      message: 'Running from source (Git). Auto-update disabled. Please use "git pull" to update.',
    }
  }

  const { command, args, shell, updateType, localTarball } = buildNpmInstallInvocation(target)
  const cwd = process.cwd()

  // Async spawn (not spawnSync): a blocking npm install inside the server's event loop
  // would freeze every proxied request and the dashboard for the whole install.
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let child
    try {
      child = spawn(command, args, { stdio: 'pipe', encoding: 'utf8', cwd, shell })
    } catch (err) {
      return resolve({ ok: false, message: `Failed to run npm update: ${err?.message || err}` })
    }
    child.stdout?.on('data', chunk => { stdout += chunk })
    child.stderr?.on('data', chunk => { stderr += chunk })
    child.on('error', (err) => {
      resolve({ ok: false, message: `Failed to run npm update: ${err?.message || err}` })
    })
    child.on('close', (status) => {
      if (status !== 0) {
        const details = (stderr || stdout || 'npm update failed').trim()
        if (details.includes('EACCES') || details.includes('EPERM')) {
          return resolve({
            ok: false,
            message: `Permission denied during ${updateType} update. Please run "node bin/hammer.js" with sudo/Administrator privileges.`,
          })
        }
        return resolve({ ok: false, message: `npm ${updateType} update failed: ${details}` })
      }
      resolve({
        ok: true,
        message: localTarball
          ? `Updated hammer from local package${getLocalUpdateVersion() ? ` (v${getLocalUpdateVersion()})` : ''}.`
          : `Updated hammer to ${target === 'latest' ? 'latest version' : `v${target}`} (${updateType}).`,
      })
    })
  })
}

export async function runUpdateCommand(target = 'latest', skipRestart = false) {
  const status = getAutostartStatus()
  // We only stop/start if it's already configured as a background service
  const shouldManageBackground = status.supported && status.configured
  const shouldStopBackground = shouldManageBackground && shouldStopAutostartBeforeUpdate(skipRestart)
  const messages = []

  // Note: On Windows, stopAutostart() kills other instances but leaves the current one.
  // For in-process updates on Unix-like platforms, we intentionally avoid stopping first
  // so the current service can finish the install and then exit cleanly for supervision restart.
  if (shouldStopBackground) {
    const stopResult = stopAutostart()
    if (!stopResult.ok) return stopResult
    messages.push(stopResult.message)
  }

  const updateResult = await runNpmUpdate(target)
  if (!updateResult.ok) return updateResult
  messages.push(updateResult.message)

  if (shouldManageBackground && !skipRestart) {
    const startResult = startAutostart()
    if (!startResult.ok) {
      return {
        ok: false,
        message: `${messages.join('\n')}\nUpdate succeeded, but failed to restart autostart target: ${startResult.message}`,
      }
    }
    messages.push(startResult.message)
  }

  return {
    ok: true,
    message: messages.join('\n'),
  }
}
