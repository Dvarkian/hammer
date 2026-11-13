/**
 * The mark has to be one drawing in one set of colours.
 *
 * It is drawn independently in five places — the generator, the favicon, the dashboard header,
 * the harness empty state and the splash — because the generator cannot reach inside a browser or
 * a tray. That is precisely how it drifted: each copy picked its own tones for the head, and the
 * icon in the taskbar stopped matching the one on screen. This file holds the canonical values
 * down and asserts every copy against them, so the next hand edit has a test that fails.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')

const generator = read('tools/make-desktop-icons.mjs')
const favicon = read('public/favicon.svg')
const html = read('public/index.html')
const harness = read('public/harness.js')
const splash = read('desktop/splash.html')

/** The three tones and the corner radius, as the generator defines them. */
const GROUND = '7d2231'
const HEAD = 'f6ece5'
const HANDLE = 'd9c3bb'
const RADIUS = 6

/** Whitespace-normalised copy of a file, so a multi-line SVG matches a one-line one. */
const flat = (text) => text.replace(/\s+/g, ' ')

/**
 * The transform applied to the mark in every copy; the numbers belong to the generator.
 *
 * The sign of the rotation is the whole point of the value. The generator's rasteriser reads
 * screen space back through `toMark`, which turns by `-TILT_DEGREES`, so the drawing reaches an
 * SVG as `+TILT_DEGREES`. Emitting `TILT_DEGREES` instead tilted every in-app copy the opposite
 * way from the icon in the taskbar — the drift this file exists for, with all four copies
 * agreeing with each other and disagreeing with the raster.
 */
const TRANSFORM =
  'translate(-2.2 5.18) rotate(32 16 16) translate(16 16) scale(1.1) translate(-16 -16)'

test('the generator still defines the three tones every copy is checked against', () => {
  // Read them out of the source rather than restating them here, so editing the generator's
  // palette cannot leave a test guarding the old one.
  assert.match(generator, /const GROUND = \[0x7d, 0x22, 0x31\]/)
  assert.match(generator, /const HEAD_TONE = \[0xf6, 0xec, 0xe5\]/)
  assert.match(generator, /const HANDLE_TONE = \[0xd9, 0xc3, 0xbb\]/)
  assert.match(generator, /radius: 6 \}\)/)

  // The hexes the SVG copies use are derived from those arrays, so a palette edit has to reach
  // the favicon for this to stay green.
  assert.match(favicon, new RegExp(`fill="#${GROUND}"`))
  assert.match(favicon, new RegExp(`fill="#${HEAD}"`))
  assert.match(favicon, new RegExp(`fill="#${HANDLE}"`))
})

test('the SVG copies turn the mark the way the rasteriser does', () => {
  // The two outputs of one generator have to be compared with each other, not only with their
  // own kind: the copies below all matched one another while the favicon leaned the other way
  // from the PNG in the taskbar.
  assert.match(generator, /rotate\(\$\{round\(-TILT_DEGREES\)\}/)
  assert.match(generator, /const radians = \(-TILT_DEGREES \* Math\.PI\) \/ 180/)
})

test('every copy of the mark is the same drawing on the same transform', () => {
  const copies = { favicon, html, harness, splash }
  const handle = /d="(M12\.55 8\.4[^"]*)"/g
  const head = /d="(M21\.76 2\.91[^"]*)"/g

  for (const [name, text] of Object.entries(copies)) {
    const flattened = flat(text)
    // Path data carries no whitespace in the generator's output, and normalising lets the
    // multi-line splash and header match the single-line favicon.
    assert.ok(flattened.includes(TRANSFORM), `${name} is missing the mark transform`)
    assert.ok(flattened.match(handle), `${name} is missing the handle path`)
    assert.ok(flattened.match(head), `${name} is missing the head path`)
  }
})

test("the mark on screen draws the head and handle in the icon's tones, not in theme colours", () => {
  // Regression: both in-app copies used `var(--hx-brand)` for the head, which is the ground's
  // maroon — a silhouette where the icon shows cream. Neither may reach the theme again.
  for (const [name, text] of Object.entries({ harness })) {
    assert.ok(!/var\(--hx-brand\)/.test(text), `${name} still fills the head from a theme variable`)
    assert.match(text, new RegExp(`M21\\.76 2\\.91[^"]*" fill="#${HEAD}"`))
    assert.match(text, new RegExp(`M12\\.55 8\\.4[^"]*" fill="#${HANDLE}"`))
  }
})

test('the mark on screen carries the same rounded ground as the icon', () => {
  // The header mark used to be drawn without its ground, so the wordmark read as a bare hammer
  // on a card while the taskbar showed the maroon tile. Both in-app marks now use the tile.
  for (const [name, text] of Object.entries({ favicon, harness, splash })) {
    assert.match(
      text,
      new RegExp(`<rect width="32" height="32" rx="${RADIUS}" fill="#${GROUND}"`),
      `${name} does not carry the icon\u2019s ground`,
    )
  }
})

test('the header draws the bare mark, not a tile', () => {
  // A tile is a 32px-icon device. In the app bar the mark sits beside the wordmark instead, so it
  // is drawn without the ground and in the text colour, that it reads in either theme.
  const start = html.indexOf('class="hx-brand"')
  const brand = html.slice(start, html.indexOf('</svg>', start))
  assert.ok(brand.length > 0, 'the header mark is missing')
  assert.ok(!/<rect width="32"/.test(brand), 'the header still draws the maroon tile')
  assert.match(brand, /fill="currentColor"/)
  assert.ok(!/#f6ece5|#d9c3bb/.test(brand), 'the header still paints the icon\u2019s own tones')
})
