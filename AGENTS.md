# Working on Hammer

Hammer is one application with two ways to run it, and they do **not** share assets. Almost every
mistake in this repo comes from forgetting that.

| How it runs            | What serves the dashboard                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `hammer` (dev)         | `~/.local/bin/hammer` is a bash wrapper that runs `node ~/Development/Hammer/bin/hammer.js` — the working tree, live |
| The desktop app (tray) | `~/.local/opt/hammer/hammer`, an Electron bundle serving `~/.local/opt/hammer/resources/app.asar`                    |

`lib/server.js` mounts `express.static(path.join(__dirname, '../public'))`, and inside the packaged
app `__dirname` resolves **inside the asar**. So the moment a change touches anything the desktop
app uses, editing the checkout does nothing for the window you are looking at. Restarting the app
does not help either: it re-launches the same frozen bundle.

## The rule

**After any change, rebuild and reinstall the desktop app before reporting the work as done.**

That includes changes to `public/` (dashboard, harness, CSS, HTML), `lib/`, `bin/`, `desktop/`,
`sources.js`, `scores.js`, `package.json`, and anything else that ends up inside the asar. A
behavioural change that only exists in the working tree is not shipped; the user is looking at the
packaged copy.

Markdown-only changes (`README.md`, `docs/`, this file) need no rebuild.

## The routine

Run from the repo root. Every step matters: the packaging verifies, the backup makes the swap
reversible, and the HTTP check is what proves the app is actually serving the new files.

1. **Check the tree first.** `npm run check` (lint, typecheck, format, tests). Packaging a failing
   tree only spreads the failure. If a check was already failing before your change, report it
   rather than reformatting unrelated files to manufacture a green run.

2. **Package.**

   ```bash
   npm run desktop:package          # -> release/Hammer-linux-x64
   ```

   The script runs `electron-packager` with `--overwrite --prune` and ignores `release`, `test`,
   `tools`, `docs` and dot-directories. It needs `desktop/assets/icon.png`; `npm run icons`
   regenerates it.

3. **Verify the payload _inside_ the asar**, not the working tree — this is the step that catches
   "I edited it but it is not in the build":

   ```bash
   node - release/Hammer-linux-x64/resources/app.asar <<'NODE'
   const asar = require('@electron/asar')
   const read = (p) => asar.extractFile(process.argv[2], p).toString('utf8')
   const html = read('public/index.html')
   console.log('index.html bytes:', html.length, '· expected marker count:', (html.match(/some-marker/g) || []).length)
   NODE
   ```

   `@electron/asar` is already present as a dependency of `@electron/packager`.

4. **Install the payload, not the whole bundle.** Replace `resources/app.asar` only:

   ```bash
   stamp=$(date +%Y%m%d-%H%M%S)
   target=~/.local/opt/hammer
   cp -a "$target/resources/app.asar" "$target/resources/app.asar.bak-$stamp"
   cp -a release/Hammer-linux-x64/resources/app.asar "$target/resources/app.asar"
   ```

   Do **not** copy the electron binaries over the installed directory. `chrome-sandbox` needs its
   ownership and setuid bit, and `cp` as a normal user cannot preserve them; a naive `cp -a
release/Hammer-linux-x64 ~/.local/opt/hammer` can leave an app that refuses to start. The
   electron version is pinned by `devDependencies`, so the existing binaries already match.

5. **Restart the app and prove what it serves.**

   ```bash
   pid=$(ss -lntp | grep '127.0.0.1:7352' | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1)
   [ -n "$pid" ] && kill "$pid"            # never pkill/pgrep -f: the pattern can match this shell
   setsid nohup ~/.local/opt/hammer/hammer > /tmp/hammer-app.log 2>&1 < /dev/null &
   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7352/     # wait for 200
   ```

   Then assert on what came back, not on the file you wrote:

   ```bash
   curl -s http://127.0.0.1:7352/ | grep -c 'the-marker-you-added-or-removed'
   curl -s http://127.0.0.1:7352/harness.js | grep -c 'hx-role'
   ```

   The app starts a splash while provider discovery runs, so the server may take up to a minute to
   answer; poll instead of assuming failure.

6. **Report the rebuild.** Say that the app was repackaged, which payload hash/receipt you
   verified, and that the served files now match. If the swap or relaunch could not be done, say so
   instead of implying the user is looking at the new build.

## Rolling back

Every install leaves `resources/app.asar.bak-<stamp>` beside the live payload. Restore one and
restart, or repackage an earlier commit and repeat the routine.

## Things that are never part of a rebuild

- `~/.hammer.json` (router config and API keys) and `~/.hammer/` (Pi agent dir) are user state.
  Packaging and installing must not touch them.
- Do not commit `release/`, `node_modules/`, or any `*.bak-*` backup.
- Do not `npm publish`, push, or deploy anything as part of "rebuild the app".

## Development loop without repackaging

When iterating on dashboard or harness UI, run the source server instead and use the browser:

```bash
node bin/hammer.js --port 7353      # or `hammer --port 7353`
```

That serves `public/` from the checkout, so a browser reload shows each edit. Use it for the inner
loop, then do the packaged rebuild once before handing the change back.
