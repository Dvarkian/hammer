/**
 * @file desktop-launcher.js
 * @description Installs the freedesktop `.desktop` entry and icon that let Hammer be launched — and
 * pinned to the taskbar/dock — from the desktop environment's application menu.
 *
 * The launcher points at the packaged app (`~/.local/opt/hammer/hammer`), not the checkout: the
 * desktop build is the one users see, and a `.desktop` file that starts the dev wrapper would
 * serve the working tree instead of the installed payload.
 *
 * Everything pure lives here (entry rendering, GVariant parsing, path resolution) so the tests can
 * exercise it without a desktop session; `tools/install-desktop-launcher.mjs` supplies the argv and
 * the filesystem writes.
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const LAUNCHER_ID = 'hammer.desktop'
export const LAUNCHER_NAME = 'Hammer'
// The window's Wayland `app_id` (and X11 `WM_CLASS`), set in desktop/main.js via
// `app.setDesktopName(LAUNCHER_ID)`. GNOME matches a running window to this launcher by this
// value, so `StartupWMClass` has to be the base id rather than the human-readable name.
export const LAUNCHER_APP_ID = LAUNCHER_ID.replace(/\.desktop$/, '')
export const ICON_NAME = 'hammer'
export const FAVORITES_SCHEMA = 'org.gnome.shell'
export const FAVORITES_KEY = 'favorite-apps'

const DEFAULT_APP_PARTS = ['.local', 'opt', 'hammer', 'hammer']

/** The installed desktop payload, the path AGENTS.md calls the packaged copy. */
export function defaultAppExecutable(home = homedir()) {
  return join(home, ...DEFAULT_APP_PARTS)
}

/** The packaged icon ships beside this module, so the launcher and the window cannot disagree. */
export function defaultIconSource() {
  return fileURLToPath(new URL('../desktop/assets/icon.png', import.meta.url))
}

/**
 * XDG_DATA_HOME is the right home for per-user desktop entries; defaults are expanded here rather
 * than by the caller so tests can point a fake home at a temp directory.
 */
export function resolveLauncherPaths({
  home = homedir(),
  dataHome = process.env.XDG_DATA_HOME || join(home, '.local', 'share'),
} = {}) {
  const applications = join(dataHome, 'applications')
  const iconDir = join(dataHome, 'icons', 'hicolor', '512x512', 'apps')
  return {
    applications,
    desktopFile: join(applications, LAUNCHER_ID),
    iconDir,
    iconFile: join(iconDir, `${ICON_NAME}.png`),
  }
}

function runCommand(command, args = []) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: 'pipe' })
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
    error: result.error?.message || '',
  }
}

/**
 * Escapes one Exec argument per the Desktop Entry spec: quote the value, backslash the characters
 * the spec reserves inside quotes, and double a literal `%` so it is not read as a field code.
 */
export function quoteExecArgument(value) {
  const escaped = String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$')
    .replace(/%/g, '%%')
  return `"${escaped}"`
}

/**
 * A launcher with no field codes is what we want: the app owns its port and window, and a `%f`/`%u`
 * here would make a file manager offer to "open with Hammer" things the router cannot read.
 */
export function renderDesktopEntry({
  execPath,
  extraArgs = [],
  iconName = ICON_NAME,
  name = LAUNCHER_NAME,
  genericName = 'AI Router Dashboard',
  comment = 'Launch Hammer, the local OpenAI-compatible model router',
  categories = 'Development;',
  wmClass = LAUNCHER_APP_ID,
} = {}) {
  const exec = [quoteExecArgument(execPath), ...extraArgs.map(quoteExecArgument)].join(' ')
  return (
    [
      '[Desktop Entry]',
      'Type=Application',
      'Version=1.5',
      `Name=${name}`,
      `GenericName=${genericName}`,
      `Comment=${comment}`,
      `Exec=${exec}`,
      `Icon=${iconName}`,
      'Terminal=false',
      'StartupNotify=true',
      `StartupWMClass=${wmClass}`,
      `Categories=${categories}`,
      'Keywords=hammer;ai;llm;router;models;',
      '',
    ].join('\n') + '\n'
  )
}

/**
 * GVariant prints a string array as `['a.desktop', 'b.desktop']`, and typed-empty values as
 * `@as []`. Reading the quoted tokens rather than JSON.parse-ing the whole string keeps this
 * working for both forms and for escaped quotes inside an id.
 */
export function parseFavoriteApps(value) {
  const apps = []
  const pattern = /'((?:\\.|[^'\\])*)'/g
  let match = pattern.exec(String(value ?? ''))
  while (match) {
    apps.push(match[1].replace(/\\(.)/g, '$1'))
    match = pattern.exec(String(value ?? ''))
  }
  return apps
}

export function formatFavoriteApps(apps = []) {
  const quoted = apps.map((app) => `'${String(app).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`)
  return `[${quoted.join(', ')}]`
}

/** Appends the launcher to GNOME's dock/taskbar favourites without disturbing the existing order. */
export function pinLauncher({ id = LAUNCHER_ID, run = runCommand } = {}) {
  const read = run('gsettings', ['get', FAVORITES_SCHEMA, FAVORITES_KEY])
  if (!read.ok) {
    return {
      pinned: false,
      changed: false,
      reason: `gsettings could not read ${FAVORITES_SCHEMA} ${FAVORITES_KEY}`,
    }
  }

  const favorites = parseFavoriteApps(read.stdout)
  if (favorites.includes(id)) {
    return { pinned: true, changed: false, favorites }
  }

  const next = [...favorites, id]
  const write = run('gsettings', ['set', FAVORITES_SCHEMA, FAVORITES_KEY, formatFavoriteApps(next)])
  if (!write.ok) {
    return {
      pinned: false,
      changed: false,
      favorites,
      reason: `gsettings could not write ${FAVORITES_SCHEMA} ${FAVORITES_KEY}`,
    }
  }

  return { pinned: true, changed: true, favorites: next }
}

export function unpinLauncher({ id = LAUNCHER_ID, run = runCommand } = {}) {
  const read = run('gsettings', ['get', FAVORITES_SCHEMA, FAVORITES_KEY])
  if (!read.ok) return { pinned: false, changed: false, favorites: [] }

  const favorites = parseFavoriteApps(read.stdout)
  if (!favorites.includes(id)) return { pinned: false, changed: false, favorites }

  const next = favorites.filter((app) => app !== id)
  const write = run('gsettings', ['set', FAVORITES_SCHEMA, FAVORITES_KEY, formatFavoriteApps(next)])
  return { pinned: write.ok, changed: write.ok, favorites: write.ok ? next : favorites }
}

function refreshDesktopDatabase(applications, run) {
  // Optional in the XDG stack. A failure here only means a menu cache is stale, so it must not
  // turn a successful install into an error.
  run('update-desktop-database', [applications])
}

/**
 * Writes the entry and icon, then optionally pins the result. The executable is checked because a
 * launcher that exists but cannot start is worse than a clear "build the app first" message.
 */
export function installDesktopLauncher({
  home = homedir(),
  dataHome,
  execPath = defaultAppExecutable(home),
  iconSource = defaultIconSource(),
  pin = false,
  run = runCommand,
} = {}) {
  const paths = resolveLauncherPaths({ home, dataHome })

  if (!execPath || !existsSync(execPath)) {
    return {
      ok: false,
      paths,
      error:
        `Hammer executable not found at ${execPath}. ` +
        'Package the desktop app first: npm run desktop:package',
    }
  }
  if (!existsSync(iconSource)) {
    return { ok: false, paths, error: `Launcher icon not found at ${iconSource}` }
  }

  mkdirSync(paths.applications, { recursive: true })
  mkdirSync(paths.iconDir, { recursive: true })
  writeFileSync(paths.desktopFile, renderDesktopEntry({ execPath }), { mode: 0o644 })
  copyFileSync(iconSource, paths.iconFile)
  refreshDesktopDatabase(paths.applications, run)

  const pinResult = pin ? pinLauncher({ run }) : null
  return { ok: true, paths, execPath, pinned: pinResult, error: null }
}

export function uninstallDesktopLauncher({
  home = homedir(),
  dataHome,
  unpin = true,
  run = runCommand,
} = {}) {
  const paths = resolveLauncherPaths({ home, dataHome })
  const removed = existsSync(paths.desktopFile)
  if (removed) rmSync(paths.desktopFile)
  if (existsSync(paths.iconFile)) rmSync(paths.iconFile)
  const unpinResult = unpin ? unpinLauncher({ run }) : null
  refreshDesktopDatabase(paths.applications, run)
  return { ok: true, paths, removed, unpinned: unpinResult, error: null }
}
