import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

// Below 960px the sidebars stop being grid columns and become fixed drawers, and the two
// layouts are moved by different things: a column by `hx-*-collapsed` on the body, a drawer by
// `hx-*-drawer-open`. A toggle that only ever flipped the column class looked broken on a
// narrow window, because the media query re-displays the "collapsed" column as a drawer.
test('a sidebar toggle moves the drawer the narrow layout is showing', () => {
  const harness = read('public/harness.js')
  assert.match(harness, /const DRAWER_QUERY = '\(max-width: 960px\)'/)
  assert.match(harness, /function drawerLayout\(\)/)
  // The toggle branches on the layout before it touches the stored column state.
  assert.match(harness, /if \(drawerLayout\(\)\) \{/)
  assert.match(harness, /function setDrawer\(which, open\)/)
  assert.match(harness, /function closeDrawers\(\)/)
  // One drawer at a time: they cover the same narrow screen.
  assert.match(harness, /document\.body\.classList\.remove\(other\)/)
  // The header icons and the Details chip are one control, not two.
  assert.match(harness, /toggleSidebar\('details'\)/)
  assert.match(harness, /toggleSidebar\('sessions'\)/)
  // Escape and a click outside dismiss a drawer, and a width change cannot leave one claimed.
  assert.match(harness, /if \(event\.key === 'Escape'\) closeDrawers\(\)/)
  assert.match(harness, /matchMedia\?\.\(DRAWER_QUERY\)/)
  // `aria-pressed` follows what is on screen, not the stored column preference.
  assert.match(harness, /document\.body\.classList\.contains\('hx-sessions-drawer-open'\)/)
  assert.match(harness, /document\.body\.classList\.contains\('hx-drawer-open'\)/)
  // Every dismissal goes through the helper: a click on a listed session and Escape both do.
  assert.match(
    harness,
    /const row = event\.target\.closest\('\[data-session\]'\)[\s\S]{0,120}?closeDrawers\(\)\s*openConversation/,
  )
  assert.match(harness, /closePalette\(\)\s*else closeDrawers\(\)/)
})

test('both sidebars are still drawers in the narrow layout', () => {
  const css = read('public/harness.css')
  // The last 960px block is the drawer block; the first one belongs to the header.
  const media = css.slice(css.lastIndexOf('@media (max-width: 960px)'))
  // A collapsed column must still be laid out as a drawer, or it could never be opened.
  assert.match(media, /body\.hx-sessions-collapsed \.hx-side-sessions,[\s\S]{0,80}display: flex/)
  assert.match(
    media,
    /body\.hx-drawer-open \.hx-side-details[\s\S]{0,60}transform: translateX\(0\)/,
  )
  // An open drawer covers the page, so the page behind it must not scroll.
  assert.match(
    media,
    /body\.hx-sessions-drawer-open,\s*body\.hx-drawer-open \{[\s\S]{0,60}overflow: hidden/,
  )
  const html = read('public/index.html')
  assert.match(html, /id="hx-toggle-sessions"/)
  assert.match(html, /id="hx-toggle-details"/)
  assert.match(html, /class="hx-side hx-side-sessions"/)
  assert.match(html, /class="hx-side hx-side-details"/)
})
