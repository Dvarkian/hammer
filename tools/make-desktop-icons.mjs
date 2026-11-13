#!/usr/bin/env node
/**
 * @file make-desktop-icons.mjs
 * @description Rasterises Hammer's mark into the PNGs Electron and the desktop environment need.
 *
 * The mark is a claw hammer in profile: a straight handle behind a head that is a single forged
 * piece — blunt striking face, mass at the eye, and a claw that hooks down with an open throat.
 * The claw is what makes it a hammer instead of a mallet, so it is drawn with curves rather than
 * straight segments; faceted prongs read as a beak at icon size.
 *
 * Two tones, no gradient, no gloss, no bevel. A silhouette is also the only thing that survives a
 * 16px tray, so the drawing is deliberately simple at its core.
 *
 * The same path data is written to public/favicon.svg and printed for the in-app glyphs, so the
 * favicon, the header, the empty state and the packaged icon cannot drift apart.
 *
 * Two finishes come out of the one drawing: the tile (maroon ground, cream head) for the app icon,
 * favicon, splash and empty state, and the bare mark with a transparent ground for the status tray
 * and the app bar, where a tile reads as a sticker.
 *
 * Run: node tools/make-desktop-icons.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'desktop', 'assets')
const PUBLIC_DIR = join(ROOT, 'public')
const SUPERSAMPLE = 4

// Maroon ground, cream head, bone handle: the tile is the brand colour, and the two tones stay
// separable all the way down to the 16px tray.
const GROUND = [0x7d, 0x22, 0x31]
const HEAD_TONE = [0xf6, 0xec, 0xe5]
const HANDLE_TONE = [0xd9, 0xc3, 0xbb]

// ── The mark ───────────────────────────────────────────────────────────────────────────────
// Authored upright in a 32×32 box, then scaled to sit inside the ground and tilted once. The
// transform is applied at read time so the SVG and the rasteriser agree exactly.

const TILT_DEGREES = -32
const CENTER = 16
/** The drawing is asymmetric, so centring it by eye is how it went lopsided. Both the scale and
 *  the offset below are measured from the rendered silhouette instead. */
const round = (value) => Math.round(value * 100) / 100
const TARGET_SIZE = 23.2
let SCALE = 0.88
let OFFSET = [0, 0]
/**
 * The turn the rasteriser applies, written in SVG's own order.
 *
 * The rasteriser reads every pixel back through `toMark`, which rotates screen space by
 * `-TILT_DEGREES`; the model-to-screen turn is therefore the opposite one, `+TILT_DEGREES`, and
 * this asks for it explicitly. Asking for `TILT_DEGREES` tilted the SVG the other way: the
 * favicon, the header, the empty state and the splash leaned one way while the icon in the
 * taskbar leaned the other, and no test could see it because every in-app copy agreed with every
 * other and none of them was ever compared with the raster.
 */
const markTransform = () =>
  `translate(${round(OFFSET[0])} ${round(OFFSET[1])}) rotate(${round(-TILT_DEGREES)} ${CENTER} ${CENTER}) translate(${CENTER} ${CENTER}) scale(${round(SCALE)}) translate(${-CENTER} ${-CENTER})`

/**
 * The head in profile, taken from the profile the user supplied (`gemini-svg.svg`, a 128-box
 * drawing) rather than drawn by hand.
 *
 * The supplied drawing faces left with its claw to the right; this is that outline flipped
 * horizontally and scaled so the collar (16 units wide in the source) matches the handle.
 * Everything is baked into the numbers below, so the rasteriser sees one flat silhouette and the
 * SVG copies stay one path. Its gradients, strokes and cheek facet are dropped: the mark is two
 * flat tones, and a shading pass on a 16px tray is only noise.
 *
 * It is not turned about the collar. It was, by 26°, and that rotated the collar's flat seat out
 * from under the handle's top edge: the seat and the shaft met at a wedge, so the head read as
 * cocked on the shaft instead of seated on it. The seat is horizontal here, so it lies along the
 * handle's top edge exactly; the mark's own -32° turn still tilts the whole hammer.
 *
 * The mouth of the claw is left open toward the handle, so the gap reads at every size.
 */
const HEAD = [
  ['M', 21.76, 2.91],
  ['L', 19.86, 2.91],
  ['C', 19, 2.91, 18.49, 3.6, 17.63, 3.6],
  ['C', 16.6, 3.6, 16.08, 2.91, 15.05, 2.91],
  ['L', 11.95, 2.91],
  ['C', 8.17, 2.91, 5.42, 4.63, 3.18, 8.07],
  ['C', 5.93, 5.83, 8.34, 6, 11.09, 6.69],
  ['C', 11.78, 6.86, 11.95, 7.72, 12.12, 9.1],
  ['L', 14.88, 9.1],
  ['C', 15.05, 7.72, 15.22, 6.86, 16.08, 6.52],
  ['C', 16.77, 6.18, 17.11, 6, 17.63, 6],
  ['C', 18.49, 6, 19, 6.69, 19.86, 6.69],
  ['L', 21.76, 6.69],
  ['L', 22.27, 6.18],
  ['L', 22.27, 3.42],
  ['Z'],
]

const HANDLE_PATH = [
  ['M', 12.55, 8.4],
  ['L', 14.45, 8.4],
  ['C', 14.6, 9.6, 14.72, 10.6, 14.72, 12.2],
  ['C', 14.72, 14.5, 14.5, 17.5, 14.55, 19.4],
  ['C', 14.6, 21.2, 14.85, 22.6, 14.86, 23.4],
  ['C', 14.88, 24.6, 14.4, 25.1, 13.5, 25.1],
  ['C', 12.6, 25.1, 12.12, 24.6, 12.14, 23.4],
  ['C', 12.15, 22.6, 12.4, 21.2, 12.45, 19.4],
  ['C', 12.5, 17.5, 12.28, 14.5, 12.28, 12.2],
  ['C', 12.28, 10.6, 12.4, 9.6, 12.55, 8.4],
  ['Z'],
]

/** Flattens the path into a polygon so it can go through the same ray-casting fill as anything
 *  else. Curves are sampled finely enough that the 512px icon shows no facets. */
function flatten(commands, steps = 16) {
  const points = []
  let current = [0, 0]
  let start = [0, 0]

  const quad = (c, p, t) => [
    (1 - t) * (1 - t) * current[0] + 2 * (1 - t) * t * c[0] + t * t * p[0],
    (1 - t) * (1 - t) * current[1] + 2 * (1 - t) * t * c[1] + t * t * p[1],
  ]
  const cubic = (c1, c2, p, t) => {
    const u = 1 - t
    return [
      u * u * u * current[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p[0],
      u * u * u * current[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p[1],
    ]
  }

  for (const [code, ...values] of commands) {
    if (code === 'M') {
      current = [values[0], values[1]]
      start = current
      points.push(current)
    } else if (code === 'L') {
      current = [values[0], values[1]]
      points.push(current)
    } else if (code === 'Q') {
      const control = [values[0], values[1]]
      const end = [values[2], values[3]]
      for (let i = 1; i <= steps; i += 1) points.push(quad(control, end, i / steps))
      current = end
    } else if (code === 'C') {
      const c1 = [values[0], values[1]]
      const c2 = [values[2], values[3]]
      const end = [values[4], values[5]]
      for (let i = 1; i <= steps; i += 1) points.push(cubic(c1, c2, end, i / steps))
      current = end
    } else if (code === 'Z') {
      points.push(start)
    }
  }

  return points
}

const HEAD_POLY = flatten(HEAD)
const HANDLE_POLY = flatten(HANDLE_PATH)

function inRoundRect(x, y, rect) {
  const { x: x0, y: y0, w, h, radius } = rect
  if (x < x0 || y < y0 || x > x0 + w || y > y0 + h) return false
  const dx = Math.max(x0 + radius - x, 0, x - (x0 + w - radius))
  const dy = Math.max(y0 + radius - y, 0, y - (y0 + h - radius))
  return dx * dx + dy * dy <= radius * radius
}

/** Ray casting, so a silhouette can be concave — the throat needs it. */
/** Bounding box of the drawn silhouette, in 32-space. */
function measureMark() {
  const samples = 192
  const step = 32 / samples
  let minX = 32
  let minY = 32
  let maxX = 0
  let maxY = 0
  let sumX = 0
  let sumY = 0
  let count = 0
  for (let j = 0; j < samples; j += 1) {
    for (let i = 0; i < samples; i += 1) {
      const x = (i + 0.5) * step
      const y = (j + 0.5) * step
      const [u, v] = toMark(x, y)
      if (!inPolygon(u, v, HEAD_POLY) && !inPolygon(u, v, HANDLE_POLY)) continue
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
      sumX += x
      sumY += y
      count += 1
    }
  }
  return { minX, minY, maxX, maxY, centroid: [sumX / count, sumY / count] }
}

function inPolygon(x, y, points) {
  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const a = points[i]
    const b = points[j]
    const straddles = a[1] > y !== b[1] > y
    if (straddles && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside
  }
  return inside
}

/** Screen space → the upright, unit-scale space the path is authored in. */
function toMark(x, y) {
  const radians = (-TILT_DEGREES * Math.PI) / 180
  const dx = x - OFFSET[0] - CENTER
  const dy = y - OFFSET[1] - CENTER
  const cos = Math.cos(-radians)
  const sin = Math.sin(-radians)
  const rx = CENTER + dx * cos - dy * sin
  const ry = CENTER + dx * sin + dy * cos
  return [CENTER + (rx - CENTER) / SCALE, CENTER + (ry - CENTER) / SCALE]
}

/** Samples one point in 32-space and returns straight (non-premultiplied) RGBA, alpha 0..1. */
function sample(x, y, withGround = true) {
  let r = 0
  let g = 0
  let b = 0
  let a = 0

  const over = (color, alpha) => {
    if (alpha <= 0) return
    const [cr, cg, cb] = color
    const outA = alpha + a * (1 - alpha)
    if (outA <= 0) return
    r = (cr * alpha + r * a * (1 - alpha)) / outA
    g = (cg * alpha + g * a * (1 - alpha)) / outA
    b = (cb * alpha + b * a * (1 - alpha)) / outA
    a = outA
  }

  if (withGround && inRoundRect(x, y, { x: 0, y: 0, w: 32, h: 32, radius: 6 })) over(GROUND, 1)

  const [u, v] = toMark(x, y)
  if (inPolygon(u, v, HANDLE_POLY)) over(HANDLE_TONE, 1)
  // The head goes on last: its cream underside is the joint, which is crisper than any drawn seam.
  if (inPolygon(u, v, HEAD_POLY)) over(HEAD_TONE, 1)

  return [r, g, b, a]
}

/**
 * Fit the drawing to `target` units across, then put its optical centre on the icon's centre.
 *
 * A hammer is heavy at the head and thin down the handle, so the box centre is not where it looks
 * balanced: this aims between the box centre and the area centroid, weighted toward the centroid.
 * Runs at two targets — the tile icons, and the transparent tray mark, which has no tile padding
 * to sit inside and so is fitted wider.
 */
function fitMark(target, boxWeight = 0.7) {
  // reset both, so the fit depends only on the target and the drawing — measuring is done by
  // sampling screen space through the current transform, so a stale offset would bias it
  SCALE = 0.88
  OFFSET = [0, 0]
  for (let pass = 0; pass < 2; pass += 1) {
    const box = measureMark()
    SCALE *= target / Math.max(box.maxX - box.minX, box.maxY - box.minY)
  }
  const fitted = measureMark()
  const boxCentre = [(fitted.minX + fitted.maxX) / 2, (fitted.minY + fitted.maxY) / 2]
  const optical = [
    fitted.centroid[0] * (1 - boxWeight) + boxCentre[0] * boxWeight,
    fitted.centroid[1] * (1 - boxWeight) + boxCentre[1] * boxWeight,
  ]
  OFFSET = [CENTER - optical[0], CENTER - optical[1]]
  return measureMark()
}

/**
 * The transparent mark's fit, measured from the flattened outline rather than by sampling.
 *
 * `fitMark` reads its box back through the screen grid, so it is accurate to a sample — good
 * enough inside a tile with its margin, but the bare mark is fitted nearly to the edges, and there
 * a sample of slack put the claw against the top row and the panel cut it. This projects every
 * outline point directly, so the box is the drawing's own, and centres it on that.
 */
function exactFit(target) {
  const radians = (-TILT_DEGREES * Math.PI) / 180
  const project = (point, scale, offset) => {
    const x = (point[0] - CENTER) * scale
    const y = (point[1] - CENTER) * scale
    return [
      CENTER + x * Math.cos(radians) - y * Math.sin(radians) + offset[0],
      CENTER + x * Math.sin(radians) + y * Math.cos(radians) + offset[1],
    ]
  }
  const box = (scale, offset) => {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const point of [...HEAD_POLY, ...HANDLE_POLY]) {
      const [x, y] = project(point, scale, offset)
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
    return { minX, minY, maxX, maxY }
  }
  let scale = 1
  for (let pass = 0; pass < 3; pass += 1) {
    const measured = box(scale, [0, 0])
    scale *= target / Math.max(measured.maxX - measured.minX, measured.maxY - measured.minY)
  }
  const measured = box(scale, [0, 0])
  SCALE = scale
  OFFSET = [
    CENTER - (measured.minX + measured.maxX) / 2,
    CENTER - (measured.minY + measured.maxY) / 2,
  ]
  return box(scale, OFFSET)
}

/**
 * The mark on its own, fitted wider: the tray has no tile, so the drawing may use the margin.
 * Centred on its bounding box rather than on its visual mass, and fitted to 26 of the 32 units
 * rather than nearly all of them: a status bar sizes a tray icon by height, so a mark that fills
 * the canvas loses its top row to the panel's own crop.
 */
const TRAY_TARGET = 26

const finalBox = fitMark(TARGET_SIZE)
console.log(
  `fit: box ${round(finalBox.minX)}→${round(finalBox.maxX)} × ${round(finalBox.minY)}→${round(finalBox.maxY)}` +
    `, margins L${round(finalBox.minX)} R${round(32 - finalBox.maxX)}` +
    ` T${round(finalBox.minY)} B${round(32 - finalBox.maxY)}`,
)

function render(size, withGround = true) {
  const pixels = Buffer.alloc(size * size * 4)
  const step = 32 / size
  const samples = SUPERSAMPLE * SUPERSAMPLE

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const [sr, sg, sb, sa] = sample(
            (px + (sx + 0.5) / SUPERSAMPLE) * step,
            (py + (sy + 0.5) / SUPERSAMPLE) * step,
            withGround,
          )
          r += sr * sa
          g += sg * sa
          b += sb * sa
          a += sa
        }
      }
      const offset = (py * size + px) * 4
      const alpha = a / samples
      pixels[offset] = alpha > 0 ? Math.round(r / a) : 0
      pixels[offset + 1] = alpha > 0 ? Math.round(g / a) : 0
      pixels[offset + 2] = alpha > 0 ? Math.round(b / a) : 0
      pixels[offset + 3] = Math.round(alpha * 255)
    }
  }
  return pixels
}

// ── PNG encoding ───────────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

function encodePng(size, rgba) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // colour type: RGBA
  header[10] = 0
  header[11] = 0
  header[12] = 0

  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0 // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ── Output ─────────────────────────────────────────────────────────────────────────────────

const toPathData = (commands) =>
  commands
    .map(([code, ...values]) => {
      if (code === 'Z') return 'Z'
      const numbers = values.map(round)
      if (code === 'Q') return `Q${numbers[0]} ${numbers[1]} ${numbers[2]} ${numbers[3]}`
      if (code === 'C')
        return `C${numbers[0]} ${numbers[1]} ${numbers[2]} ${numbers[3]} ${numbers[4]} ${numbers[5]}`
      return `${code}${numbers[0]} ${numbers[1]}`
    })
    .join('')

const HEAD_D = toPathData(HEAD)
const HANDLE_D = toPathData(HANDLE_PATH)
const hex = (color) => `#${color.map((c) => c.toString(16).padStart(2, '0')).join('')}`

mkdirSync(OUT_DIR, { recursive: true })
// A ladder, not two files: the panel asks for 22 or 24 depending on its size, and handing it a 32
// makes it resample something that was never drawn at that size.
for (const size of [512, 256, 128, 64, 48, 32, 24, 22, 16]) {
  const path = join(OUT_DIR, `icon-${size}.png`)
  writeFileSync(path, encodePng(size, render(size)))
  console.log(`wrote ${path} (${size}×${size})`)
}
writeFileSync(join(OUT_DIR, 'icon.png'), encodePng(512, render(512)))
console.log(`wrote ${join(OUT_DIR, 'icon.png')} (512×512)`)
// The tray and the app bar want the hammer without the maroon tile: a tile is a 32px-icon device,
// and in a panel or beside a wordmark it reads as a sticker. Transparent, fitted wider.
const trayBox = exactFit(TRAY_TARGET)
console.log(
  `tray fit: box ${round(trayBox.minX)}→${round(trayBox.maxX)} × ${round(trayBox.minY)}→${round(trayBox.maxY)}`,
)
writeFileSync(join(OUT_DIR, 'tray.png'), encodePng(32, render(32, false)))
console.log(`wrote ${join(OUT_DIR, 'tray.png')} (32×32, no ground)`)
fitMark(TARGET_SIZE)

writeFileSync(
  join(PUBLIC_DIR, 'favicon.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <!-- Hammer's mark: a claw hammer in profile — maroon ground, cream head, deep maroon handle.
       Generated by tools/make-desktop-icons.mjs; do not hand-edit. -->
  <rect width="32" height="32" rx="6" fill="${hex(GROUND)}"/>
  <g transform="${markTransform()}">
    <path d="${HANDLE_D}" fill="${hex(HANDLE_TONE)}"/>
    <path d="${HEAD_D}" fill="${hex(HEAD_TONE)}"/>
  </g>
</svg>
`,
)
console.log('wrote public/favicon.svg')
console.log(`\nMARK_TRANSFORM = ${markTransform()}`)
console.log(`\nHEAD_D = ${HEAD_D}`)
console.log(`\nHANDLE_D = ${HANDLE_D}`)
