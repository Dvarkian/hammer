import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

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
  assert.match(harness, /markHeight = Math\.max\(node\.offsetHeight, 1\)/)
  // A long thinking block must not be painted with its turn's answer: thinking and prose
  // share one bubble, so the tick covers the bubble's non-thinking children — the union of
  // their extents, first prose top to last prose bottom.
  assert.match(harness, /filter\(\s*\(el\) => !el\.classList\.contains\('hx-thinking'\),?\s*\)/)
  assert.match(harness, /markHeight = Math\.max\(last\.bottom - first\.top, 1\)/)
  assert.match(harness, /row\.markTop \* scale/)
  assert.match(harness, /row\.markHeight \* scale/)
  assert.match(harness, /const track = rail\.clientHeight/)
  assert.match(harness, /const scale = Math\.max\(\(track - MINIMAP_TICK\)/)
  assert.match(harness, /if \(!node \|\| !node\.isConnected\) return null/)
})

test('the rail repaints with the transcript, on every path that rebuilds it', () => {
  assert.match(
    harness,
    /if \(jump\) jump\.style\.display = atBottom\(transcript\) \? 'none' : ''\s*\n\s*scheduleMinimap\(\)/,
  )
  assert.match(harness, /function renderMinimap\(\)/)
  assert.match(harness, /if \(minimapFrame\) return/)
  assert.match(harness, /minimapFrame = requestAnimationFrame\(/)
  assert.match(
    harness,
    /item\.node\.innerHTML = assistantMarkup\(item, item\.showRole !== false\)[\s\S]{0,250}scheduleMinimap\(\)/,
  )
})

test('the rail is hidden when there is nothing worth mirroring', () => {
  assert.match(harness, /if \(!total \|\| transcript\.querySelector\('\.hx-empty'\)\)/)
  assert.match(harness, /rail\.hidden = true/)
  // Unhidden before measuring: `hidden` is display:none, which measures as a 0px track, so a
  // height guard first would deadlock — the rail could never unhide itself.
  assert.match(harness, /rail\.hidden = false[\s\S]{0,300}if \(!rail\.clientHeight\) return/)
})

test('only prompts and answers get marks; the work between them condenses', () => {
  // The transcript's maroon spine is carried by tool and thinking rows; the prompts and the
  // answers are the rows that stand free of it. The rail marks exactly those.
  assert.match(harness, /function minimapMark\(item\)/)
  assert.match(harness, /item\.kind === 'user'\) return true/)
  assert.match(
    harness,
    /item\.kind === 'assistant'[\s\S]{0,120}block\.kind === 'text' && block\.text/,
  )
  assert.match(harness, /mark: minimapMark\(item\)/)
  assert.doesNotMatch(harness, /MINIMAP_KEEP/)
  assert.match(harness, /'hx-minimap-tick is-user' : 'hx-minimap-tick'/)
  assert.doesNotMatch(harness, /is-\$\{row\.kind\}/)
  assert.doesNotMatch(harness, /is-notice/)

  // When marks would fuse, the answers stay and the work between them collapses into gaps.
  assert.match(harness, /const capacity = Math\.max\(Math\.floor\(track \/ MINIMAP_TICK\), 1\)/)
  assert.match(harness, /if \(rows\.length > capacity\)/)
  assert.match(harness, /const kept = rows\.filter\(\(row\) => row\.mark\)/)
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
  // The excerpt alone — the tick's colour carries the role, so no "You:"/"Hammer:" prefix.
  assert.doesNotMatch(harness, /\$\{who\}: \$\{excerpt\}/)
  assert.match(harness, /item\.name.*tool.*toolSummary/)
  assert.match(harness, /\.slice\(0, 120\)/)
  assert.match(harness, /function minimapHover\(event\)/)
  assert.ok(
    harness.includes('tip.innerHTML = escapeHtml(minimapLabel(item))'),
    'the tooltip label must be escaped, not assembled from raw text',
  )
})

test('the viewport window says where in the conversation you are', () => {
  assert.match(harness, /function updateMinimapWindow\(\)/)
  assert.match(harness, /const scrollable = transcript\.scrollHeight - transcript\.clientHeight/)
  assert.match(
    harness,
    /windowEl\.style\.top = `\$\{Math\.round\(Math\.min\(top, track - height\)\)\}px`/,
  )
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
  assert.match(harness, /\{ label: 'Next prompt', hint: 'Alt\+↓', run: \(\) => jumpPrompt\(1\) \}/)
})

test('the rail stays a rail below the two-column width', () => {
  assert.match(css, /@media \(max-width: 960px\) \{[\s\S]{0,900}\.hx-minimap \{\s*display: none;/)
  assert.match(
    css,
    /@media \(max-width: 960px\) \{[\s\S]{0,700}\.hx-jump \{\s*right: var\(--hx-gutter\);/,
  )
})

test("the rail speaks in the rows' colours: blue for you, maroon for the answers", () => {
  // The colours are the rows' own — blue where the reader asked, maroon where Hammer answered.
  assert.match(css, /\.hx-minimap-tick \{[\s\S]{0,400}background: var\(--accent\);/)
  assert.match(css, /\.hx-minimap-tick\.is-user \{\s*background: var\(--success\);/)
  assert.doesNotMatch(css, /\.hx-minimap-tick\.is-assistant/)
  assert.doesNotMatch(css, /\.hx-minimap-tick\.is-notice/)
  // Blue prompts win the overlap, and hover lights a tick without repainting it: a prompt
  // stays blue under the pointer.
  assert.match(css, /\.hx-minimap-tick\.is-user \{[\s\S]{0,200}z-index: 1;/)
  assert.match(css, /\.hx-minimap-tick:hover,[\s\S]{0,200}filter: brightness\(1\.25\);/)
  assert.doesNotMatch(css, /\.hx-minimap-tick:hover,[\s\S]{0,200}background: var\(--text\);/)
  assert.match(css, /\.hx-minimap-tip \{\s*position: absolute;\s*right: 22px;\s*left: auto;/)
  assert.match(css, /pointer-events: none/)
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\) \{[\s\S]{0,300}\.hx-row-flash \{\s*animation: none;/,
  )
})
