import { spawnSync } from 'node:child_process'

function commandTokens(commandLine) {
  return String(commandLine || '')
    .split(/\s+/)
    .map(token => token.replace(/^['"]|['"]$/g, '').replace(/[;,]+$/g, ''))
    .filter(Boolean)
}

/** Return true when a process command line identifies the Hammer CLI executable. */
export function isHammerProcessCommandLine(commandLine) {
  if (typeof commandLine !== 'string' || /^\s*(?:pgrep|grep|powershell(?:\.exe)?)\b/i.test(commandLine)) return false
  const tokens = commandTokens(commandLine)
  const first = tokens[0] || ''
  const firstBase = first.split(/[\\/]/).pop() || ''
  if (/^(?:hammer|hammer\.js)$/i.test(firstBase)) return true
  if (!/^(?:node|node\.exe)$/i.test(firstBase)) return false
  return tokens.slice(1).some(token => {
    const basename = token.split(/[\\/]/).pop() || ''
    return /^(?:hammer|hammer\.js)$/i.test(basename)
      && (/[\\/]bin[\\/]hammer(?:\.js)?$/i.test(token) || /^(?:hammer|hammer\.js)$/i.test(token))
  })
}

function defaultSpawn(command, args) {
  return spawnSync(command, args, { encoding: 'utf8', stdio: 'pipe' })
}

function listUnixProcesses(spawn) {
  const result = spawn('pgrep', ['-af', 'hammer'])
  if (result?.error?.code === 'ENOENT' || result?.status !== 0) return []
  return String(result.stdout || '').split(/\r?\n/).flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(.*)$/)
    if (!match || !isHammerProcessCommandLine(match[2])) return []
    return [{ pid: Number(match[1]), command: match[2] }]
  })
}

function isAlive(pid, kill) {
  try {
    kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}

function terminateUnixProcesses(processes, kill) {
  const stopped = []
  for (const processInfo of processes) {
    try {
      kill(processInfo.pid, 'SIGTERM')
      stopped.push(processInfo)
    } catch (err) {
      if (err?.code !== 'ESRCH') throw err
    }
  }
  return stopped
}

function listWindowsProcesses(spawn, currentPid) {
  const script = [
    '$currentPid = ' + Number(currentPid),
    "$targets = Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $currentPid -and $_.CommandLine -and $_.CommandLine -match '(?i)hammer' } | Select-Object ProcessId, CommandLine",
    '$targets | ConvertTo-Json -Compress',
  ].join('; ')
  const result = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script])
  if (result?.error?.code === 'ENOENT') return { error: 'PowerShell was not found; unable to stop existing Hammer processes.' }
  if (result?.status !== 0) return { error: 'Unable to inspect existing Hammer processes.' }
  const raw = String(result.stdout || '').trim()
  if (!raw) return { processes: [] }
  try {
    const parsed = JSON.parse(raw)
    const rows = Array.isArray(parsed) ? parsed : [parsed]
    return {
      processes: rows.flatMap(row => {
        const pid = Number(row?.ProcessId)
        const command = String(row?.CommandLine || '')
        return pid > 1 && isHammerProcessCommandLine(command) ? [{ pid, command }] : []
      }),
    }
  } catch {
    return { error: 'Unable to read the existing Hammer process list.' }
  }
}

/**
 * Stop other Hammer instances before the router starts. This is intentionally
 * opt-out for test harnesses and callers that manage their own process tree.
 */
export async function stopExistingHammerProcesses({
  platform = process.platform,
  currentPid = process.pid,
  spawn = defaultSpawn,
  kill = process.kill,
  waitMs = 3000,
} = {}) {
  if (process.env.HAMMER_SKIP_INSTANCE_STOP === '1') {
    return { stopped: [], skipped: true, message: 'Instance stop skipped.' }
  }

  if (platform === 'win32') {
    const listed = listWindowsProcesses(spawn, currentPid)
    if (listed.error) return { stopped: [], skipped: false, message: listed.error }
    const stopped = []
    for (const processInfo of listed.processes) {
      const result = spawn('taskkill.exe', ['/PID', String(processInfo.pid), '/F'])
      if (result?.status === 0) stopped.push(processInfo)
    }
    return {
      stopped,
      skipped: false,
      message: stopped.length > 0
        ? `Stopped ${stopped.length} existing Hammer process${stopped.length === 1 ? '' : 'es'}.`
        : 'No existing Hammer processes found.',
    }
  }

  const processes = listUnixProcesses(spawn).filter(({ pid }) => pid !== Number(currentPid) && pid > 1)
  if (processes.length === 0) return { stopped: [], skipped: false, message: 'No existing Hammer processes found.' }

  const stopped = terminateUnixProcesses(processes, kill)
  const deadline = Date.now() + Math.max(0, waitMs)
  while (Date.now() < deadline && stopped.some(({ pid }) => isAlive(pid, kill))) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  for (const processInfo of stopped) {
    if (isAlive(processInfo.pid, kill)) {
      try { kill(processInfo.pid, 'SIGKILL') } catch (err) {
        if (err?.code !== 'ESRCH') throw err
      }
    }
  }
  return { stopped, skipped: false, message: `Stopped ${stopped.length} existing Hammer process${stopped.length === 1 ? '' : 'es'}.` }
}
