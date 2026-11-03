import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  LAUNCHER_APP_ID,
  LAUNCHER_ID,
  defaultAppExecutable,
  formatFavoriteApps,
  installDesktopLauncher,
  parseFavoriteApps,
  pinLauncher,
  quoteExecArgument,
  renderDesktopEntry,
  resolveLauncherPaths,
  uninstallDesktopLauncher,
  unpinLauncher,
} from '../lib/desktop-launcher.js'

function fakeHome() {
  return mkdtempSync(join(tmpdir(), 'hammer-launcher-'))
}

function fakeCommand({ get = "['existing.desktop']", fail = false } = {}) {
  const calls = []
  const run = (command, args) => {
    calls.push([command, ...args])
    if (fail && command === 'gsettings') return { ok: false, stdout: '', stderr: 'no session' }
    if (command === 'gsettings' && args[0] === 'get') return { ok: true, stdout: get, stderr: '' }
    return { ok: true, stdout: '', stderr: '' }
  }
  return { run, calls }
}

test('the launcher points at the installed payload, not the checkout', () => {
  assert.equal(defaultAppExecutable('/home/someone'), '/home/someone/.local/opt/hammer/hammer')

  const paths = resolveLauncherPaths({ home: '/home/someone', dataHome: '/data' })
  assert.equal(paths.desktopFile, '/data/applications/hammer.desktop')
  assert.equal(paths.iconFile, '/data/icons/hicolor/512x512/apps/hammer.png')
})

test('an Exec argument is quoted and literal percent signs are escaped', () => {
  // Spaces need quotes; `%` would otherwise be read as a field code, and `$`/backticks would be
  // expanded by a shell if the value ever passed through one.
  assert.equal(quoteExecArgument('/opt/Hammer $HOME'), '"/opt/Hammer \\$HOME"')
  assert.equal(quoteExecArgument('/opt/100%/hammer'), '"/opt/100%%/hammer"')
})

test('the desktop entry has the keys a dock and menu need to group the window', () => {
  const entry = renderDesktopEntry({ execPath: '/home/someone/.local/opt/hammer/hammer' })

  assert.match(entry, /^\[Desktop Entry\]$/m)
  assert.match(entry, /^Type=Application$/m)
  assert.match(entry, /^Name=Hammer$/m)
  assert.match(entry, /^Exec="\/home\/someone\/\.local\/opt\/hammer\/hammer"$/m)
  assert.match(entry, /^Icon=hammer$/m)
  // GNOME on Wayland groups the window with the launcher by `app_id` (X11: WM_CLASS), which is the
  // `.desktop` base id the app announces via `app.setDesktopName`. The human name must not leak in.
  assert.equal(LAUNCHER_APP_ID, 'hammer')
  assert.match(entry, /^StartupWMClass=hammer$/m)
  assert.match(entry, /^Terminal=false$/m)
  // No field codes: a file manager must not offer to open documents with the router.
  assert.doesNotMatch(entry, /%[fFuU]/)
  assert.ok(entry.endsWith('\n'))
})

test('GNOME favourites round-trip in both the populated and typed-empty forms', () => {
  assert.deepEqual(parseFavoriteApps("['a.desktop', 'b.desktop']"), ['a.desktop', 'b.desktop'])
  assert.deepEqual(parseFavoriteApps('@as []'), [])
  assert.deepEqual(parseFavoriteApps('[]'), [])
  assert.equal(formatFavoriteApps(['a.desktop']), "['a.desktop']")
  assert.deepEqual(parseFavoriteApps(formatFavoriteApps(['a', "b'c"])), ['a', "b'c"])
})

test('pinning appends without reordering the existing taskbar', () => {
  const { run, calls } = fakeCommand({ get: "['term.desktop', 'browser.desktop']" })
  const result = pinLauncher({ run })

  assert.equal(result.pinned, true)
  assert.equal(result.changed, true)
  assert.deepEqual(result.favorites, ['term.desktop', 'browser.desktop', LAUNCHER_ID])
  assert.deepEqual(calls.at(-1), [
    'gsettings',
    'set',
    'org.gnome.shell',
    'favorite-apps',
    "['term.desktop', 'browser.desktop', 'hammer.desktop']",
  ])
})

test('pinning is idempotent and unpinning preserves the rest', () => {
  const already = pinLauncher({ run: fakeCommand({ get: "['hammer.desktop']" }).run })
  assert.equal(already.pinned, true)
  assert.equal(already.changed, false)

  const removed = unpinLauncher({
    run: fakeCommand({ get: "['a.desktop', 'hammer.desktop']" }).run,
  })
  assert.equal(removed.changed, true)
  assert.deepEqual(removed.favorites, ['a.desktop'])
})

test('a desktop without gsettings is reported, not thrown', () => {
  const result = pinLauncher({ run: fakeCommand({ fail: true }).run })
  assert.equal(result.pinned, false)
  assert.match(result.reason, /gsettings/)
})

test('install writes the entry and icon, and uninstall removes both', () => {
  const home = fakeHome()
  const execPath = join(home, 'hammer')
  const iconSource = join(home, 'icon.png')
  writeFileSync(execPath, '#!/bin/sh\n', { mode: 0o755 })
  writeFileSync(iconSource, 'png')
  const { run } = fakeCommand()

  try {
    const result = installDesktopLauncher({ home, execPath, iconSource, run })
    assert.equal(result.ok, true)
    assert.equal(existsSync(result.paths.desktopFile), true)
    assert.equal(existsSync(result.paths.iconFile), true)
    const entry = readFileSync(result.paths.desktopFile, 'utf8')
    assert.ok(entry.includes(`Exec="${execPath}"`))

    const removed = uninstallDesktopLauncher({ home, run })
    assert.equal(removed.removed, true)
    assert.equal(existsSync(result.paths.desktopFile), false)
    assert.equal(existsSync(result.paths.iconFile), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('install refuses to write a launcher for an executable that is not there', () => {
  const home = fakeHome()
  try {
    const result = installDesktopLauncher({
      home,
      execPath: join(home, 'missing'),
      iconSource: join(home, 'icon.png'),
      run: fakeCommand().run,
    })
    assert.equal(result.ok, false)
    assert.match(result.error, /npm run desktop:package/)
    assert.equal(existsSync(result.paths.desktopFile), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('install creates the applications directory on a home that has none', () => {
  const home = fakeHome()
  mkdirSync(join(home, 'bin'))
  const execPath = join(home, 'bin', 'hammer')
  const iconSource = join(home, 'icon.png')
  writeFileSync(execPath, '')
  writeFileSync(iconSource, 'png')

  try {
    const result = installDesktopLauncher({ home, execPath, iconSource, run: fakeCommand().run })
    assert.equal(result.ok, true)
    assert.equal(existsSync(result.paths.applications), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
