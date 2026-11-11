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
const { renderText, highlightCode, languageForCommand } = new Function(
  `const MAX_TEXT = 120000;\n${harness.slice(start, end)}; return { renderText, highlightCode, languageForCommand }`,
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
  // The language is an attribute now, and the body is coloured by it.
  assert.match(html, /<pre class="hx-code" data-lang="js">/)
  assert.match(html, /<span class="hx-hl-key">const<\/span> x = <span class="hx-hl-num">1<\/span>/)
  assert.doesNotMatch(html, /js\nconst/)
})

test('a fence colours what it can, and a language it does not know stays plain', () => {
  const css = renderText('```css\n/* note */\n.card { color: red; }\n```')
  assert.match(css, /<span class="hx-hl-com">\/\* note \*\/<\/span>/)
  assert.match(css, /<span class="hx-hl-prop">color<\/span>/)

  const html = renderText('```html\n<a href="/x">hi</a>\n```')
  assert.match(html, /<span class="hx-hl-tag">&lt;a<\/span>/)
  assert.match(html, /<span class="hx-hl-attr">href<\/span>/)

  const python = renderText('```py\ndef go(x):\n    return x  # done\n```')
  assert.match(python, /<span class="hx-hl-key">def<\/span>/)
  assert.match(python, /<span class="hx-hl-com"># done<\/span>/)

  const json = renderText('```json\n{"name": true}\n```')
  assert.match(json, /<span class="hx-hl-prop">&quot;name&quot;<\/span>/)

  // No info string means no language: the block is escaped and left as it was written.
  assert.equal(
    renderText('```\nno language here\n```'),
    '<pre class="hx-code">no language here</pre>',
  )
})

test('code inside a fence is escaped, never markup', () => {
  const html = renderText('```html\n<script>alert(1)</script>\n```')
  assert.doesNotMatch(html, /<script/)
  assert.match(html, /&lt;script/)
  assert.match(html, /&lt;\/script/)
})

test('a run block is coloured by the code it runs', () => {
  // The reported case: a Python script handed to the interpreter through a heredoc, which is
  // the whole of the block a reader has to follow.
  const command = [
    "python3 - <<'EOF'",
    'import json',
    'for row in rows:',
    '    print(row)  # done',
    'EOF',
  ].join('\n')
  assert.equal(languageForCommand(command), 'python')
  const html = highlightCode(command, languageForCommand(command))
  assert.match(html, /<span class="hx-hl-key">import<\/span>/)
  assert.match(html, /<span class="hx-hl-com"># done<\/span>/)
  // The interpreter line itself is still readable, escaped once.
  assert.match(html, /python3 - &lt;&lt;/)

  // The program is found through wrappers and pipelines, and not from a word that is merely
  // an argument.
  assert.equal(languageForCommand('cd /tmp && python3 build.py'), 'python')
  assert.equal(languageForCommand('sudo -E node scripts/check.js'), 'js')
  assert.equal(languageForCommand('cat file | sqlite3 db.sqlite'), 'sql')
  assert.equal(languageForCommand('bash -lc "make -j"'), 'sh')
  assert.equal(languageForCommand('grep -n python file.txt'), '')
  assert.equal(languageForCommand('ls -la'), '')

  // The card asks the command and paints it with the same highlighter.
  assert.match(harness, /highlightCode\(runCommand, runLang\)/)
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
