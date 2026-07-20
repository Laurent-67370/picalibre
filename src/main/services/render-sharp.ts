/**
 * Moteur d'EXPORT (pleine résolution) — sharp/libvips.
 *
 * Pipeline en 2 passes déterministes :
 *   1. Orientation EXIF + redressement (straighten) → buffer intermédiaire
 *   2. Crop en pixels (calculé sur les dimensions post-rotation) → pixels bruts
 *      → applyColorOps (MÊME math que la preview) → encodage final
 *
 * Module pur (pas d'import electron) → testable en Node directement.
 */
import sharp from 'sharp'
import {
  EditStack,
  applyColorOps,
  applySpatialOps,
  cropRectPx,
  straightenAngle,
  getBlurRadius,
  getSharpenAmount,
  getSoftFocusIntensity,
  getGlowIntensity,
  getOrtonIntensity,
  getTiltShiftParams,
  getHdrIntensity,
  getDefinitionAmount,
  getTextOp,
  getBorderOp,
  escapeSvgText,
  hexToSvgFill,
  TiltShiftParams
} from '../../shared/edit-engine'
import { resolveHeicInput } from '../../shared/heic'

/**
 * Construit le masque SVG du tilt-shift (0 = net, 255 = flou), reproduisant
 * EXACTEMENT t = clamp((dist - rPx) / transition, 0, 1) :
 * - radial : radialGradient en userSpaceOnUse (distance euclidienne, comme
 *   Math.hypot) de rayon rPx+transition, stop noir a rPx/(rPx+transition),
 *   blanc a 1 - interpolation lineaire entre les deux, pad blanc au-dela.
 * - linear : linearGradient vertical a 4 stops (blanc/noir/noir/blanc aux
 *   positions cy-/+(rPx+transition) et cy-/+rPx). Les positions hors image
 *   sont clampees en recalculant la VALEUR exacte de t a y=0 et y=H -
 *   un simple clamp d'offset denaturerait la pente aux bords.
 * Exportee pour le test de parite avec l'ancienne implementation JS.
 */
export function buildTiltShiftMaskSvg(
  mode: 'radial' | 'linear',
  W: number,
  H: number,
  cx: number,
  cy: number,
  rPx: number,
  transition: number
): string {
  const grey = (t: number): string => {
    const v = Math.round(Math.max(0, Math.min(1, t)) * 255)
    return `rgb(${v},${v},${v})`
  }
  if (mode === 'radial') {
    const R = rPx + transition
    const inner = R > 0 ? rPx / R : 0
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><radialGradient id="g" gradientUnits="userSpaceOnUse" cx="${cx}" cy="${cy}" r="${R}"><stop offset="${inner}" stop-color="black"/><stop offset="1" stop-color="white"/></radialGradient></defs><rect width="${W}" height="${H}" fill="url(#g)"/></svg>`
  }
  const tAt = (y: number): number => {
    const dist = Math.abs(y - cy)
    if (dist <= rPx) return 0
    if (dist >= rPx + transition) return 1
    return (dist - rPx) / transition
  }
  const raw: Array<{ y: number; t: number }> = [
    { y: cy - rPx - transition, t: 1 },
    { y: cy - rPx, t: 0 },
    { y: cy + rPx, t: 0 },
    { y: cy + rPx + transition, t: 1 }
  ]
  const stops: Array<{ off: number; t: number }> = [{ off: 0, t: tAt(0) }]
  for (const s of raw) {
    if (s.y > 0 && s.y < H) stops.push({ off: s.y / H, t: s.t })
  }
  stops.push({ off: 1, t: tAt(H) })
  const stopsXml = stops
    .map((s) => `<stop offset="${s.off}" stop-color="${grey(s.t)}"/>`)
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="${H}">${stopsXml}</linearGradient></defs><rect width="${W}" height="${H}" fill="url(#g)"/></svg>`
}

export interface ExportOptions {
  format?: 'jpeg' | 'webp' | 'png'
  quality?: number
  maxSize?: number // redimensionnement final optionnel (bord le plus long)
  watermark?: string // texte incrusté en bas à droite
}

export async function renderEdited(
  filepath: string,
  stack: EditStack,
  opts: ExportOptions = {}
): Promise<Buffer> {
  const { format = 'jpeg', quality = 92, maxSize, watermark } = opts
  const input = await resolveHeicInput(filepath)

  // Passe 1 : orientation EXIF + redressement
  let pass1 = sharp(input, { failOn: 'none' }).rotate()
  const angle = straightenAngle(stack)
  if (angle !== 0) {
    pass1 = pass1.rotate(angle, { background: { r: 0, g: 0, b: 0 } })
  }
  const rotated = await pass1.toBuffer()

  // Passe 2 : crop (px calculés post-rotation) puis pixels bruts
  let pass2 = sharp(rotated)
  const meta = await pass2.metadata()
  const rect = cropRectPx(stack, meta.width ?? 0, meta.height ?? 0)
  if (rect) pass2 = pass2.extract(rect)

  // Flou spatial (opération spatiale, appliquée AVANT les colorOps)
  const blurRadius = getBlurRadius(stack)
  if (blurRadius > 0) {
    pass2 = pass2.blur(blurRadius)
  }

  // Netteté (unsharp mask) : image + amount * (image - blur(image))
  const sharpenAmount = getSharpenAmount(stack)
  if (sharpenAmount > 0) {
    pass2 = pass2.sharpen({ sigma: 1.0, m1: sharpenAmount * 500, m2: sharpenAmount * 500 })
  }

  // Doucette/softfocus : blend(image, blur(image), intensity) —
  // mélange l'original avec une version floutée, opacité = intensity.
  // Implémentation native sharp : on génère un calque flouté avec un canal
  // alpha uniforme = intensity, puis composite en blend 'over'. libvips
  // effectue le mélange (base*(1-t) + layer*t) sans materialiser le buffer
  // raw en JS (24 MP × 3 canaux = 72 Mo évités, pipeline libvips natif).
  const softFocusIntensity = getSoftFocusIntensity(stack)
  if (softFocusIntensity > 0) {
    const base = await pass2.png().toBuffer()
    const blurred = await pass2
      .clone()
      .blur(6)
      .ensureAlpha(softFocusIntensity)
      .png()
      .toBuffer()
    pass2 = sharp(base).composite([{ input: blurred, blend: 'over' }])
  }

  // Glow : image + blur(bright_parts) — floute une version surexposée,
  // puis composite en mode screen pour créer un halo lumineux.
  // composite (blend 'screen' + alpha du calque = t) produit :
  //   screen = 255 - (255-base)*(255-layer)/255
  //   result  = base*(1-t) + screen*t   ← identique au JS précédent.
  const glowIntensity = getGlowIntensity(stack)
  if (glowIntensity > 0) {
    const base = await pass2.png().toBuffer()
    const glow = await pass2
      .clone()
      .modulate({ brightness: 1.3 })
      .blur(10)
      .ensureAlpha(glowIntensity)
      .png()
      .toBuffer()
    pass2 = sharp(base).composite([{ input: glow, blend: 'screen' }])
  }

  // Orton : blend(overexposed, blur(large), 0.5) —
  // sur-expose l'image, floute largement, puis blend à 50% avec l'original.
  // composite (blend 'over' + alpha du calque = t*0.5) =
  //   base*(1-t*0.5) + layer*(t*0.5).
  const ortonIntensity = getOrtonIntensity(stack)
  if (ortonIntensity > 0) {
    const base = await pass2.png().toBuffer()
    const orton = await pass2
      .clone()
      .modulate({ brightness: 1.4 })
      .blur(15)
      .ensureAlpha(ortonIntensity * 0.5)
      .png()
      .toBuffer()
    pass2 = sharp(base).composite([{ input: orton, blend: 'over' }])
  }

  // Tilt-shift : flou gaussien sur toute l'image, puis blend avec l'originale
  // selon un masque de distance (net au centre, flou sur les bords).
  // Mode radial : cercle net centré sur (focusX, focusY) avec rayon focusRadius.
  // Mode linear : bande nette horizontale centrée sur focusY, hauteur 2×focusRadius.
  //
  // 100 % natif libvips (audit item 1-2) : l'ancien code parcourait les
  // 24 millions de pixels en JS (Math.hypot par pixel). La transition du
  // masque étant LINÉAIRE (t = clamp((dist - rPx) / transition)), un
  // dégradé SVG — qui interpole linéairement entre stops, en distance
  // euclidienne pour un radialGradient userSpaceOnUse — la reproduit
  // exactement. Le mélange orig×(1-t) + flou×t est exactement la
  // composition alpha « over » avec t pour alpha du calque flouté.
  const tiltShiftParams = getTiltShiftParams(stack)
  if (tiltShiftParams && tiltShiftParams.blurRadius > 0) {
    const tsParams: TiltShiftParams = tiltShiftParams
    const origBuf = await pass2.clone().raw().toBuffer({ resolveWithObject: true })
    const W = origBuf.info.width
    const H = origBuf.info.height
    const ch = origBuf.info.channels
    const blurBuf = await pass2
      .blur(tsParams.blurRadius)
      .raw()
      .toBuffer({ resolveWithObject: true })
    const rPx = tsParams.focusRadius * W
    const cx = tsParams.focusX * W
    const cy = tsParams.focusY * H
    const transition = rPx * 0.5

    const maskSvg = buildTiltShiftMaskSvg(tsParams.mode, W, H, cx, cy, rPx, transition)
    const mask = await sharp(Buffer.from(maskSvg))
      .ensureAlpha()
      .extractChannel(0)
      .raw()
      .toBuffer()
    // Calque flouté avec le masque pour alpha, composé « over » l'originale.
    const blurRgba = await sharp(blurBuf.data, { raw: { width: W, height: H, channels: ch as 3 } })
      .joinChannel(mask, { raw: { width: W, height: H, channels: 1 } })
      .raw()
      .toBuffer()
    const outBuf = await sharp(origBuf.data, { raw: { width: W, height: H, channels: ch as 3 } })
      .composite([{ input: blurRgba, raw: { width: W, height: H, channels: 4 }, blend: 'over' }])
      .removeAlpha()
      .raw()
      .toBuffer()
    pass2 = sharp(outBuf, {
      raw: { width: W, height: H, channels: ch }
    })
  }

  // Pseudo-HDR : local tone mapping
  // Étape 1 : flou léger (radius ~5px) → image basse fréquence
  // Étape 2 : high_freq = image - blurred (détails)
  // Étape 3 : hdr = image + intensity * high_freq * 2 (boost des détails locaux)
  // Étape 4 : tone compression : hdr / (1 + hdr/255) (Reinhard)
  const hdrIntensity = getHdrIntensity(stack)
  if (hdrIntensity > 0) {
    const origBuf = await pass2.clone().raw().toBuffer({ resolveWithObject: true })
    const W = origBuf.info.width
    const H = origBuf.info.height
    const ch = origBuf.info.channels
    const blurBuf = await pass2
      .blur(5)
      .raw()
      .toBuffer({ resolveWithObject: true })
    const od = origBuf.data
    const bd = blurBuf.data
    const t = hdrIntensity

    for (let i = 0; i < od.length; i += ch) {
      for (let c = 0; c < 3; c++) {
        const px = od[i + c]
        const highFreq = px - bd[i + c] // détail local
        const hdr = px + t * highFreq * 2 // boost des détails
        // Tone mapping Reinhard : hdr / (1 + hdr/255)
        const mapped = (hdr * 255) / (255 + hdr)
        od[i + c] = Math.max(0, Math.min(255, Math.round(mapped)))
      }
    }
    pass2 = sharp(od, {
      raw: { width: W, height: H, channels: ch }
    })
  }

  // Définition/Clarté : contraste local sur une zone BEAUCOUP plus large
  // que la netteté (rayon 30px vs ~1px) — accentue la texture/structure
  // générale de l'image sans les halos fins du sharpen. Contrairement au
  // pseudo-HDR, pas de compression de dynamique (Reinhard) : accentuation
  // directe, plus proche du curseur « Clarté » de Lightroom.
  const definitionAmount = getDefinitionAmount(stack)
  if (definitionAmount > 0) {
    const origBuf2 = await pass2.clone().raw().toBuffer({ resolveWithObject: true })
    const W2 = origBuf2.info.width
    const H2 = origBuf2.info.height
    const ch2 = origBuf2.info.channels
    const blurBuf2 = await pass2
      .blur(30)
      .raw()
      .toBuffer({ resolveWithObject: true })
    const od2 = origBuf2.data
    const bd2 = blurBuf2.data
    const t2 = definitionAmount
    for (let i = 0; i < od2.length; i += ch2) {
      for (let c = 0; c < 3; c++) {
        const px = od2[i + c]
        const highFreq = px - bd2[i + c] // structure locale (basse fréquence retirée)
        od2[i + c] = Math.max(0, Math.min(255, Math.round(px + t2 * highFreq * 1.5)))
      }
    }
    pass2 = sharp(od2, {
      raw: { width: W2, height: H2, channels: ch2 }
    })
  }

  const { data, info } = await pass2
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  // Math partagée avec la preview : spatial (tampon, yeux rouges) puis couleur
  applySpatialOps(data, info.width, info.height, 3, stack.ops)
  applyColorOps(data, 3, stack.ops, info.width)

  // Encodage final
  let out = sharp(data, {
    raw: { width: info.width, height: info.height, channels: 3 }
  })
  if (maxSize) {
    out = out.resize(maxSize, maxSize, { fit: 'inside', withoutEnlargement: true })
  }

  // Texte sur photo : composé APRÈS le redimensionnement pour garantir
  // que le fontSize relatif (ratio de la largeur) est identique en preview et en export.
  // Parité preview/export : même paramètres, même position normalisée, même font.
  const textOp = getTextOp(stack)
  if (textOp && textOp.params.content.trim() !== '') {
    const inter = await out.png().toBuffer()
    const m = await sharp(inter).metadata()
    const W = m.width ?? 100
    const H = m.height ?? 100
    const p = textOp.params
    const fontSizePx = Math.round(p.fontSize * W)
    const px = p.x * W
    const py = p.y * H
    const fillAttrs = hexToSvgFill(p.color, p.opacity)
    const escaped = escapeSvgText(p.content)

    // Ombre portée : filtre SVG blur
    let shadowDef = ''
    let shadowStyle = ''
    if (p.shadow) {
      const blurPx = Math.round(p.shadowBlur * W)
      const shadowFill = hexToSvgFill(p.shadowColor, p.opacity)
      shadowDef = `<filter id="textShadow" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur in="SourceAlpha" stdDeviation="${blurPx}"/>
        <feOffset dx="0" dy="0" result="offsetblur"/>
        <feFlood flood-color="${shadowFill.fill}" flood-opacity="${shadowFill.opacity}"/>
        <feComposite in2="offsetblur" operator="in"/>
        <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>`
      shadowStyle = ' filter="url(#textShadow)"'
    }

    const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      <defs>${shadowDef}</defs>
      <text x="${px}" y="${py}"
        text-anchor="middle" dominant-baseline="middle"
        font-family="${p.fontFamily}" font-size="${fontSizePx}"
        font-weight="${p.fontWeight}"
        fill="${fillAttrs.fill}" fill-opacity="${fillAttrs.opacity}"${shadowStyle}>${escaped}</text></svg>`
    const composited = await sharp(inter)
      .composite([{ input: Buffer.from(svg) }])
      .removeAlpha()
      .png()
      .toBuffer()
    out = sharp(composited)
  }

  // Filigrane : composé APRÈS le redimensionnement, taille relative à l'image
  if (watermark) {
    const inter = await out.png().toBuffer()
    const m = await sharp(inter).metadata()
    const W = m.width ?? 100
    const H = m.height ?? 100
    const fontSize = Math.max(12, Math.round(W / 28))
    const escaped = watermark.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      <text x="${W - Math.round(fontSize * 0.6)}" y="${H - Math.round(fontSize * 0.6)}"
        text-anchor="end" font-family="DejaVu Sans, sans-serif" font-size="${fontSize}"
        fill="#ffffff" fill-opacity="0.85" stroke="#000000" stroke-opacity="0.35"
        stroke-width="1">${escaped}</text></svg>`
    const composited = await sharp(inter)
      .composite([{ input: Buffer.from(svg) }])
      .removeAlpha() // le SVG introduit un canal alpha : on reste en RGB
      .png()
      .toBuffer()
    out = sharp(composited)
  }

  // Bordure/cadre : appliqué APRÈS le texte et le filigrane, car la bordure
  // étend l'image. Parité preview/export : même épaisseur relative, même couleur.
  const borderOp = getBorderOp(stack)
  if (borderOp && borderOp.params.thickness > 0) {
    const inter = await out.png().toBuffer()
    const m = await sharp(inter).metadata()
    const W = m.width ?? 100
    const H = m.height ?? 100
    const bw = Math.round(borderOp.params.thickness * W)
    const isMuseum = borderOp.params.style === 'museum'
    const topBw = isMuseum ? Math.round(bw * 2.5) : bw
    const sideBw = isMuseum ? Math.round(bw * 2.5) : bw
    const bottomBw =
      borderOp.params.style === 'polaroid' ? bw * 4 : isMuseum ? Math.round(bw * 2.5) : bw
    // Parser la couleur hex en { r, g, b }
    const hexMatch = /^#?([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(borderOp.params.color)
    const bg = hexMatch
      ? { r: parseInt(hexMatch[1], 16), g: parseInt(hexMatch[2], 16), b: parseInt(hexMatch[3], 16) }
      : { r: 255, g: 255, b: 255 }

    out = sharp(inter).extend({
      top: topBw,
      bottom: bottomBw,
      left: sideBw,
      right: sideBw,
      background: { r: bg.r, g: bg.g, b: bg.b, alpha: 1 }
    }).removeAlpha()
  }

  switch (format) {
    case 'webp':
      return out.webp({ quality }).toBuffer()
    case 'png':
      return out.png().toBuffer()
    default:
      return out.jpeg({ quality, mozjpeg: true }).toBuffer()
  }
}
