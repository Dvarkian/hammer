import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// ── The transcript's outline rail ────────────────────────────────────────────────────
//
// A rail of ticks down the right edge of the log, one per row, at the height that row
// actually occupies: it answers "where in this conversation is that thing?" without a
// scroll hunt. That is the whole feature, and each assertion below names a half of it that
// a plausible-looking port loses.
//
// The page is a classic script, so this guards the fold the same way the transcript fold is
// guarded (pi-agent.test.js): by the source text, plus the CSS rules that make it visible at
// all. What is checked here is what cannot be left out — the rail must be a *mirror* of the
// rows, measured from them, and must never disagree with the log.

const harness = readFileSync(new URL('../public/harness.js', import.meta.url), 'utf8')
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
const css = readFileSync(new URL('../public/harness.css', import.meta.url), 'utf8')

test('the rail is in the transcript pane, beside the jump rather than under it', () => {
  assert.match(
    html,
    /<div class="hx-transcript-wrap"[^>]*>\s*<div class="hx-transcript" id="hx-transcript"[^>]*><\/div>/,
  )
  assert.match(html, /<nav class="hx-minimap" id="hx-minimap"[^>]*><\/nav>/)
  assert.match(
    css,
    /\.hx-jump \{\s*position: absolute;\s*right: calc\(var\(--hx-gutter\) \+ 22px\);/,
  )
  assert.match(
    css,
    /\.hx-minimap \{\s*position: absolute;\s*top: 14px;\s*right: 4px;\s*bottom: 14px;/,
  )
})

test('a tick stands at the position its row actually occupies', () => {
  assert.match(harness, /top: node\.offsetTop/)
  assert.match(harness, /height: Math\.max\(node\.offsetHeight, 1\)/)
  assert.match(harness, /const track = rail\.clientHeight/)
  assert.match(harness, /const scale = Math\.max\(\(track - MINIMAP_TICK\)/)
  assert.match(harness, /if \(!node \|\| !node\.isConnected\) return null/)
})

test('the rail repaints with the transcript, on every path that rebuilds it', () => {
  assert.match(harness, /if \(jump\) jump\.style\.display = atBottom\(transcript\) \? 'none' : ''\s*\n\s*scheduleMinimap\(\)/)
  assert.match(harness, /function renderMinimap\(\)/)
  assert.match(harness, /if \(minimapFrame\) return/)
  assert.match(harness, /minimapFrame = requestAnimationFrame\(/)
  assert.match(harness, /item\.node\.innerHTML = assistantMarkup[\s\S]{0,200}scheduleMinimap\(\)/)
})

test('the rail is hidden when there is nothing worth mirroring', () => {
  assert.match(harness, /if \(!total \|\| transcript\.querySelector\('\.hx-empty'\)\)/)
  assert.match(harness, /rail\.hidden = true/)
  assert.match(harness, /if \(!rail \|\| !transcript \|\| !rail\.clientHeight\) return/)
})

test('when rows outnumber the rail, the landmarks are kept and the filler condenses', () => {
  assert.match(harness, /const MINIMAP_KEEP = new Set\(\['user', 'assistant', 'notice'\]\)/)
  assert.match(harness, /const capacity = Math\.max\(Math\.floor\(track \/ MINIMAP_TICK\), 1\)/)
  assert.match(harness, /if \(rows\.length > capacity\)/)
  assert.match(harness, /let stride = Math\.max\(Math\.ceil\(rows\.length \/ capacity\), 1\)/)
  assert.match(harness, /drawn\.length <= capacity \|\| stride >= rows\.length/)
  assert.match(harness, /stride \+= 1/)
  assert.match(css, /\.hx-minimap-gap \{/)
})

test('a tick jumps to its row, instantly, and the row is marked', () => {
  assert.match(harness, /function minimapJump\(index\) \{\s*const item = state\.items\[index\]/)
  assert.match(
    harness,
    /transcript\.scrollTop = Math\.max\(\s*0,\s*Math\.min\(\s*item\.node\.offsetTop - transcript\.clientHeight \/ 2/,
  )
  assert.doesNotMatch(harness, /behavior: 'smooth'/)
  assert.match(harness, /classList\.add\('hx-row-flash'\)/)
  assert.match(harness, /classList\.remove\('hx-row-flash'\)/)
  assert.match(css, /@keyframes hx-row-flash/)
})

test('a tick names its row to a screen reader and to a hover', () => {
  assert.match(harness, /function minimapAriaLabel\(item\)/)
  assert.match(harness, /return excerpt \? `\\$\\{who\\}: \\$\\{excerpt\\}` : who/)
  assert.match(
    harness,
    /return `\\$\\{item\\.name \\|\\| 'tool'\\} — \\$\\{toolSummary\\(item\\)\\}`/,
  )
  assert.match(harness, /\.slice\(0, 120\)/)
  assert.match(harness, /function minimapHover\(event\)/)
  assert.ok(
    harness.includes(
      'tip.innerHTML = `<b>${escapeHtml(who)}</b>${escapeHtml(minimapLabel(item))}`',
    ),
    'the tooltip label must be escaped, not assembled from raw text',
  )
})

test('the viewport window says where in the conversation you are', () => {
  assert.match(harness, /function updateMinimapWindow\(\)/)
  assert.match(harness, /const scrollable = transcript\.scrollHeight - transcript\.clientHeight/)
  assert.match(harness, /windowEl\.style\.top = `\$\{Math\.round\(Math\.min\(top, track - height\)\)\}px`/)
  assert.match(harness, /if \(scrollable <= 0\) \{/)
  assert.match(harness, /\$\('hx-transcript'\)\?\.addEventListener\('scroll', \(\) => \{/)
  assert.match(harness, /setPointerCapture\?\.\(event\.pointerId\)/)
  assert.match(harness, /if \(!rail \|\| minimapDragging\) return/)
})

test('the rail is navigable from the keyboard too', () => {
  assert.match(harness, /function jumpPrompt\(direction\)/)
  assert.match(
    harness,
    /if \(event\.altKey && !meta && \(event\.key === 'ArrowUp' \|\| event\.key === 'ArrowDown'\)\)/,
  )
  assert.match(
    harness,
    /if \(event\.target instanceof HTMLInputElement \|\| event\.target instanceof HTMLTextAreaElement\) return/,
  )
  assert.match(
    harness,
    /\{ label: 'Previous prompt', hint: 'Alt\+↑', run: \(\) => jumpPrompt\(-1\) \}/,
  )
  assert.match(
    harness,
    /\{ label: 'Next prompt', hint: 'Alt\+↓', run: \(\) => jumpPrompt\(1\) \}/,
  )
})

test('the rail stays a rail below the two-column width', () => {
  assert.match(css, /@media \(max-width: 960px\) \{[\s\S]{0,900}\.hx-minimap \{\s*display: none;/)
  assert.match(css, /@media \(max-width: 960px\) \{[\s\S]{0,700}\.hx-jump \{\s*right: var\(--hx-gutter\);/)
})

test('the rail reads as the log: one language, the same colour keys', () => {
  assert.match(css, /\.hx-minimap-tick\.is-user/)
  assert.match(css, /\.hx-minimap-tick\.is-assistant/)
  assert.match(css, /\.hx-minimap-tick\.is-user \{\s*background: var\(--success\)/)
  assert.match(css, /\.hx-minimap-tick\.is-assistant \{\s*background: var\(--accent\)/)
  assert.match(css, /\.hx-minimap-tick\.is-notice \{\s*background: var\(--error\)/)
  assert.match(css, /\.hx-minimap-tip \{\s*position: absolute;\s*right: 22px;\s*left: auto;/)
  assert.match(css, /pointer-events: none/)
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\) \{[\s\S]{0,120}\.hx-row-flash \{\s*animation: none;/,
  )
})
