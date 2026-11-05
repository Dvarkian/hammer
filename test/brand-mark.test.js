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

/** The transform is applied to the mark in every copy; the numbers belong to the generator. */
const TRANSFORM =
  'translate(-0.17 2.22) rotate(-32 16 16) translate(16 16) scale(1.05) translate(-16 -16)'

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

test('every copy of the mark is the same drawing on the same transform', () => {
  const copies = { favicon, html, harness, splash }
  const handle = /d="(M11\.75 8\.6[^"]*)"/g
  const head = /d="(M21\.6 6\.9[^"]*)"/g

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
  for (const [name, text] of Object.entries({ html, harness })) {
    assert.ok(!/var\(--hx-brand\)/.test(text), `${name} still fills the head from a theme variable`)
    assert.match(text, new RegExp(`M21\\.6 6\\.9[^"]*" fill="#${HEAD}"`))
    assert.match(text, new RegExp(`M11\\.75 8\\.6[^"]*" fill="#${HANDLE}"`))
  }
})

test('the mark on screen carries the same rounded ground as the icon', () => {
  // The header mark used to be drawn without its ground, so the wordmark read as a bare hammer
  // on a card while the taskbar showed the maroon tile. Both in-app marks now use the tile.
  for (const [name, text] of Object.entries({ favicon, html, harness, splash })) {
    assert.match(
      text,
      new RegExp(`<rect width="32" height="32" rx="${RADIUS}" fill="#${GROUND}"`),
      `${name} does not carry the icon\u2019s ground`,
    )
  }
})
