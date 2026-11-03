/**
 * @file main.js
 * @description Electron entry point for the Hammer desktop app.
 *
 * This is a shell, not a second server. It starts the real router from `lib/server.js` in this
 * process and points the window at `http://127.0.0.1:<port>/` — the same origin a browser would
 * use — so the dashboard cannot drift from the web build and the `/v1` endpoint that coding tools
 * point at keeps answering while the window is open.
 */

import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspect } from 'node:util'
import { app, BrowserWindow, Menu, Tray, dialog, nativeImage, shell } from 'electron'
import {
  LOOPBACK_HOST,
  dashboardUrl,
  isPortInUse,
  parseDesktopArgs,
  probeRouter,
  waitForDashboard,
} from './runtime.js'

const APP_TITLE = 'Hammer'
const LOG_PATH = join(homedir(), '.hammer-desktop.log')
const MAX_LOG_BYTES = 1024 * 1024
const DOCS_URL = 'https://github.com/Dvarkian/hammer#readme'
const ISSUES_URL = 'https://github.com/Dvarkian/hammer/issues'

const desktopArgs = parseDesktopArgs(process.argv, process.env)
const baseUrl = dashboardUrl(desktopArgs.port)
const splashPath = fileURLToPath(new URL('./splash.html', import.meta.url))
const iconPath = fileURLToPath(new URL('./assets/icon.png', import.meta.url))
const trayIconPath = fileURLToPath(new URL('./assets/tray.png', import.meta.url))

let mainWindow = null
let tray = null
let routerServer = null
let quitting = false

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/g

/**
 * A packaged app has no terminal, so the router's startup lines would otherwise be lost. Every
 * console call is mirrored to a size-capped file that the menu can open. Logging is best-effort:
 * a read-only home directory must not stop the app from starting.
 */
function installFileLog(path = LOG_PATH, maxBytes = MAX_LOG_BYTES) {
  const append = (level, text) => {
    try {
      if (existsSync(path) && statSync(path).size > maxBytes) renameSync(path, `${path}.1`)
      appendFileSync(path, `${new Date().toISOString()} ${level} ${text}\n`)
    } catch {
      // Logging is diagnostics; never let it break the app.
    }
  }
  const format = (value) =>
    typeof value === 'string'
      ? value
      : value instanceof Error
        ? value.stack || value.message
        : inspect(value)

  for (const level of ['log', 'info', 'warn', 'error']) {
    const original = console[level].bind(console)
    console[level] = (...args) => {
      original(...args)
      append(level, args.map(format).join(' ').replace(ANSI_PATTERN, ''))
    }
  }
  return path
}

function showLogFile() {
  if (existsSync(LOG_PATH)) shell.showItemInFolder(LOG_PATH)
  else shell.openPath(homedir())
}

function quitApp() {
  quitting = true
  app.quit()
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    mainWindow.loadURL(baseUrl)
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/** Updates the splash's status text. A no-op once the window has navigated to the dashboard. */
async function setSplashStatus(status, detail = '') {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const call = JSON.stringify([String(status), String(detail)])
  try {
    await mainWindow.webContents.executeJavaScript(
      `window.setSplashStatus && window.setSplashStatus(...${call})`,
    )
  } catch {
    // The window moved on to the dashboard (or is gone); there is no splash left to update.
  }
}

function showAbout() {
  const version = app.getVersion()
  dialog.showMessageBox(mainWindow ?? undefined, {
    type: 'info',
    title: `About ${APP_TITLE}`,
    message: `${APP_TITLE} ${version}`,
    detail:
      `Desktop shell over the local router.\n\n` +
      `Dashboard: ${baseUrl}\n` +
      `OpenAI-compatible endpoint: ${baseUrl}v1\n` +
      `Config: ${join(homedir(), '.hammer.json')}\n` +
      `Log: ${LOG_PATH}\n\n` +
      `Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}`,
    buttons: ['Close'],
  })
}

/**
 * Ends the app with something the user can act on: a wrong port and a broken provider look the
 * same on the splash, and the log is where the difference is written.
 */
function reportFailure(title, detail) {
  const buttons = ['Quit', 'Retry']
  if (existsSync(LOG_PATH)) buttons.push('Show Log')
  const choice = dialog.showMessageBoxSync(mainWindow ?? undefined, {
    type: 'error',
    title,
    message: title,
    detail: `${detail}\n\nLog: ${LOG_PATH}`,
    buttons,
    defaultId: 0,
    cancelId: 0,
  })
  if (choice === 1) {
    app.relaunch()
    quitApp()
    return
  }
  if (choice === 2) {
    showLogFile()
    return
  }
  quitApp()
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 960,
    minHeight: 620,
    title: APP_TITLE,
    backgroundColor: '#0b0e14',
    show: false,
    icon: iconPath,
    webPreferences: {
      // The page is ordinary web content served over loopback. It needs no Node access, so the
      // renderer stays sandboxed with no preload bridge and no IPC surface to abuse.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })

  mainWindow.once('ready-to-show', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show()
  })

  // Closing the window parks Hammer in the tray instead of killing the router that /v1 clients are
  // talking to. Quit (menu, tray, Cmd/Ctrl+Q) is the only path that exits.
  mainWindow.on('close', (event) => {
    if (quitting || !tray) return
    event.preventDefault()
    mainWindow.hide()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    // -3 is ERR_ABORTED, which is what replacing the splash with the dashboard looks like.
    if (quitting || errorCode === -3) return
    reportFailure(
      'Hammer could not open its dashboard',
      `${errorDescription} (${errorCode})\n\n${baseUrl}`,
    )
  })

  return mainWindow
}

function createTray() {
  try {
    const image = nativeImage.createFromPath(trayIconPath)
    if (image.isEmpty()) throw new Error(`tray icon is missing at ${trayIconPath}`)
    tray = new Tray(image.resize({ width: 16, height: 16 }))
    tray.setToolTip(`${APP_TITLE} — ${baseUrl}`)
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Hammer', click: showWindow },
        { label: 'Open in Browser', click: () => shell.openExternal(baseUrl) },
        { label: 'Show Log File', click: showLogFile },
        { type: 'separator' },
        { label: 'Quit Hammer', click: quitApp },
      ]),
    )
    tray.on('click', showWindow)
  } catch (err) {
    // Some Linux desktops ship no status-notifier host. The app still works; it just cannot park in
    // the tray, so `window-all-closed` has to quit rather than leave an invisible process.
    console.warn(`Tray unavailable: ${err?.message || err}`)
    tray = null
  }
}

function buildMenu() {
  const isMac = process.platform === 'darwin'
  return Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: APP_TITLE,
      submenu: [
        { label: `About ${APP_TITLE}`, click: showAbout },
        { label: 'Open in Browser', click: () => shell.openExternal(baseUrl) },
        { label: 'Show Log File', click: showLogFile },
        { type: 'separator' },
        isMac
          ? { role: 'close' }
          : { label: 'Quit Hammer', accelerator: 'CmdOrCtrl+Q', click: quitApp },
      ],
    },
    // Text inputs in Settings need copy/paste, so the standard edit roles come with the window.
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        {
          label: 'Reload Dashboard',
          accelerator: 'CmdOrCtrl+R',
          click: () => mainWindow?.webContents.reload(),
        },
        {
          label: 'Toggle Developer Tools',
          accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I',
          click: () => mainWindow?.webContents.toggleDevTools(),
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Documentation', click: () => shell.openExternal(DOCS_URL) },
        { label: 'Report an Issue', click: () => shell.openExternal(ISSUES_URL) },
      ],
    },
  ])
}

/**
 * Starts the router in this process unless one is already listening. Startup is genuinely slow —
 * `runServer` discovers provider models before it binds — so the readiness poll runs *alongside* it
 * and feeds the splash real elapsed time instead of a timer that guesses.
 */
async function startRouter() {
  const existing = await probeRouter(baseUrl)
  if (existing) {
    console.log(`  Using the ${APP_TITLE} already listening on ${baseUrl} (v${existing.version}).`)
    return existing
  }

  if (await isPortInUse(desktopArgs.port)) {
    throw new Error(
      `Port ${desktopArgs.port} is already in use by another application.\n\n` +
        'Close it, or launch Hammer with --port <number>.',
    )
  }

  await setSplashStatus('Loading configuration…')
  const { loadConfig } = await import('../lib/config.js')
  const { runServer } = await import('../lib/server.js')
  const config = loadConfig()

  await setSplashStatus('Starting router…')
  const cancelled = new AbortController()
  const ready = waitForDashboard(baseUrl, {
    signal: cancelled.signal,
    onPoll: ({ elapsedMs }) =>
      setSplashStatus('Discovering provider models…', `${(elapsedMs / 1000).toFixed(0)}s elapsed`),
  })

  try {
    // Forced to loopback regardless of `host` in the config: a desktop window is not a reason to
    // expose the router on the LAN, and that decision belongs to the CLI flag that documents it.
    routerServer = await runServer(
      config,
      desktopArgs.port,
      false,
      desktopArgs.bannedModels,
      LOOPBACK_HOST,
      desktopArgs.verbose,
    )
    return await ready
  } catch (err) {
    cancelled.abort()
    ready.catch(() => {})
    throw err
  }
}

async function bootstrap() {
  app.setAppUserModelId('com.hammer.router')
  installFileLog()
  console.log(`  ${APP_TITLE} desktop starting (port ${desktopArgs.port}, log ${LOG_PATH}).`)

  const window = createWindow()
  await window.loadFile(splashPath)
  Menu.setApplicationMenu(buildMenu())
  createTray()

  try {
    const meta = await startRouter()
    await setSplashStatus(
      'Opening dashboard…',
      meta?.version ? `${APP_TITLE} v${meta.version}` : '',
    )
    await window.loadURL(baseUrl)
    console.log(`  Dashboard loaded from ${baseUrl}.`)
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle(`${APP_TITLE} — ${baseUrl}`)
  } catch (err) {
    const message = String(err?.message || err)
    console.error(`  Startup failed: ${message}`)
    if (window && !window.isDestroyed()) {
      await window.webContents
        .executeJavaScript(
          `window.showSplashError && window.showSplashError(${JSON.stringify(message)})`,
        )
        .catch(() => {})
    }
    reportFailure('Hammer could not start', message)
  }
}

/**
 * A packaged app has no terminal, so an uncaught error would otherwise be an opaque blocked
 * window: Electron shows it as a modal dialog and nothing reaches the log. Report the stack first.
 */
function handleFatal(err) {
  console.error(`  Fatal: ${err?.stack || err}`)
  if (!app.isReady()) {
    app.exit(1)
    return
  }
  reportFailure('Hammer hit an unexpected error', String(err?.message || err))
}

process.on('uncaughtException', handleFatal)
process.on('unhandledRejection', handleFatal)

// Only one Hammer may own the port and the window: a second launch focuses the first.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.setName(APP_TITLE)
  // Wayland `app_id` / X11 `WM_CLASS` must equal the installed launcher's base id (`hammer`) so
  // the dock/taskbar shows Hammer's icon instead of a generic one. Must run before `ready`.
  if (typeof app.setDesktopName === 'function') app.setDesktopName('hammer.desktop')
  app.on('second-instance', showWindow)
  app.on('activate', showWindow)
  app.on('before-quit', () => {
    quitting = true
    // The agent is deliberately not stopped here: quitting to relaunch a new build is exactly
    // the restart a running turn has to survive. Its keeper stops it when no router has been
    // attached for its idle window, which is what keeps a closed app from leaving one behind.
    if (routerServer) {
      try {
        routerServer.close()
      } catch {
        // Already closed; nothing left to release.
      }
      routerServer = null
    }
  })
  // With a tray the window only hides, so this fires solely on desktops with no tray support.
  app.on('window-all-closed', quitApp)
  app
    .whenReady()
    .then(bootstrap)
    .catch((err) => {
      reportFailure('Hammer could not start', String(err?.message || err))
    })
}
