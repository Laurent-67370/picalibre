/**
 * Parité tilt-shift : ancienne implémentation JS (référence, recopiée ici
 * à l'identique) vs nouveau chemin natif (masque SVG + composite), sur
 * une image de test à fort contraste, dans les deux modes.
 * Tolérance : écart moyen < 1,0 et écart max ≤ 8 sur 255 (arrondis
 * librsvg + composition alpha prémultipliée vs mix entier direct).
 */
import sharp from 'sharp'
import { buildTiltShiftMaskSvg } from '../src/main/services/render-sharp'

const W = 640
const H = 480

async function makeTestImage(): Promise<Buffer> {
  // damier + dégradés : sensible au flou et au moindre décalage de masque
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs><pattern id="p" width="16" height="16" patternUnits="userSpaceOnUse">
      <rect width="16" height="16" fill="#d33"/><rect width="8" height="8" fill="#3d3"/>
      <rect x="8" y="8" width="8" height="8" fill="#33d"/></pattern></defs>
    <rect width="${W}" height="${H}" fill="url(#p)"/>
    <circle cx="${W / 2}" cy="${H / 2}" r="90" fill="#ff0"/></svg>`
  return sharp(Buffer.from(svg)).png().toBuffer()
}

interface Params {
  mode: 'radial' | 'linear'
  focusX: number
  focusY: number
  focusRadius: number
  blurRadius: number
}

async function referenceJs(png: Buffer, p: Params): Promise<Buffer> {
  const orig = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const blur = await sharp(png).removeAlpha().blur(p.blurRadius).raw().toBuffer({ resolveWithObject: true })
  const od = Buffer.from(orig.data)
  const bd = blur.data
  const ch = orig.info.channels
  const rPx = p.focusRadius * W
  const cx = p.focusX * W
  const cy = p.focusY * H
  const transition = rPx * 0.5
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dist = p.mode === 'radial' ? Math.hypot(x - cx, y - cy) : Math.abs(y - cy)
      let t: number
      if (dist <= rPx) t = 0
      else if (dist >= rPx + transition) t = 1
      else t = (dist - rPx) / transition
      const i = (y * W + x) * ch
      for (let c = 0; c < 3; c++) od[i + c] = Math.round(od[i + c] * (1 - t) + bd[i + c] * t)
    }
  }
  return od
}

async function nativeImpl(png: Buffer, p: Params): Promise<Buffer> {
  const orig = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const blur = await sharp(png).removeAlpha().blur(p.blurRadius).raw().toBuffer({ resolveWithObject: true })
  const rPx = p.focusRadius * W
  const cx = p.focusX * W
  const cy = p.focusY * H
  const transition = rPx * 0.5
  const maskSvg = buildTiltShiftMaskSvg(p.mode, W, H, cx, cy, rPx, transition)
  const mask = await sharp(Buffer.from(maskSvg)).ensureAlpha().extractChannel(0).raw().toBuffer()
  const blurRgba = await sharp(blur.data, { raw: { width: W, height: H, channels: 3 } })
    .joinChannel(mask, { raw: { width: W, height: H, channels: 1 } })
    .raw()
    .toBuffer()
  return sharp(orig.data, { raw: { width: W, height: H, channels: 3 } })
    .composite([{ input: blurRgba, raw: { width: W, height: H, channels: 4 }, blend: 'over' }])
    .removeAlpha()
    .raw()
    .toBuffer()
}

function compare(a: Buffer, b: Buffer): { mean: number; max: number } {
  let sum = 0
  let max = 0
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i])
    sum += d
    if (d > max) max = d
  }
  return { mean: sum / a.length, max }
}

async function main(): Promise<void> {
  const png = await makeTestImage()
  const cases: Params[] = [
    { mode: 'radial', focusX: 0.5, focusY: 0.5, focusRadius: 0.25, blurRadius: 8 },
    { mode: 'radial', focusX: 0.2, focusY: 0.8, focusRadius: 0.4, blurRadius: 12 },
    { mode: 'linear', focusX: 0.5, focusY: 0.5, focusRadius: 0.2, blurRadius: 8 },
    { mode: 'linear', focusX: 0.5, focusY: 0.15, focusRadius: 0.35, blurRadius: 10 }
  ]
  let fail = 0
  for (const p of cases) {
    const ref = await referenceJs(png, p)
    const nat = await nativeImpl(png, p)
    const { mean, max } = compare(ref, nat)
    const ok = mean < 1.0 && max <= 8
    console.log(
      `[tiltshift-parity] ${p.mode} focus(${p.focusX},${p.focusY}) r=${p.focusRadius} blur=${p.blurRadius} → écart moyen ${mean.toFixed(3)}, max ${max} — ${ok ? 'OK' : 'ÉCHEC'}`
    )
    if (!ok) fail++
  }
  console.log(fail === 0 ? '[tiltshift-parity] 4/4 CONFORMES' : `[tiltshift-parity] ${fail} ÉCHEC(S)`)
  process.exit(fail === 0 ? 0 : 1)
}

void main()
