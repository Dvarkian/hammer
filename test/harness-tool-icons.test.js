/**
 * ── The tool icon as line art grown out of the spine ────────────────────────────────
 *
 * The tool rows carry the transcript's maroon spine: a 2px line down their left edge. The
 * icon used to be a solid badge parked on that line, which put a gap above and below every
 * tool call; the brief that replaced it asked for genuine line art that sits along the
 * spine and appears to link into it top and bottom.
 *
 * "Appears to link in" is a geometric claim, so these tests check the geometry rather than
 * the styling that is supposed to produce it. Two earlier revisions looked right in their
 * own CSS and still drew the icon 14px to the right of the spine, because `left` was
 * written against the wrong containing block and nothing measured the result. So:
 *
 *   1. the icon node is pinned to a 24px box centred on the 2px line — the arithmetic is
 *      checked, not just the value, so the offset cannot drift again unnoticed;
 *   2. every glyph actually reaches the spine's column at the top and bottom of its box,
 *      which is parsed out of the path data with a real SVG path walker.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const harness = readFileSync(new URL('../public/harness.js', import.meta.url), 'utf8')
const css = readFileSync(new URL('../public/harness.css', import.meta.url), 'utf8')

/** The badge-rule block, isolated so assertions below do not match spacing edits elsewhere. */
const badgeBlock = (() => {
  const start = css.indexOf('.hx-tool-icon {')
  const end = css.indexOf('}', start)
  return css.slice(start, end + 1)
})()

/** The `.hx-tool-icon svg` block, likewise. */
const svgBlock = (() => {
  const start = css.indexOf('.hx-tool-icon svg {')
  const end = css.indexOf('}', start)
  return css.slice(start, end + 1)
})()

/**
 * Walks SVG path data and returns every point the stroke actually passes through, flattened
 * to [x, y] pairs. Enough of the command set to read these glyphs: M/m, L/l, H/h, V/v, C/c
 * (endpoints only — the control points are not on the curve), Z/z, and arcs (whose endpoint
 * is on the curve; its interior is not needed here).
 */
function pathPoints(d) {
  const t = String(d).match(/[MmLlHhVvCcSsQqTtAaZz]|-?\d*\.?\d+(?:e-?\d+)?/g) || []
  let x = 0
  let y = 0
  let sx = 0
  let sy = 0
  const out = []
  let i = 0
  let cmd = null
  while (i < t.length) {
    if (/[A-Za-z]/.test(t[i])) cmd = t[i]
    else if (cmd == null) {
      i += 1
      continue
    }
    i += 1
    const nums = []
    while (i < t.length && !/[A-Za-z]/.test(t[i])) nums.push(parseFloat(t[i++]))
    if (!nums.length) continue
    let n = 0
    while (n < nums.length) {
      const a = nums[n]
      const b = nums[n + 1]
      switch (cmd) {
        case 'M':
          x = a
          y = b
          sx = x
          sy = y
          out.push([x, y])
          n += 2
          break
        case 'm':
          x += a
          y += b
          sx = x
          sy = y
          out.push([x, y])
          n += 2
          break
        case 'L':
        case 'C':
        case 'Q':
          x = cmd === 'L' ? a : nums[n + (cmd === 'C' ? 4 : 2)]
          y = cmd === 'L' ? b : nums[n + (cmd === 'C' ? 5 : 3)]
          out.push([x, y])
          n += cmd === 'C' ? 6 : cmd === 'Q' ? 4 : 2
          break
        case 'l':
        case 'c':
        case 'q':
          x += cmd === 'l' ? a : nums[n + (cmd === 'c' ? 4 : 2)]
          y += cmd === 'l' ? b : nums[n + (cmd === 'c' ? 5 : 3)]
          out.push([x, y])
          n += cmd === 'c' ? 6 : cmd === 'q' ? 4 : 2
          break
        case 'H':
          x = a
          out.push([x, y])
          n += 1
          break
        case 'h':
          x += a
          out.push([x, y])
          n += 1
          break
        case 'V':
          y = a
          out.push([x, y])
          n += 1
          break
        case 'v':
          y += a
          out.push([x, y])
          n += 1
          break
        case 'A':
        case 'a':
          x = nums[n + 5]
          y = nums[n + 6]
          out.push([x, y])
          n += 7
          break
        case 'Z':
        case 'z':
          x = sx
          y = sy
          out.push([x, y])
          n += 1
          break
        default:
          n += 1
      }
    }
    // A bare coordinate pair after a command repeats it; the next token restates it.
    if (i < t.length && /[A-Za-z]/.test(t[i])) cmd = t[i]
  }
  return out
}

/** Every drawn point in one glyph's inner SVG markup, from paths and circles alike. */
function glyphPoints(inner) {
  const pts = []
  for (const m of inner.match(/<path[^>]*d="([^"]*)"/g)) {
    const d = m.match(/d="([^"]*)"/)[1]
    pts.push(...pathPoints(d))
  }
  for (const m of inner.matchAll(/<circle[^>]*cx="([\d.]+)"[^>]*cy="([\d.]+)"[^>]*r="([\d.]+)"/g)) {
    const cx = parseFloat(m[1])
    const cy = parseFloat(m[2])
    const r = parseFloat(m[3])
    // The four cardinal points are on the ring and are the only ones that can meet the
    // spine's column at the top or bottom of the box.
    pts.push([cx - r, cy], [cx + r, cy], [cx, cy - r], [cx, cy + r])
  }
  return pts
}

/** The glyph table, keyed by tool name, straight out of harness.js. */
const glyphTable = (() => {
  const m = harness.match(
    /function toolIcon\(name\) \{[\s\S]*?const body = icons\[key\] \|\| icons\.other/,
  )
  assert.ok(m, 'toolIcon must exist')
  const found = {}
  for (const [, name, inner] of m[0].matchAll(/(\w+): '(<[^']*)'/g)) found[name] = inner
  return found
})()

/* ──────────────────────────────────────────────────────────────────────────────────── */

test('the node is a 24px box centred on the 2px spine', () => {
  // The brief: the glyph is drawn out of the line, so the node has to sit on the line.
  assert.match(badgeBlock, /width: 24px;/)
  assert.match(badgeBlock, /height: 24px;/)
  // No plate: a ground behind the node would cut the spine into a dashed pattern, which is
  // the very defect the task opened with.
  assert.match(badgeBlock, /background: transparent;/)
  assert.doesNotMatch(badgeBlock, /border-radius/)
  assert.doesNotMatch(badgeBlock, /box-shadow: 0 0 0/)
})

test('the node is pinned to the row top, and not stretched by an open row', () => {
  // The two revisions that failed here: `height: 100%` scaled the viewBox up with an open
  // tool row's output, so the drawing's ends drifted past the row edges and the joins —
  // the only thing that makes it read as the spine — were the first casualty.
  // The row pads its content by 2px, so `top: 0` against the details put the glyph 2px below
  // the row's own edge, leaving a gap to the line above it. -2px pins the box to the edge.
  assert.match(badgeBlock, /top: -2px;/)
  assert.doesNotMatch(badgeBlock, /height: 100%/)
  // The SVG is a fixed 24px square, letterboxed at nothing: upscaling or shrinking it would
  // move the ends off the row edges.
  assert.match(svgBlock, /width: 24px;/)
  assert.match(svgBlock, /height: 24px;/)
  // Visible overflow so a stroke that overshoots its box is not clipped by the node.
  assert.match(svgBlock, /overflow: visible;/)
})

test("every join is the spine's own width, with no gap", () => {
  // The row's 2px top padding sits between the row edge and the details, so a glyph pinned to
  // the details began 2px below the edge where the previous station's line ended — a gap
  // between two stations. The icon is pulled onto the edge, and the spine resumes 2px inside
  // the glyph's foot, so the two overlap instead of meeting at a seam.
  assert.match(css, /\.hx-row \{[^}]*padding: 2px 0;/)
  assert.match(badgeBlock, /top: -2px;/)
  assert.match(css, /\.hx-row-tool::before \{[\s\S]{0,200}top: 22px;/)

  // 1.6px of stroke against a 2px line leaves a notch at the joint, so each station wears a
  // 2px collar at both ends of its 24px box, in the drawing's own colour.
  assert.match(
    css,
    /\.hx-tool-icon::before,\s*\.hx-tool-icon::after,\s*\.hx-thinking-icon::before,\s*\.hx-thinking-icon::after,\s*\.hx-compaction-icon::before,[\s\S]{0,400}width: 2px;/,
  )
  assert.match(
    css,
    /\.hx-tool-icon::before,\s*\.hx-thinking-icon::before,\s*\.hx-compaction-icon::before,\s*\.hx-model-icon::before \{\s*top: 0;/,
  )
  assert.match(
    css,
    /\.hx-tool-icon::after,\s*\.hx-thinking-icon::after,\s*\.hx-compaction-icon::after,\s*\.hx-model-icon::after \{\s*bottom: 0;/,
  )

  // A thought is a station too, and its mark had the gap this test is about: 6px of margin
  // held the icon off the line while the spine stopped dead above and below it. It now follows
  // the tool glyph's geometry — no margin, the box on the row edge, the spine resuming at the
  // glyph's foot 22px down.
  const thinkingBlock = css.match(/^\.hx-thinking \{[^}]*\}/m)
  assert.ok(thinkingBlock, '.hx-thinking still has a base rule to hold the station geometry')
  assert.match(thinkingBlock[0], /margin: 0;/)
  assert.match(css.match(/^\.hx-thinking-icon \{[^}]*\}/m)[0], /top: -2px;/)
  assert.match(css, /^\.hx-thinking::before \{[\s\S]{0,240}top: 22px;/m)
  // ... and runs through the row's 2px bottom padding, to the edge the next station starts
  // from, which is where a tool row's rail ends.
  assert.match(css, /^\.hx-thinking::before \{[\s\S]{0,240}bottom: -2px;/m)
})

test('the icon is centred on the spine, measured from the row', () => {
  // This is the assertion the earlier revisions lacked, and it is why they shipped a glyph
  // standing 12px clear of the line while every visual check in the suite passed.
  //
  // The node is absolutely positioned against the <details>, which is now the nearest
  // positioned ancestor (the row moved to a pseudo-element spine, so it carries no border
  // and the details starts at the row's content edge: 12px of padding). The 2px spine is a
  // ::before on the row itself, centred 1px in. Centring the 24px node therefore needs:
  //     left = 1 - 12 (the details' 12px offset) - (24 / 2) = -23px
  // Anything else is silent in exactly the way the brief complained about: the glyph still
  // draws, but it hangs half outside the row with the spine nicking only one edge.
  const detailsOffset = 12
  const nodeWidth = 24
  const expected = 1 - detailsOffset - nodeWidth / 2
  const found = badgeBlock.match(/left:\s*(-?[\d.]+)px;/)
  assert.ok(found, '.hx-tool-icon must position itself with a left offset')
  assert.equal(
    parseFloat(found[1]),
    expected,
    `left must be ${expected}px to centre the node on the 2px line, was ${found[1]}`,
  )
})

test('the spine stops short of the icon instead of cutting through it', () => {
  // The core complaint: a continuous border-left ran straight through the icons and read as
  // clutter. The rail is now painted below the 24px icon band only, so the glyph is the
  // spine through its own 24px and the line resumes under it.
  assert.match(css, /\.hx-row-tool \{[^}]*position: relative;/)
  assert.doesNotMatch(css, /\.hx-row-tool \{[^}]*border-left:/)
  assert.match(css, /\.hx-row-tool::before \{[\s\S]{0,200}top: 22px;/)
  assert.match(css, /\.hx-row-tool::before \{[\s\S]{0,200}bottom: 0;/)
  assert.match(css, /\.hx-row-tool::before \{[\s\S]{0,200}width: 2px;/)
  assert.match(css, /\.hx-row-tool::before \{[\s\S]{0,200}background: var\(--accent\);/)
})

test('every glyph is a sparse stroke set that stays legible at 12px', () => {
  for (const [name, inner] of Object.entries(glyphTable)) {
    const shapes = (inner.match(/<path/g) || []).length + (inner.match(/<circle/g) || []).length
    assert.ok(shapes > 0 && shapes <= 4, `${name} keeps to four shapes, had ${shapes}`)
  }
})

test('every tool the router can name has a glyph, and the set stays sparse', () => {
  const names = [
    'bash',
    'read',
    'edit',
    'write',
    'grep',
    'find',
    'glob',
    'ls',
    'task',
    'todo',
    'webfetch',
    'web_search',
    'web_fetch',
    'question',
    'other',
  ]
  for (const name of names) {
    assert.ok(glyphTable[name], `a glyph for ${name}`)
  }
  assert.match(harness, /icons\.other/)
  assert.match(harness, /icons\[key\] \|\| icons\.other/)
})

test('each glyph meets the spine at the top and the bottom of its box', () => {
  // The design claim, parsed from the path data: each glyph must put a drawn point on the
  // spine's column (x = 12, the viewBox's centre) at y = 0 and again at y = 24. That point
  // on the spine's line is what makes the icon read as the spine's own growth rather than a
  // badge hung beside it. The node is 24px and the viewBox is 24 units, so these are also
  // the row's top and bottom edges.
  const failures = []
  for (const [name, inner] of Object.entries(glyphTable)) {
    const pts = glyphPoints(inner)
    const atTop = pts.filter(([x, y]) => Math.abs(x - 12) < 0.51 && y <= 0.51)
    const atBottom = pts.filter(([x, y]) => Math.abs(x - 12) < 0.51 && y >= 23.49)
    if (!atTop.length) failures.push(`${name}: nothing at the spine's head (12,0)`)
    if (!atBottom.length) failures.push(`${name}: nothing at the spine's foot (12,24)`)
  }
  assert.equal(failures.join('; '), '', 'every glyph links into the spine at both ends')
})

test('each state of the badge is a colour, not a filled box', () => {
  assert.match(css, /\.hx-tool\.running \.hx-tool-icon \{[^}]*color: var\(--accent\);/)
  assert.match(css, /\.hx-tool\.running \.hx-tool-icon \{[^}]*animation: hx-pulse/)
  // A finished call keeps the spine's maroon: it is part of the log's body, not a verdict
  // beside it, so the mark and its state do not recede to a separate colour.
  assert.match(css, /\.hx-tool\.ok \.hx-tool-icon \{[^}]*color: var\(--accent\);/)
  assert.match(css, /\.hx-tool\.ok \.hx-tool-state \{[^}]*color: var\(--accent\);/)
  assert.match(css, /\.hx-tool\.error \.hx-tool-icon \{[^}]*color: var\(--error\);/)
  assert.match(css, /\.hx-tool\.interrupted \.hx-tool-icon \{[^}]*color: var\(--text-muted\);/)
})

test('the glyph is stroked thin, in currentColor, so state is the only tint', () => {
  assert.match(svgBlock, /stroke: currentColor;/)
  assert.match(svgBlock, /fill: none;/)
  assert.match(svgBlock, /stroke-width: 1\.6;/)
  assert.match(svgBlock, /stroke-linecap: round;/)
  assert.match(svgBlock, /stroke-linejoin: round;/)
})

test('the old filled-box glyphs are gone', () => {
  for (const [, inner] of Object.entries(glyphTable)) {
    // The old tool badge drew a filled ring.
    assert.doesNotMatch(inner, /M13 8h7/)
    assert.doesNotMatch(inner, /M13 17h6/)
  }
  assert.doesNotMatch(css, /\.hx-tool-icon \{[^}]*background: var\(--chat-bg\)/)
})
test('a failed tool call folds away like a finished one', () => {
  // A failure used to keep its row open so the error was visible, which meant one broken command
  // pushed the rest of the turn off screen. \"failed\" is already in the summary, in the error
  // colour, and the output is one click away — the same deal a successful call gets.
  const source = readFileSync(new URL('../public/harness.js', import.meta.url), 'utf8')
  assert.match(
    source,
    /const open =\s*body && \(item\.open \|\| item\.status === 'running' \|\| item\.status === 'preparing'\)/,
  )
  assert.doesNotMatch(source, /item\.status !== 'ok' && !isEdit/)
  // The failure still reads as one: the state label and its colour are untouched.
  assert.match(source, /if \(item\.status === 'error'\) return 'failed'/)
})
