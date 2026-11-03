#!/usr/bin/env node
/**
 * @file install-desktop-launcher.mjs
 * @description Adds Hammer to the desktop's application menu, then optionally pins it to the
 * GNOME dock/taskbar.
 *
 * The launcher targets the packaged app by default (`~/.local/opt/hammer/hammer`). Pass `--app`
 * to point somewhere else, such as `release/Hammer-linux-x64/hammer` for a build you have not
 * installed yet.
 *
 * Run: node tools/install-desktop-launcher.mjs [--app <path>] [--pin]
 *      node tools/install-desktop-launcher.mjs --uninstall
 */

import { homedir } from 'node:os'
import {
  defaultAppExecutable,
  defaultIconSource,
  installDesktopLauncher,
  uninstallDesktopLauncher,
} from '../lib/desktop-launcher.js'

function parseArgs(argv) {
  const args = { app: defaultAppExecutable(homedir()), pin: false, uninstall: false, json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--app') args.app = argv[++i]
    else if (token.startsWith('--app=')) args.app = token.slice('--app='.length)
    else if (token === '--pin') args.pin = true
    else if (token === '--uninstall') args.uninstall = true
    else if (token === '--json') args.json = true
    else if (token === '--help' || token === '-h') args.help = true
    else throw new Error(`Unknown argument: ${token}`)
  }
  return args
}

function printHelp() {
  console.log(`Install a Hammer launcher for the desktop application menu and taskbar.

Usage:
  npm run desktop:launcher -- [--pin]
  npm run desktop:launcher -- --app <path> [--pin]
  npm run desktop:launcher -- --uninstall

Flags:
  --app <path>   Executable the launcher starts (default: ~/.local/opt/hammer/hammer)
  --pin          Also pin the launcher to the GNOME dock/taskbar favourites
  --uninstall    Remove the launcher and its icon, and unpin it
  --json         Print the result as JSON
`)
}

function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(err.message)
    printHelp()
    process.exitCode = 1
    return
  }

  if (args.help) {
    printHelp()
    return
  }

  const result = args.uninstall
    ? uninstallDesktopLauncher()
    : installDesktopLauncher({
        execPath: args.app,
        iconSource: defaultIconSource(),
        pin: args.pin,
      })

  if (args.json) {
    console.log(JSON.stringify(result, null, 2))
  } else if (!result.ok) {
    console.error(`✗ ${result.error}`)
  } else if (args.uninstall) {
    console.log(`✓ Removed ${result.paths.desktopFile}`)
    if (result.unpinned?.changed) console.log('✓ Unpinned Hammer from the taskbar')
  } else {
    console.log(`✓ Launcher written to ${result.paths.desktopFile}`)
    console.log(`  Starts ${result.execPath}`)
    console.log(`✓ Icon installed at ${result.paths.iconFile}`)
    if (result.pinned?.pinned && result.pinned.changed) {
      console.log('✓ Pinned Hammer to the GNOME dock/taskbar')
    } else if (result.pinned?.pinned) {
      console.log('  Hammer was already pinned to the GNOME dock/taskbar')
    } else if (args.pin) {
      console.log(`  Not pinned: ${result.pinned?.reason || 'GNOME favourites unavailable'}`)
    }
  }

  if (!result.ok) process.exitCode = 1
}

main()
