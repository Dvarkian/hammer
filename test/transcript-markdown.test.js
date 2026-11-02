import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// ── Markdown in the transcript ───────────────────────────────────────────────────────
//
// The harness renders the agent's Markdown — headings, tables, lists, quotes — but the
// one thing it must never do is let model output become markup. These tests evaluate the
// renderer exactly as the page runs it and pin both halves: the constructs that must
// appear, and the injection that must not.

const harness = readFileSync(new URL('../public/harness.js', import.meta.url), 'utf8')

// The renderer lives inside the page's IIFE; the slice from escapeHtml to setHint is the
// self-contained Markdown half of it (its only free variable is MAX_TEXT).
const start = harness.indexOf('function escapeHtml')
const end = harness.indexOf('function setHint')
assert.notEqual(start, -1, 'escapeHtml is present in harness.js')
assert.notEqual(end, -1, 'setHint is present in harness.js')
const { renderText } = new Function(
  `const MAX_TEXT = 120000;\n${harness.slice(start, end)}; return { renderText }`,
)()

test('a heading, a table, a list and a quote render as their elements', () => {
  const md = [
    '## Plan',
    '',
    '| Name | Count |',
    '|:-----|------:|',
    '| alpha | 1 |',
    '',
    '- one',
    '- two',
    '',
    '> a note',
    '',
    'Body text with **bold** and `code`.',
  ].join('\n')
  const html = renderText(md)

  assert.match(html, /<h2 class="hx-h2">Plan<\/h2>/)
  assert.match(html, /<div class="hx-table-wrap"><table class="hx-table">/)
  assert.match(html, /<th style="text-align:left">Name<\/th>/)
  assert.match(html, /<td style="text-align:right">1<\/td>/)
  assert.match(html, /<ul class="hx-list"><li>one<\/li><li>two<\/li><\/ul>/)
  assert.match(html, /<blockquote class="hx-quote">/)
  assert.match(html, /<strong>bold<\/strong>/)
  assert.match(html, /<code class="hx-inline-code">code<\/code>/)
})

test('a fenced block shows the code, not its language tag', () => {
  const html = renderText('```js\nconst x = 1\n```')
  assert.match(html, /<pre class="hx-code">const x = 1<\/pre>/)
  assert.doesNotMatch(html, /js\\nconst/)
})

test('model output never becomes markup on the page', () => {
  const html = renderText('<script>alert(1)</script> and [x](javascript:alert(1))')
  assert.doesNotMatch(html, /<script/)
  // The tag is visible as escaped text instead — escaped exactly once, not doubled.
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  // A non-http link scheme is refused: the markdown stays literal text.
  assert.doesNotMatch(html, /href="javascript:/)
  assert.match(html, /\[x\]\(javascript:alert\(1\)\)/)
})

test('entities and a bare greater-than in prose are escaped once', () => {
  assert.match(renderText('a & b'), /a &amp; b/)
  assert.match(renderText('5 > 4'), /5 &gt; 4/)
})
